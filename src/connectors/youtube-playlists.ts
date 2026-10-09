/**
 * YouTube playlists connector (Phase 4 — ADR-0039 §1): official
 * playlistItems + videos-details contract ONLY. The search endpoint and
 * any video download are FORBIDDEN by the registry
 * (`useSearchEndpoint:false`, `downloadVideo:false` — enforced here and
 * pinned by tests). API key travels in the `X-Goog-Api-Key` HEADER —
 * never a query string (ADR-0039 §2).
 *
 * Watchlist = owner-supplied `config.playlists` (registry ships none —
 * no playlist IDs are invented). One playlistItems page per playlist per
 * poll (newest-first), then ONE videos-details call for the collected
 * ids. Bounded: ≤ RUNTIME_CONFIG_BOUNDS.maxYoutubePlaylists playlists.
 */
import { INGESTION_LIMITS } from '../domain/source/source-registry';
import { RUNTIME_CONFIG_BOUNDS } from './contract';
import { normalizeRawItem, type NormalizedItemOut } from './normalize';
import {
  isJsonContentType,
  parseRetryAfterSeconds,
  type ConnectorFetchInput,
  type ConnectorFetchOutput,
  type SourceConnector,
} from './contract';
import type { SafeFetchResult, SafeFetchResultOk } from '../shared/http/safe-http';
import { z } from 'zod';

export const YoutubeRuntimeConfigSchema = z
  .object({
    useSearchEndpoint: z.literal(false),
    downloadVideo: z.literal(false),
    playlists: z.array(z.string().regex(/^[A-Za-z0-9_-]{12,64}$/)).max(25),
  })
  .strict();

const PLAYLIST_ITEMS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/playlistItems';
const VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';

interface PlaylistItemsResponse {
  items?: Array<{
    snippet?: {
      title?: string;
      description?: string;
      publishedAt?: string;
      videoOwnerChannelTitle?: string;
    };
    contentDetails?: { videoId?: string };
  }>;
}

interface VideosResponse {
  items?: Array<{
    id?: string;
    snippet?: { publishedAt?: string; channelTitle?: string };
    contentDetails?: { duration?: string };
  }>;
}

const MAX_PAGE_ITEMS = 25;

export function createYoutubePlaylistsConnector(): SourceConnector {
  return {
    id: 'youtube-playlists',
    byteCap: 1_048_576,
    plannedRequestCount(config: Record<string, unknown>): number {
      const parsed = YoutubeRuntimeConfigSchema.safeParse(config);
      if (!parsed.success || parsed.data.playlists.length === 0) {
        return 0;
      }
      // playlistItems pages + one videos-details call.
      return parsed.data.playlists.length + 1;
    },
    preflight(
      config: Record<string, unknown>,
      secrets: (name: string) => string | undefined,
    ): { ok: true } | { ok: false; reason: 'watchlist_empty' | 'credentials_missing' } {
      const parsed = YoutubeRuntimeConfigSchema.safeParse(config);
      if (!parsed.success || parsed.data.playlists.length === 0) {
        return { ok: false, reason: 'watchlist_empty' };
      }
      if (secrets('YOUTUBE_API_KEY') === undefined) {
        return { ok: false, reason: 'credentials_missing' };
      }
      return { ok: true };
    },
    allowedHosts(): readonly string[] {
      return ['www.googleapis.com'];
    },
    async fetch(input: ConnectorFetchInput): Promise<ConnectorFetchOutput> {
      const { config, effects, sourceId } = input;
      const parsedConfig = YoutubeRuntimeConfigSchema.safeParse(config);
      if (!parsedConfig.success || parsedConfig.data.playlists.length === 0) {
        return failed('watchlist_empty', 0);
      }
      const apiKey = effects.secrets('YOUTUBE_API_KEY');
      if (apiKey === undefined) {
        return failed('credentials_missing', 0);
      }
      const headers: Record<string, string> = {
        accept: 'application/json',
        'x-goog-api-key': apiKey,
      };
      const items: NormalizedItemOut[] = [];
      const videoIds: string[] = [];
      interface VideoMeta {
        title: string | null;
        description: string | null;
        publishedAt: string | null;
        channelTitle: string | null;
      }
      const itemMetaById = new Map<string, VideoMeta>();
      let requestCount = 0;
      let malformed = 0;

      for (const playlistId of parsedConfig.data.playlists.slice(0, RUNTIME_CONFIG_BOUNDS.maxYoutubePlaylists)) {
        const url =
          `${PLAYLIST_ITEMS_ENDPOINT}?part=snippet,contentDetails` +
          `&playlistId=${encodeURIComponent(playlistId)}&maxResults=${MAX_PAGE_ITEMS}`;
        const response = await effects.safeFetch({
          url,
          headers,
          byteCap: 1_048_576,
          timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
          maxRedirects: INGESTION_LIMITS.maxRedirects,
          allowedHosts: ['www.googleapis.com'],
        });
        requestCount += response.requestCount;
        const guard = checkJsonStatus(response, effects.nowMs());
        if (guard.type === 'fail') {
          return guard.output;
        }
        let parsedResponse: PlaylistItemsResponse;
        try {
          parsedResponse = JSON.parse(guard.response.bodyText) as PlaylistItemsResponse;
        } catch {
          return failed('response_malformed', requestCount);
        }
        const playlistItems = parsedResponse.items;
        if (!Array.isArray(playlistItems)) {
          malformed += 1;
          continue;
        }
        for (const entry of playlistItems.slice(0, MAX_PAGE_ITEMS)) {
          const videoId = entry.contentDetails?.videoId;
          if (typeof videoId !== 'string' || videoId === '') {
            malformed += 1;
            continue;
          }
          videoIds.push(videoId);
          itemMetaById.set(videoId, {
            title: typeof entry.snippet?.title === 'string' ? entry.snippet.title : null,
            description:
              typeof entry.snippet?.description === 'string' ? entry.snippet.description : null,
            publishedAt:
              typeof entry.snippet?.publishedAt === 'string' ? entry.snippet.publishedAt : null,
            channelTitle:
              typeof entry.snippet?.videoOwnerChannelTitle === 'string'
                ? entry.snippet.videoOwnerChannelTitle
                : null,
          });
        }
      }

      if (videoIds.length > 0) {
        // ONE bounded videos-details call (up to MAX_PAGE_ITEMS ids).
        const ids = videoIds.slice(0, MAX_PAGE_ITEMS).map((id) => encodeURIComponent(id)).join(',');
        const detailsUrl = `${VIDEOS_ENDPOINT}?part=snippet,contentDetails&id=${ids}&maxResults=${MAX_PAGE_ITEMS}`;
        const detailsResponse = await effects.safeFetch({
          url: detailsUrl,
          headers,
          byteCap: 1_048_576,
          timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
          maxRedirects: INGESTION_LIMITS.maxRedirects,
          allowedHosts: ['www.googleapis.com'],
        });
        requestCount += detailsResponse.requestCount;
        // Details are enrichment: a failed details call does not discard
        // the playlistItems data (degraded but honest provenance).
        if (detailsResponse.ok && detailsResponse.status >= 200 && detailsResponse.status < 300) {
          try {
            const details = JSON.parse(detailsResponse.bodyText) as VideosResponse;
            if (Array.isArray(details.items)) {
              for (const detail of details.items) {
                const videoId = detail.id;
                const meta = typeof videoId === 'string' ? itemMetaById.get(videoId) : undefined;
                if (meta !== undefined) {
                  itemMetaById.set(videoId!, {
                    ...meta,
                    // Authoritative publish time from the videos contract.
                    publishedAt:
                      typeof detail.snippet?.publishedAt === 'string'
                        ? detail.snippet.publishedAt
                        : meta.publishedAt,
                    channelTitle:
                      typeof detail.snippet?.channelTitle === 'string'
                        ? detail.snippet.channelTitle
                        : meta.channelTitle,
                  });
                }
              }
            }
          } catch {
            malformed += 1;
          }
        }
      }

      for (const [videoId, meta] of itemMetaById.entries()) {
        const normalized = await normalizeRawItem({
          connector: 'youtube-playlists',
          sourceId,
          originLabel: `youtube-video-${videoId}`,
          raw: {
            id: videoId,
            link: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
            title: meta.title,
            bodyText: meta.description,
            author: meta.channelTitle,
            publishedRaw: meta.publishedAt,
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

type GuardedJson =
  | { readonly type: 'ok'; readonly response: SafeFetchResultOk }
  | { readonly type: 'fail'; readonly output: ConnectorFetchOutput };

function checkJsonStatus(response: SafeFetchResult, nowMs: number): GuardedJson {
  if (!response.ok) {
    return { type: 'fail', output: failed('http_status_error', response.requestCount) };
  }
  if (response.status === 429) {
    return {
      type: 'fail',
      output: {
        status: 'rate_limited',
        items: [],
        cursor: null,
        etag: null,
        lastModified: null,
        retryAfterSeconds: parseRetryAfterSeconds(response.headers.get('retry-after'), nowMs),
        requestCount: response.requestCount,
        malformedCount: 0,
        failureReason: null,
      },
    };
  }
  if (response.status === 403 || response.status === 401) {
    return { type: 'fail', output: failed('credentials_rejected', response.requestCount) };
  }
  if (response.status < 200 || response.status >= 300) {
    return { type: 'fail', output: failed('http_status_error', response.requestCount) };
  }
  if (!isJsonContentType(response.headers.get('content-type'))) {
    return { type: 'fail', output: failed('unexpected_content_type', response.requestCount) };
  }
  return { type: 'ok', response };
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
