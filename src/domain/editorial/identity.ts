/**
 * Deterministic editorial identity primitives (Phase 5A — ADR-0042 §2).
 *
 * Every identifier and idempotency key in the source→draft path is
 * DERIVED from stable business inputs (source item id + snapshot hash +
 * the versioned schema label) and never from randomness or wall-clock
 * time (blueprint §1.3; Posidon R1.11 §3). Re-delivering the same input
 * therefore resolves the SAME story/claim/evidence/draft rows instead of
 * creating duplicates, and `formatIdempotencyKey` guarantees
 * collision-safe, versioned, bounded keys.
 *
 * Identity versioning: the `v1` label in the scope/seed parts is part
 * of the hashed input — a future behavioral change re-derives NEW ids
 * rather than colliding with v1 rows.
 */

import { formatIdempotencyKey, sha256Hex } from '../../shared/ids/idempotency-key';

/** Identity schema label — bump ONLY with a documented identity migration. */
export const EDITORIAL_IDENTITY_VERSION = 'v1';

/** Bounded id prefixes (TEXT PK columns; kept short and stable). */
const STORY_ID_PREFIX = 'edst';
const CLAIM_ID_PREFIX = 'edcl';
const EVIDENCE_ID_PREFIX = 'edev';
const DRAFT_ID_PREFIX = 'eddr';
const AI_RUN_ID_PREFIX = 'edai';

/** Bounded hex length taken from the full SHA-256 (128-bit collision margin). */
const ID_HEX_LENGTH = 32;

async function prefixedId(prefix: string, seedParts: readonly string[]): Promise<string> {
  const canonical = [EDITORIAL_IDENTITY_VERSION, ...seedParts].join('\u001f');
  const hex = await sha256Hex(canonical);
  return `${prefix}_${hex.slice(0, ID_HEX_LENGTH)}`;
}

/**
 * Durable job idempotency key for one (sourceItemId, snapshotHash) pair:
 * replaying the same enqueue input resolves the SAME durable job row
 * (jobs.idempotency_key UNIQUE), never a second pipeline run.
 */
export async function editorialPrepareDraftIdempotencyKey(
  sourceItemId: string,
  snapshotHash: string,
): Promise<string> {
  return formatIdempotencyKey('editorial.prepare_draft', [
    EDITORIAL_IDENTITY_VERSION,
    sourceItemId,
    snapshotHash,
  ]);
}

/**
 * Deterministic story key for one item snapshot: one snapshot of one
 * source_item has EXACTLY ONE conservative initial story. Different
 * snapshots (different content hashes) NEVER share a story key — similar
 * or identical titles alone must not merge items into one story
 * (R1.11 scenario 8; semantic merging is a later phase).
 */
export async function storyKeyForSnapshot(
  sourceItemId: string,
  snapshotHash: string,
): Promise<string> {
  return formatIdempotencyKey('editorial.story', [
    EDITORIAL_IDENTITY_VERSION,
    sourceItemId,
    snapshotHash,
  ]);
}

/** Deterministic story row id for the snapshot story. */
export async function storyIdForSnapshot(
  sourceItemId: string,
  snapshotHash: string,
): Promise<string> {
  return prefixedId(STORY_ID_PREFIX, ['story', sourceItemId, snapshotHash]);
}

/**
 * Deterministic `source_report` claim id: the claim "source X reported
 * this text" exists ONCE per snapshot story.
 */
export async function sourceReportClaimId(storyId: string, sourceItemId: string): Promise<string> {
  return prefixedId(CLAIM_ID_PREFIX, ['source_report', storyId, sourceItemId]);
}

/**
 * Deterministic `mentions` evidence id linking the source_report claim to
 * its origin source_item. The evidence UNIQUE(claim_id, source_item_id,
 * stance) constraint is the second, schema-level guard.
 */
export async function mentionsEvidenceId(claimId: string, sourceItemId: string): Promise<string> {
  return prefixedId(EVIDENCE_ID_PREFIX, ['mentions', claimId, sourceItemId]);
}

/** Deterministic draft row id for the snapshot story's version-1 draft. */
export async function draftIdForStory(storyId: string): Promise<string> {
  return prefixedId(DRAFT_ID_PREFIX, ['draft_v1', storyId]);
}

/**
 * Deterministic ai_runs row id for ONE job execution attempt: a retry is a
 * NEW generation and therefore a NEW, honestly-distinct ai_runs row; a
 * commit batch can never insert the same run twice.
 */
export async function aiRunIdForAttempt(jobId: string, generation: number): Promise<string> {
  return prefixedId(AI_RUN_ID_PREFIX, ['ai_run', jobId, String(generation)]);
}

/** Draft version produced by THIS phase (one snapshot → one v1 draft). */
export const EDITORIAL_DRAFT_VERSION = 1;

/**
 * Deterministic input hash for the AI request (canonical evidence
 * representation): recorded on `ai_runs.input_hash` so a run is
 * identifiable without storing news text.
 */
export async function editorialAiInputHash(
  evidenceInputs: readonly { readonly id: string; readonly text: string }[],
): Promise<string> {
  const canonical = evidenceInputs
    .map((snippet) => `${snippet.id}\u001f${snippet.text}`)
    .join('\u001e');
  return sha256Hex(`${EDITORIAL_IDENTITY_VERSION}\u001e${canonical}`);
}
