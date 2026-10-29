/**
 * Exact-content identity and reuse selection (Phase 5C-3 — R1.15): the
 * deterministic, VERSIONED identity of one FULL composed evidence text and
 * the pure selection rule for a verified reuse target.
 *
 * WHAT THIS IS:
 * - `exactContentDigest(fullEvidenceText)` — the SAME versioned `sc1`
 *   content digest the story fingerprints index (delegated, never
 *   re-implemented): a digest of the FULL title+body composition from
 *   `buildFullEvidenceText`, deliberately INDEPENDENT of
 *   sourceItemId/sourceId/URL, so two different sources can be compared on
 *   the stored text alone.
 * - `exactContentAnchorValue(digest)` — the group-unique index value
 *   `sc1:<digest>` (NO story suffix) written ONCE per content group by the
 *   fenced commit. The `story_fingerprints(kind,value)` PRIMARY KEY makes
 *   the anchor group-unique across ALL stories: a second story committing
 *   the same full content collides on the PK and the WHOLE atomic batch
 *   rolls back — the durable, SQL-level uniqueness of one stable result
 *   per exact content. Story-scoped rows (`sc1:<digest>:<storyId>`) are
 *   UNCHANGED and remain multi-owner; the anchor is an ADDITIONAL row with
 *   a distinct value shape in the SAME namespace and kind.
 * - `composedFullTextEquals(a, b)` — EXACT string equality of the two
 *   composed texts. NO normalization of any kind: numbers, negations,
 *   units, punctuation, Persian/Latin digits and the stored text itself
 *   are never equated. (The composition itself performs only the ONE
 *   pre-existing edge trim defined by `buildFullEvidenceText` — a stored
 *   field contract that predates this round; everything between the edges
 *   is byte-exact.)
 * - `selectExactContentReuseTarget` — the pure, deterministic choice of
 *   the reuse target among probe-ordered candidates: the FIRST candidate
 *   that BOTH (a) still owns a usable ready draft at the pipeline's draft
 *   version AND (b) REALLY equals the current full composed text through
 *   at least one of its attached reference items. The fingerprint is only
 *   the LOCATOR; the DECISION is the byte-exact comparison — a stale,
 *   corrupt, or foreign fingerprint can never cause a wrong reuse. The
 *   probe's overflow flag does not change the selection; it is returned
 *   for honest reporting (coverage is bounded by the probe page).
 *
 * WHAT THIS NEVER DOES:
 * - It is NOT a same-event proof, NOT truth verification, NOT source
 *   independence. Exact-content sharing authorizes REUSING ONE STORED
 *   DRAFT RESULT — it is NOT a semantic story merge: the story keeps its
 *   own snapshot identity and is never rewritten; the reusing item keeps
 *   its OWN provenance (its own source_report claim + mentions evidence).
 * - No fuzzy matching, no translation, no embedding, no model, no clock.
 */

import { storyFingerprintDigest, STORY_FINGERPRINT_INDEX_VERSION } from './story-fingerprints';

/**
 * The versioned exact-content digest of one FULL composed evidence text —
 * the SAME digest the `content_hash` fingerprint signal indexes (delegation
 * guarantees the anchor, the index rows and the probe can never drift).
 */
export function exactContentDigest(fullEvidenceText: string): Promise<string> {
  return storyFingerprintDigest('content_hash', fullEvidenceText);
}

/**
 * The group-unique anchor value `sc1:<digest>` (no story suffix). The
 * `(kind, value)` PRIMARY KEY of `story_fingerprints` enforces AT MOST ONE
 * anchor per exact content across all stories — the SQL-level uniqueness
 * of the stable result for one content group.
 */
export function exactContentAnchorValue(digest: string): string {
  return `${STORY_FINGERPRINT_INDEX_VERSION}:${digest}`;
}

/**
 * EXACT equality of two composed full texts: no normalization, no case
 * folding, no digit conversion, no truncation — the stored text is the
 * contract.
 */
export function composedFullTextEquals(a: string, b: string): boolean {
  return a === b;
}

/** One probe candidate's verification result (pure data, handler-derived). */
export interface ReuseCandidateVerification {
  /** The candidate story id (probe order: ascending indexed value). */
  readonly storyId: string;
  /** The story still owns a usable ready draft at the pipeline's version. */
  readonly hasUsableDraft: boolean;
  /** At least one attached reference item's composed text REALLY equals
   * the current full text (byte-exact, no normalization). */
  readonly contentVerified: boolean;
}

/**
 * The deterministic reuse-target selection: the FIRST probe-ordered
 * candidate that is BOTH usable AND really content-equal. Candidates are
 * checked in the given order (the handler passes the probe's ascending
 * indexed order); the selection never depends on list position ALONE —
 * both verification conditions must hold. `probeOverflow` is carried for
 * honest reporting only (it never changes the choice).
 */
export function selectExactContentReuseTarget(
  verifications: readonly ReuseCandidateVerification[],
): { readonly storyId: string } | null {
  for (const verification of verifications) {
    if (verification.hasUsableDraft && verification.contentVerified) {
      return { storyId: verification.storyId };
    }
  }
  return null;
}

/**
 * Bound on the reference items read for ONE candidate story's real-content
 * verification (the story's attached source items via its source_report
 * claims' evidence). Stories in this pipeline carry ONE original item plus
 * byte-equal reuse attachments, so the bound is defensive only.
 */
export const REUSE_REFERENCE_ITEM_LIMIT = 8;
