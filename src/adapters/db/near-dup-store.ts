/**
 * Slice 6 — the near-dup store (`story_merges` + `quality_rejections`,
 * migration 0009).
 *
 * Durable records for the near-dup pipeline (DESIGN §10.1/§9.4):
 * - `story_merges`: ONE row per adjudication of an incoming source item
 *   against a canonical story (the story ledger). `merged_as_update`
 *   means the item became an UPDATE of the canonical story — never a
 *   second post; `needs_review` means the middle band — held for AI/human
 *   adjudication, never posted meanwhile; `distinct` means no merge.
 * - `quality_rejections`: the negative cache for the quality gate. ONE
 *   row per rejected fingerprint (the source item's content_hash), alive
 *   for 30 days (a TIME predicate — rows are never deleted). A cached
 *   rejection is never re-fed to AI.
 *
 * BOUNDARY (ADR-0022): all D1 access for these tables goes through this
 * module. Never log SQL text or bind parameters; never log full rows.
 */
import type { DbExecutor } from './db-executor';
import { toDbAppError } from './d1-errors';
import { NEGATIVE_CACHE_TTL_MS, type NearDupDisposition } from '../../domain/editorial/near-dup';

/** One recent story as read by the bounded near-dup scan. */
export interface RecentStoryRow {
  readonly id: string;
  readonly workingHeadline: string | null;
  readonly contentType: string;
}

/** Statuses that can never be a merge target (already dead-ended). */
const NON_MERGEABLE_STORY_STATUSES: readonly string[] = [
  'duplicate',
  'rejected',
  'closed',
  'denied',
];

/**
 * Bounded recent-story scan for the near-dup check: stories first seen
 * inside the window, mergeable, newest evidence first. Never a
 * full-table scan (the (status, last_evidence_at) index serves it).
 */
export async function findRecentStories(
  executor: DbExecutor,
  input: { readonly sinceMs: number; readonly limit: number },
): Promise<readonly RecentStoryRow[]> {
  const placeholders = NON_MERGEABLE_STORY_STATUSES.map(() => '?').join(', ');
  const { rows } = await executor.query<RecentStoryRow>({
    sql: `SELECT id, working_headline AS workingHeadline, content_type AS contentType FROM stories
           WHERE first_seen_at >= ?
             AND status NOT IN (${placeholders})
           ORDER BY last_evidence_at DESC
           LIMIT ?`,
    params: [input.sinceMs, ...NON_MERGEABLE_STORY_STATUSES, input.limit],
  });
  return rows;
}

/** The linked entity ids of one story (bounded, deterministic order). */
export async function findStoryEntityIds(
  executor: DbExecutor,
  storyId: string,
): Promise<readonly string[]> {
  const { rows } = await executor.query<{ entity_id: string }>({
    sql: `SELECT entity_id FROM story_entities
           WHERE story_id = ?
           ORDER BY entity_id ASC
           LIMIT 50`,
    params: [storyId],
  });
  return rows.map((row) => row.entity_id);
}

export interface StoryMergeRow {
  readonly id: string;
  readonly canonicalStoryId: string;
  readonly mergedStoryId: string | null;
  readonly sourceItemId: string;
  readonly similarityScore: number;
  readonly titleScore: number;
  readonly entityScore: number;
  readonly method: 'deterministic' | 'ai';
  readonly disposition: NearDupDisposition;
  readonly decidedBy: string;
  readonly reasonCode: string;
  readonly createdAtMs: number;
}

interface StoryMergeDbRow {
  readonly id: string;
  readonly canonical_story_id: string;
  readonly merged_story_id: string | null;
  readonly source_item_id: string;
  readonly similarity_score: number;
  readonly title_score: number;
  readonly entity_score: number;
  readonly method: string;
  readonly disposition: string;
  readonly decided_by: string;
  readonly reason_code: string;
  readonly created_at_ms: number;
}

function toStoryMergeRow(row: StoryMergeDbRow): StoryMergeRow | null {
  if (row.method !== 'deterministic' && row.method !== 'ai') {
    return null;
  }
  if (
    row.disposition !== 'merged_as_update' &&
    row.disposition !== 'needs_review' &&
    row.disposition !== 'distinct'
  ) {
    return null;
  }
  return {
    id: row.id,
    canonicalStoryId: row.canonical_story_id,
    mergedStoryId: row.merged_story_id,
    sourceItemId: row.source_item_id,
    similarityScore: row.similarity_score,
    titleScore: row.title_score,
    entityScore: row.entity_score,
    method: row.method,
    disposition: row.disposition,
    decidedBy: row.decided_by,
    reasonCode: row.reason_code,
    createdAtMs: row.created_at_ms,
  };
}

export async function findStoryMergeBySourceItem(
  executor: DbExecutor,
  input: { readonly sourceItemId: string; readonly canonicalStoryId: string },
): Promise<StoryMergeRow | null> {
  const row = await executor.first<StoryMergeDbRow>({
    sql: `SELECT id, canonical_story_id, merged_story_id, source_item_id,
                 similarity_score, title_score, entity_score, method,
                 disposition, decided_by, reason_code, created_at_ms
            FROM story_merges
           WHERE source_item_id = ? AND canonical_story_id = ?`,
    params: [input.sourceItemId, input.canonicalStoryId],
  });
  return row === null ? null : toStoryMergeRow(row);
}

export type RecordStoryMergeOutcome =
  | { readonly kind: 'recorded'; readonly id: string }
  | { readonly kind: 'already_recorded'; readonly id: string };

/**
 * Record one adjudication in the story ledger. Idempotent per
 * (source_item_id, canonical_story_id): a redelivered adjudication of
 * the same pair reuses the existing row instead of writing a second
 * verdict (the UNIQUE index is the backstop; the pre-read is the
 * honest path).
 */
export async function recordStoryMerge(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly canonicalStoryId: string;
    readonly mergedStoryId: string | null;
    readonly sourceItemId: string;
    readonly similarityScore: number;
    readonly titleScore: number;
    readonly entityScore: number;
    readonly method: 'deterministic' | 'ai';
    readonly disposition: NearDupDisposition;
    readonly decidedBy: string;
    readonly reasonCode: string;
    readonly nowMs: number;
  },
): Promise<RecordStoryMergeOutcome> {
  const existing = await findStoryMergeBySourceItem(executor, {
    sourceItemId: input.sourceItemId,
    canonicalStoryId: input.canonicalStoryId,
  });
  if (existing !== null) {
    return { kind: 'already_recorded', id: existing.id };
  }
  try {
    await executor.run({
      sql: `INSERT INTO story_merges
                   (id, canonical_story_id, merged_story_id, source_item_id,
                    similarity_score, title_score, entity_score, method,
                    disposition, decided_by, reason_code, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.id,
        input.canonicalStoryId,
        input.mergedStoryId,
        input.sourceItemId,
        input.similarityScore,
        input.titleScore,
        input.entityScore,
        input.method,
        input.disposition,
        input.decidedBy,
        input.reasonCode,
        input.nowMs,
      ],
    });
  } catch (error) {
    // A concurrent adjudication won the UNIQUE index first — re-read the
    // winner instead of failing the redelivery.
    if (toDbAppError(error).code !== 'db_constraint_violation') {
      throw error;
    }
    const winner = await findStoryMergeBySourceItem(executor, {
      sourceItemId: input.sourceItemId,
      canonicalStoryId: input.canonicalStoryId,
    });
    if (winner === null) {
      throw error;
    }
    return { kind: 'already_recorded', id: winner.id };
  }
  return { kind: 'recorded', id: input.id };
}

/**
 * Bump the canonical story on a merge: status `updated`, fresh evidence
 * clock, version +1. Guarded: a dead-ended story (duplicate / rejected /
 * closed / denied) never moves — a merge into one is a ledger-only
 * record, never a resurrection.
 */
export async function markCanonicalStoryUpdated(
  executor: DbExecutor,
  input: { readonly storyId: string; readonly nowMs: number },
): Promise<boolean> {
  const placeholders = NON_MERGEABLE_STORY_STATUSES.map(() => '?').join(', ');
  const meta = await executor.run({
    sql: `UPDATE stories
             SET status = 'updated', last_evidence_at = ?, version = version + 1,
                 updated_at = ?
           WHERE id = ? AND status NOT IN (${placeholders})`,
    params: [input.nowMs, input.nowMs, input.storyId, ...NON_MERGEABLE_STORY_STATUSES],
  });
  return (meta.changes ?? 0) > 0;
}

/**
 * Move a source item's processing status after a near-dup decision.
 * Guarded on the live states only (`new` / `queued`): an already
 * processed/duplicate item never moves again.
 * - merged_as_update → `duplicate` (the CHECK vocabulary: the item will
 *   never take its own path);
 * - needs_review → `queued` (held for adjudication; a later re-enqueue
 *   re-runs the near-dup check and lands on the same ledger row).
 */
export async function markSourceItemNearDupStatus(
  executor: DbExecutor,
  input: {
    readonly sourceItemId: string;
    readonly status: 'duplicate' | 'queued';
  },
): Promise<boolean> {
  const meta = await executor.run({
    sql: `UPDATE source_items
             SET processing_status = ?
           WHERE id = ? AND processing_status IN ('new', 'queued')`,
    params: [input.status, input.sourceItemId],
  });
  return (meta.changes ?? 0) > 0;
}

export interface QualityRejectionRow {
  readonly id: string;
  readonly fingerprint: string;
  readonly reason: string;
  readonly sourceItemId: string;
  readonly rejectedAtMs: number;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
}

interface QualityRejectionDbRow {
  readonly id: string;
  readonly fingerprint: string;
  readonly reason: string;
  readonly source_item_id: string;
  readonly rejected_at_ms: number;
  readonly expires_at_ms: number;
  readonly created_at_ms: number;
}

function toQualityRejectionRow(row: QualityRejectionDbRow): QualityRejectionRow {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    reason: row.reason,
    sourceItemId: row.source_item_id,
    rejectedAtMs: row.rejected_at_ms,
    expiresAtMs: row.expires_at_ms,
    createdAtMs: row.created_at_ms,
  };
}

/**
 * The LIVE negative-cache read: a rejection counts only while its 30-day
 * window is still open (an expired row is dead — the item may be fed to
 * AI again). Expiry is a TIME predicate on the read, never a sweep.
 */
export async function findLiveNegativeCacheEntry(
  executor: DbExecutor,
  input: { readonly fingerprint: string; readonly nowMs: number },
): Promise<QualityRejectionRow | null> {
  const row = await executor.first<QualityRejectionDbRow>({
    sql: `SELECT id, fingerprint, reason, source_item_id, rejected_at_ms,
                 expires_at_ms, created_at_ms
            FROM quality_rejections
           WHERE fingerprint = ? AND expires_at_ms > ?`,
    params: [input.fingerprint, input.nowMs],
  });
  return row === null ? null : toQualityRejectionRow(row);
}

export type RecordQualityRejectionOutcome =
  | { readonly kind: 'recorded'; readonly id: string }
  | { readonly kind: 'refreshed'; readonly id: string };

/**
 * Record (or refresh) a quality-gate rejection in the negative cache.
 * The fingerprint is the source item's content_hash; the window is 30
 * days from THIS rejection. A re-rejection of the same fingerprint
 * refreshes the window instead of duplicating the row (UNIQUE).
 */
export async function recordQualityRejection(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly fingerprint: string;
    readonly reason: string;
    readonly sourceItemId: string;
    readonly nowMs: number;
  },
): Promise<RecordQualityRejectionOutcome> {
  const expiresAtMs = input.nowMs + NEGATIVE_CACHE_TTL_MS;
  const existing = await executor.first<{ id: string }>({
    sql: `SELECT id FROM quality_rejections WHERE fingerprint = ?`,
    params: [input.fingerprint],
  });
  if (existing !== null) {
    await executor.run({
      sql: `UPDATE quality_rejections
               SET reason = ?, source_item_id = ?, rejected_at_ms = ?,
                   expires_at_ms = ?
             WHERE fingerprint = ?`,
      params: [input.reason, input.sourceItemId, input.nowMs, expiresAtMs, input.fingerprint],
    });
    return { kind: 'refreshed', id: existing.id };
  }
  try {
    await executor.run({
      sql: `INSERT INTO quality_rejections
                   (id, fingerprint, reason, source_item_id,
                    rejected_at_ms, expires_at_ms, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.id,
        input.fingerprint,
        input.reason,
        input.sourceItemId,
        input.nowMs,
        expiresAtMs,
        input.nowMs,
      ],
    });
  } catch (error) {
    if (toDbAppError(error).code !== 'db_constraint_violation') {
      throw error;
    }
    const winner = await executor.first<{ id: string }>({
      sql: `SELECT id FROM quality_rejections WHERE fingerprint = ?`,
      params: [input.fingerprint],
    });
    if (winner === null) {
      throw error;
    }
    return { kind: 'refreshed', id: winner.id };
  }
  return { kind: 'recorded', id: input.id };
}
