/**
 * Source connector contract (Phase 4 — ADR-0039 §1; blueprint §8
 * SourceConnector/FetchResult model, folded into one bounded fetch call:
 * fetch + normalization run inside the connector so the poll handler can
 * commit items and state in ONE atomic batch, ADR-0038 §5).
 *
 * Connectors are pure orchestration over injected ports — no global
 * fetch, no AI, no Telegram, no storage. One `fetch` call performs ONE
 * bounded request sequence (planned count pre-reservable, ADR-0038 §6).
 */
import type { SourceHealthReason } from '../domain/source/types';
import type { NormalizedItemOut } from './normalize';
import type { SafeFetchExecutor, SafeHttpFailureReason } from '../shared/http/safe-http';
import { SafeFetchAuthorityError, type SafeFetchResult } from '../shared/http/safe-http';

/** Secret-resolution port (values never logged — AGENTS.md §3). */
export type SecretReader = (name: string) => string | undefined;

/** Effects injected into every connector fetch. */
export interface ConnectorEffects {
  readonly safeFetch: SafeFetchExecutor;
  readonly nowMs: () => number;
  readonly random: () => number;
  readonly secrets: SecretReader;
}

/** State carried between polls (from source_state). */
export interface ConnectorState {
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly cursor: string | null;
}

export interface ConnectorFetchInput {
  readonly sourceId: string;
  readonly config: Record<string, unknown>;
  readonly state: ConnectorState;
  readonly effects: ConnectorEffects;
}

export interface ConnectorFetchOutput {
  readonly status: 'changed' | 'not_modified' | 'rate_limited' | 'failed';
  readonly items: readonly NormalizedItemOut[];
  /** Opaque bounded cursor JSON persisted to source_state.cursor. */
  readonly cursor: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  /**
   * Parsed Retry-After for 429s (true lower bound, ADR-0038 §4). For a
   * multi-feed/multi-repository fetch this is the STRONGEST observed
   * lower bound across all rate-limited responses (R05) — see
   * `strongestRetryAfterLowerBound`.
   */
  readonly retryAfterSeconds: number | null;
  /** ACTUAL requests spent (hops included) — reconciled into the budget. */
  readonly requestCount: number;
  readonly malformedCount: number;
  /** Stable health reason when status === 'failed'. */
  readonly failureReason: SourceHealthReason | null;
  /**
   * R10 (Round 1.8): the ingestion transport's budget authority refused a
   * unit mid-sequence (`budget_denied` or `budget_source_missing`). The
   * sequence ended by AUTHORITY, not by provider failure: NO items may be
   * derived from it, the PRIOR cursor/validators are proposed unchanged
   * (R10.1/B2: saved etag/lastModified survive the denial EXACTLY), and
   * `failureReason` is 'budget_exhausted' (never HTTP 429, never an
   * auth failure, never infrastructure). `retryAfterSeconds` carries the
   * strongest provider bound observed earlier in the SAME sequence
   * (R10.1/B3). Connectors set this on EVERY exit path triggered by a
   * denial and abort the whole sequence (no further network). Absent or
   * undefined for every other outcome.
   */
  readonly budgetDenied?: true;
  /**
   * R10: which authority refusal ended the sequence (set iff `budgetDenied`).
   * 'budget_exhausted' — the source/day cap (or a quota of 0) refused the
   * unit. 'source_missing' — the source row vanished between the handler's
   * existence check and a later hop; the handler surfaces the same permanent
   * `ingestion_source_missing` job outcome the old job-start path used.
   */
  readonly budgetDenialKind?: 'budget_exhausted' | 'source_missing';
}

/** The Phase 4 connector port. */
export interface SourceConnector {
  readonly id: string;
  /** Planned request count for budget pre-reservation (ADR-0038 §6). */
  plannedRequestCount(config: Record<string, unknown>): number;
  /** Fail-closed pre-flight: implemented + configured check (no network). */
  preflight(
    config: Record<string, unknown>,
    secrets: SecretReader,
  ): { ok: true } | { ok: false; reason: SourceHealthReason };
  /** Positive host allowlist for this connector's configured endpoints. */
  allowedHosts(config: Record<string, unknown>): readonly string[];
  /** Byte cap for this connector's responses. */
  readonly byteCap: number;
  fetch(input: ConnectorFetchInput): Promise<ConnectorFetchOutput>;
}

/** Bounded runtime config schemas per connector (registry + owner data). */
export const RUNTIME_CONFIG_BOUNDS = {
  maxSteamApps: 50,
  maxYoutubePlaylists: 25,
  maxGithubRepositories: 25,
  maxRedditSubreddits: 10,
} as const;

/**
 * R10: classify a transport failure reason as a budget-authority denial.
 * Returns the denial kind for `budget_denied` / `budget_source_missing` and
 * null for every other reason. Connectors MUST check this BEFORE the
 * generic !ok handling: a denial aborts the whole sequence with the typed
 * `budgetDenied` propagation instead of degrading into a provider-facing
 * health reason.
 */
export function budgetDenialKindOf(
  reason: SafeHttpFailureReason,
): 'budget_exhausted' | 'source_missing' | null {
  if (reason === 'budget_denied') {
    return 'budget_exhausted';
  }
  if (reason === 'budget_source_missing') {
    return 'source_missing';
  }
  return null;
}

/**
 * R10: the typed connector output for a budget-denied (incomplete-by-
 * authority) sequence. `requestCount` is the cumulative OBSERVED raw
 * attempt count (hops included) up to the denial; `cursor`, `etag` and
 * `lastModified` are the PRIOR persisted state (never a partially advanced
 * or nulled one — R10.1/B2: a denied window must not destroy saved
 * validators, tested with NON-NULL fixtures); `retryAfterSeconds` is the
 * STRONGEST provider Retry-After lower bound already observed earlier in
 * the SAME sequence (R10.1/B3 — a subsequent denial must not erase it,
 * zero stays valid); items are always empty — a denied window is deferred
 * whole and refetched after the budget becomes available.
 */
export function budgetDeniedOutput(input: {
  readonly requestCount: number;
  readonly cursor: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly retryAfterSeconds: number | null;
  readonly denialKind: 'budget_exhausted' | 'source_missing';
}): ConnectorFetchOutput {
  return {
    status: 'failed',
    items: [],
    cursor: input.cursor,
    etag: input.etag,
    lastModified: input.lastModified,
    retryAfterSeconds: input.retryAfterSeconds,
    requestCount: input.requestCount,
    malformedCount: 0,
    failureReason: 'budget_exhausted',
    budgetDenied: true,
    budgetDenialKind: input.denialKind,
  };
}

/**
 * R10.1 (Round 1.8.1, B4): run ONE top-level SafeFetch sequence and, when
 * the budget authority throws mid-sequence, re-surface the typed
 * `SafeFetchAuthorityError` with the POLL-LEVEL observed attempt total:
 * prior completed sequences' counts (`priorObserved`) + the failing
 * sequence's own count — each aggregated EXACTLY ONCE. The handler exposes
 * this safe attempted total on its stable infrastructure warning; it is
 * DISTINCT from durable charged units (charge-before-fetch windows can
 * legitimately differ). No raw error payload is attached.
 */
export async function fetchWithObservedAttempts(
  priorObserved: number,
  sequence: () => Promise<SafeFetchResult>,
): Promise<SafeFetchResult> {
  try {
    return await sequence();
  } catch (error) {
    if (error instanceof SafeFetchAuthorityError) {
      throw new SafeFetchAuthorityError(priorObserved + error.requestCount);
    }
    throw error;
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) as seconds. */
export function parseRetryAfterSeconds(headerValue: string | null, nowMs: number): number | null {
  if (headerValue === null || headerValue.length === 0 || headerValue.length > 64) {
    return null;
  }
  if (/^[0-9]+$/.test(headerValue)) {
    const seconds = Number.parseInt(headerValue, 10);
    if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86_400) {
      return null;
    }
    return seconds;
  }
  const parsed = Date.parse(headerValue);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  const deltaSeconds = Math.ceil((parsed - nowMs) / 1000);
  if (deltaSeconds <= 0) {
    return 0;
  }
  return Math.min(deltaSeconds, 86_400);
}

/**
 * Aggregate one more parsed Retry-After observation into the STRONGEST
 * applicable lower bound across a fetch's feeds/repositories (R05).
 *
 * Retry-After is a LOWER bound: "do not retry before N seconds". An
 * aggregate over several rate-limited responses must therefore never
 * promise an earlier retry than ANY single observed bound — the maximum
 * wins. Specifically:
 * - a later SHORTER bound must not erase an earlier LONGER one;
 * - a later MISSING or INVALID header (parsed → null) carries NO
 *   information and must never erase an earlier valid bound;
 * - ZERO is a real observed bound ("retrying now is allowed", from
 *   delta-seconds "0" or an already-past HTTP-date) — it is distinct
 *   from null (unknown) and is preserved when it is the only
 *   observation, but never erases a stronger bound.
 */
export function strongestRetryAfterLowerBound(
  current: number | null,
  incoming: number | null,
): number | null {
  if (incoming === null) {
    return current;
  }
  if (current === null) {
    return incoming;
  }
  return Math.max(current, incoming);
}

/** Approved response content types per connector family. */
export function isXmlContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return true; // typeless responses are parsed and fail safely if malformed
  }
  const lower = contentType.toLowerCase();
  return (
    lower.includes('xml') ||
    lower.startsWith('text/plain') ||
    lower.startsWith('application/octet-stream')
  );
}

export function isJsonContentType(contentType: string | null): boolean {
  if (contentType === null) {
    return true;
  }
  const lower = contentType.toLowerCase();
  return lower.includes('json') || lower.startsWith('application/octet-stream');
}

/** Extract the host of a configured https endpoint (allowlist input). */
export function endpointHost(endpoint: string): string | null {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' || parsed.host === '') {
      return null;
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}
