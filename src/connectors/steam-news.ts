/**
 * Steam News connector (Phase 4 — ADR-0039 §1; R03 strict descriptor
 * contract): ISteamNews/GetNewsForApp v2 (keyless, documented), bounded
 * configured app watchlist, per-app item limits. The app watchlist is
 * OWNER-supplied runtime configuration (`config.apps`); the registry
 * ships only the batch/limit policy — no app IDs are ever invented here.
 * The official endpoint is PINNED: a config `endpoint` descriptor, when
 * present, must equal it exactly (R03) — official host restrictions are
 * preserved and arbitrary endpoints are rejected, never ignored.
 *
 * Round 1.7 (R04): bounded PERSISTENT CYCLIC ROTATION through the
 * existing `source_state.cursor`. Each successful poll visits exactly
 * min(appsPerBatch, apps.length) configured entries starting at the
 * validated cursor (wrapping at the end) and proposes the next cursor
 * `(start + selectedCount) mod currentLength`, persisted ONLY through
 * the poll handler's atomic items/state commit. Failed/rate_limited
 * outcomes preserve the input window's cursor so the SAME window is
 * retried; failed D1 batches cannot advance the durable cursor (atomic
 * batch). The cursor is a bounded, versioned, opaque JSON that never
 * carries an app ID/URL/host — see ./steam-cursor.ts and
 * docs/reviews/PIXEL_ROUND1_7_STEAM_ROTATION.md. Fairness (disclosed
 * honestly): with a stable watchlist every configured position is
 * visited within ceil(N/B) SUCCESSFUL polls; a permanently failing
 * selected window delays rotation under the conservative retry policy
 * rather than silently skipping data.
 */
import { INGESTION_LIMITS } from '../domain/source/source-registry';
import { normalizeRawItem, type NormalizedItemOut } from './normalize';
import {
  endpointHost,
  isJsonContentType,
  parseRetryAfterSeconds,
  type ConnectorFetchInput,
  type ConnectorFetchOutput,
  type SourceConnector,
} from './contract';
import { buildSteamCursor, nextSteamCursorStart, normalizeSteamCursor } from './steam-cursor';
import { z } from 'zod';

const STEAM_ENDPOINT = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';

/**
 * Steam runtime config (R03 coherent strict configuration contract):
 * STRICT — unknown keys are rejected. Every documented field is explicitly
 * validated, including the registry-owned descriptor fact `endpoint`:
 * when present it must be EXACTLY the official ISteamNews endpoint — an
 * arbitrary or attacker-chosen endpoint is a configuration error and fails
 * preflight; it is never silently ignored (the connector only ever talks
 * to the pinned official host below). The owner watchlist (`apps`) stays
 * owner-domain; the registry ships no app IDs (none are invented here).
 */
export const SteamRuntimeConfigSchema = z
  .object({
    appsPerBatch: z.number().int().min(1).max(25),
    maxItemsPerApp: z.number().int().min(1).max(10),
    apps: z.array(z.number().int().min(1).max(2_147_483_647)).max(50),
    endpoint: z.literal(STEAM_ENDPOINT).optional(),
  })
  .strict();

interface SteamNewsItem {
  gid: string;
  title: string;
  url: string;
  author?: string;
  contents?: string;
  feedlabel?: string;
  date: number;
}

interface SteamNewsResponse {
  appnews?: {
    appid?: number;
    newsitems?: SteamNewsItem[];
  };
}

export function createSteamNewsConnector(): SourceConnector {
  return {
    id: 'steam-news',
    byteCap: 1_048_576, // JSON API — 1 MiB is ample for 10 apps × 3 items
    plannedRequestCount(config: Record<string, unknown>): number {
      const parsed = SteamRuntimeConfigSchema.safeParse(config);
      if (!parsed.success) {
        return 0;
      }
      // One request per watched app, bounded by appsPerBatch (0 when the
      // watchlist is empty — nothing is ever fetched for a blocked source).
      return Math.min(parsed.data.apps.length, parsed.data.appsPerBatch);
    },
    preflight(
      config: Record<string, unknown>,
    ): { ok: true } | { ok: false; reason: 'watchlist_empty' } {
      const parsed = SteamRuntimeConfigSchema.safeParse(config);
      if (!parsed.success || parsed.data.apps.length === 0) {
        return { ok: false, reason: 'watchlist_empty' };
      }
      return { ok: true };
    },
    allowedHosts(): readonly string[] {
      return [endpointHost(STEAM_ENDPOINT) ?? 'api.steampowered.com'];
    },
    async fetch(input: ConnectorFetchInput): Promise<ConnectorFetchOutput> {
      const { config, effects, sourceId, state } = input;
      const parsedConfig = SteamRuntimeConfigSchema.safeParse(config);
      if (!parsedConfig.success || parsedConfig.data.apps.length === 0) {
        // No rotation without a watchlist — preserve whatever cursor was
        // persisted (conservative pass-through; production reaches this
        // only behind the handler's fail-closed preflight).
        return failed('watchlist_empty', 0, state.cursor);
      }
      const { apps, appsPerBatch, maxItemsPerApp } = parsedConfig.data;
      // R04 rotation: ordered cyclic window from the VALIDATED owner
      // watchlist, starting at the normalized durable cursor. Duplicate
      // configured entries are honored as configured (never silently
      // deduplicated); every requested ID comes from `apps` and the
      // pinned endpoint — the cursor can never introduce one.
      const placement = normalizeSteamCursor(state.cursor, apps);
      const selectedCount = Math.min(appsPerBatch, apps.length);
      const batch: number[] = [];
      for (let offset = 0; offset < selectedCount; offset += 1) {
        // The index is always within [0, apps.length): the placement is
        // validated against the CURRENT list and the step wraps modulo it
        // (apps is non-empty here — the empty case returned above).
        const appId = apps[(placement.start + offset) % apps.length];
        if (appId !== undefined) {
          batch.push(appId);
        }
      }
      // The cursor preserved by every FAILED / rate_limited outcome: the
      // normalized placement of THIS attempt, so the same selected window
      // is retried (never null while a watchlist exists — a non-null
      // cursor is never reset to null by an early return).
      const retryCursor = buildSteamCursor(apps, placement.start);
      const items: NormalizedItemOut[] = [];
      let requestCount = 0;
      let malformed = 0;

      for (const appId of batch) {
        const url = `${STEAM_ENDPOINT}?appid=${appId}&count=${maxItemsPerApp}&maxlength=800&format=json`;
        const response = await effects.safeFetch({
          url,
          headers: { accept: 'application/json' },
          byteCap: 1_048_576,
          timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
          maxRedirects: INGESTION_LIMITS.maxRedirects,
          allowedHosts: ['api.steampowered.com'],
        });
        requestCount += response.requestCount;
        if (!response.ok) {
          return failed('http_status_error', requestCount, retryCursor);
        }
        if (response.status === 429) {
          return {
            status: 'rate_limited',
            items: [],
            cursor: retryCursor,
            etag: null,
            lastModified: null,
            retryAfterSeconds: parseRetryAfterSeconds(
              response.headers.get('retry-after'),
              effects.nowMs(),
            ),
            requestCount,
            malformedCount: 0,
            failureReason: null,
          };
        }
        if (response.status < 200 || response.status >= 300) {
          return failed('http_status_error', requestCount, retryCursor);
        }
        if (!isJsonContentType(response.headers.get('content-type'))) {
          return failed('unexpected_content_type', requestCount, retryCursor);
        }
        let parsedResponse: SteamNewsResponse;
        try {
          parsedResponse = JSON.parse(response.bodyText) as SteamNewsResponse;
        } catch {
          return failed('response_malformed', requestCount, retryCursor);
        }
        const newsItems = parsedResponse.appnews?.newsitems;
        if (!Array.isArray(newsItems)) {
          malformed += 1;
          continue;
        }
        for (const newsItem of newsItems.slice(0, maxItemsPerApp)) {
          const normalized = await normalizeRawItem({
            connector: 'steam-news',
            sourceId,
            originLabel: `steam-app-${appId}`,
            raw: {
              id: typeof newsItem.gid === 'string' ? newsItem.gid : null,
              link: typeof newsItem.url === 'string' ? newsItem.url : null,
              title: typeof newsItem.title === 'string' ? newsItem.title : null,
              bodyText: typeof newsItem.contents === 'string' ? newsItem.contents : null,
              author: typeof newsItem.author === 'string' ? newsItem.author : null,
              publishedRaw:
                typeof newsItem.date === 'number'
                  ? new Date(newsItem.date * 1000).toISOString()
                  : null,
            },
            stripDownloads: true,
            nowMs: effects.nowMs(),
          });
          if (normalized.ok) {
            items.push(normalized.item);
          } else {
            malformed += 1;
          }
        }
      }

      // Successful complete-batch outcome: propose the next cursor
      // (start + selectedCount) mod currentLength. Persisted ONLY via the
      // poll handler's atomic items/state commit — a failed D1 batch
      // cannot advance it. Empty successful responses still rotate
      // (progress is defined by windows visited, not items seen).
      return {
        status: 'changed',
        items,
        cursor: buildSteamCursor(
          apps,
          nextSteamCursorStart(placement.start, selectedCount, apps.length),
        ),
        etag: null,
        lastModified: null,
        retryAfterSeconds: null,
        requestCount,
        malformedCount: malformed,
        failureReason: null,
      };
    },
  };
}

function failed(
  reason: ConnectorFetchOutput['failureReason'],
  requestCount: number,
  cursor: string | null,
): ConnectorFetchOutput {
  return {
    status: 'failed',
    items: [],
    cursor,
    etag: null,
    lastModified: null,
    retryAfterSeconds: null,
    requestCount,
    malformedCount: 0,
    failureReason: reason,
  };
}
