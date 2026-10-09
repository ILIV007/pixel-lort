/**
 * RSS/Atom connector (Phase 4 — ADR-0039 §1/§3). Covers all seven RSS
 * entries of the registry generically: single `endpoint` or bounded
 * `endpointTemplates` lists.
 *
 * Behavior: conditional GET (If-None-Match + If-Modified-Since from the
 * per-feed cursor), safe bounded XML parsing, normalization via the
 * shared module. All-304 across feeds → not_modified. Malformed feeds
 * fail safe (item-level drop with malformedCount; whole-feed parse
 * failure is a `failed` poll for that feed — but OTHER feeds' durable
 * items still commit; the cursor keeps their state, the broken feed's
 * entry is left untouched, ADR-0038 §5).
 */
import { INGESTION_LIMITS } from '../domain/source/source-registry';
import type { SafeHttpFailureReason } from '../shared/http/safe-http';
import { safeHttpReasonToHealthReason } from '../shared/http/safe-http';
import { parseFeedDocument } from './xml/feed-reader';
import { normalizeRawItem, type NormalizedItemOut } from './normalize';
import {
  endpointHost,
  isXmlContentType,
  parseRetryAfterSeconds,
  type ConnectorFetchInput,
  type ConnectorFetchOutput,
  type SourceConnector,
} from './contract';

interface FeedCursorEntry {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

type FeedCursor = Record<string, FeedCursorEntry>;

function parseCursor(cursor: string | null): FeedCursor {
  if (cursor === null || cursor.length === 0 || cursor.length > 16_384) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const out: FeedCursor = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        key.startsWith('https://')
      ) {
        const entry = value as Record<string, unknown>;
        out[key] = {
          etag: typeof entry.etag === 'string' ? entry.etag.slice(0, 256) : null,
          lastModified: typeof entry.lastModified === 'string' ? entry.lastModified.slice(0, 128) : null,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function feedUrls(config: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const endpoint = config['endpoint'];
  if (typeof endpoint === 'string' && endpoint.startsWith('https://')) {
    urls.push(endpoint);
  }
  const templates = config['endpointTemplates'];
  if (Array.isArray(templates)) {
    for (const template of templates) {
      if (typeof template === 'string' && template.startsWith('https://') && urls.length < 4) {
        urls.push(template);
      }
    }
  }
  return urls.slice(0, 4);
}

export function createRssConnector(): SourceConnector {
  return {
    id: 'rss',
    byteCap: INGESTION_LIMITS.maxFeedBytes,
    plannedRequestCount(config: Record<string, unknown>): number {
      return Math.max(1, feedUrls(config).length);
    },
    preflight(config: Record<string, unknown>): { ok: true } | { ok: false; reason: 'watchlist_empty' } {
      return feedUrls(config).length > 0 ? { ok: true } : { ok: false, reason: 'watchlist_empty' };
    },
    allowedHosts(config: Record<string, unknown>): readonly string[] {
      return feedUrls(config)
        .map((url) => endpointHost(url))
        .filter((host): host is string => host !== null);
    },
    async fetch(input: ConnectorFetchInput): Promise<ConnectorFetchOutput> {
      const { config, state, effects, sourceId } = input;
      const urls = feedUrls(config);
      if (urls.length === 0) {
        return {
          status: 'failed',
          items: [],
          cursor: state.cursor,
          etag: null,
          lastModified: null,
          retryAfterSeconds: null,
          requestCount: 0,
          malformedCount: 0,
          failureReason: 'watchlist_empty',
        };
      }
      const cursor = parseCursor(state.cursor);
      const items: NormalizedItemOut[] = [];
      let requestCount = 0;
      let malformed = 0;
      let anyChanged = false;
      let anyRateLimited = false;
      let anyFailed = false;
      let retryAfterSeconds: number | null = null;
      let failureReason: ConnectorFetchOutput['failureReason'] = null;
      const nextCursor: FeedCursor = { ...cursor };

      for (const feedUrl of urls) {
        const entry = cursor[feedUrl] ?? { etag: null, lastModified: null };
        const headers: Record<string, string> = {
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          'user-agent': 'PixelEditorialAgent/1.4 (+https://t.me/pixellort)',
        };
        // Conditional GET: BOTH validators when available (blueprint §8).
        if (entry.etag !== null) {
          headers['if-none-match'] = entry.etag;
        }
        if (entry.lastModified !== null) {
          headers['if-modified-since'] = entry.lastModified;
        }
        const response = await effects.safeFetch({
          url: feedUrl,
          headers,
          byteCap: INGESTION_LIMITS.maxFeedBytes,
          timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
          maxRedirects: INGESTION_LIMITS.maxRedirects,
          allowedHosts: [endpointHost(feedUrl) ?? ''],
        });
        requestCount += response.requestCount;
        if (!response.ok) {
          anyFailed = true;
          failureReason = mapFailureReason(response.reason);
          continue;
        }
        if (response.status === 304) {
          nextCursor[feedUrl] = entry;
          continue;
        }
        if (response.status === 429) {
          anyRateLimited = true;
          retryAfterSeconds = parseRetryAfterSeconds(
            response.headers.get('retry-after'),
            effects.nowMs(),
          );
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          anyFailed = true;
          failureReason = 'http_status_error';
          continue;
        }
        if (!isXmlContentType(response.headers.get('content-type'))) {
          anyFailed = true;
          failureReason = 'unexpected_content_type';
          continue;
        }
        const parsed = parseFeedDocument(response.bodyText);
        if (!parsed.ok) {
          malformed += 1;
          anyFailed = true;
          failureReason = 'response_malformed';
          continue;
        }
        anyChanged = true;
        const etag = response.headers.get('etag');
        const lastModified = response.headers.get('last-modified');
        nextCursor[feedUrl] = {
          etag: etag === null ? null : etag.slice(0, 256),
          lastModified: lastModified === null ? null : lastModified.slice(0, 128),
        };
        const stripDownloads = config['stripDownloadLinks'] === true;
        for (const rawItem of parsed.feed.items) {
          const normalized = await normalizeRawItem({
            connector: 'rss',
            sourceId,
            originLabel: feedUrl,
            raw: {
              id: rawItem.id,
              link: rawItem.link,
              guidPermalink: rawItem.guidPermalink,
              title: rawItem.title,
              bodyText: rawItem.bodyText,
              author: rawItem.author,
              publishedRaw: rawItem.publishedRaw,
            },
            stripDownloads,
            nowMs: effects.nowMs(),
          });
          if (normalized.ok) {
            items.push(normalized.item);
          } else {
            malformed += 1;
          }
        }
      }

      if (anyRateLimited) {
        return {
          status: 'rate_limited',
          items,
          cursor: JSON.stringify(nextCursor),
          etag: null,
          lastModified: null,
          retryAfterSeconds,
          requestCount,
          malformedCount: malformed,
          failureReason: null,
        };
      }
      if (anyFailed) {
        return {
          status: 'failed',
          items,
          cursor: JSON.stringify(nextCursor),
          etag: null,
          lastModified: null,
          retryAfterSeconds: null,
          requestCount,
          malformedCount: malformed,
          failureReason,
        };
      }
      if (!anyChanged) {
        return {
          status: 'not_modified',
          items: [],
          cursor: JSON.stringify(nextCursor),
          etag: null,
          lastModified: null,
          retryAfterSeconds: null,
          requestCount,
          malformedCount: 0,
          failureReason: null,
        };
      }
      return {
        status: 'changed',
        items,
        cursor: JSON.stringify(nextCursor),
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

function mapFailureReason(reason: SafeHttpFailureReason): ConnectorFetchOutput['failureReason'] {
  return safeHttpReasonToHealthReason(reason) as ConnectorFetchOutput['failureReason'];
}
