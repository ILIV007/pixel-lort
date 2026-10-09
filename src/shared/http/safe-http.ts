/**
 * Safe HTTP fetch for source connectors (Phase 4 — ADR-0039 §2).
 *
 * Hard bounds on every request sequence:
 * - HTTPS-only targets re-validated through the URL guard (literal layer)
 *   PLUS the caller's positive host allowlist (the real SSRF boundary);
 * - automatic redirect following DISABLED — each Location hop is resolved
 *   against the current URL and re-validated (scheme/host/port/userinfo/
 *   allowlist) before the next request, at most `maxRedirects` hops;
 * - authentication-shaped headers (Authorization, Cookie, API-key headers)
 *   are stripped on any ORIGIN CHANGE (host mismatch) — never forwarded
 *   across an unapproved origin;
 * - total 10 s deadline covering HEADERS AND BODY: one AbortController is
 *   wired through every hop and every stream read, so a slow-drip body is
 *   cut at the deadline (tested);
 * - streamed byte cap via the existing bounded-reader primitive
 *   (Content-Length is an early hint, never trusted); strict UTF-8;
 * - every hop counts as a real request (callers spend budget honestly).
 *
 * This module never logs URLs, headers, or body content.
 */
import { guardFetchTarget } from '../security/url-guard';
import {
  BoundedReadError,
  decodeUtf8Strict,
  parseContentLengthHeader,
  readStreamBounded,
} from './bounded-reader';

/** Headers that must never cross an origin change (ADR-0039 §2). */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-goog-api-key',
  'x-api-key',
  'api-key',
  'proxy-authorization',
]);

export type SafeHttpFailureReason =
  | 'invalid_url'
  | 'scheme_not_https'
  | 'port_not_allowed'
  | 'userinfo_present'
  | 'host_missing'
  | 'host_not_allowed'
  | 'ip_literal_forbidden'
  | 'host_invalid'
  | 'redirect_limit'
  | 'redirect_location_invalid'
  | 'timeout'
  | 'network_error'
  | 'body_too_large'
  | 'invalid_utf8'
  | 'stream_read_failed'
  | 'invalid_content_length';

/** Stable failure error carrying ONLY the reason (no URL, no headers). */
export class SafeHttpError extends Error {
  readonly reason: SafeHttpFailureReason;

  constructor(reason: SafeHttpFailureReason) {
    super(`safe http failed: ${reason}`);
    this.name = 'SafeHttpError';
    this.reason = reason;
  }
}

export interface SafeFetchInput {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly byteCap: number;
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly allowedHosts: ReadonlyArray<string>;
  /** GET (default) or POST (bounded form body — OAuth token endpoints). */
  readonly method?: 'GET' | 'POST';
  /** Bounded request body (POST only, ≤ 4 KiB, never logged). */
  readonly body?: string;
}

/** Hard bound for POST bodies (token endpoints need tiny form bodies). */
export const MAX_REQUEST_BODY_BYTES = 4_096;

export interface SafeFetchResultOk {
  readonly ok: true;
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
  readonly requestCount: number;
  readonly finalUrl: string;
}

export interface SafeFetchResultErr {
  readonly ok: false;
  readonly reason: SafeHttpFailureReason;
  readonly requestCount: number;
}

export type SafeFetchResult = SafeFetchResultOk | SafeFetchResultErr;

/**
 * Create the SafeFetch port used by connectors. `fetchFn` is injected
 * (global fetch in production wiring, mocks in tests).
 */
export function createSafeFetch(fetchFn: typeof fetch): SafeFetchExecutor {
  return async (input: SafeFetchInput): Promise<SafeFetchResult> => {
    let currentUrl = input.url;
    let requestCount = 0;
    // One deadline for the WHOLE sequence (all hops + body reads).
    const deadline = Date.now() + input.timeoutMs;

    for (let hop = 0; hop <= input.maxRedirects; hop++) {
      const guarded = guardFetchTarget(currentUrl, input.allowedHosts);
      if (!guarded.ok || guarded.url === undefined) {
        return {
          ok: false,
          reason: guarded.reason ?? 'invalid_url',
          requestCount,
        };
      }

      // Method/body: POST carries a bounded body on the FIRST hop only;
      // redirect hops always degrade to GET (never re-POST elsewhere).
      const isPost = hop === 0 && input.method === 'POST';
      const body: string | undefined = isPost ? (input.body ?? '') : undefined;
      if (
        isPost &&
        (body === undefined || body.length === 0 || body.length > MAX_REQUEST_BODY_BYTES)
      ) {
        return { ok: false, reason: 'network_error', requestCount };
      }

      // Strip credential headers unless the origin matches the ORIGINAL
      // request origin (host comparison; scheme/port fixed by the guard).
      const headers: Record<string, string> = {};
      const originalHost = new URL(input.url).host;
      for (const [name, value] of Object.entries(input.headers)) {
        if (CREDENTIAL_HEADERS.has(name.toLowerCase()) && guarded.url.host !== originalHost) {
          continue; // cross-origin: never forward authentication material
        }
        headers[name] = value;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return { ok: false, reason: 'timeout', requestCount };
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), remainingMs);

      let response: Response;
      requestCount += 1;
      try {
        response = await fetchFn(guarded.url.toString(), {
          method: isPost ? 'POST' : 'GET',
          headers,
          body: isPost ? body : undefined,
          redirect: 'manual',
          signal: abort.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof Error && error.name === 'AbortError') {
          return { ok: false, reason: 'timeout', requestCount };
        }
        return { ok: false, reason: 'network_error', requestCount };
      }

      // 3xx: validate the next hop manually (never auto-followed).
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location === null) {
          clearTimeout(timer);
          return { ok: false, reason: 'redirect_location_invalid', requestCount };
        }
        let next: URL;
        try {
          next = new URL(location, guarded.url);
        } catch {
          clearTimeout(timer);
          return { ok: false, reason: 'redirect_location_invalid', requestCount };
        }
        // Drain nothing; cancel the redirect body defensively.
        try {
          await response.body?.cancel();
        } catch {
          // Body cancel failures never mask the redirect decision.
        }
        clearTimeout(timer);
        if (hop === input.maxRedirects) {
          return { ok: false, reason: 'redirect_limit', requestCount };
        }
        currentUrl = next.toString();
        continue;
      }

      // Final response: bound the body WITH the shared deadline.
      try {
        const declared = parseContentLengthHeader(
          response.headers.get('content-length'),
          input.byteCap,
        );
        if (declared.kind === 'oversized') {
          try {
            await response.body?.cancel();
          } catch {
            // Ignore cancel failures on the rejection path.
          }
          return { ok: false, reason: 'body_too_large', requestCount };
        }
        if (declared.kind === 'invalid') {
          return { ok: false, reason: 'invalid_content_length', requestCount };
        }
        const bytes = await readUntilDeadline(response.body, input.byteCap, deadline, abort);
        clearTimeout(timer);
        const text = decodeUtf8Strict(bytes);
        return {
          ok: true,
          status: response.status,
          headers: response.headers,
          bodyText: text,
          requestCount,
          finalUrl: guarded.url.toString(),
        };
      } catch (error) {
        clearTimeout(timer);
        // OUR deadline abort during the body read is a timeout (the deadline
        // covers body reading, not just headers — ADR-0039 §2).
        if (abort.signal.aborted) {
          return { ok: false, reason: 'timeout', requestCount };
        }
        if (error instanceof BoundedReadError) {
          const reason: SafeHttpFailureReason =
            error.reason === 'too_large'
              ? 'body_too_large'
              : error.reason === 'invalid_utf8'
                ? 'invalid_utf8'
                : 'stream_read_failed';
          return { ok: false, reason, requestCount };
        }
        if (error instanceof Error && error.name === 'AbortError') {
          return { ok: false, reason: 'timeout', requestCount };
        }
        return { ok: false, reason: 'stream_read_failed', requestCount };
      }
    }
    // Unreachable (loop always returns) — kept for exhaustiveness.
    return { ok: false, reason: 'redirect_limit', requestCount };
  };
}

export type SafeFetchExecutor = (input: SafeFetchInput) => Promise<SafeFetchResult>;

/**
 * Read a response body up to `maxBytes` with an ABSOLUTE deadline
 * (deadline covers the body read, not just the headers). Combines the
 * bounded reader with the shared abort signal.
 */
async function readUntilDeadline(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  deadline: number,
  abort: AbortController,
): Promise<Uint8Array> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new BoundedReadError('stream_read_failed');
  }
  const timer = setTimeout(() => abort.abort(), remainingMs);
  try {
    return await readStreamBounded(body, maxBytes);
  } finally {
    clearTimeout(timer);
  }
}

/** Map a SafeHttpError reason onto a stable source-health reason. */
export function safeHttpReasonToHealthReason(reason: SafeHttpFailureReason): string {
  switch (reason) {
    case 'timeout':
      return 'http_timeout';
    case 'redirect_limit':
      return 'http_redirect_limit';
    case 'body_too_large':
      return 'response_too_large';
    case 'invalid_utf8':
      return 'response_invalid_utf8';
    case 'host_not_allowed':
    case 'ip_literal_forbidden':
    case 'scheme_not_https':
    case 'port_not_allowed':
    case 'userinfo_present':
    case 'invalid_url':
    case 'host_invalid':
    case 'host_missing':
      return 'connector_unavailable';
    default:
      return 'http_status_error';
  }
}
