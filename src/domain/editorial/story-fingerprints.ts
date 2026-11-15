/**
 * Durable story fingerprints (Phase 5C-1 — R1.13): PURE, DETERMINISTIC,
 * VERSIONED signal digests for LIMITED candidate discovery. NO SQL, NO
 * network, NO SDK, NO model call, NO clock — the same offline purity as the
 * Phase 5A mapper and the Evidence Guard (ADR-0042 §2), so every digest is
 * reproducible from its inputs alone.
 *
 * WHAT THIS IS (and nothing more):
 * - AT MOST THREE signals derived from the STORED source item:
 *     1. `url`          — the stored `canonical_url` VERBATIM, when
 *                         non-empty. The URL is NEVER fetched, resolved,
 *                         case-folded, or stripped of parameters/path by
 *                         guesswork: the stored URL identity IS the basis.
 *     2. `content_hash` — a digest of the FULL defined title+body text,
 *                         computed with the SAME composition as
 *                         `buildFullEvidenceText` — deliberately
 *                         INDEPENDENT of sourceItemId/sourceId, so two
 *                         sources can be compared on text alone. (The
 *                         source_items.content_hash COLUMN is snapshot
 *                         identity and is NOT reused here: its generation
 *                         contract is not a cross-source text contract.)
 *     3. `title_key`    — a digest of the non-empty title under the ONE
 *                         limited, explicit normalization (NFC + Unicode
 *                         whitespace collapse + trim — the SAME function
 *                         the Evidence Guard uses). The title is a WEAK
 *                         signal only.
 *
 * WHAT THIS NEVER DOES (Posidon R1.13 honesty boundary):
 * - Equal URL / equal text / equal title alone NEVER proves "same event"
 *   or "independent sources" — candidates are DISCOVERY ONLY.
 * - Numbers, negations, units, and Persian–Latin digits are NEVER equated:
 *   two different statements never become the same fingerprint.
 * - No truncation, no URL caps, no input rewriting, no ingestion changes.
 *
 * INDEX CONTRACT (multi-owner, NO new DDL — migrations 0001 stay schema 3):
 * - `story_fingerprints` rows written by THIS round use
 *     kind  ∈ {'url','content_hash','title_key'}
 *     value = `sc1:<64-hex digest>:<storyId>`
 *   The story-scoped value means MANY stories can share one digest while
 *   every (story, signal) pair stays a single row. The PRIMARY KEY
 *   (kind, value) therefore does NOT mean "one news per title", and no
 *   write ever replaces another owner: inserts are plain
 *   INSERT..SELECT with a NOT EXISTS guard on the story's OWN row, never
 *   INSERT OR REPLACE, never a silent collision override.
 * - Lookups use the EXACT namespace+digest prefix as parameterized range
 *   bounds on the PK index — never wildcards, never a full scan.
 * - Historical rows without the `sc1:` namespace are NOT reinterpreted.
 */

import { sha256Hex } from '../../shared/ids/idempotency-key';
import { normalizeForDirectTextMatch } from './evidence-guard';

/** Index namespace version — bump ONLY with a documented contract change. */
export const STORY_FINGERPRINT_INDEX_VERSION = 'sc1' as const;

/** The only kinds THIS round writes or looks up (0001 CHECK allows them). */
export const STORY_FINGERPRINT_KINDS = ['url', 'content_hash', 'title_key'] as const;
export type StoryFingerprintKind = (typeof STORY_FINGERPRINT_KINDS)[number];

/** Signal priority = display order ONLY — never confidence or likelihood. */
export const STORY_FINGERPRINT_SIGNAL_PRIORITY: readonly StoryFingerprintKind[] = [
  'url',
  'content_hash',
  'title_key',
];

/** Stable per-kind reason codes (additive-only; never remapped). */
export const STORY_FINGERPRINT_REASON_CODES: Readonly<Record<StoryFingerprintKind, string>> = {
  url: 'url_fingerprint_match',
  content_hash: 'content_hash_fingerprint_match',
  title_key: 'title_key_fingerprint_match',
};

/** Full SHA-256 hex — fixed-length digests; raw text/URL never indexed. */
export const FINGERPRINT_DIGEST_HEX_LENGTH = 64;

/** Per-lookup row probe: 8 candidates + 1 row to DETECT overflow honestly. */
export const FINGERPRINT_LOOKUP_ROW_LIMIT = 9;

/** Maximum unique candidates in one report (explicit, tested cap). */
export const STORY_CANDIDATES_MAX = 8;

/**
 * Collision-safe canonical framing: EVERY part is length-prefixed, so no
 * delimiter sequence inside a payload can ever re-frame the tuple. Two
 * different (version, kind, payload) triples therefore always produce
 * different canonical inputs — proven by unit tests, including payloads
 * full of delimiter-like characters.
 */
function canonicalFingerprintInput(kind: StoryFingerprintKind, payload: string): string {
  const frame = (part: string): string => `${part.length.toString(16)}:${part}`;
  return [STORY_FINGERPRINT_INDEX_VERSION, kind, payload].map(frame).join('');
}

/** The stored-input signals one item contributes (pure data, no ids). */
export interface StoryFingerprintSignals {
  /** The stored canonical_url VERBATIM (null/empty → no url signal). */
  readonly canonicalUrl: string | null;
  /** The FULL defined title+body text (same composition the AI input cap
   * checks) — the content_hash signal payload. */
  readonly fullEvidenceText: string;
  /** The stored title (normalized under the ONE limited rule). */
  readonly title: string;
}

/** One planned index row: a fixed-length digest behind the sc1 namespace. */
export interface StoryFingerprintRowPlan {
  readonly kind: StoryFingerprintKind;
  /** `sc1:<64-hex digest>:<storyId>` — story-scoped, multi-owner safe. */
  readonly value: string;
  readonly digest: string;
}

/** The deterministic digest for one signal payload (pure, async sha-256). */
export async function storyFingerprintDigest(
  kind: StoryFingerprintKind,
  payload: string,
): Promise<string> {
  return sha256Hex(canonicalFingerprintInput(kind, payload));
}

/**
 * Build the value actually stored in `story_fingerprints`:
 * `sc1:<digest>:<storyId>`. The storyId suffix makes the row OWNED by one
 * story; another story with the same digest writes its OWN row and no
 * write of this round can ever replace it.
 */
export async function storyFingerprintValue(
  kind: StoryFingerprintKind,
  payload: string,
  storyId: string,
): Promise<string> {
  const digest = await storyFingerprintDigest(kind, payload);
  return `${STORY_FINGERPRINT_INDEX_VERSION}:${digest}:${storyId}`;
}

/**
 * The ≤3 fingerprint rows one stored item contributes, in deterministic
 * signal-priority order. Signals with nothing to say are simply absent:
 * an empty/absent URL contributes nothing, an empty full text (impossible
 * on the real path but possible for the PURE function) contributes no
 * content_hash, and a title that normalizes to nothing contributes no
 * title_key.
 */
export async function buildStoryFingerprints(
  input: StoryFingerprintSignals & { readonly storyId: string },
): Promise<readonly StoryFingerprintRowPlan[]> {
  const plans: StoryFingerprintRowPlan[] = [];
  const url = input.canonicalUrl ?? '';
  if (url.length > 0) {
    const digest = await storyFingerprintDigest('url', url);
    plans.push({
      kind: 'url',
      digest,
      value: `${STORY_FINGERPRINT_INDEX_VERSION}:${digest}:${input.storyId}`,
    });
  }
  if (input.fullEvidenceText.length > 0) {
    const digest = await storyFingerprintDigest('content_hash', input.fullEvidenceText);
    plans.push({
      kind: 'content_hash',
      digest,
      value: `${STORY_FINGERPRINT_INDEX_VERSION}:${digest}:${input.storyId}`,
    });
  }
  const normalizedTitle = normalizeForDirectTextMatch(input.title);
  if (normalizedTitle.length > 0) {
    const digest = await storyFingerprintDigest('title_key', normalizedTitle);
    plans.push({
      kind: 'title_key',
      digest,
      value: `${STORY_FINGERPRINT_INDEX_VERSION}:${digest}:${input.storyId}`,
    });
  }
  return plans;
}

/** One parameterized, indexable prefix lookup (no wildcards, no raw text). */
export interface FingerprintLookupPlan {
  readonly kind: StoryFingerprintKind;
  /** `sc1:<digest>:` — the inclusive lower bound of the story-suffixed rows. */
  readonly lowerBound: string;
  /** Exclusive upper bound covering every storyId suffix of this digest. */
  readonly upperBound: string;
}

/**
 * Plan the ≤3 lookups for one item's fingerprints, in signal-priority
 * order. The bounds are EXACT prefix ranges over the (kind, value) primary
 * key — parameterized, indexable, and free of any raw text or wildcard.
 */
export async function planFingerprintLookups(
  input: StoryFingerprintSignals,
): Promise<readonly FingerprintLookupPlan[]> {
  const plans: FingerprintLookupPlan[] = [];
  const url = input.canonicalUrl ?? '';
  if (url.length > 0) {
    const digest = await storyFingerprintDigest('url', url);
    plans.push(prefixPlan('url', digest));
  }
  if (input.fullEvidenceText.length > 0) {
    const digest = await storyFingerprintDigest('content_hash', input.fullEvidenceText);
    plans.push(prefixPlan('content_hash', digest));
  }
  const normalizedTitle = normalizeForDirectTextMatch(input.title);
  if (normalizedTitle.length > 0) {
    const digest = await storyFingerprintDigest('title_key', normalizedTitle);
    plans.push(prefixPlan('title_key', digest));
  }
  return plans;
}

function prefixPlan(kind: StoryFingerprintKind, digest: string): FingerprintLookupPlan {
  const lowerBound = `${STORY_FINGERPRINT_INDEX_VERSION}:${digest}:`;
  // U+10FFFF sorts above every character a storyId can contain, so the
  // half-open range [lowerBound, upperBound) covers ALL story-scoped rows
  // of this digest and NOTHING beyond the namespace prefix.
  return { kind, lowerBound, upperBound: `${lowerBound}\u{10ffff}` };
}
