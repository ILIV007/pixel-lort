/**
 * Source ingestion domain types (Phase 4 — ADR-0038/0039; blueprint §3
 * `domain/source`: Source, cursor, budget and normalized SourceItem).
 *
 * Pure domain vocabulary: no Cloudflare, provider SDK, or HTTP client
 * types. Connectors (src/connectors/) implement the FetchContract against
 * injected ports; persistence lives in src/adapters/db/; orchestration in
 * src/application/ingestion/.
 *
 * Clock unit: epoch MILLISECONDS everywhere (matches the schema and
 * ADR-0036).
 */

/** The five implemented connector families (ADR-0039 §1). */
export const IMPLEMENTED_CONNECTORS = [
  'rss',
  'steam-news',
  'youtube-playlists',
  'reddit-oauth',
  'github-releases',
] as const;

export type ImplementedConnector = (typeof IMPLEMENTED_CONNECTORS)[number];

/** All connectors recognized by the registry catalog (blueprint v1). */
export const CATALOG_CONNECTORS = [...IMPLEMENTED_CONNECTORS, 'bluesky-public', 'igdb'] as const;

export type CatalogConnector = (typeof CATALOG_CONNECTORS)[number];

export function isImplementedConnector(value: string): value is ImplementedConnector {
  return (IMPLEMENTED_CONNECTORS as readonly string[]).includes(value);
}

/** Blueprint §8 FetchResult statuses. */
export type FetchStatus = 'changed' | 'not_modified' | 'rate_limited' | 'failed';

/**
 * Stable source health reasons persisted in `source_state.last_error`.
 * AUTHORED constants only — never provider text (AGENTS.md §3).
 */
export const SOURCE_HEALTH_REASONS = [
  'watchlist_empty',
  'credentials_missing',
  'credentials_rejected',
  'connector_not_implemented',
  'connector_unavailable',
  'budget_exhausted',
  'http_timeout',
  'http_status_error',
  'http_redirect_limit',
  'unexpected_content_type',
  'response_too_large',
  'response_invalid_utf8',
  'response_malformed',
  'pagination_bounded',
  'source_disabled',
] as const;

export type SourceHealthReason = (typeof SOURCE_HEALTH_REASONS)[number];

/** Normalized item produced by a connector and persisted to source_items. */
export interface NormalizedItem {
  /** Stable provider identifier, or a deterministic synthesized fallback. */
  readonly externalId: string;
  /** Canonical public item URL, or null when no safe link exists. */
  readonly canonicalUrl: string | null;
  /** Bounded plain-text title (always present). */
  readonly title: string;
  /** Bounded safe plain-text excerpt, or null. */
  readonly excerpt: string | null;
  /** Bounded author display text, or null. */
  readonly author: string | null;
  /** Validated publication timestamp (epoch ms) or null. */
  readonly publishedAtMs: number | null;
  /** Deterministic SHA-256 content hash (hex). */
  readonly contentHash: string;
  /** Bounded raw-provenance JSON object (≤ RAW_JSON_MAX_BYTES). */
  readonly rawJson: Record<string, unknown>;
}

/** Per-feed/per-target raw state carried between polls (JSON cursor). */
export interface RawFetchedItem {
  /** Provider item id (guid / gid / videoId / fullname / release id). */
  readonly id: string | null;
  /** Raw item link, if any. */
  readonly link: string | null;
  /** Raw title (pre-sanitization). */
  readonly title: string | null;
  /** Raw body text (pre-sanitization). */
  readonly bodyText: string | null;
  /** Raw author. */
  readonly author: string | null;
  /** Raw timestamp string. */
  readonly publishedRaw: string | null;
  /** Connector-specific download-shaped links stripped from body text. */
  readonly strippedDownloadLinkCount: number;
}

/** Classification of what one poll actually persisted. */
export interface ItemPersistenceCounts {
  readonly attempted: number;
  readonly inserted: number;
  readonly duplicateExternal: number;
  readonly duplicateUrl: number;
  readonly malformed: number;
}

/**
 * Connectors receive every effect through ports — never a global fetch.
 * The fetch port type lives in src/connectors/ (HTTP integration layer);
 * domain code stays free of HTTP vocabulary (blueprint §3).
 */

/** Injected effects for one connector fetch (test-friendly). */
export interface ConnectorFetchEffects {
  readonly nowMs: () => number;
  readonly random: () => number;
}

/** Source configuration resolved from D1 for one poll. */
export interface SourceRuntimeConfig {
  readonly id: string;
  readonly connector: string;
  readonly config: Record<string, unknown>;
  readonly dailyRequestBudget: number;
  readonly intervalSeconds: number;
}
