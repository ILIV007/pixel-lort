/**
 * Safe HTTP fetch for source connectors (Phase 4 — ADR-0039 §2).
 *
 * Hard bounds on every request sequence:
 * - HTTPS-only targets re-validated through the URL guard (literal layer)
 *   PLUS the caller's positive host allowlist (the real SSRF boundary);
 * - automatic redirect following DISABLED — each Location hop is resolved
 *   against the current URL and re-validated (scheme/host/port/userinfo/
 *   allowlist) before the next request, at most `maxRedirects` hops;
 * - EXACT 3xx status classes (R01): only 301/302/303/307/308 are followed;
 *   304 is a terminal response (empty body, validators via headers); other
 *   3xx (300/305/306) terminate with `redirect_status_not_followable`;
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
 * R10 per-hop budget authority (Round 1.8): TWO factories share ONE sequence
 * implementation (`runSafeSequence`).
 *
 * - `createSafeFetch(fetchFn)` — the DELIBERATELY UNBOUNDED core transport
 *   for non-ingestion/test use. It never charges any budget and must NOT be
 *   wired into the production ingestion path.
 * - `createIngestionSafeFetch({ fetchFn, authorizeUnit })` — the PRODUCTION
 *   ingestion transport. `authorizeUnit` is a REQUIRED constructor dependency
 *   (never optional, never connector-supplied): before EVERY raw fetch
 *   attempt — hop 0, every redirect hop, every later connector request — the
 *   sequence atomically consumes ONE source/day unit. A cap denial returns a
 *   typed `budget_denied` / `budget_source_missing` failure with ZERO raw
 *   requests and no observed-attempt increment; an authorizer THROW is
 *   infrastructure and surfaces as the typed `SafeFetchAuthorityError`
 *   carrying the observed attempt count so far (never converted to a
 *   provider-facing reason). Invalid targets, invalid POST bodies and an
 *   expired deadline are rejected BEFORE a unit is spent.
 *
 * R10.1 (Round 1.8.1): the authorization WAIT is itself bounded by the SAME
 * absolute sequence deadline as the raw fetch (B1) — a slow or stalled
 * authority can never start a raw attempt after the deadline, a late grant
 * never resumes the network (the remaining budget is recomputed after the
 * grant), and an authority already in flight at the deadline may still keep
 * its unit durably charged (conservative, disclosed, never refunded).
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
  | 'redirect_status_not_followable'
  | 'timeout'
  | 'network_error'
  | 'body_too_large'
  | 'invalid_utf8'
  | 'stream_read_failed'
  | 'invalid_content_length'
  /** R10: the source/day budget authority refused the unit (cap reached). */
  | 'budget_denied'
  /** R10: the source row vanished — the authority cannot charge any unit. */
  | 'budget_source_missing';

/**
 * R10 per-hop authorization outcome supplied by the ingestion wiring. The
 * authorizer is implemented by the poll handler over the atomic budget
 * store; the transport only understands these three shapes. A THROW from
 * `authorizeUnit` is infrastructure: it fails closed (no raw request) and
 * propagates to the handler's typed retry path — it is never mapped onto a
 * `SafeFetchResult`.
 */
export type SafeFetchUnitGrant =
  | { readonly kind: 'granted' }
  | { readonly kind: 'budget_denied' }
  | { readonly kind: 'source_missing' };

/** Stable failure error carrying ONLY the reason (no URL, no headers). */
export class SafeHttpError extends Error {
  readonly reason: SafeHttpFailureReason;

  constructor(reason: SafeHttpFailureReason) {
    super(`safe http failed: ${reason}`);
    this.name = 'SafeHttpError';
    this.reason = reason;
  }
}

/**
 * R10.1 (Round 1.8.1, B4): the per-hop budget authorization THROWED —
 * infrastructure, never quota exhaustion and never a provider-facing
 * result. The typed error carries the sequence's OBSERVED raw-attempt
 * count at the failure point (`requestCount` — raw attempts already issued
 * by THIS sequence, e.g. prior redirect hops) so the poll's attempted
 * total survives the throw; it deliberately carries NO raw error payload
 * (no original message/cause, no URL, no headers). Classification stays
 * infrastructure end to end: the handler maps it to the stable retry path.
 */
export class SafeFetchAuthorityError extends Error {
  readonly requestCount: number;

  constructor(requestCount: number) {
    super('safe fetch budget authority failed');
    this.name = 'SafeFetchAuthorityError';
    this.requestCount = requestCount;
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

/**
 * EXACT redirect statuses that are followed (R01 fix). The old behavior
 * treated EVERY 300–399 as a redirect, which made a bodyless 304 Not
 * Modified resolve to `redirect_location_invalid` (no Location header) —
 * conditional-GET could never reach the connectors' 304 paths through the
 * production port.
 *
 * - 301/302/303/307/308: followed (Location re-validated per hop below).
 * - 304: TERMINAL response with an empty body (RFC 9110 §15.4.5) — returned
 *   to the caller so validators (ETag/Last-Modified) ride the headers.
 * - 300/305/306: NEVER followed — 300 offers no single followable target,
 *   305 (Use Proxy) is a proxy-injection hazard, 306 is reserved/unused.
 *   These terminate with `redirect_status_not_followable` (no next hop is
 *   attempted, no body is read).
 */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

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
 * Create the DELIBERATELY UNBOUNDED SafeFetch core transport. `fetchFn` is
 * injected (mocks in tests; the production INGESTION path never constructs
 * this — see `createIngestionSafeFetch`). Every hop still passes the full
 * URL-guard security boundary; the only thing this transport never does is
 * charge a budget.
 */
export function createSafeFetch(fetchFn: typeof fetch): SafeFetchExecutor {
  return (input: SafeFetchInput) => runSafeSequence({ fetchFn, input, authorizeUnit: null });
}

/** Constructor dependencies of the PRODUCTION ingestion transport (R10). */
export interface IngestionSafeFetchDeps {
  readonly fetchFn: typeof fetch;
  /**
   * REQUIRED per-hop authorizer (atomic ONE-unit consume before every raw
   * fetch attempt). Non-optional by construction: the production ingestion
   * path can never default to unlimited.
   */
  readonly authorizeUnit: () => Promise<SafeFetchUnitGrant>;
}

/**
 * Create the PRODUCTION ingestion transport (R10): the same guarded
 * sequence as the unbounded core, with a MANDATORY per-hop budget
 * authorization before every raw fetch attempt. See the module header and
 * docs/reviews/PIXEL_ROUND1_8_PER_HOP_BUDGET.md for the exact call chain.
 */
export function createIngestionSafeFetch(deps: IngestionSafeFetchDeps): SafeFetchExecutor {
  return (input: SafeFetchInput) =>
    runSafeSequence({ fetchFn: deps.fetchFn, input, authorizeUnit: deps.authorizeUnit });
}

interface SequenceDeps {
  readonly fetchFn: typeof fetch;
  readonly input: SafeFetchInput;
  /** null → deliberately unbounded core; otherwise authorized per hop. */
  readonly authorizeUnit: (() => Promise<SafeFetchUnitGrant>) | null;
}

/** Outcome of ONE deadline-bounded authorization wait (R10.1, B1). */
type AuthorizationOutcome =
  | { readonly kind: 'settled'; readonly grant: SafeFetchUnitGrant }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'threw' };

/**
 * R10.1 (Round 1.8.1, B1): race ONE authorization against the SAME
 * absolute sequence deadline that bounds the raw fetch. The wait itself is
 * bounded — a slow or never-settling authority can no longer let a raw
 * attempt start after the deadline.
 *
 * - `deadline` wins → the caller returns `timeout` with ZERO raw requests.
 *   The authority work ALREADY in flight (e.g. a D1 unit consume) may still
 *   complete afterwards and keep its unit durably charged: a conservative,
 *   disclosed under-utilization window — there is NO refund and NO claimed
 *   cancellation/rollback of the storage transaction.
 * - A LATE settlement of the authority (grant or throw) after the deadline
 *   is absorbed: it can NEVER resume the network and never surfaces as an
 *   unhandled rejection (the handlers below are always attached).
 * - A throw WITHIN the deadline is infrastructure: the caller converts it
 *   to the typed `SafeFetchAuthorityError` (B4) — no raw payload is kept.
 * - The one timer introduced here is cleared on EVERY exit path.
 */
function raceAuthorization(
  authorize: () => Promise<SafeFetchUnitGrant>,
  budgetMs: number,
): Promise<AuthorizationOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (outcome: AuthorizationOutcome): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: 'deadline' }), budgetMs);
    let pending: Promise<SafeFetchUnitGrant>;
    try {
      pending = Promise.resolve(authorize());
    } catch {
      finish({ kind: 'threw' });
      return;
    }
    pending.then(
      (grant) => finish({ kind: 'settled', grant }),
      () => finish({ kind: 'threw' }),
    );
  });
}

/** ONE guarded request sequence shared by both transports (identical code). */
async function runSafeSequence(deps: SequenceDeps): Promise<SafeFetchResult> {
  const { fetchFn, input, authorizeUnit } = deps;
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

    const preAuthRemainingMs = deadline - Date.now();
    if (preAuthRemainingMs <= 0) {
      return { ok: false, reason: 'timeout', requestCount };
    }

    // R10: authorize ONE unit AFTER the target/body/deadline checks and
    // immediately BEFORE the raw fetch — invalid targets, invalid bodies
    // and expired deadlines never spend a unit. Denial emits ZERO raw
    // requests and never increments the observed attempt count.
    //
    // R10.1 (Round 1.8.1, B1): the authorization WAIT is bounded by the
    // SAME absolute sequence deadline as the raw fetch — a slow or stalled
    // authority can never push a raw attempt past the deadline, and a
    // grant that arrives after the deadline NEVER resumes the network (the
    // remaining time is recomputed from the real clock below and the
    // sequence exits with `timeout` first). An authority already in flight
    // when the deadline hits may still commit its D1 unit afterwards: that
    // conservative charge window is disclosed and never refunded.
    //
    // R10.1 (B4): an authorizer THROW is infrastructure: no raw request is
    // issued for this hop and it surfaces as the typed
    // `SafeFetchAuthorityError` carrying the observed attempt count so far
    // (never a provider-facing reason, never the raw error payload).
    if (authorizeUnit !== null) {
      const outcome = await raceAuthorization(authorizeUnit, preAuthRemainingMs);
      if (outcome.kind === 'deadline') {
        return { ok: false, reason: 'timeout', requestCount };
      }
      if (outcome.kind === 'threw') {
        throw new SafeFetchAuthorityError(requestCount);
      }
      if (outcome.grant.kind === 'budget_denied') {
        return { ok: false, reason: 'budget_denied', requestCount };
      }
      if (outcome.grant.kind === 'source_missing') {
        return { ok: false, reason: 'budget_source_missing', requestCount };
      }
    }

    // Recompute AFTER the grant (B1): a slow-but-timely authority must
    // leave only its REAL remainder for headers/body — a raw attempt never
    // starts on a stale pre-authorization budget.
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

    // 304 Not Modified: TERMINAL success-shaped response (R01 fix). The
    // body is empty by definition; cancel it defensively and hand the
    // status + headers (validators) to the caller untouched.
    if (response.status === 304) {
      clearTimeout(timer);
      try {
        await response.body?.cancel();
      } catch {
        // Cancel failures never mask the 304 decision.
      }
      return {
        ok: true,
        status: 304,
        headers: response.headers,
        bodyText: '',
        requestCount,
        finalUrl: guarded.url.toString(),
      };
    }

    // Canonical redirects only: validate the next hop manually (never
    // auto-followed by the platform — redirect: 'manual' is preserved).
    if (REDIRECT_STATUSES.has(response.status)) {
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

    // Any OTHER 3xx (300, 305, 306, …): explicitly NOT followable (R01).
    // Terminal failure BEFORE any further network I/O; the body is never
    // read. Callers see a stable reason — never a silent 2xx conversion.
    if (response.status >= 300 && response.status < 400) {
      clearTimeout(timer);
      try {
        await response.body?.cancel();
      } catch {
        // Cancel failures never mask the classification.
      }
      return { ok: false, reason: 'redirect_status_not_followable', requestCount };
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

/**
 * Map a SafeHttpError reason onto a stable source-health reason. The R10
 * budget reasons are intentionally NOT mapped here — connectors must handle
 * them through the typed `budgetDenied` propagation (contract.ts) instead of
 * silently degrading them into provider-facing health reasons.
 */
export function safeHttpReasonToHealthReason(reason: SafeHttpFailureReason): string {
  switch (reason) {
    case 'timeout':
      return 'http_timeout';
    case 'redirect_limit':
      return 'http_redirect_limit';
    case 'redirect_status_not_followable':
      return 'http_status_error';
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
