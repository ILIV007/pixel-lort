/**
 * Slice 4 — inbound pipeline store (`published_posts` + `inbound_approvals`,
 * migration 0007).
 *
 * Durable records for the owner-sent inbound flow (DESIGN §10.1/§10.2):
 * - `published_posts`: ONE row per channel-published inbound post. The
 *   (source_chat_id, source_message_id) pair is the EDIT ANCHOR — an
 *   edited source message re-runs the pipeline and edits THIS row's
 *   channel post in place. `channel_message_ids` is the JSON array of
 *   channel message ids in part order (a multi-part post edits each part);
 *   `media_file_id` records the published file (an in-place edit can never
 *   swap it — only the caption).
 * - `inbound_approvals`: ONE row per approval-mode preview. The processed
 *   content (parts + media, JSON) with its stable fingerprint, the 24-hour
 *   expiry, and the guarded state machine
 *   pending -> approved/rejected/expired/published. The partial UNIQUE
 *   index admits ONE pending approval per source message.
 *
 * BOUNDARY (ADR-0022): all D1 access for these tables goes through this
 * module. Never log SQL text or bind parameters; never log full rows.
 */
import type { DbExecutor } from './db-executor';
import { toDbAppError } from './d1-errors';
import type { GamingCategory } from '../../domain/inbound/classifier';
import type { InboundPresentation } from '../../domain/inbound/rich-decision';

export interface PublishedPostRow {
  readonly id: string;
  readonly sourceChatId: number;
  readonly sourceMessageId: number;
  readonly channelMessageIds: readonly number[];
  readonly kind: 'text' | 'photo' | 'video';
  readonly mediaFileId: string | null;
  readonly category: string;
  readonly presentation: InboundPresentation;
  readonly createdByUserId: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type InboundApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'published';

export interface InboundApprovalRow {
  readonly id: string;
  readonly sourceChatId: number;
  readonly sourceMessageId: number;
  readonly sourceUpdateId: number;
  readonly createdByUserId: number;
  readonly contentJson: string;
  readonly fingerprint: string;
  readonly category: string;
  readonly presentation: InboundPresentation;
  readonly state: InboundApprovalState;
  readonly expiresAtMs: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

interface PublishedPostDbRow {
  readonly id: string;
  readonly source_chat_id: number;
  readonly source_message_id: number;
  readonly channel_message_ids: string;
  readonly kind: string;
  readonly media_file_id: string | null;
  readonly category: string;
  readonly presentation: string;
  readonly created_by_user_id: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

interface InboundApprovalDbRow {
  readonly id: string;
  readonly source_chat_id: number;
  readonly source_message_id: number;
  readonly source_update_id: number;
  readonly created_by_user_id: number;
  readonly content_json: string;
  readonly fingerprint: string;
  readonly category: string;
  readonly presentation: string;
  readonly state: string;
  readonly expires_at_ms: number;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

function parseChannelMessageIds(json: string): readonly number[] | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return null;
    }
    const ids: number[] = [];
    for (const value of parsed) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        return null;
      }
      ids.push(value);
    }
    return ids.length > 0 ? ids : null;
  } catch {
    return null;
  }
}

function toPublishedPostRow(row: PublishedPostDbRow): PublishedPostRow | null {
  const channelMessageIds = parseChannelMessageIds(row.channel_message_ids);
  if (channelMessageIds === null) {
    return null;
  }
  if (row.kind !== 'text' && row.kind !== 'photo' && row.kind !== 'video') {
    return null;
  }
  if (row.presentation !== 'rich' && row.presentation !== 'classic') {
    return null;
  }
  return {
    id: row.id,
    sourceChatId: row.source_chat_id,
    sourceMessageId: row.source_message_id,
    channelMessageIds,
    kind: row.kind,
    mediaFileId: row.media_file_id,
    category: row.category,
    presentation: row.presentation,
    createdByUserId: row.created_by_user_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function toInboundApprovalRow(row: InboundApprovalDbRow): InboundApprovalRow | null {
  const states: readonly string[] = ['pending', 'approved', 'rejected', 'expired', 'published'];
  if (!states.includes(row.state)) {
    return null;
  }
  if (row.presentation !== 'rich' && row.presentation !== 'classic') {
    return null;
  }
  return {
    id: row.id,
    sourceChatId: row.source_chat_id,
    sourceMessageId: row.source_message_id,
    sourceUpdateId: row.source_update_id,
    createdByUserId: row.created_by_user_id,
    contentJson: row.content_json,
    fingerprint: row.fingerprint,
    category: row.category,
    presentation: row.presentation,
    state: row.state as InboundApprovalState,
    expiresAtMs: row.expires_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export async function findPublishedPostBySource(
  executor: DbExecutor,
  input: { readonly sourceChatId: number; readonly sourceMessageId: number },
): Promise<PublishedPostRow | null> {
  const row = await executor.first<PublishedPostDbRow>({
    sql: `SELECT id, source_chat_id, source_message_id, channel_message_ids,
                 kind, media_file_id, category, presentation,
                 created_by_user_id, created_at_ms, updated_at_ms
            FROM published_posts
           WHERE source_chat_id = ? AND source_message_id = ?`,
    params: [input.sourceChatId, input.sourceMessageId],
  });
  return row === null ? null : toPublishedPostRow(row);
}

export async function recordPublishedPost(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly sourceChatId: number;
    readonly sourceMessageId: number;
    readonly channelMessageIds: readonly number[];
    readonly kind: 'text' | 'photo' | 'video';
    readonly mediaFileId: string | null;
    readonly category: GamingCategory;
    readonly presentation: InboundPresentation;
    readonly createdByUserId: number;
    readonly nowMs: number;
  },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO published_posts
                 (id, source_chat_id, source_message_id, channel_message_ids,
                  kind, media_file_id, category, presentation,
                  created_by_user_id, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      input.id,
      input.sourceChatId,
      input.sourceMessageId,
      JSON.stringify([...input.channelMessageIds]),
      input.kind,
      input.mediaFileId,
      input.category,
      input.presentation,
      input.createdByUserId,
      input.nowMs,
      input.nowMs,
    ],
  });
}

/**
 * Update a published post's channel mapping after an edit (new part ids,
 * possibly a new kind/category). Guarded: only the row for this source
 * message moves, and only when its id matches.
 */
export async function updatePublishedPostAfterEdit(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly channelMessageIds: readonly number[];
    readonly kind: 'text' | 'photo' | 'video';
    readonly mediaFileId: string | null;
    readonly category: GamingCategory;
    readonly presentation: InboundPresentation;
    readonly nowMs: number;
  },
): Promise<boolean> {
  const meta = await executor.run({
    sql: `UPDATE published_posts
             SET channel_message_ids = ?, kind = ?, media_file_id = ?,
                 category = ?, presentation = ?, updated_at_ms = ?
           WHERE id = ?`,
    params: [
      JSON.stringify([...input.channelMessageIds]),
      input.kind,
      input.mediaFileId,
      input.category,
      input.presentation,
      input.nowMs,
      input.id,
    ],
  });
  return (meta.changes ?? 0) > 0;
}

export type CreateInboundApprovalOutcome =
  | { readonly kind: 'created'; readonly id: string }
  | { readonly kind: 'already_pending'; readonly id: string };

/**
 * Create a pending approval for a source message. The partial UNIQUE index
 * admits ONE pending approval per source message: a redelivered update (or
 * a second send of the same message) reuses the existing pending row
 * instead of creating a second live preview.
 */
export async function createInboundApproval(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly sourceChatId: number;
    readonly sourceMessageId: number;
    readonly sourceUpdateId: number;
    readonly createdByUserId: number;
    readonly contentJson: string;
    readonly fingerprint: string;
    readonly category: GamingCategory;
    readonly presentation: InboundPresentation;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  },
): Promise<CreateInboundApprovalOutcome> {
  const existing = await executor.first<{ id: string }>({
    sql: `SELECT id FROM inbound_approvals
           WHERE source_chat_id = ? AND source_message_id = ? AND state = 'pending'`,
    params: [input.sourceChatId, input.sourceMessageId],
  });
  if (existing !== null) {
    return { kind: 'already_pending', id: existing.id };
  }
  try {
    await executor.run({
      sql: `INSERT INTO inbound_approvals
                   (id, source_chat_id, source_message_id, source_update_id,
                    created_by_user_id, content_json, fingerprint, category,
                    presentation, state, expires_at_ms, created_at_ms, updated_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      params: [
        input.id,
        input.sourceChatId,
        input.sourceMessageId,
        input.sourceUpdateId,
        input.createdByUserId,
        input.contentJson,
        input.fingerprint,
        input.category,
        input.presentation,
        input.expiresAtMs,
        input.nowMs,
        input.nowMs,
      ],
    });
  } catch (error) {
    // A concurrent insert won the partial unique index first — re-read the
    // winner instead of failing the redelivery.
    if (toDbAppError(error).code !== 'db_constraint_violation') {
      throw error;
    }
    const winner = await executor.first<{ id: string }>({
      sql: `SELECT id FROM inbound_approvals
             WHERE source_chat_id = ? AND source_message_id = ? AND state = 'pending'`,
      params: [input.sourceChatId, input.sourceMessageId],
    });
    if (winner === null) {
      throw error;
    }
    return { kind: 'already_pending', id: winner.id };
  }
  return { kind: 'created', id: input.id };
}

export async function getInboundApproval(
  executor: DbExecutor,
  id: string,
): Promise<InboundApprovalRow | null> {
  const row = await executor.first<InboundApprovalDbRow>({
    sql: `SELECT id, source_chat_id, source_message_id, source_update_id,
                 created_by_user_id, content_json, fingerprint, category,
                 presentation, state, expires_at_ms, created_at_ms, updated_at_ms
            FROM inbound_approvals
           WHERE id = ?`,
    params: [id],
  });
  return row === null ? null : toInboundApprovalRow(row);
}

export async function findPendingInboundApprovalBySource(
  executor: DbExecutor,
  input: { readonly sourceChatId: number; readonly sourceMessageId: number },
): Promise<InboundApprovalRow | null> {
  const row = await executor.first<InboundApprovalDbRow>({
    sql: `SELECT id, source_chat_id, source_message_id, source_update_id,
                 created_by_user_id, content_json, fingerprint, category,
                 presentation, state, expires_at_ms, created_at_ms, updated_at_ms
            FROM inbound_approvals
           WHERE source_chat_id = ? AND source_message_id = ? AND state = 'pending'`,
    params: [input.sourceChatId, input.sourceMessageId],
  });
  return row === null ? null : toInboundApprovalRow(row);
}

/**
 * Guarded transition for an approval row: `from` -> `to`, exactly once.
 * Returns false when the row is not in `from` (already decided, or a
 * concurrent consumer won) — the caller answers honestly instead of
 * double-publishing. The forward path is pending -> approved -> published;
 * approved -> pending is the send-failure rollback (the row is never stuck
 * in 'approved' with nothing published).
 */
export async function transitionInboundApproval(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly from: InboundApprovalState;
    readonly to: InboundApprovalState;
    readonly nowMs: number;
  },
): Promise<boolean> {
  const meta = await executor.run({
    sql: `UPDATE inbound_approvals
             SET state = ?, updated_at_ms = ?
           WHERE id = ? AND state = ?`,
    params: [input.to, input.nowMs, input.id, input.from],
  });
  return (meta.changes ?? 0) > 0;
}
