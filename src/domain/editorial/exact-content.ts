/**
 * Exact-content identity and reuse selection (Phase 5C-3 — R1.15; correctness
 * corrections R1.15.1): the deterministic, VERSIONED identity of one FULL
 * composed evidence text, the pure verification of an immutable reuse basis,
 * and the pure selection rule for a verified reuse target.
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
 *
 * R1.15.1 (Posidon counterexamples P1+P2) — THE IMMUTABLE COMPARISON BASIS:
 * the byte-exact equality decision is made against the DRAFT RESULT'S OWN
 * immutable record, never against a mutable `source_items` row alone
 * (drafts have NO update path — they are written once by the fenced commit
 * and never rewritten):
 * - `readReuseDocumentBasis(documentJson)` — the defensive, typed read of
 *   the basis a pipeline-committed draft carries inside `document_json`:
 *   `sourceReport.{sourceItemId, excerptText, truncated}` plus the
 *   Evidence Guard's recorded ORIGINAL snapshot identity
 *   (`evidenceGuard.snapshot.{sourceItemId, contentHash}`). A document
 *   without a coherent basis (foreign/corrupt/seeded shapes) reads as
 *   `null` — never guessed, never backfilled.
 * - `verifyExactContentReuseCandidate({basis, referenceRow, fullText})` —
 *   the pure decision for ONE candidate story:
 *     1. the document basis must exist and self-agree (the guard's recorded
 *        source item, when present, must be the sourceReport's own);
 *     2. the story's ORIGINAL reference row (the snapshot the draft was
 *        built from) must still exist as read;
 *     3. when `truncated === false`, `sourceReport.excerptText` IS the full
 *        composed text of that snapshot (immutable) — the arriving text is
 *        byte-compared against IT;
 *     4. when `truncated === true`, the full text exists only through the
 *        IDENTITY BRIDGE: the reference row's `content_hash` must EQUAL the
 *        guard's recorded ORIGINAL snapshot hash (the row is still the
 *        snapshot the draft was built from), and the arriving text is
 *        byte-compared against the bridged row's composed text. A mutated
 *        reference therefore fails the bridge BEFORE any commit — the P2
 *        pre-verification mutation can never attribute the new reference
 *        text to the old draft;
 *     5. on success the decision carries the FENCE identity —
 *        (referenceItemId, referenceContentHash AS READ) — which the reuse
 *        commit re-evaluates INSIDE the atomic batch together with the
 *        exact compared `document_json` bytes (`rd.document_json = ?`):
 *        the reference/version that was really compared must remain valid
 *        until commit, enforced in SQL on ALL reuse artifacts, never by a
 *        JS re-read.
 * - `selectExactContentReuseTarget` — the pure, deterministic choice of
 *   the reuse target among verification-ordered candidates: the FIRST
 *   candidate that BOTH (a) still owns a usable ready draft at the
 *   pipeline's draft version AND (b) REALLY equals the current full
 *   composed text through the immutable basis above. The fingerprint is
 *   only the LOCATOR; the DECISION is the byte-exact comparison through
 *   the immutable record — a stale, corrupt, or foreign fingerprint can
 *   never cause a wrong reuse. The probe's overflow flag does not change
 *   the selection; it is returned for honest reporting (coverage is
 *   bounded by the probe page).
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
import { buildFullEvidenceText } from './mapper';

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

/**
 * The immutable reuse basis a pipeline-committed draft carries inside its
 * `document_json` (R1.15.1) — the ONLY honest equality basis for a reuse
 * decision (a mutable `source_items` row alone can never prove what an OLD
 * draft was built from).
 */
export interface ReuseDocumentBasis {
  /** The draft's ORIGINAL source item (the snapshot the draft was built from). */
  readonly sourceItemId: string;
  /** The stored traceable excerpt of that snapshot — the FULL composed text
   * exactly when `truncated === false` (see `buildTraceableExcerpt`). */
  readonly excerptText: string;
  /** `false` ⇒ `excerptText` is the complete immutable full-text basis. */
  readonly truncated: boolean;
  /** The Evidence Guard's recorded ORIGINAL snapshot identity, when the
   * draft carries a guard report — the identity bridge for truncated
   * excerpts. `null` when absent (pre-R1.12-shaped documents). */
  readonly guardSnapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  } | null;
}

/**
 * Defensive, typed read of the reuse basis from one draft's `document_json`
 * (R1.15.1; R1.15.2 hardening). ANY shape mismatch (unparseable JSON,
 * missing/incoherent sourceReport, a malformed PRESENT guard/snapshot —
 * null, primitive, or array where an object is required — or a guard whose
 * recorded source item differs from the sourceReport's own) reads as `null`
 * — a corrupt or foreign document is NEVER a basis, malformed PRESENT data
 * is NEVER silently reinterpreted as the legitimate absent-legacy shape,
 * and nothing is ever guessed or backfilled. The read never throws.
 */
export function readReuseDocumentBasis(documentJson: string): ReuseDocumentBasis | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const document = parsed as {
    readonly sourceReport?: unknown;
    readonly evidenceGuard?: unknown;
  };
  // R1.15.2 (Posidon defensive-reader regression Q2): EVERY level is guarded
  // as an UNKNOWN value BEFORE any member access — a `null`/primitive/array
  // at the document, sourceReport, evidenceGuard, or snapshot level can
  // never throw a TypeError. The parse is TOTAL: it returns the documented
  // unusable-basis result (`null`) or a coherent basis, nothing else.
  const sourceReport: unknown = document.sourceReport;
  if (typeof sourceReport !== 'object' || sourceReport === null || Array.isArray(sourceReport)) {
    return null;
  }
  const report = sourceReport as {
    readonly sourceItemId?: unknown;
    readonly excerptText?: unknown;
    readonly truncated?: unknown;
  };
  if (
    typeof report.sourceItemId !== 'string' ||
    report.sourceItemId.length === 0 ||
    typeof report.excerptText !== 'string' ||
    typeof report.truncated !== 'boolean'
  ) {
    return null;
  }
  const guard: unknown = document.evidenceGuard;
  let guardSnapshot: ReuseDocumentBasis['guardSnapshot'] = null;
  if (guard !== undefined) {
    // R1.15.2: PRESENT guard data must be a coherent object. A malformed
    // PRESENT shape (null / primitive / array) is NEVER silently
    // reinterpreted as the documented absent-legacy shape (pre-R1.12
    // documents carry NO guard at all — an absent KEY stays legitimate).
    if (guard === null || typeof guard !== 'object' || Array.isArray(guard)) {
      return null;
    }
    const guardRecord = guard as { readonly snapshot?: unknown };
    const guardSnapshotRaw: unknown = guardRecord.snapshot;
    if (guardSnapshotRaw !== undefined) {
      // R1.15.2: PRESENT snapshot data must be a coherent object with the
      // recorded identity fields — malformed present data (including
      // `null` and empty strings) is a corrupt shape, never "absent".
      if (
        typeof guardSnapshotRaw !== 'object' ||
        guardSnapshotRaw === null ||
        Array.isArray(guardSnapshotRaw)
      ) {
        return null;
      }
      const snapshotRecord = guardSnapshotRaw as {
        readonly sourceItemId?: unknown;
        readonly contentHash?: unknown;
      };
      if (
        typeof snapshotRecord.sourceItemId !== 'string' ||
        snapshotRecord.sourceItemId.length === 0 ||
        typeof snapshotRecord.contentHash !== 'string' ||
        snapshotRecord.contentHash.length === 0
      ) {
        return null;
      }
      // The document must self-agree: a guard naming a DIFFERENT source item
      // than the sourceReport is a corrupt shape — never a basis.
      if (snapshotRecord.sourceItemId !== report.sourceItemId) {
        return null;
      }
      guardSnapshot = {
        sourceItemId: snapshotRecord.sourceItemId,
        contentHash: snapshotRecord.contentHash,
      };
    }
  }
  return {
    sourceItemId: report.sourceItemId,
    excerptText: report.excerptText,
    truncated: report.truncated,
    guardSnapshot,
  };
}

/** The pure verification outcome for ONE candidate story (R1.15.1). */
export interface ReuseBasisDecision {
  /** The arriving full text REALLY equals the draft's immutable basis. */
  readonly verified: boolean;
  /** The SQL fence identity the reuse commit must re-evaluate INSIDE the
   * atomic batch (the reference/version that was really compared) — present
   * exactly when `verified === true`. */
  readonly fence:
    | {
        readonly referenceItemId: string;
        readonly referenceContentHash: string;
      }
    | undefined;
}

/** The read shape the verification needs from the candidate's ORIGINAL
 * reference row (as read NOW — the commit re-fences this identity in SQL). */
export interface ReuseReferenceRowRead {
  readonly id: string;
  readonly content_hash: string;
  readonly title: string;
  readonly body_excerpt: string | null;
}

/**
 * The pure reuse verification for ONE candidate story (R1.15.1): the
 * arriving full text must equal the draft's IMMUTABLE basis — the document's
 * own excerpt text when untruncated, else the text of the reference row
 * bridged by the guard's recorded ORIGINAL snapshot hash. The decision
 * carries the fence identity (the reference row AS READ) for the commit's
 * SQL predicate. No normalization, no guessing: any missing piece (no
 * basis, no row, a broken bridge) is `verified: false`.
 */
export function verifyExactContentReuseCandidate(input: {
  readonly basis: ReuseDocumentBasis | null;
  readonly referenceRow: ReuseReferenceRowRead | null;
  readonly fullText: string;
}): ReuseBasisDecision {
  const { basis, referenceRow, fullText } = input;
  if (
    basis === null ||
    referenceRow === null ||
    referenceRow.id !== basis.sourceItemId ||
    referenceRow.content_hash.length === 0
  ) {
    return { verified: false, fence: undefined };
  }
  if (basis.truncated) {
    // The full text is NOT in the document: the IDENTITY BRIDGE must hold —
    // the reference row must still BE the snapshot the draft was built from.
    if (
      basis.guardSnapshot === null ||
      basis.guardSnapshot.contentHash !== referenceRow.content_hash
    ) {
      return { verified: false, fence: undefined };
    }
    const bridgedText = buildFullEvidenceText({
      title: referenceRow.title,
      body_excerpt: referenceRow.body_excerpt,
    });
    return composedFullTextEquals(bridgedText, fullText)
      ? {
          verified: true,
          fence: {
            referenceItemId: referenceRow.id,
            referenceContentHash: referenceRow.content_hash,
          },
        }
      : { verified: false, fence: undefined };
  }
  // `truncated === false`: the document's excerpt text IS the full composed
  // text of the snapshot the draft was built from — fully immutable.
  return composedFullTextEquals(basis.excerptText, fullText)
    ? {
        verified: true,
        fence: {
          referenceItemId: referenceRow.id,
          referenceContentHash: referenceRow.content_hash,
        },
      }
    : { verified: false, fence: undefined };
}

/** One probe candidate's verification result (pure data, handler-derived). */
export interface ReuseCandidateVerification {
  /** The candidate story id (probe order: ascending indexed value). */
  readonly storyId: string;
  /** The story still owns a usable ready draft at the pipeline's version. */
  readonly hasUsableDraft: boolean;
  /** The arriving full text REALLY equals the story's draft immutable basis
   * (byte-exact, R1.15.1 — no normalization). */
  readonly contentVerified: boolean;
  /** R1.15.1: the fence identity of the verified comparison — present only
   * when `contentVerified === true`; carried into the commit's SQL
   * predicate (`document_json = ?` + the reference-row identity). */
  readonly fence?: {
    readonly referenceItemId: string;
    readonly referenceContentHash: string;
  };
}

/**
 * The deterministic reuse-target selection: the FIRST verification-ordered
 * candidate that is BOTH usable AND really content-equal. Candidates are
 * checked in the given order (the handler passes the anchor owner FIRST —
 * the designated group owner — then the probe's ascending indexed order);
 * the selection never depends on list position ALONE — both verification
 * conditions must hold. The verified candidate's fence identity rides with
 * the selection into the commit.
 */
export function selectExactContentReuseTarget(
  verifications: readonly ReuseCandidateVerification[],
): { readonly storyId: string; readonly fence: ReuseCandidateVerification['fence'] } | null {
  for (const verification of verifications) {
    if (verification.hasUsableDraft && verification.contentVerified) {
      return { storyId: verification.storyId, fence: verification.fence };
    }
  }
  return null;
}

/**
 * Bound on the reference items read for ONE candidate story's real-content
 * verification (the story's attached source items via its source_report
 * claims' evidence). Stories in this pipeline carry ONE original item plus
 * byte-equal reuse attachments, so the bound is defensive only. (R1.15.1:
 * the reuse DECISION no longer scans references — it verifies the draft's
 * immutable document basis through the ONE original reference row; this
 * bound remains the store read contract for `findStoryReferenceItems`.)
 */
export const REUSE_REFERENCE_ITEM_LIMIT = 8;
