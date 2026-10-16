/**
 * Reddit OAuth connector (Phase 4 — ADR-0039 §1): approved OAuth API only
 * — token endpoint `POST https://www.reddit.com/api/v1/access_token`
 * (grant_type=client_credentials, Basic auth, bounded form body) then
 * `GET https://oauth.reddit.com/r/{subreddit}/new?limit=` with a Bearer
 * token. Unauthenticated scraping is NOT implemented (pinned by tests).
 *
 * Watchlist = registry-configured subreddits (validated identifiers; the
 * listing URL is materialized ONLY through the template's `{subreddit}`
 * slot — never arbitrary string interpolation). Signal-only policy and
 * stripDownloadLinks are honored in normalization.
 *
 * R10 (Round 1.8): a budget-authority denial from the ingestion transport
 * (token request OR any listing request) aborts the whole sequence with
 * the typed `budgetDenied` propagation and the PRIOR saved cursor — no
 * items are derived from a denied window.
 *
 * R10.1 (Round 1.8.1): a denial also preserves the prior source-level
 * validators (B2); an authority throw keeps the poll's observed attempt
 * total (B4).
 */
import { INGESTION_LIMITS } from '../domain/source/source-registry';
import { RUNTIME_CONFIG_BOUNDS } from './contract';
import { normalizeRawItem, type NormalizedItemOut } from './normalize';
import {
  budgetDenialKindOf,
  budgetDeniedOutput,
  fetchWithObservedAttempts,
  isJsonContentType,
  parseRetryAfterSeconds,
  type ConnectorFetchInput,
  type ConnectorFetchOutput,
  type SourceConnector,
} from './contract';
import { z } from 'zod';

export const RedditRuntimeConfigSchema = z
  .object({
    subreddits: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/))
      .min(1)
      .max(10),
    limit: z.number().int().min(1).max(50),
    stripDownloadLinks: z.boolean().optional(),
  })
  .strict();

const TOKEN_ENDPOINT = 'https://www.reddit.com/api/v1/access_token';
const LISTING_TEMPLATE = 'https://oauth.reddit.com/r/{subreddit}/new';

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  error?: string;
}

interface ListingResponse {
  data?: {
    after?: string | null;
    children?: Array<{
      data?: {
        id?: string;
        name?: string;
        title?: string;
        selftext?: string;
        permalink?: string;
        author?: string;
        created_utc?: number;
        url?: string;
      };
    }>;
  };
}

export function createRedditOauthConnector(): SourceConnector {
  return {
    id: 'reddit-oauth',
    byteCap: 1_048_576,
    plannedRequestCount(config: Record<string, unknown>): number {
      const parsed = RedditRuntimeConfigSchema.safeParse(config);
      if (!parsed.success) {
        return 0;
      }
      // One token request + one listing per configured subreddit.
      return 1 + Math.min(parsed.data.subreddits.length, RUNTIME_CONFIG_BOUNDS.maxRedditSubreddits);
    },
    preflight(
      config: Record<string, unknown>,
      secrets: (name: string) => string | undefined,
    ): { ok: true } | { ok: false; reason: 'watchlist_empty' | 'credentials_missing' } {
      const parsed = RedditRuntimeConfigSchema.safeParse(config);
      if (!parsed.success || parsed.data.subreddits.length === 0) {
        return { ok: false, reason: 'watchlist_empty' };
      }
      if (
        secrets('REDDIT_CLIENT_ID') === undefined ||
        secrets('REDDIT_CLIENT_SECRET') === undefined
      ) {
        return { ok: false, reason: 'credentials_missing' };
      }
      return { ok: true };
    },
    allowedHosts(): readonly string[] {
      return ['www.reddit.com', 'oauth.reddit.com'];
    },
    async fetch(input: ConnectorFetchInput): Promise<ConnectorFetchOutput> {
      const { config, effects, sourceId } = input;
      const parsedConfig = RedditRuntimeConfigSchema.safeParse(config);
      if (!parsedConfig.success || parsedConfig.data.subreddits.length === 0) {
        return failed('watchlist_empty', 0);
      }
      const clientId = effects.secrets('REDDIT_CLIENT_ID');
      const clientSecret = effects.secrets('REDDIT_CLIENT_SECRET');
      if (clientId === undefined || clientSecret === undefined) {
        return failed('credentials_missing', 0);
      }

      // 1. App-only OAuth token (client_credentials, Basic auth header).
      // R10.1 (B4): an authority throw keeps the poll's observed attempt
      // total (failing sequence count; no prior sequence exists yet).
      const tokenResponse = await fetchWithObservedAttempts(0, () =>
        effects.safeFetch({
          url: TOKEN_ENDPOINT,
          method: 'POST',
          body: 'grant_type=client_credentials',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
            // Basic auth composed here at call time — never stored/logged.
            authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
            'user-agent': 'PixelEditorialAgent/1.4 (+https://t.me/pixellort)',
          },
          byteCap: 65_536,
          timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
          maxRedirects: INGESTION_LIMITS.maxRedirects,
          allowedHosts: ['www.reddit.com'],
        }),
      );
      let requestCount = tokenResponse.requestCount;
      // R10: a budget-authority denial on the token request aborts the
      // sequence BEFORE any listing (no further network, prior cursor).
      // R10.1 (B2): prior validators pass through (no earlier in-sequence
      // bound exists — a token 429 returns rate_limited immediately).
      const tokenDenial = tokenResponse.ok ? null : budgetDenialKindOf(tokenResponse.reason);
      if (tokenDenial !== null) {
        return budgetDeniedOutput({
          requestCount,
          cursor: input.state.cursor,
          etag: input.state.etag,
          lastModified: input.state.lastModified,
          retryAfterSeconds: null,
          denialKind: tokenDenial,
        });
      }
      if (!tokenResponse.ok) {
        return failed('http_status_error', requestCount);
      }
      if (tokenResponse.status === 429) {
        return rateLimited(tokenResponse.headers.get('retry-after'), requestCount, effects.nowMs());
      }
      if (tokenResponse.status === 401 || tokenResponse.status === 403) {
        return failed('credentials_rejected', requestCount);
      }
      if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
        return failed('http_status_error', requestCount);
      }
      let token: TokenResponse;
      try {
        token = JSON.parse(tokenResponse.bodyText) as TokenResponse;
      } catch {
        return failed('response_malformed', requestCount);
      }
      const accessToken = token.access_token;
      if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 512) {
        return failed('response_malformed', requestCount);
      }

      // 2. One bounded listing per configured subreddit (newest-first).
      const items: NormalizedItemOut[] = [];
      let malformed = 0;
      const cursor: Record<string, string> = {};
      try {
        if (input.state.cursor !== null) {
          const previous: unknown = JSON.parse(input.state.cursor);
          if (previous !== null && typeof previous === 'object' && !Array.isArray(previous)) {
            for (const [key, value] of Object.entries(previous as Record<string, unknown>)) {
              if (typeof value === 'string' && value.length <= 64) {
                cursor[key] = value;
              }
            }
          }
        }
      } catch {
        // Corrupt cursor: start fresh (bounded, safe).
      }

      for (const subreddit of parsedConfig.data.subreddits.slice(
        0,
        RUNTIME_CONFIG_BOUNDS.maxRedditSubreddits,
      )) {
        // Template materialization: validated identifier ONLY.
        const listingUrl = LISTING_TEMPLATE.replace('{subreddit}', encodeURIComponent(subreddit));
        const url = `${listingUrl}?limit=${parsedConfig.data.limit}&raw_json=1`;
        // R10.1 (B4): an authority throw mid-sequence keeps the poll's
        // observed attempt total (token call + prior listings + failing
        // sequence, aggregated exactly once).
        const response = await fetchWithObservedAttempts(requestCount, () =>
          effects.safeFetch({
            url,
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${accessToken}`,
              'user-agent': 'PixelEditorialAgent/1.4 (+https://t.me/pixellort)',
            },
            byteCap: 1_048_576,
            timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
            maxRedirects: INGESTION_LIMITS.maxRedirects,
            allowedHosts: ['oauth.reddit.com'],
          }),
        );
        requestCount += response.requestCount;
        // R10: a budget-authority denial aborts the whole sequence — no
        // further subreddits, no items, the PRIOR saved cursor. R10.1 (B2):
        // prior validators pass through unchanged.
        const denial = response.ok ? null : budgetDenialKindOf(response.reason);
        if (denial !== null) {
          return budgetDeniedOutput({
            requestCount,
            cursor: input.state.cursor,
            etag: input.state.etag,
            lastModified: input.state.lastModified,
            retryAfterSeconds: null,
            denialKind: denial,
          });
        }
        if (!response.ok) {
          return failed('http_status_error', requestCount);
        }
        if (response.status === 429) {
          return rateLimited(response.headers.get('retry-after'), requestCount, effects.nowMs());
        }
        if (response.status === 401 || response.status === 403) {
          return failed('credentials_rejected', requestCount);
        }
        if (response.status < 200 || response.status >= 300) {
          return failed('http_status_error', requestCount);
        }
        if (!isJsonContentType(response.headers.get('content-type'))) {
          return failed('unexpected_content_type', requestCount);
        }
        let listing: ListingResponse;
        try {
          listing = JSON.parse(response.bodyText) as ListingResponse;
        } catch {
          return failed('response_malformed', requestCount);
        }
        const children = listing.data?.children;
        if (!Array.isArray(children)) {
          malformed += 1;
          continue;
        }
        if (typeof listing.data?.after === 'string' && listing.data.after.length <= 64) {
          cursor[subreddit] = listing.data.after;
        }
        for (const child of children.slice(0, parsedConfig.data.limit)) {
          const data = child.data;
          if (data === undefined) {
            malformed += 1;
            continue;
          }
          const fullname = typeof data.name === 'string' ? data.name : null;
          // Canonical public permalink: www.reddit.com + relative path.
          const permalink =
            typeof data.permalink === 'string' && data.permalink.startsWith('/')
              ? `https://www.reddit.com${data.permalink}`
              : typeof data.url === 'string'
                ? data.url
                : null;
          const bodyText = typeof data.selftext === 'string' ? data.selftext : null;
          const normalized = await normalizeRawItem({
            connector: 'reddit-oauth',
            sourceId,
            originLabel: `reddit-${subreddit}`,
            raw: {
              id: fullname ?? (typeof data.id === 'string' ? data.id : null),
              link: permalink,
              title: typeof data.title === 'string' ? data.title : null,
              bodyText,
              author: typeof data.author === 'string' ? data.author : null,
              publishedRaw:
                typeof data.created_utc === 'number'
                  ? new Date(data.created_utc * 1000).toISOString()
                  : null,
            },
            stripDownloads: parsedConfig.data.stripDownloadLinks === true,
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
        cursor: JSON.stringify(cursor),
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

function rateLimited(
  retryAfter: string | null,
  requestCount: number,
  nowMs: number,
): ConnectorFetchOutput {
  return {
    status: 'rate_limited',
    items: [],
    cursor: null,
    etag: null,
    lastModified: null,
    retryAfterSeconds: parseRetryAfterSeconds(retryAfter, nowMs),
    requestCount,
    malformedCount: 0,
    failureReason: null,
  };
}
