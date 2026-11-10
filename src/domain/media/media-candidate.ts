/**
 * Phase 7.2 — the media CANDIDATE model (blueprint §3 `domain/media`,
 * §14 media pipeline steps 1–2): the typed candidate, the conservative
 * canonical-URL discipline, and the deterministic precedence comparator.
 *
 * BOUNDARY (src/domain/README): NO Cloudflare, Telegram, provider SDK or
 * HTTP-client types; NO I/O; NO clock; NO network. A PURE domain layer
 * consumed by the (7.3+) collection/selection adapters.
 *
 * WHAT THIS MODULE IS:
 * - the versioned candidate shape (v1) — the unit the collectors
 *   propose; every candidate carries its provenance origin, its
 *   ORDINAL quality labels (officiality / relevance / freshness), its
 *   role (photo: cover_key_art | gameplay | concept_art |
 *   other_screenshot; video: video), its dedup keys (canonicalUrl +
 *   optional opaque contentHash + optional opaque visualKey) and the
 *   usage-history presence (previouslyUsed — the file_id-reuse economy
 *   input);
 * - the URL canonicalization: https-only (a FIXED transport rule),
 *   credentials rejected, non-ASCII hosts rejected (no punycode
 *   interpretation), fragment dropped, port 443 dropped, host
 *   lower-cased — and the path/query preserved BYTE-EXACT. Deliberately
 *   CONSERVATIVE: no tracking-param guessing, no redirect following, no
 *   normalization beyond the fixed rules. Identity-grade dedup comes
 *   from content/visual keys — URL similarity NEVER establishes identity
 *   (the 5.3 lesson, applied from birth);
 * - the reader (R1.12.1 lesson applied from birth): a strict typed
 *   validator — a payload that merely CLAIMS schemaVersion 1 or carries
 *   any wrong-typed/out-of-vocabulary/over-bound field is malformed;
 *   the canonicalUrl must ALREADY be canonical (re-canonicalizing must
 *   be the identity); the role must MATCH the kind; extra keys fail;
 * - the comparator: a TOTAL deterministic order over ORDINAL labels —
 *   officiality > relevance > freshness > unused-before-used > canonical
 *   URL lexicographic tiebreak. NO numeric score, NO percentage, NO
 *   weight, NO confidence anywhere (the Phase 6 gate condition: no
 *   accuracy vocabulary without a real benchmark).
 *
 * WHAT THIS MODULE NEVER DOES: it never fetches, never downloads, never
 * decides rights (media-rights), never builds an album plan
 * (album-plan), never touches a Telegram or R2 contract. The download
 * permission and the temporary-storage policy live in the sibling
 * modules of this same phase.
 */

export type MediaCandidateKindV1 = 'photo' | 'video';

export type MediaRoleV1 =
  'cover_key_art' | 'gameplay' | 'concept_art' | 'other_screenshot' | 'video';

export type MediaOriginV1 = 'official_api' | 'source_metadata';

export type MediaOfficialityV1 = 'official' | 'verified_source' | 'unofficial';

export type MediaRelevanceV1 = 'primary' | 'supporting';

export type MediaFreshnessV1 = 'current_cycle' | 'recent' | 'aged';

export interface MediaCandidateV1 {
  readonly schemaVersion: 1;
  readonly kind: MediaCandidateKindV1;
  readonly role: MediaRoleV1;
  readonly origin: MediaOriginV1;
  readonly officiality: MediaOfficialityV1;
  readonly relevance: MediaRelevanceV1;
  readonly freshness: MediaFreshnessV1;
  /** Already canonical (https, no fragment, no default port, no credentials). */
  readonly canonicalUrl: string;
  /** Optional OPAQUE dedup key over the fetched bytes (never interpreted). */
  readonly contentHash?: string;
  /** Optional OPAQUE visual-similarity key (the ≤2-per-key album cap input). */
  readonly visualKey?: string;
  /** Usage-history presence: has this media's file_id been saved before? */
  readonly previouslyUsed: boolean;
  /** Declared source dimensions (bounded 1..10000; aspect math stays with the caller). */
  readonly declaredDimensions?: { readonly width: number; readonly height: number };
}

export type UrlCanonicalReasonV1 =
  | 'unsupported_url_scheme'
  | 'non_https_media_url'
  | 'url_credentials_forbidden'
  | 'unsupported_host_characters'
  | 'url_over_bound';

export type UrlCanonicalOutcome =
  { ok: true; url: string } | { ok: false; reason: UrlCanonicalReasonV1 };

export type CandidateReadReasonV1 =
  | 'candidate_malformed'
  | 'candidate_version_unsupported'
  | 'candidate_role_kind_mismatch'
  | 'candidate_url_not_canonical';

const PHOTO_ROLES: readonly MediaRoleV1[] = [
  'cover_key_art',
  'gameplay',
  'concept_art',
  'other_screenshot',
];
const KINDS: readonly MediaCandidateKindV1[] = ['photo', 'video'];
const ORIGINS: readonly MediaOriginV1[] = ['official_api', 'source_metadata'];
const OFFICIALITY: readonly MediaOfficialityV1[] = ['official', 'verified_source', 'unofficial'];
const RELEVANCE: readonly MediaRelevanceV1[] = ['primary', 'supporting'];
const FRESHNESS: readonly MediaFreshnessV1[] = ['current_cycle', 'recent', 'aged'];

const URL_BOUND = 2048;
const OPAQUE_KEY_BOUND = 256;
const DIMENSION_BOUND = 10000;

function isBoundedOpaqueKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= OPAQUE_KEY_BOUND &&
    /^[ -~]+$/.test(value)
  );
}

function isBoundedDimension(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= DIMENSION_BOUND
  );
}

/**
 * The conservative https-only URL canonicalization (blueprint §14 step 2).
 * Deterministic, side-effect-free, and BYTE-PRESERVING on path+query:
 * identity-grade dedup NEVER rests on URL munging.
 */
export function canonicalizeMediaUrl(raw: string): UrlCanonicalOutcome {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'unsupported_url_scheme' };
  }
  if (raw.length > URL_BOUND) {
    return { ok: false, reason: 'url_over_bound' };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'unsupported_url_scheme' };
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'http:') return { ok: false, reason: 'non_https_media_url' };
  if (protocol !== 'https:') return { ok: false, reason: 'unsupported_url_scheme' };
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'url_credentials_forbidden' };
  }
  // The WHATWG parser punycode-encodes non-ASCII hosts of special schemes;
  // detect the non-ASCII host on the RAW text instead (no IDN interpretation).
  // A code-point scan (not a regex) — hosts are ASCII-only, period.
  const rawHost = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1] ?? '';
  const hasNonAsciiHost = Array.from(rawHost).some((ch) => ch.charCodeAt(0) > 0x7e);
  if (hasNonAsciiHost) return { ok: false, reason: 'unsupported_host_characters' };
  const host = parsed.hostname.toLowerCase();
  if (host === '') return { ok: false, reason: 'unsupported_url_scheme' };
  const port = parsed.port === '443' || parsed.port === '' ? '' : `:${parsed.port}`;
  const canonical = `https://${host}${port}${parsed.pathname}${parsed.search}`;
  if (canonical.length > URL_BOUND) return { ok: false, reason: 'url_over_bound' };
  return { ok: true, url: canonical };
}

/**
 * The strict typed candidate reader (fail-closed; a claimed v1 that does
 * not re-derive every invariant is malformed).
 */
export function readMediaCandidateV1(
  value: unknown,
): { ok: true; candidate: MediaCandidateV1 } | { ok: false; reason: CandidateReadReasonV1 } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'candidate_malformed' };
  }
  const record = value as Record<string, unknown>;
  // An ABSENT version means the payload is not even claiming to be a
  // candidate (malformed); a PRESENT wrong version is a version failure.
  if (record['schemaVersion'] === undefined || record['schemaVersion'] === null) {
    return { ok: false, reason: 'candidate_malformed' };
  }
  if (record['schemaVersion'] !== 1) {
    return { ok: false, reason: 'candidate_version_unsupported' };
  }
  const kind = record['kind'];
  const role = record['role'];
  const origin = record['origin'];
  const officiality = record['officiality'];
  const relevance = record['relevance'];
  const freshness = record['freshness'];
  const canonicalUrl = record['canonicalUrl'];
  const previouslyUsed = record['previouslyUsed'];
  if (!KINDS.includes(kind as MediaCandidateKindV1))
    return { ok: false, reason: 'candidate_malformed' };
  if (typeof canonicalUrl !== 'string' || canonicalUrl.length === 0)
    return { ok: false, reason: 'candidate_malformed' };
  if (kind === 'photo') {
    // 'video' is the OTHER kind's role (a mismatch); anything else outside
    // the photo vocabulary is plain malformed.
    if (role === 'video') return { ok: false, reason: 'candidate_role_kind_mismatch' };
    if (!PHOTO_ROLES.includes(role as MediaRoleV1))
      return { ok: false, reason: 'candidate_malformed' };
  } else {
    if (PHOTO_ROLES.includes(role as MediaRoleV1))
      return { ok: false, reason: 'candidate_role_kind_mismatch' };
    if (role !== 'video') return { ok: false, reason: 'candidate_malformed' };
  }
  if (!ORIGINS.includes(origin as MediaOriginV1))
    return { ok: false, reason: 'candidate_malformed' };
  if (!OFFICIALITY.includes(officiality as MediaOfficialityV1))
    return { ok: false, reason: 'candidate_malformed' };
  if (!RELEVANCE.includes(relevance as MediaRelevanceV1))
    return { ok: false, reason: 'candidate_malformed' };
  if (!FRESHNESS.includes(freshness as MediaFreshnessV1))
    return { ok: false, reason: 'candidate_malformed' };
  if (typeof previouslyUsed !== 'boolean') return { ok: false, reason: 'candidate_malformed' };
  const recanonical = canonicalizeMediaUrl(canonicalUrl);
  if (!recanonical.ok || recanonical.url !== canonicalUrl)
    return { ok: false, reason: 'candidate_url_not_canonical' };
  if (record['contentHash'] !== undefined && !isBoundedOpaqueKey(record['contentHash'])) {
    return { ok: false, reason: 'candidate_malformed' };
  }
  if (record['visualKey'] !== undefined && !isBoundedOpaqueKey(record['visualKey'])) {
    return { ok: false, reason: 'candidate_malformed' };
  }
  let declaredDimensions: { readonly width: number; readonly height: number } | undefined;
  if (record['declaredDimensions'] !== undefined) {
    const dims = record['declaredDimensions'] as Record<string, unknown> | null | undefined;
    if (typeof dims !== 'object' || dims === null)
      return { ok: false, reason: 'candidate_malformed' };
    if (!isBoundedDimension(dims['width']) || !isBoundedDimension(dims['height'])) {
      return { ok: false, reason: 'candidate_malformed' };
    }
    declaredDimensions = { width: dims['width'] as number, height: dims['height'] as number };
  }
  const allowedKeys = new Set([
    'schemaVersion',
    'kind',
    'role',
    'origin',
    'officiality',
    'relevance',
    'freshness',
    'canonicalUrl',
    'contentHash',
    'visualKey',
    'previouslyUsed',
    'declaredDimensions',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) return { ok: false, reason: 'candidate_malformed' };
  }
  const candidate: MediaCandidateV1 = {
    schemaVersion: 1,
    kind: kind as MediaCandidateKindV1,
    role: role as MediaRoleV1,
    origin: origin as MediaOriginV1,
    officiality: officiality as MediaOfficialityV1,
    relevance: relevance as MediaRelevanceV1,
    freshness: freshness as MediaFreshnessV1,
    canonicalUrl,
    previouslyUsed,
    ...(record['contentHash'] !== undefined
      ? { contentHash: record['contentHash'] as string }
      : {}),
    ...(record['visualKey'] !== undefined ? { visualKey: record['visualKey'] as string } : {}),
    ...(declaredDimensions !== undefined ? { declaredDimensions } : {}),
  };
  return { ok: true, candidate };
}

const OFFICIALITY_ORDER: Readonly<Record<MediaOfficialityV1, number>> = {
  official: 0,
  verified_source: 1,
  unofficial: 2,
};
const RELEVANCE_ORDER: Readonly<Record<MediaRelevanceV1, number>> = {
  primary: 0,
  supporting: 1,
};
const FRESHNESS_ORDER: Readonly<Record<MediaFreshnessV1, number>> = {
  current_cycle: 0,
  recent: 1,
  aged: 2,
};

/**
 * The TOTAL deterministic precedence comparator: officiality > relevance
 * > freshness > unused-before-used > canonicalUrl lexicographic. Outputs
 * are only -1 | 0 | 1 — never a numeric score.
 */
export function compareMediaCandidates(a: MediaCandidateV1, b: MediaCandidateV1): -1 | 0 | 1 {
  const officiality = OFFICIALITY_ORDER[a.officiality] - OFFICIALITY_ORDER[b.officiality];
  if (officiality !== 0) return officiality < 0 ? -1 : 1;
  const relevance = RELEVANCE_ORDER[a.relevance] - RELEVANCE_ORDER[b.relevance];
  if (relevance !== 0) return relevance < 0 ? -1 : 1;
  const freshness = FRESHNESS_ORDER[a.freshness] - FRESHNESS_ORDER[b.freshness];
  if (freshness !== 0) return freshness < 0 ? -1 : 1;
  const used = (a.previouslyUsed ? 1 : 0) - (b.previouslyUsed ? 1 : 0);
  if (used !== 0) return used < 0 ? -1 : 1;
  if (a.canonicalUrl === b.canonicalUrl) return 0;
  return a.canonicalUrl < b.canonicalUrl ? -1 : 1;
}
