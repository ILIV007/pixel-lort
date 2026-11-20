/**
 * Near-duplicate detection (slice 6 — DESIGN §10.1: the same story
 * arriving from several sources with similar title/entities is adjudicated
 * as ONE story — an update, never a second post).
 *
 * PURE, DETERMINISTIC, OFFLINE: no SQL, no network, no model call, no
 * clock. The similarity is a transparent combination of two bounded
 * signals:
 *
 *  - TITLE JACCARD: the Jaccard index of the normalized title token sets.
 *    Normalization is the ONE limited, explicit rule set: NFC + whitespace
 *    collapse (the evidence-guard normalizer), Persian/Arabic letter
 *    folding (Arabic ي → Persian ی, Arabic ك → Persian ک), Persian/Arabic
 *    digit folding to Latin digits, lowercasing, and tokenization on
 *    non-letters/non-digits. Numbers are NEVER equated across values: a
 *    token is a token — "2" and "3" are different tokens, so two stories
 *    that differ only in a number score lower, never identical.
 *  - ENTITY OVERLAP: the Jaccard index of the two entity-id sets (the
 *    resolved entity mentions of the incoming item vs the canonical
 *    story's linked entities). When EITHER side has no entities, the
 *    entity component is 0 — no entity evidence, no entity credit.
 *
 * COMBINED SCORE: 0.7 * title + 0.3 * entity when both sides carry
 * entities; the title score alone when either side is entity-empty (the
 * entity component cannot invent evidence).
 *
 * THRESHOLDS (versioned policy `nd1` — a threshold change is a documented
 * contract change, never a silent rewrite):
 *  - score >= 0.80 (AND title >= 0.60) → `merged_as_update`: the same
 *    story — the incoming item updates the canonical story, never posts
 *    a second time. The title floor keeps a high entity overlap from
 *    merging two different stories about the same game.
 *  - 0.60 <= score < 0.80 → `needs_review`: possibly the same story —
 *    HELD for AI/human adjudication (the existing candidate-adjudication
 *    report + the admin review surface), never posted meanwhile.
 *  - score < 0.60 → `distinct`: its own story, its own path.
 *
 * WHAT THIS NEVER DOES: it never proves "same event" or "truth" — the
 * ledger records the score, the method (`deterministic`) and the
 * disposition, and the merge is the DURABLE story-ledger decision the
 * pipeline acts on. An AI adjudication that later disagrees records its
 * own row (method `ai`) and supersedes the deterministic one in the
 * review surface; the deterministic row is never rewritten.
 */

import { normalizeForDirectTextMatch } from './evidence-guard';

/** The near-dup policy version — bump ONLY with a documented change. */
export const NEAR_DUP_POLICY_VERSION = 'nd1' as const;

/** Merge threshold: at or above this, the item is the same story. */
export const NEAR_DUP_MERGE_THRESHOLD = 0.8;
/** Review threshold: at or above this (below merge), the item is held. */
export const NEAR_DUP_REVIEW_THRESHOLD = 0.6;
/** The title floor of a merge: entity overlap alone never merges. */
export const NEAR_DUP_MERGE_TITLE_FLOOR = 0.6;

/** Title weight in the combined score (entities carry the rest). */
export const NEAR_DUP_TITLE_WEIGHT = 0.7;
/** Entity weight in the combined score. */
export const NEAR_DUP_ENTITY_WEIGHT = 0.3;

/** The negative-cache TTL for a quality-gate rejection (DESIGN §9.4). */
export const NEGATIVE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The near-dup lookback window: only stories this fresh are compared. */
export const NEAR_DUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum recent stories compared per incoming item (bounded work). */
export const NEAR_DUP_CANDIDATE_LIMIT = 20;

export type NearDupDisposition = 'merged_as_update' | 'needs_review' | 'distinct';

export interface NearDupScore {
  /** The combined score (0..1). */
  readonly combined: number;
  /** The title-token Jaccard (0..1). */
  readonly title: number;
  /** The entity-set Jaccard (0..1; 0 when either side is entity-empty). */
  readonly entity: number;
}

/**
 * Normalize one title into its token set. NFC + whitespace collapse ride
 * the evidence-guard normalizer; the ي/ك letter folding and the digit
 * folding are the explicit additions of THIS module (documented above).
 * Tokenization splits on anything that is not a letter or a digit
 * (Unicode-aware). Empty titles yield the empty set (never a crash,
 * never a match).
 */
export function nearDupTitleTokens(title: string): ReadonlySet<string> {
  const normalized = normalizeForDirectTextMatch(title);
  if (normalized.length === 0) {
    return new Set<string>();
  }
  const folded = normalized
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .toLowerCase();
  const tokens = new Set<string>();
  for (const token of folded.split(/[^\p{L}\p{N}]+/u)) {
    if (token.length > 0) {
      tokens.add(token);
    }
  }
  return tokens;
}

/** The Jaccard index of two sets (0 when both are empty — no evidence). */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * The combined near-dup score of an incoming item against one canonical
 * story. TOTAL and DETERMINISTIC: same inputs → byte-identical score.
 */
export function scoreNearDup(input: {
  readonly incomingTitle: string;
  readonly incomingEntityIds: readonly string[];
  readonly candidateTitle: string;
  readonly candidateEntityIds: readonly string[];
}): NearDupScore {
  const title = jaccardSimilarity(
    nearDupTitleTokens(input.incomingTitle),
    nearDupTitleTokens(input.candidateTitle),
  );
  const incomingEntities = new Set(input.incomingEntityIds);
  const candidateEntities = new Set(input.candidateEntityIds);
  const entity =
    incomingEntities.size === 0 || candidateEntities.size === 0
      ? 0
      : jaccardSimilarity(incomingEntities, candidateEntities);
  const combined =
    incomingEntities.size === 0 || candidateEntities.size === 0
      ? title
      : NEAR_DUP_TITLE_WEIGHT * title + NEAR_DUP_ENTITY_WEIGHT * entity;
  return { combined, title, entity };
}

/**
 * The deterministic disposition of one score under policy `nd1`.
 * Precedence (documented, tested): merge needs BOTH the combined
 * threshold AND the title floor; the review band holds; anything below
 * is distinct.
 */
export function classifyNearDupScore(score: NearDupScore): NearDupDisposition {
  if (score.combined >= NEAR_DUP_MERGE_THRESHOLD && score.title >= NEAR_DUP_MERGE_TITLE_FLOOR) {
    return 'merged_as_update';
  }
  if (score.combined >= NEAR_DUP_REVIEW_THRESHOLD) {
    return 'needs_review';
  }
  return 'distinct';
}
