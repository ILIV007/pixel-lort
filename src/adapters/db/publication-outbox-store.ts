/**
 * Phase 8.2 — the D1-backed PUBLICATION OUTBOX store over the
 * BLUEPRINT-APPROVED `publications` / `publication_messages` tables
 * (migration 0001 — consumed, ZERO DDL, schema stays 6; ADR-0058). The REAL
 * durable half of the Phase 8.2 scheduler: the integration tests drive THIS
 * over real workerd D1 (the Telegram transport is the only fake).
 *
 * House discipline:
 * - parameterized SQL ONLY (values are never logged — the DbExecutor
 *   contract);
 * - the lifecycle machine (src/domain/publishing/outbox-lifecycle.ts) is the
 *   authority: every durable transition here corresponds to a machine-legal
 *   (from, reason) pair, and every write is FENCED — a claimed row's
 *   terminal transition pins its attempts generation, so a late worker can
 *   never overwrite newer state (the admin-post house fence, now over the
 *   attempts column);
 * - the ATOMIC CLAIM is a conditional UPDATE (status/run_after/lease/
 *   budget conditions in the WHERE) — exactly one concurrent caller wins;
 *   the attempts value after the claim is the GENERATION the terminal
 *   writes are fenced by;
 * - the attempt budget is enforced AT the claim boundary (attempts <
 *   max_attempts in the claim WHERE) — a spent-budget row can never be
 *   re-executed by a crashed generation (the ADR-0037 lesson);
 * - `publication_messages` is the at-most-once ledger: the
 *   UNIQUE(chat_id, message_id) constraint and the PK(publication_id,
 *   ordinal) make a recorded delivery impossible to forget and impossible
 *   to record twice; a rejected record is surfaced honestly
 *   (duplicate_message), never swallowed;
 * - the enqueue SUPPRESSES duplicates through the blueprint §7 identity:
 *   the UNIQUE derived idempotency key (pidek1) — a duplicate enqueue
 *   returns the EXISTING row, never a second publication.
 *
 * THE HONEST PARKING PIN (ADR-0058): the schema-6 status vocabulary has no
 * `uncertain` value; the ambiguous outcome parks in 'failed' with the
 * classifier's code in last_error, and the evidence heal (failed ->
 * published, proof-backed only) is the reconciliation path. An unconfirmed
 * attempt is never auto-resent.
 */

import type { DbExecutor } from './db-executor';
import { AppError, isAppError } from '../../shared/errors/app-error';
import { derivePublicationIdempotencyKey } from '../../domain/publishing/publication-identity';
import {
  isPublicationStatus,
  PUBLICATION_STATUSES,
  publicationMaxAttempts,
  transitionPublication,
  type PublicationStatus,
} from '../../domain/publishing/outbox-lifecycle';

const MAX_DESTINATION_LENGTH = 256;
const MAX_LAST_ERROR_LENGTH = 128;

export interface PublicationRow {
  readonly id: string;
  readonly story_id: string;
  readonly draft_id: string;
  readonly status: PublicationStatus;
  readonly priority: number;
  readonly approval_mode: 'auto' | 'safe_auto' | 'approval';
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
}

export interface PublicationMessageRow {
  readonly publication_id: string;
  readonly chat_id: string;
  readonly message_id: number;
  readonly media_group_id: string | null;
  readonly ordinal: number;
  readonly text_hash: string | null;
  readonly created_at: number;
}

interface PublicationDbRow {
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
}

function toPublicationRow(row: PublicationDbRow): PublicationRow | null {
  if (typeof row.id !== 'string' || row.id.length === 0) return null;
  if (typeof row.story_id !== 'string' || row.story_id.length === 0) return null;
  if (typeof row.draft_id !== 'string' || row.draft_id.length === 0) return null;
  if (typeof row.status !== 'string') return null;
  if (!Number.isInteger(row.priority) || row.priority < 0 || row.priority > 100) return null;
  if (
    row.approval_mode !== 'auto' &&
    row.approval_mode !== 'safe_auto' &&
    row.approval_mode !== 'approval'
  ) {
    return null;
  }
  if (!Number.isInteger(row.run_after) || row.run_after < 0) return null;
  if (!Number.isInteger(row.attempts) || row.attempts < 0) return null;
  if (!Number.isInteger(row.max_attempts) || row.max_attempts < 1) return null;
  if (typeof row.idempotency_key !== 'string' || row.idempotency_key.length === 0) return null;
  if (!Number.isInteger(row.created_at) || !Number.isInteger(row.updated_at)) return null;
  return {
    id: row.id,
    story_id: row.story_id,
    draft_id: row.draft_id,
    status: row.status as PublicationStatus,
    priority: row.priority,
    approval_mode: row.approval_mode,
    scheduled_at: row.scheduled_at,
    run_after: row.run_after,
    claimed_at: row.claimed_at,
    lease_until: row.lease_until,
    published_at: row.published_at,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    idempotency_key: row.idempotency_key,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function clampErrorCode(code: string | undefined): string | null {
  if (code === undefined || code === null || code.length === 0) return null;
  return code.slice(0, MAX_LAST_ERROR_LENGTH);
}

// ---------------------------------------------------------------------------
// enqueue — the blueprint §7 idempotency identity
// ---------------------------------------------------------------------------

export type EnqueueOutcome =
  | { readonly kind: 'created'; readonly publicationId: string; readonly idempotencyKey: string }
  | { readonly kind: 'duplicate'; readonly publicationId: string }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid_draft_id'
        | 'invalid_destination'
        | 'invalid_score'
        | 'draft_not_found'
        | 'draft_not_sendable'
        | 'mode_status_mismatch';
    };

const MODE_STATUS_MATRIX: Readonly<Record<'auto' | 'safe_auto' | 'approval', readonly string[]>> = {
  auto: ['auto_approved', 'approved'],
  safe_auto: ['auto_approved', 'approved'],
  approval: ['approved'],
};

/**
 * Enqueue one publication. The draft row is the single source of truth for
 * the story reference and the eligibility: the draft must exist and be
 * sendable, and the approval mode must agree with the draft's actual status
 * (an 'approval' mode over an auto_approved draft is a rejected mismatch —
 * the human approval chain cannot be skipped by a config slip). The
 * duplicate path is the UNIQUE idempotency key: the existing row wins, the
 * caller is told which one.
 */
export async function enqueuePublication(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly draftId: string;
    readonly destination: string;
    readonly priorityScore: number;
    readonly approvalMode: 'auto' | 'safe_auto' | 'approval';
    readonly nowMs: number;
  },
): Promise<EnqueueOutcome> {
  if (
    typeof input.draftId !== 'string' ||
    input.draftId.length === 0 ||
    input.draftId.length > MAX_DESTINATION_LENGTH
  ) {
    return { kind: 'rejected', reason: 'invalid_draft_id' };
  }
  if (
    typeof input.destination !== 'string' ||
    input.destination.length === 0 ||
    input.destination.length > MAX_DESTINATION_LENGTH
  ) {
    return { kind: 'rejected', reason: 'invalid_destination' };
  }
  const budget = publicationMaxAttempts(input.priorityScore);
  if (!budget.ok) {
    return { kind: 'rejected', reason: 'invalid_score' };
  }
  const key = await derivePublicationIdempotencyKey({
    draftId: input.draftId,
    destination: input.destination,
  });
  if (!key.ok) {
    return { kind: 'rejected', reason: 'invalid_draft_id' };
  }

  const draft = await executor.first<{
    readonly id: string;
    readonly story_id: string;
    readonly status: string;
  }>({
    sql: `SELECT id, story_id, status FROM drafts WHERE id = ?`,
    params: [input.draftId],
  });
  if (!draft) {
    return { kind: 'rejected', reason: 'draft_not_found' };
  }
  const allowedStatuses = MODE_STATUS_MATRIX[input.approvalMode];
  if (!allowedStatuses.includes(draft.status)) {
    return {
      kind: 'rejected',
      reason:
        draft.status === 'approved' || draft.status === 'auto_approved'
          ? 'mode_status_mismatch'
          : 'draft_not_sendable',
    };
  }

  try {
    await executor.run({
      sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
              scheduled_at, run_after, claimed_at, lease_until, published_at, attempts,
              max_attempts, idempotency_key, last_error, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, NULL, NULL, NULL, 0, ?, ?, NULL, ?, ?)`,
      params: [
        input.publicationId,
        draft.story_id,
        input.draftId,
        input.priorityScore,
        input.approvalMode,
        input.nowMs,
        budget.value,
        key.key,
        input.nowMs,
        input.nowMs,
      ],
    });
    return { kind: 'created', publicationId: input.publicationId, idempotencyKey: key.key };
  } catch (error) {
    if (isAppError(error) && error.code === 'db_constraint_violation') {
      // The UNIQUE idempotency key (or the PK): find the existing row and
      // report it honestly. A not-found re-check means an unexpected
      // constraint — rethrown, never swallowed.
      const existing = await executor.first<{ readonly id: string }>({
        sql: `SELECT id FROM publications WHERE idempotency_key = ?`,
        params: [key.key],
      });
      if (existing) {
        return { kind: 'duplicate', publicationId: existing.id };
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

export async function findPublicationById(
  executor: DbExecutor,
  publicationId: string,
): Promise<PublicationRow | null> {
  const row = await executor.first<PublicationDbRow>({
    sql: `SELECT * FROM publications WHERE id = ?`,
    params: [publicationId],
  });
  return row ? toPublicationRow(row) : null;
}

/**
 * The due scan: pending/retry_wait rows whose run_after has elapsed and
 * whose (absent) lease has expired, highest priority first, then the
 * earliest due. The index idx_publications_due(status, run_after,
 * priority DESC) serves the shape.
 */
export async function listDuePublications(
  executor: DbExecutor,
  input: { readonly nowMs: number; readonly limit: number },
): Promise<readonly PublicationRow[]> {
  const limit = Math.max(1, Math.min(64, Math.floor(input.limit)));
  const rows = await executor.query<PublicationDbRow>({
    sql: `SELECT * FROM publications
          WHERE status IN ('pending', 'retry_wait')
            AND run_after <= ?
            AND (lease_until IS NULL OR lease_until < ?)
          ORDER BY priority DESC, run_after ASC
          LIMIT ?`,
    params: [input.nowMs, input.nowMs, limit],
  });
  return rows.rows.map(toPublicationRow).filter((row): row is PublicationRow => row !== null);
}

export async function countDuePublications(
  executor: DbExecutor,
  input: { readonly nowMs: number },
): Promise<number> {
  const row = await executor.first<{ readonly total: number }>({
    sql: `SELECT COUNT(*) AS total FROM publications
          WHERE status IN ('pending', 'retry_wait')
            AND run_after <= ?
            AND (lease_until IS NULL OR lease_until < ?)`,
    params: [input.nowMs, input.nowMs],
  });
  const total = row?.total;
  return typeof total === 'number' && Number.isInteger(total) && total >= 0 ? total : 0;
}

export async function listFailedPublications(
  executor: DbExecutor,
  input: { readonly limit: number },
): Promise<readonly PublicationRow[]> {
  const limit = Math.max(1, Math.min(64, Math.floor(input.limit)));
  const rows = await executor.query<PublicationDbRow>({
    sql: `SELECT * FROM publications WHERE status = 'failed' ORDER BY updated_at ASC LIMIT ?`,
    params: [limit],
  });
  return rows.rows.map(toPublicationRow).filter((row): row is PublicationRow => row !== null);
}

// ---------------------------------------------------------------------------
// the atomic claim and the fenced writes
// ---------------------------------------------------------------------------

export type ClaimOutcome =
  { readonly kind: 'claimed'; readonly generation: number } | { readonly kind: 'not_claimable' };

/**
 * The atomic claim: pending|retry_wait, due, lease-free, WITH budget left
 * (attempts < max_attempts — a spent row is never re-executed; the caller
 * dead-letters it at the boundary). The post-claim attempts value is the
 * GENERATION every terminal write is fenced by; the read is stable because
 * the row is 'claimed' under a fresh lease no other WHERE can match.
 */
export async function claimPublication(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly nowMs: number;
    readonly leaseMs: number;
  },
): Promise<ClaimOutcome> {
  const claimMeta = await executor.run({
    sql: `UPDATE publications
            SET status = 'claimed', claimed_at = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ?
            AND status IN ('pending', 'retry_wait')
            AND run_after <= ?
            AND (lease_until IS NULL OR lease_until < ?)
            AND attempts < max_attempts`,
    params: [
      input.nowMs,
      input.nowMs + input.leaseMs,
      input.nowMs,
      input.publicationId,
      input.nowMs,
      input.nowMs,
    ],
  });
  if (claimMeta.changes !== 1) {
    return { kind: 'not_claimable' };
  }
  // The row is now 'claimed' under a fresh lease: no other claimer's WHERE
  // can match, and the stale-lease reclaim cannot fire (the lease is in the
  // future) — the generation read is stable.
  const generationRow = await executor.first<{ readonly attempts: number }>({
    sql: `SELECT attempts FROM publications WHERE id = ?`,
    params: [input.publicationId],
  });
  const generation = generationRow?.attempts;
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) {
    // The claim won but the generation read is unusable — a storage-level
    // anomaly must not proceed with an unfenced send.
    throw new AppError('db_query_failed');
  }
  return { kind: 'claimed', generation };
}

export type FencedWriteOutcome = { readonly kind: 'written' } | { readonly kind: 'fence_rejected' };

/**
 * The fenced terminal write shared by the SEND-PATH exits. The send starts
 * in 'claimed' and crosses into 'publishing' at the send-started marker
 * (the independent review d65d811 P1-1 fix), so a generation's terminal
 * must fence over BOTH source statuses. The machine is consulted for BOTH:
 * a (from, reason) pair the machine rejects — or two rows that disagree on
 * the target — is a bug: it throws typed and nothing is written.
 */
async function writeClaimedTerminal(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly generation: number;
    readonly reason: 'publish' | 'fail_hold' | 'mark_uncertain' | 'schedule_retry' | 'dead_letter';
    readonly errorCode?: string;
    readonly runAfterMs?: number;
    readonly nowMs: number;
  },
): Promise<FencedWriteOutcome> {
  const machineClaimed = transitionPublication('claimed', input.reason);
  const machinePublishing = transitionPublication('publishing', input.reason);
  if (!machineClaimed.ok || !machinePublishing.ok || machineClaimed.to !== machinePublishing.to) {
    throw new AppError('internal_error');
  }
  const meta = await executor.run({
    sql: `UPDATE publications
            SET status = ?, lease_until = NULL, claimed_at = NULL, published_at = ?, last_error = ?,
                run_after = ?, updated_at = ?
          WHERE id = ? AND status IN ('claimed', 'publishing') AND attempts = ?`,
    params: [
      machineClaimed.to,
      input.reason === 'publish' ? input.nowMs : null,
      clampErrorCode(input.errorCode),
      input.runAfterMs ?? 0,
      input.nowMs,
      input.publicationId,
      input.generation,
    ],
  });
  return meta.changes === 1 ? { kind: 'written' } : { kind: 'fence_rejected' };
}

/**
 * The policy-defer release: claimed -> pending with the attempt generation
 * RESTORED (no send was attempted — no attempt was consumed) and the
 * durable deferral recorded (run_after, and scheduled_at only when a time
 * was actually planned).
 */
export async function releaseClaimed(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly generation: number;
    readonly runAfterMs: number;
    readonly scheduledAtMs: number | null;
    readonly nowMs: number;
  },
): Promise<FencedWriteOutcome> {
  const machine = transitionPublication('claimed', 'release');
  if (!machine.ok) {
    throw new AppError('internal_error');
  }
  const meta = await executor.run({
    sql: `UPDATE publications
            SET status = 'pending', attempts = attempts - 1, lease_until = NULL, claimed_at = NULL,
                run_after = ?, scheduled_at = ?, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND attempts = ?`,
    params: [
      input.runAfterMs,
      input.scheduledAtMs,
      input.nowMs,
      input.publicationId,
      input.generation,
    ],
  });
  return meta.changes === 1 ? { kind: 'written' } : { kind: 'fence_rejected' };
}

// ---------------------------------------------------------------------------
// THE DURABLE SEND-STARTED STATE (the independent review d65d811, P1-1 fix)
// ---------------------------------------------------------------------------

/**
 * The honest parking code for the AMBIGUOUS in-flight window: a generation
 * marked the send started (the transport MAY have been reached) and its
 * lease expired without a terminal — the outcome is UNKNOWN, the row is
 * held for the human dispositions, and a recorded delivery proof still
 * heals it (Phase A). It is NEVER auto-resent on the absence of a ledger
 * record.
 */
export const SEND_MAY_HAVE_STARTED_ERROR = 'send_may_have_started';

export type SendStartOutcome = { readonly kind: 'marked' } | { readonly kind: 'fence_rejected' };

/**
 * Mark the claimed generation's send STARTED, durably, BEFORE any network
 * effect: the machine's `mark_send_started` transition (claimed ->
 * publishing) fenced by the attempts generation, with the lease EXTENDED
 * to cover the in-flight window (a healthy send is never reclaimed
 * mid-flight). After this write the row can only exit through the
 * generation's own fenced terminals — a concurrent scan can neither claim
 * it ('publishing' is outside the claim WHERE) nor reclaim it while the
 * extended lease holds. A crash here leaves the row in the ambiguous
 * window the parking path holds for the human dispositions.
 */
export async function markClaimedSendStarted(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly generation: number;
    readonly nowMs: number;
    readonly leaseMs: number;
  },
): Promise<SendStartOutcome> {
  const machine = transitionPublication('claimed', 'mark_send_started');
  if (!machine.ok || machine.to !== 'publishing') {
    throw new AppError('internal_error');
  }
  const leaseMs = Number.isInteger(input.leaseMs) && input.leaseMs > 0 ? input.leaseMs : 0;
  if (leaseMs === 0) {
    throw new AppError('bad_request');
  }
  const meta = await executor.run({
    sql: `UPDATE publications
            SET status = 'publishing', lease_until = ?, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND attempts = ?`,
    params: [input.nowMs + leaseMs, input.nowMs, input.publicationId, input.generation],
  });
  return meta.changes === 1 ? { kind: 'marked' } : { kind: 'fence_rejected' };
}

export type PublishParkOutcome = { readonly parked: number };

/**
 * The ambiguous-window parking: a 'publishing' row whose EXTENDED in-flight
 * lease expired without a terminal — the generation crashed (or hung) with
 * the send MAYBE started. The write is the machine's `mark_uncertain`
 * transition (publishing -> failed, the schema's honest parking state) with
 * SEND_MAY_HAVE_STARTED_ERROR in last_error; the row is NEVER auto-resent:
 * Phase A's evidence heal is its only proof-backed exit, otherwise it waits
 * for the human dispositions. Rows still 'claimed' with an expired lease
 * are NOT touched here — the send-started marker never landed for them, so
 * the reclaim's re-send is provably safe (the stale-lease reclaim).
 */
export async function parkExpiredPublishingUncertain(
  executor: DbExecutor,
  input: { readonly nowMs: number },
): Promise<PublishParkOutcome> {
  const machine = transitionPublication('publishing', 'mark_uncertain');
  if (!machine.ok || machine.to !== 'failed') {
    throw new AppError('internal_error');
  }
  const meta = await executor.run({
    sql: `UPDATE publications
            SET status = 'failed', lease_until = NULL, claimed_at = NULL,
                last_error = ?, run_after = 0, updated_at = ?
          WHERE status = 'publishing' AND lease_until IS NOT NULL AND lease_until < ?`,
    params: [SEND_MAY_HAVE_STARTED_ERROR, input.nowMs, input.nowMs],
  });
  return { parked: meta.changes };
}

export async function markClaimedPublished(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly generation: number;
    readonly nowMs: number;
  },
): Promise<FencedWriteOutcome> {
  return writeClaimedTerminal(executor, {
    publicationId: input.publicationId,
    generation: input.generation,
    reason: 'publish',
    nowMs: input.nowMs,
  });
}

export async function markClaimedFailed(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly generation: number;
    readonly errorCode: string;
    readonly nowMs: number;
  },
): Promise<FencedWriteOutcome> {
  return writeClaimedTerminal(executor, {
    publicationId: input.publicationId,
    generation: input.generation,
    reason: 'fail_hold',
    errorCode: input.errorCode,
    nowMs: input.nowMs,
  });
}

export async function markClaimedUncertain(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly generation: number;
    readonly errorCode: string;
    readonly nowMs: number;
  },
): Promise<FencedWriteOutcome> {
  // The machine maps the ambiguous outcome ('mark_uncertain') onto the
  // schema's honest parking state ('failed') — the classifier's code in
  // last_error carries the epistemic truth (ADR-0058 pin).
  return writeClaimedTerminal(executor, {
    publicationId: input.publicationId,
    generation: input.generation,
    reason: 'mark_uncertain',
    errorCode: input.errorCode,
    nowMs: input.nowMs,
  });
}

export async function markClaimedRetryWait(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly generation: number;
    readonly errorCode: string;
    readonly runAfterMs: number;
    readonly nowMs: number;
  },
): Promise<FencedWriteOutcome> {
  return writeClaimedTerminal(executor, {
    publicationId: input.publicationId,
    generation: input.generation,
    reason: 'schedule_retry',
    errorCode: input.errorCode,
    runAfterMs: input.runAfterMs,
    nowMs: input.nowMs,
  });
}

export async function markClaimedDeadLetter(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly generation: number;
    readonly errorCode: string;
    readonly nowMs: number;
  },
): Promise<FencedWriteOutcome> {
  return writeClaimedTerminal(executor, {
    publicationId: input.publicationId,
    generation: input.generation,
    reason: 'dead_letter',
    errorCode: input.errorCode,
    nowMs: input.nowMs,
  });
}

export type BoundaryDeadLetterOutcome =
  { readonly kind: 'dead_lettered' } | { readonly kind: 'not_dead_letterable' };

/**
 * The budget-spent dead-letter AT the claim boundary: a waiting row with no
 * budget left is dead-lettered WITHOUT re-execution. The write is
 * conditional (status still waiting AND budget still spent) — losing it to
 * a concurrent claimer is the honest not_dead_letterable.
 */
export async function markWaitingPublicationDeadLetter(
  executor: DbExecutor,
  input: { readonly publicationId: string; readonly nowMs: number },
): Promise<BoundaryDeadLetterOutcome> {
  const meta = await executor.run({
    sql: `UPDATE publications
            SET status = 'dead_letter', lease_until = NULL, claimed_at = NULL, last_error = 'attempt_budget_spent', updated_at = ?
          WHERE id = ? AND status IN ('pending', 'retry_wait') AND attempts >= max_attempts`,
    params: [input.nowMs, input.publicationId],
  });
  return meta.changes === 1 ? { kind: 'dead_lettered' } : { kind: 'not_dead_letterable' };
}

// ---------------------------------------------------------------------------
// the at-most-once ledger (publication_messages)
// ---------------------------------------------------------------------------

export type RecordMessageOutcome =
  { readonly kind: 'recorded' } | { readonly kind: 'duplicate_message' };

/** The Bot API media-group bound (2..10 items) — the ordinal vocabulary cap. */
export const MAX_MEDIA_GROUP_ORDINAL = 9;

/**
 * Record ONE delivered message. The record happens ONLY after a parsed
 * successful send response — the ledger never records a guess. The
 * UNIQUE(chat_id, message_id) constraint is the cross-publication guard: a
 * reused/forged message id is REJECTED (duplicate_message) — the caller
 * treats that as an uncertain outcome, never as a published one.
 *
 * THE ALBUM WIRING (ADR-0060): the ordinal defaults to 0 (the text path's
 * single-message record, unchanged) and the media-group path records one
 * row PER ordinal — the PK(publication_id, ordinal) fences a duplicate
 * per-ordinal record exactly like the text path's single row.
 */
export async function recordPublicationMessage(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly chatId: string;
    readonly messageId: number;
    readonly textHash: string | null;
    readonly nowMs: number;
    readonly mediaGroupId?: string;
    /** The per-item ordinal (the media-group path); default 0 (the text path). */
    readonly ordinal?: number;
  },
): Promise<RecordMessageOutcome> {
  if (
    typeof input.chatId !== 'string' ||
    input.chatId.length === 0 ||
    input.chatId.length > MAX_DESTINATION_LENGTH ||
    !Number.isInteger(input.messageId) ||
    input.messageId <= 0 ||
    (input.ordinal !== undefined &&
      (!Number.isInteger(input.ordinal) ||
        input.ordinal < 0 ||
        input.ordinal > MAX_MEDIA_GROUP_ORDINAL))
  ) {
    throw new AppError('bad_request');
  }
  try {
    await executor.run({
      sql: `INSERT INTO publication_messages (publication_id, chat_id, message_id, media_group_id, ordinal, text_hash, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.publicationId,
        input.chatId,
        input.messageId,
        input.mediaGroupId ?? null,
        input.ordinal ?? 0,
        input.textHash,
        input.nowMs,
      ],
    });
    return { kind: 'recorded' };
  } catch (error) {
    if (isAppError(error) && error.code === 'db_constraint_violation') {
      return { kind: 'duplicate_message' };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// the per-ordinal usage binding (media_usages — the album wiring, ADR-0060)
// ---------------------------------------------------------------------------

export type RecordUsagesOutcome =
  { readonly kind: 'recorded' } | { readonly kind: 'duplicate_usage' };

/**
 * Bind the sent album's items to their LEDGER assets, one row per ordinal
 * (the blueprint's per-publication ordinal record, finally consumed). The
 * write is ONE atomic batch — all ordinals or none; the PK(publication_id,
 * ordinal) fences a duplicate binding (duplicate_usage). Called AFTER the
 * delivery records: a failure here parks the row uncertain and the NEXT
 * scan's evidence check heals it from the recorded messages — the binding
 * failure can never orphan a delivery proof.
 */
export async function recordPublicationMediaUsages(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly usages: readonly { readonly ordinal: number; readonly mediaAssetId: string }[];
    readonly nowMs: number;
  },
): Promise<RecordUsagesOutcome> {
  if (
    typeof input?.publicationId !== 'string' ||
    input.publicationId.length === 0 ||
    !Number.isInteger(input.nowMs) ||
    !Array.isArray(input.usages) ||
    input.usages.length === 0 ||
    input.usages.length > MAX_MEDIA_GROUP_ORDINAL + 1
  ) {
    throw new AppError('bad_request');
  }
  for (const usage of input.usages) {
    if (
      typeof usage !== 'object' ||
      usage === null ||
      !Number.isInteger(usage.ordinal) ||
      usage.ordinal < 0 ||
      usage.ordinal > MAX_MEDIA_GROUP_ORDINAL ||
      typeof usage.mediaAssetId !== 'string' ||
      usage.mediaAssetId.length === 0 ||
      usage.mediaAssetId.length > 128
    ) {
      throw new AppError('bad_request');
    }
  }
  try {
    await executor.batch(
      input.usages.map((usage) => ({
        sql: `INSERT INTO media_usages (media_asset_id, publication_id, ordinal, created_at)
              VALUES (?, ?, ?, ?)`,
        params: [usage.mediaAssetId, input.publicationId, usage.ordinal, input.nowMs],
      })),
    );
    return { kind: 'recorded' };
  } catch (error) {
    if (isAppError(error) && error.code === 'db_constraint_violation') {
      return { kind: 'duplicate_usage' };
    }
    throw error;
  }
}

export async function listPublicationMessages(
  executor: DbExecutor,
  publicationId: string,
): Promise<readonly PublicationMessageRow[]> {
  const rows = await executor.query<PublicationMessageRow>({
    sql: `SELECT publication_id, chat_id, message_id, media_group_id, ordinal, text_hash, created_at
          FROM publication_messages WHERE publication_id = ? ORDER BY ordinal ASC`,
    params: [publicationId],
  });
  return rows.rows;
}

/** The bound per-ordinal usage view (the evidence-completeness reconcile). */
export interface PublicationUsageRow {
  readonly ordinal: number;
  readonly media_asset_id: string;
}

/**
 * The bounded per-ordinal usage read for ONE publication (the PK covers
 * publication_id + ordinal). The evidence-completeness evaluator consumes
 * the ordinals; the ids ride along for the honest heal-time rebinding.
 */
export async function listPublicationMediaUsages(
  executor: DbExecutor,
  publicationId: string,
): Promise<readonly PublicationUsageRow[]> {
  const rows = await executor.query<PublicationUsageRow>({
    sql: `SELECT ordinal, media_asset_id FROM media_usages WHERE publication_id = ? ORDER BY ordinal ASC`,
    params: [publicationId],
  });
  return rows.rows;
}

// ---------------------------------------------------------------------------
// the reconciliation heals and the stale-lease reclaim
// ---------------------------------------------------------------------------

export type HealOutcome = { readonly kind: 'healed' } | { readonly kind: 'no_heal' };

/**
 * The evidence reconciliation heal: failed -> published, ONLY backed by
 * recorded delivery evidence (the caller checks the ledger first). The heal
 * is conditional on the status still being failed. The proof outranks the
 * earlier inference: a parked row whose delivery is proven DID publish.
 */
export async function healFailedToPublished(
  executor: DbExecutor,
  input: { readonly publicationId: string; readonly nowMs: number },
): Promise<HealOutcome> {
  const machine = transitionPublication('failed', 'publish');
  if (!machine.ok) {
    throw new AppError('internal_error');
  }
  const meta = await executor.run({
    sql: `UPDATE publications
            SET status = 'published', published_at = ?, lease_until = NULL, claimed_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'failed'`,
    params: [input.nowMs, input.nowMs, input.publicationId],
  });
  return meta.changes === 1 ? { kind: 'healed' } : { kind: 'no_heal' };
}

/**
 * The pre-send evidence heal inside a fresh claim: the claimed generation
 * found recorded delivery evidence for this publication — the send already
 * happened in a crashed earlier generation. Fenced by the generation.
 */
export async function healClaimedToPublished(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly generation: number;
    readonly nowMs: number;
  },
): Promise<FencedWriteOutcome> {
  const machine = transitionPublication('claimed', 'publish');
  if (!machine.ok) {
    throw new AppError('internal_error');
  }
  const meta = await executor.run({
    sql: `UPDATE publications
            SET status = 'published', published_at = ?, lease_until = NULL, claimed_at = NULL, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND attempts = ?`,
    params: [input.nowMs, input.nowMs, input.publicationId, input.generation],
  });
  return meta.changes === 1 ? { kind: 'written' } : { kind: 'fence_rejected' };
}

export type ReclaimOutcome = { readonly reclaimed: number };

/**
 * The stale-lease reclaim: a claimed row whose lease expired returns to the
 * waiting pool with its attempts PRESERVED (the attempt WAS consumed — the
 * generation may have sent). The next claim is a NEW generation whose
 * pre-send evidence check closes the recorded sub-window of the ambiguous
 * window (ADR-0032 gate).
 */
export async function reclaimExpiredClaims(
  executor: DbExecutor,
  input: { readonly nowMs: number },
): Promise<ReclaimOutcome> {
  const meta = await executor.run({
    sql: `UPDATE publications
            SET status = 'pending', lease_until = NULL, claimed_at = NULL, run_after = ?, updated_at = ?
          WHERE status = 'claimed' AND lease_until IS NOT NULL AND lease_until < ?`,
    params: [input.nowMs, input.nowMs, input.nowMs],
  });
  return { reclaimed: meta.changes };
}

// ---------------------------------------------------------------------------
// the policy history reads (the real context provider's basis)
// ---------------------------------------------------------------------------

export interface PublishedHistoryEntry {
  readonly publishedAtMs: number;
  readonly priority: number;
  readonly layout: string;
  readonly contentType: string;
}

/**
 * The recent published history — the NEWEST `limit` published records,
 * returned OLDEST-FIRST (the consumer's expected order: the trail's last
 * entry IS the previous send). THE SELECTION WINDOW (the independent
 * review a279e13 fix): the old query ordered ASC and THEN applied LIMIT —
 * after 512 publications the window held the OLDEST rows and every new
 * send fell outside it, feeding the cooldown/mix/layout policy stale
 * data. The selection now orders `published_at DESC, id DESC` (the
 * deterministic tie-break at equal timestamps) with the LIMIT, and the
 * chosen window is REVERSED to oldest-first for the return. The 168h mix
 * window filter is applied by the CALLER (the service) — this read
 * returns the bounded recent trail. The bounded-read boundary is honest:
 * no index covers published_at (schema 6 — ZERO DDL), so the engine
 * sorts; the LIMIT keeps the returned window bounded exactly as before.
 */
export async function listRecentPublishedHistory(
  executor: DbExecutor,
  input: { readonly nowMs: number; readonly limit: number },
): Promise<readonly PublishedHistoryEntry[]> {
  const limit = Math.max(1, Math.min(512, Math.floor(input.limit)));
  const rows = await executor.query<{
    readonly published_at: number;
    readonly priority: number;
    readonly layout: string;
    readonly content_type: string;
  }>({
    sql: `SELECT p.published_at, p.priority, d.layout, s.content_type
          FROM publications p
          JOIN drafts d ON d.id = p.draft_id
          JOIN stories s ON s.id = p.story_id
          WHERE p.status = 'published' AND p.published_at IS NOT NULL AND p.published_at <= ?
          ORDER BY p.published_at DESC, p.id DESC
          LIMIT ?`,
    params: [input.nowMs, limit],
  });
  return (
    rows.rows
      .map((row) => ({
        publishedAtMs: row.published_at,
        priority: row.priority,
        layout: row.layout,
        contentType: row.content_type,
      }))
      // The newest-first selection window, returned oldest-first: the
      // consumer reads the trail chronologically (the last entry is the
      // previous send).
      .reverse()
  );
}

// ---------------------------------------------------------------------------
// Phase 9 read-only queue views (the /queue admin surface — ADR-0046 shape)
// ---------------------------------------------------------------------------

export type PublicationStatusCounts = Readonly<Record<PublicationStatus, number>>;

/**
 * The bounded status histogram over the publications outbox — ONE
 * aggregate SELECT, zero content reads. The /queue screen's summary line.
 */
export async function countPublicationsByStatus(
  executor: DbExecutor,
): Promise<PublicationStatusCounts> {
  const counts = Object.fromEntries(PUBLICATION_STATUSES.map((status) => [status, 0])) as Record<
    PublicationStatus,
    number
  >;
  const rows = await executor.query<{ readonly status: string; readonly total: number }>({
    sql: `SELECT status, COUNT(*) AS total FROM publications GROUP BY status`,
    params: [],
  });
  for (const row of rows.rows) {
    if (isPublicationStatus(row.status) && Number.isInteger(row.total) && row.total >= 0) {
      counts[row.status] = row.total;
    }
  }
  return counts;
}

export interface PublicationQueueRow {
  readonly id: string;
  readonly status: PublicationStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** The classifier's stable code (never raw provider content). */
  readonly lastError: string | null;
  readonly updatedAt: number;
}

/**
 * The bounded most-recent rows of the outbox (oldest-updated LAST order,
 * capped) — identity/status/priority/attempt counters and the stable
 * last_error code only. NEVER draft content, never destination values.
 */
export async function listRecentPublications(
  executor: DbExecutor,
  input: { readonly limit: number },
): Promise<readonly PublicationQueueRow[]> {
  const limit = Math.max(1, Math.min(16, Math.floor(input.limit)));
  const rows = await executor.query<{
    readonly id: string;
    readonly status: string;
    readonly priority: number;
    readonly attempts: number;
    readonly max_attempts: number;
    readonly last_error: string | null;
    readonly updated_at: number;
  }>({
    sql: `SELECT id, status, priority, attempts, max_attempts, last_error, updated_at
          FROM publications ORDER BY updated_at DESC LIMIT ?`,
    params: [limit],
  });
  return rows.rows
    .filter(
      (row) =>
        typeof row.id === 'string' &&
        row.id.length > 0 &&
        isPublicationStatus(row.status) &&
        Number.isInteger(row.priority) &&
        Number.isInteger(row.attempts) &&
        Number.isInteger(row.max_attempts) &&
        Number.isInteger(row.updated_at),
    )
    .map((row) => ({
      id: row.id,
      status: row.status as PublicationStatus,
      priority: row.priority,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    }));
}
