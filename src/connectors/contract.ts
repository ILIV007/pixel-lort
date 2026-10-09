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
import type { SafeFetchExecutor } from '../shared/http/safe-http';

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
  /** Parsed Retry-After for 429s (true lower bound, ADR-0038 §4). */
  readonly retryAfterSeconds: number | null;
  /** ACTUAL requests spent (hops included) — reconciled into the budget. */
  readonly requestCount: number;
  readonly malformedCount: number;
  /** Stable health reason when status === 'failed'. */
  readonly failureReason: SourceHealthReason | null;
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
