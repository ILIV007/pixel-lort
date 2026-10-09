/**
 * Steam News connector (Phase 4 — ADR-0039 §1): ISteamNews/GetNewsForApp
 * v2 (keyless, documented), bounded configured app watchlist, per-app item
 * limits. The app watchlist is OWNER-supplied runtime configuration
 * (`config.apps`); the registry ships only the batch/limit policy — no app
 * IDs are ever invented here.
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
import { z } from 'zod';

export const SteamRuntimeConfigSchema = z
  .object({
    appsPerBatch: z.number().int().min(1).max(25),
    maxItemsPerApp: z.number().int().min(1).max(10),
    apps: z.array(z.number().int().min(1).max(2_147_483_647)).max(50),
  })
  .strict();

const STEAM_ENDPOINT = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';

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
    preflight(config: Record<string, unknown>): { ok: true } | { ok: false; reason: 'watchlist_empty' } {
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
      const { config, effects, sourceId } = input;
      const parsedConfig = SteamRuntimeConfigSchema.safeParse(config);
      if (!parsedConfig.success || parsedConfig.data.apps.length === 0) {
        return failed('watchlist_empty', 0);
      }
      const { apps, appsPerBatch, maxItemsPerApp } = parsedConfig.data;
      const batch = apps.slice(0, appsPerBatch);
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
          return failed('http_status_error', requestCount);
        }
        if (response.status === 429) {
          return {
            status: 'rate_limited',
            items: [],
            cursor: null,
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
          return failed('http_status_error', requestCount);
        }
        if (!isJsonContentType(response.headers.get('content-type'))) {
          return failed('unexpected_content_type', requestCount);
        }
        let parsedResponse: SteamNewsResponse;
        try {
          parsedResponse = JSON.parse(response.bodyText) as SteamNewsResponse;
        } catch {
          return failed('response_malformed', requestCount);
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

      return {
        status: 'changed',
        items,
        cursor: null,
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
): ConnectorFetchOutput {
  return {
    status: 'failed',
    items: [],
    cursor: null,
    etag: null,
    lastModified: null,
    retryAfterSeconds: null,
    requestCount,
    malformedCount: 0,
    failureReason: reason,
  };
}
