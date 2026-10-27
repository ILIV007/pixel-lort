/**
 * GitHub releases connector (Phase 4 — ADR-0039 §1): configured
 * repositories only (`config.repositories` = owner/repo pairs; the
 * registry ships an EMPTY watchlist — no repositories are invented),
 * prerelease policy, bounded pagination (one releases page per repo per
 * poll) and conditional GET via If-None-Match. Optional
 * `Authorization: Bearer` ONLY when GITHUB_TOKEN is configured (header,
 * never a query string).
 *
 * R10 (Round 1.8): a budget-authority denial from the ingestion transport
 * aborts the whole multi-repository sequence immediately with the typed
 * `budgetDenied` propagation and the PRIOR per-repo etag cursor — no
 * items and no partial validator progress from a denied window.
 *
 * R10.1 (Round 1.8.1): a denial also preserves the prior source-level
 * validators (B2) and the strongest Retry-After bound observed earlier in
 * the same sequence (B3); an authority throw keeps the poll's observed
 * attempt total (B4).
 */
import { INGESTION_LIMITS } from '../domain/source/source-registry';
import { RUNTIME_CONFIG_BOUNDS } from './contract';
import { normalizeRawItem, type NormalizedItemOut } from './normalize';
import {
  budgetDenialKindOf,
  budgetDeniedOutput,
  endpointHost,
  fetchWithObservedAttempts,
  isJsonContentType,
  parseRetryAfterSeconds,
  strongestRetryAfterLowerBound,
  type ConnectorFetchInput,
  type ConnectorFetchOutput,
  type SourceConnector,
} from './contract';
import { z } from 'zod';

export const GithubRuntimeConfigSchema = z
  .object({
    repositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).max(25),
    includePrereleases: z.boolean(),
  })
  .strict();

const RELEASES_TEMPLATE = 'https://api.github.com/repos/{repo}/releases';

interface ReleasePayload {
  id?: number;
  tag_name?: string;
  name?: string;
  html_url?: string;
  prerelease?: boolean;
  draft?: boolean;
  published_at?: string | null;
  created_at?: string | null;
  body?: string | null;
  author?: { login?: string };
}

export function createGithubReleasesConnector(): SourceConnector {
  return {
    id: 'github-releases',
    byteCap: 1_048_576,
    plannedRequestCount(config: Record<string, unknown>): number {
      const parsed = GithubRuntimeConfigSchema.safeParse(config);
      return parsed.success ? parsed.data.repositories.length : 0;
    },
    preflight(
      config: Record<string, unknown>,
    ): { ok: true } | { ok: false; reason: 'watchlist_empty' } {
      const parsed = GithubRuntimeConfigSchema.safeParse(config);
      if (!parsed.success || parsed.data.repositories.length === 0) {
        return { ok: false, reason: 'watchlist_empty' };
      }
      return { ok: true };
    },
    allowedHosts(): readonly string[] {
      return [endpointHost(RELEASES_TEMPLATE.replace('{repo}', 'a/b')) ?? 'api.github.com'];
    },
    async fetch(input: ConnectorFetchInput): Promise<ConnectorFetchOutput> {
      const { config, state, effects, sourceId } = input;
      const parsedConfig = GithubRuntimeConfigSchema.safeParse(config);
      if (!parsedConfig.success || parsedConfig.data.repositories.length === 0) {
        return failed('watchlist_empty', 0);
      }
      const token = effects.secrets('GITHUB_TOKEN');
      const headers: Record<string, string> = {
        accept: 'application/vnd.github+json',
        'user-agent': 'PixelEditorialAgent/1.4 (+https://t.me/pixellores)',
        'x-github-api-version': '2022-11-28',
      };
      if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
      }

      // Per-repo etag cursor.
      let etags: Record<string, string> = {};
      try {
        if (state.cursor !== null) {
          const previous: unknown = JSON.parse(state.cursor);
          if (previous !== null && typeof previous === 'object' && !Array.isArray(previous)) {
            for (const [key, value] of Object.entries(previous as Record<string, unknown>)) {
              if (typeof value === 'string' && value.length <= 256 && key.includes('/')) {
                etags[key] = value;
              }
            }
          }
        }
      } catch {
        etags = {};
      }
      const nextEtags: Record<string, string> = { ...etags };

      const items: NormalizedItemOut[] = [];
      let requestCount = 0;
      let malformed = 0;
      let anyChanged = false;
      let anyRateLimited = false;
      // STRONGEST Retry-After lower bound across ALL rate-limited
      // repositories (R05): a later shorter, missing, or invalid header
      // never erases an earlier valid bound — see
      // strongestRetryAfterLowerBound.
      let retryAfterSeconds: number | null = null;
      let failureReason: ConnectorFetchOutput['failureReason'] = null;
      let anyFailed = false;

      for (const repo of parsedConfig.data.repositories.slice(
        0,
        RUNTIME_CONFIG_BOUNDS.maxGithubRepositories,
      )) {
        // Path segments encoded SEPARATELY (owner/repo keeps its slash).
        const repoPath = repo
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/');
        const url = RELEASES_TEMPLATE.replace('{repo}', repoPath) + '?per_page=25&page=1';
        const conditionalHeaders: Record<string, string> = { ...headers };
        const knownEtag = etags[repo];
        if (knownEtag !== undefined) {
          conditionalHeaders['if-none-match'] = knownEtag;
        }
        // R10.1 (B4): an authority throw mid-sequence keeps the poll's
        // observed attempt total: prior completed repos (requestCount) +
        // the failing sequence's own count, aggregated EXACTLY once.
        const response = await fetchWithObservedAttempts(requestCount, () =>
          effects.safeFetch({
            url,
            headers: conditionalHeaders,
            byteCap: 1_048_576,
            timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
            maxRedirects: INGESTION_LIMITS.maxRedirects,
            allowedHosts: ['api.github.com'],
          }),
        );
        requestCount += response.requestCount;
        // R10: a budget-authority denial aborts the WHOLE sequence (no
        // further repos, no partial etag progress, no items — the prior
        // cursor is preserved so the window refetches whole later).
        // R10.1 (B2/B3): the PRIOR source validators and the strongest
        // Retry-After bound already observed in THIS sequence survive the
        // denial (zero stays a valid bound).
        const denial = response.ok ? null : budgetDenialKindOf(response.reason);
        if (denial !== null) {
          return budgetDeniedOutput({
            requestCount,
            cursor: state.cursor,
            etag: state.etag,
            lastModified: state.lastModified,
            retryAfterSeconds,
            denialKind: denial,
          });
        }
        if (!response.ok) {
          anyFailed = true;
          failureReason = 'http_status_error';
          continue;
        }
        if (response.status === 429) {
          anyRateLimited = true;
          retryAfterSeconds = strongestRetryAfterLowerBound(
            retryAfterSeconds,
            parseRetryAfterSeconds(response.headers.get('retry-after'), effects.nowMs()),
          );
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          anyFailed = true;
          failureReason = 'credentials_rejected';
          continue;
        }
        if (response.status === 304) {
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          anyFailed = true;
          failureReason = 'http_status_error';
          continue;
        }
        if (!isJsonContentType(response.headers.get('content-type'))) {
          anyFailed = true;
          failureReason = 'unexpected_content_type';
          continue;
        }
        let releases: unknown;
        try {
          releases = JSON.parse(response.bodyText);
        } catch {
          malformed += 1;
          anyFailed = true;
          failureReason = 'response_malformed';
          continue;
        }
        if (!Array.isArray(releases)) {
          malformed += 1;
          anyFailed = true;
          failureReason = 'response_malformed';
          continue;
        }
        const etag = response.headers.get('etag');
        if (etag !== null) {
          nextEtags[repo] = etag.slice(0, 256);
        }
        anyChanged = true;
        for (const release of (releases as ReleasePayload[]).slice(0, 25)) {
          // Prerelease policy (draft releases are never signals).
          if (release.draft === true) {
            continue;
          }
          if (release.prerelease === true && !parsedConfig.data.includePrereleases) {
            continue;
          }
          const releaseId =
            typeof release.id === 'number'
              ? String(release.id)
              : typeof release.tag_name === 'string'
                ? release.tag_name
                : null;
          const normalized = await normalizeRawItem({
            connector: 'github-releases',
            sourceId,
            originLabel: `github-${repo}`,
            raw: {
              id: releaseId,
              link: typeof release.html_url === 'string' ? release.html_url : null,
              title:
                typeof release.name === 'string' && release.name !== ''
                  ? release.name
                  : typeof release.tag_name === 'string'
                    ? release.tag_name
                    : null,
              bodyText: typeof release.body === 'string' ? release.body : null,
              author: typeof release.author?.login === 'string' ? release.author.login : null,
              publishedRaw:
                typeof release.published_at === 'string'
                  ? release.published_at
                  : typeof release.created_at === 'string'
                    ? release.created_at
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

      if (anyRateLimited) {
        return {
          status: 'rate_limited',
          items,
          cursor: JSON.stringify(nextEtags),
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
          cursor: JSON.stringify(nextEtags),
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
          cursor: JSON.stringify(nextEtags),
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
        cursor: JSON.stringify(nextEtags),
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
