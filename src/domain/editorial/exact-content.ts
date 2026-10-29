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
 * (R1.15.1). ANY shape mismatch (unparseable JSON, missing/incoherent
 * sourceReport, a guard whose recorded source item differs from the
 * sourceReport's own) reads as `null` — a corrupt or foreign document is
 * NEVER a basis, and nothing is ever guessed or backfilled.
 */
export function readReuseDocumentBasis(documentJson: string): ReuseDocumentBasis | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const document = parsed as {
    readonly sourceReport?: {
      readonly sourceItemId?: unknown;
      readonly excerptText?: unknown;
      readonly truncated?: unknown;
    };
    readonly evidenceGuard?: {
      readonly snapshot?: {
        readonly sourceItemId?: unknown;
        readonly contentHash?: unknown;
      };
    };
  };
  const sourceReport = document.sourceReport;
  if (
    sourceReport === undefined ||
    typeof sourceReport.sourceItemId !== 'string' ||
    sourceReport.sourceItemId.length === 0 ||
    typeof sourceReport.excerptText !== 'string' ||
    typeof sourceReport.truncated !== 'boolean'
  ) {
    return null;
  }
  const guard = document.evidenceGuard;
  const guardSnapshotRaw = guard?.snapshot;
  let guardSnapshot: ReuseDocumentBasis['guardSnapshot'] = null;
  if (
    guardSnapshotRaw !== undefined &&
    typeof guardSnapshotRaw.sourceItemId === 'string' &&
    guardSnapshotRaw.sourceItemId.length > 0 &&
    typeof guardSnapshotRaw.contentHash === 'string' &&
    guardSnapshotRaw.contentHash.length > 0
  ) {
    // The document must self-agree: a guard naming a DIFFERENT source item
    // than the sourceReport is a corrupt shape — never a basis.
    if (guardSnapshotRaw.sourceItemId !== sourceReport.sourceItemId) {
      return null;
    }
    guardSnapshot = {
      sourceItemId: guardSnapshotRaw.sourceItemId,
      contentHash: guardSnapshotRaw.contentHash,
    };
  }
  return {
    sourceItemId: sourceReport.sourceItemId,
    excerptText: sourceReport.excerptText,
    truncated: sourceReport.truncated,
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
