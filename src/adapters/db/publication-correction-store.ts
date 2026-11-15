/**
 * Phase 8.4 — the D1-backed CORRECTION store over the blueprint-approved
 * tables (schema 6 — consumed, ZERO DDL; ADR-0059). The durable half of the
 * edit/correction workflow: the machine-legal publication supersede, the
 * draft supersede (the crash-safe route for in-flight rows), and the
 * deterministic audit trail (the blueprint §7 «edit action: revision ID +
 * target message ID unique in audit»).
 *
 * House discipline (the 8.2 store's rules, unchanged):
 * - parameterized SQL ONLY (values are never logged — the DbExecutor
 *   contract; the audit metadata carries outcome codes, never content);
 * - the lifecycle machine (pol1) is the authority: the supersede UPDATE is
 *   a conditional write over exactly the machine's supersedable statuses;
 * - the deterministic audit id (caid1) makes `audit_events.id` the
 *   at-most-once claim for an edit and the dedup anchor for a link;
 * - every outcome is honest: `not_found` vs `not_supersedable` are distinct,
 *   a constraint conflict is surfaced as `duplicate`, never swallowed.
 */

import type { DbExecutor } from './db-executor';
import { isAppError } from '../../shared/errors/app-error';
import { SUPERSEDABLE_PUBLICATION_STATUSES } from '../../domain/publishing/edit-correction';
import type { PublicationRow } from './publication-outbox-store';

/** The machine-legal supersedable statuses as an SQL IN list fragment. */
const SUPERSEDABLE_SQL_LIST = SUPERSEDABLE_PUBLICATION_STATUSES.map((status) => `'${status}'`).join(
  ', ',
);

/** The draft statuses a correction may supersede (the active drafts). */
const SUPERSEDABLE_DRAFT_SQL_LIST =
  "'generating', 'ready', 'validated', 'approval_required', 'auto_approved', 'approved'";

export type SupersedeOutcome =
  | { readonly kind: 'superseded' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_supersedable' };

/**
 * Supersede ONE publication row. The conditional UPDATE covers exactly the
 * machine-legal supersede sources (pending/retry_wait/published/failed): a
 * claimed/publishing row (an in-flight generation owns it) and a terminal
 * row (dead_letter/cancelled/superseded — no machine exits) are refused.
 */
export async function supersedePublicationById(
  executor: DbExecutor,
  input: { readonly publicationId: string; readonly nowMs: number },
): Promise<SupersedeOutcome> {
  const result = await executor.run({
    sql: `UPDATE publications SET status = 'superseded', updated_at = ?
          WHERE id = ? AND status IN (${SUPERSEDABLE_SQL_LIST})`,
    params: [input.nowMs, input.publicationId],
  });
  if (result.changes > 0) {
    return { kind: 'superseded' };
  }
  const existing = await executor.first<{ readonly status: string }>({
    sql: `SELECT status FROM publications WHERE id = ?`,
    params: [input.publicationId],
  });
  return existing ? { kind: 'not_supersedable' } : { kind: 'not_found' };
}

/**
 * The supersedable active rows of a story (excluding the caller's own new
 * publication id): the rows a correction workflow may retire. The order is
 * deterministic (oldest first) for stable reports.
 */
export async function listActivePublicationsForStory(
  executor: DbExecutor,
  input: { readonly storyId: string; readonly excludePublicationId: string },
): Promise<readonly PublicationRow[]> {
  const rows = await executor.query<{
    readonly id: string;
    readonly story_id: string;
    readonly draft_id: string;
    readonly status: string;
    readonly priority: number;
    readonly approval_mode: string;
    readonly scheduled_at: number | null;
    readonly run_after: number;
    readonly claimed_at: number | null;
    readonly lease_until: number | null;
    readonly published_at: number | null;
    readonly attempts: number;
    readonly max_attempts: number;
    readonly idempotency_key: string;
    readonly last_error: string | null;
    readonly created_at: number;
    readonly updated_at: number;
  }>({
    sql: `SELECT * FROM publications
          WHERE story_id = ? AND id <> ? AND status IN (${SUPERSEDABLE_SQL_LIST})
          ORDER BY created_at ASC`,
    params: [input.storyId, input.excludePublicationId],
  });
  return rows.rows.filter(
    (row) => row.id.length > 0 && row.story_id.length > 0,
  ) as readonly PublicationRow[];
}

/**
 * Supersede ONE draft row (the crash-safe route for a publication an
 * in-flight generation still owns: the superseded draft leaves the
 * sendable set, so the scheduler's eligibility check dead-letters the
 * publication without a send). Active draft statuses only.
 */
export async function markDraftSuperseded(
  executor: DbExecutor,
  input: { readonly draftId: string; readonly nowMs: number },
): Promise<SupersedeOutcome> {
  const result = await executor.run({
    sql: `UPDATE drafts SET status = 'superseded', updated_at = ?
          WHERE id = ? AND status IN (${SUPERSEDABLE_DRAFT_SQL_LIST})`,
    params: [input.nowMs, input.draftId],
  });
  if (result.changes > 0) {
    return { kind: 'superseded' };
  }
  const existing = await executor.first<{ readonly status: string }>({
    sql: `SELECT status FROM drafts WHERE id = ?`,
    params: [input.draftId],
  });
  return existing ? { kind: 'not_supersedable' } : { kind: 'not_found' };
}

export type CorrectionAuditRecordOutcome =
  { readonly kind: 'recorded' } | { readonly kind: 'duplicate' };

/**
 * Record a correction audit event with the DETERMINISTIC id (caid1). The
 * INSERT is the at-most-once CLAIM: the PK conflict of a deterministic id
 * is `duplicate` — the honest absorption, never an error, never a swallow.
 * The metadata carries outcome codes and ids only — never message content,
 * never secrets.
 */
export async function recordCorrectionAuditEvent(
  executor: DbExecutor,
  input: {
    readonly eventId: string;
    readonly action: string;
    readonly actorType: 'admin' | 'system' | 'source' | 'ai';
    readonly actorId: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly traceId: string | null;
    readonly metadataJson: string;
    readonly nowMs: number;
  },
): Promise<CorrectionAuditRecordOutcome> {
  try {
    await executor.run({
      sql: `INSERT INTO audit_events (id, actor_type, actor_id, action, target_type,
              target_id, trace_id, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.eventId,
        input.actorType,
        input.actorId,
        input.action,
        input.targetType,
        input.targetId,
        input.traceId,
        input.metadataJson,
        input.nowMs,
      ],
    });
    return { kind: 'recorded' };
  } catch (error) {
    if (isAppError(error) && error.code === 'db_constraint_violation') {
      return { kind: 'duplicate' };
    }
    throw error;
  }
}

export async function findCorrectionAuditEvent(
  executor: DbExecutor,
  eventId: string,
): Promise<{ readonly id: string; readonly metadata_json: string } | null> {
  const row = await executor.first<{ readonly id: string; readonly metadata_json: string }>({
    sql: `SELECT id, metadata_json FROM audit_events WHERE id = ?`,
    params: [eventId],
  });
  return row ?? null;
}

/**
 * The compare-and-set finalization of an edit audit row claimed as
 * `attempted`: the UPDATE lands ONLY when the stored metadata is still the
 * exact JSON this generation wrote at claim time. A stale generation (or a
 * foreign writer) cannot overwrite another claim's row.
 */
export async function finalizeCorrectionAuditEvent(
  executor: DbExecutor,
  input: {
    readonly eventId: string;
    readonly attemptedMetadataJson: string;
    readonly finalMetadataJson: string;
  },
): Promise<{ readonly kind: 'finalized' } | { readonly kind: 'fenced' }> {
  const result = await executor.run({
    sql: `UPDATE audit_events SET metadata_json = ? WHERE id = ? AND metadata_json = ?`,
    params: [input.finalMetadataJson, input.eventId, input.attemptedMetadataJson],
  });
  return result.changes > 0 ? { kind: 'finalized' } : { kind: 'fenced' };
}
