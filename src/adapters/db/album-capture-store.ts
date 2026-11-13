/**
 * Phase 9D — the album CAPTURE store: the durable write half of the
 * capture surface over the blueprint-approved `admin_sessions` and
 * `media_assets` tables (schema 6 — consumed, ZERO DDL).
 *
 * House discipline (the 9C/8.2 store rules, unchanged):
 * - parameterized SQL ONLY (values never logged; the DbExecutor contract);
 * - EVERY mutation is FENCED by the WHERE clause — the rowcount is the
 *   authority (an expired/completed/replaced session loses honestly, never
 *   by inference);
 * - the finish batch is ONE executor.batch (the asset rows + the session
 *   completion commit together — a partial capture never exists);
 * - every outcome is honest and typed, never swallowed.
 */

import type { DbExecutor } from './db-executor';
import { isAppError } from '../../shared/errors/app-error';
import {
  ALBUM_CAPTURE_MIN_ITEMS,
  ALBUM_CAPTURE_SESSION_FLOW,
  ALBUM_CAPTURE_SESSION_TTL_MS,
  capturedItemCanonicalUrl,
  readAlbumCaptureState,
  type AlbumCaptureState,
} from '../../domain/media/album-capture';

interface CaptureSessionRow {
  readonly id: string;
  readonly step: string;
  readonly state_json: string;
  readonly expires_at: number;
}

function parseSessionRow(row: CaptureSessionRow):
  | {
      readonly ok: true;
      readonly session: { readonly id: string; readonly state: AlbumCaptureState };
    }
  | { readonly ok: false; readonly reason: 'state_corrupt' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.state_json);
  } catch {
    return { ok: false, reason: 'state_corrupt' };
  }
  const read = readAlbumCaptureState(parsed);
  if (!read.ok) {
    return { ok: false, reason: 'state_corrupt' };
  }
  return { ok: true, session: { id: row.id, state: read.state } };
}

export type StartCaptureOutcome =
  { readonly kind: 'started'; readonly sessionId: string } | { readonly kind: 'write_failed' };

/**
 * Start (or EXPLICITLY REPLACE) the actor's capture session: any previous
 * active session of the SAME actor is marked 'replaced' first (a bounded
 * cleanup — an actor has at most ONE active capture), then the new row is
 * inserted with the bounded TTL.
 */
export async function startAlbumCaptureSession(
  executor: DbExecutor,
  input: {
    readonly telegramUserId: number;
    readonly sessionId: string;
    readonly state: AlbumCaptureState;
    readonly nowMs: number;
  },
): Promise<StartCaptureOutcome> {
  await executor.run({
    sql: `UPDATE admin_sessions SET step = 'replaced', updated_at = ?
          WHERE telegram_user_id = ? AND flow = ? AND step = 'active'`,
    params: [input.nowMs, input.telegramUserId, ALBUM_CAPTURE_SESSION_FLOW],
  });
  try {
    await executor.run({
      sql: `INSERT INTO admin_sessions (id, telegram_user_id, flow, step, state_json, expires_at, created_at, updated_at)
            VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      params: [
        input.sessionId,
        input.telegramUserId,
        ALBUM_CAPTURE_SESSION_FLOW,
        JSON.stringify(input.state),
        input.nowMs + ALBUM_CAPTURE_SESSION_TTL_MS,
        input.nowMs,
        input.nowMs,
      ],
    });
  } catch (error) {
    if (isAppError(error) && error.code === 'db_constraint_violation') {
      // A duplicate session id (an impossible random collision) is honest
      // typed — the caller reports the write failure, never a fake start.
      return { kind: 'write_failed' };
    }
    throw error;
  }
  return { kind: 'started', sessionId: input.sessionId };
}

export type ActiveCaptureSession =
  | {
      readonly ok: true;
      readonly session: { readonly id: string; readonly state: AlbumCaptureState };
    }
  | { readonly ok: false; readonly reason: 'no_active_session' | 'state_corrupt' };

/** The FENCED active-session read (step='active' AND unexpired). */
export async function getActiveCaptureSession(
  executor: DbExecutor,
  input: { readonly telegramUserId: number; readonly nowMs: number },
): Promise<ActiveCaptureSession> {
  const row = await executor.first<CaptureSessionRow>({
    sql: `SELECT id, step, state_json, expires_at FROM admin_sessions
          WHERE telegram_user_id = ? AND flow = ? AND step = 'active' AND expires_at > ?
          ORDER BY created_at DESC LIMIT 1`,
    params: [input.telegramUserId, ALBUM_CAPTURE_SESSION_FLOW, input.nowMs],
  });
  if (row === null) {
    return { ok: false, reason: 'no_active_session' };
  }
  return parseSessionRow(row);
}

export type AppendCaptureOutcome =
  | { readonly kind: 'appended'; readonly sessionId: string; readonly state: AlbumCaptureState }
  | {
      readonly kind: 'refused';
      readonly reason: 'no_active_session' | 'state_corrupt' | 'fence_lost' | 'write_failed';
    };

/**
 * The FENCED read-modify-write append: the state is validated + mutated by
 * the pure module FIRST, then written back under the SAME fence
 * (step='active' AND unexpired) — a session expiring between the read and
 * the write loses honestly (the rowcount is the authority).
 */
export async function appendAlbumCaptureItem(
  executor: DbExecutor,
  input: {
    readonly telegramUserId: number;
    readonly nextState: AlbumCaptureState;
    readonly nowMs: number;
  },
): Promise<AppendCaptureOutcome> {
  const active = await getActiveCaptureSession(executor, {
    telegramUserId: input.telegramUserId,
    nowMs: input.nowMs,
  });
  if (!active.ok) {
    return {
      kind: 'refused',
      reason: active.reason === 'state_corrupt' ? 'state_corrupt' : 'no_active_session',
    };
  }
  const fence = await executor.run({
    sql: `UPDATE admin_sessions SET state_json = ?, updated_at = ?
          WHERE id = ? AND telegram_user_id = ? AND flow = ? AND step = 'active' AND expires_at > ?`,
    params: [
      JSON.stringify(input.nextState),
      input.nowMs,
      active.session.id,
      input.telegramUserId,
      ALBUM_CAPTURE_SESSION_FLOW,
      input.nowMs,
    ],
  });
  if (fence.changes === 0) {
    return { kind: 'refused', reason: 'fence_lost' };
  }
  return { kind: 'appended', sessionId: active.session.id, state: input.nextState };
}

export type EndCaptureOutcome =
  | {
      readonly kind: 'ended';
      readonly session: { readonly id: string; readonly state: AlbumCaptureState };
    }
  | {
      readonly kind: 'refused';
      readonly reason: 'no_active_session' | 'state_corrupt' | 'fence_lost';
    };

/**
 * The fenced session END (cancel: step -> 'cancelled'; finish handles its
 * own batch in finishAlbumCapture). The rowcount is the authority.
 */
export async function endAlbumCaptureSession(
  executor: DbExecutor,
  input: {
    readonly telegramUserId: number;
    readonly nextStep: 'cancelled' | 'completed';
    readonly nowMs: number;
  },
): Promise<EndCaptureOutcome> {
  const active = await getActiveCaptureSession(executor, {
    telegramUserId: input.telegramUserId,
    nowMs: input.nowMs,
  });
  if (!active.ok) {
    return { kind: 'refused', reason: active.reason };
  }
  const fence = await executor.run({
    sql: `UPDATE admin_sessions SET step = ?, updated_at = ?
          WHERE id = ? AND telegram_user_id = ? AND flow = ? AND step = 'active' AND expires_at > ?`,
    params: [
      input.nextStep,
      input.nowMs,
      active.session.id,
      input.telegramUserId,
      ALBUM_CAPTURE_SESSION_FLOW,
      input.nowMs,
    ],
  });
  if (fence.changes === 0) {
    return { kind: 'refused', reason: 'fence_lost' };
  }
  return { kind: 'ended', session: active.session };
}

export interface CapturedAssetInsert {
  readonly kind: 'photo' | 'video';
  readonly fileId: string;
  readonly ordinal: number;
}

export type FinishCaptureOutcome =
  | {
      readonly kind: 'finished';
      readonly sessionId: string;
      readonly state: AlbumCaptureState;
      readonly assetIds: readonly string[];
    }
  | {
      readonly kind: 'refused';
      readonly reason:
        'no_active_session' | 'state_corrupt' | 'fence_lost' | 'write_failed' | 'too_few_items';
    };

/**
 * The FENCED finish: the 2..10 bound is checked BEFORE any write (an
 * under-filled session is refused honestly and STAYS active); then ONE
 * batch commits the N candidate asset rows AND the session completion
 * together (a partial capture never exists). The rows are the OD-010
 * honest evidence: status 'candidate', rights 'unknown', the live
 * telegram_file_id, the deterministic capture-only canonical identity. A
 * duplicate deterministic id (an impossible re-finish through the fence)
 * is honest typed, never a silent overwrite.
 */
export async function finishAlbumCapture(
  executor: DbExecutor,
  input: {
    readonly telegramUserId: number;
    readonly nowMs: number;
  },
): Promise<FinishCaptureOutcome> {
  const active = await getActiveCaptureSession(executor, {
    telegramUserId: input.telegramUserId,
    nowMs: input.nowMs,
  });
  if (!active.ok) {
    return { kind: 'refused', reason: active.reason };
  }
  const session = active.session;
  if (session.state.items.length < ALBUM_CAPTURE_MIN_ITEMS) {
    return { kind: 'refused', reason: 'too_few_items' };
  }
  const statements = session.state.items.map((item) => ({
    sql: `INSERT INTO media_assets (id, type, canonical_url, rights_status, telegram_file_id, status, created_at, updated_at)
          VALUES (?, ?, ?, 'unknown', ?, 'candidate', ?, ?)`,
    params: [
      `album-cap-${session.id}-${item.ordinal}`,
      item.kind,
      capturedItemCanonicalUrl(session.id, item.ordinal),
      item.fileId,
      input.nowMs,
      input.nowMs,
    ],
  }));
  statements.push({
    sql: `UPDATE admin_sessions SET step = 'completed', updated_at = ?
          WHERE id = ? AND telegram_user_id = ? AND flow = ? AND step = 'active' AND expires_at > ?`,
    params: [
      input.nowMs,
      session.id,
      input.telegramUserId,
      ALBUM_CAPTURE_SESSION_FLOW,
      input.nowMs,
    ],
  });
  try {
    const metas = await executor.batch(statements);
    const completionMeta = metas[metas.length - 1];
    if ((completionMeta?.changes ?? 0) === 0) {
      // The completion fence lost (the session expired between the read
      // and the batch) — the batch is transactional, so NOTHING happened.
      return { kind: 'refused', reason: 'fence_lost' };
    }
  } catch (error) {
    if (isAppError(error) && error.code === 'db_constraint_violation') {
      return { kind: 'refused', reason: 'write_failed' };
    }
    throw error;
  }
  return {
    kind: 'finished',
    sessionId: session.id,
    state: session.state,
    assetIds: session.state.items.map((item) => `album-cap-${session.id}-${item.ordinal}`),
  };
}

/** The durable audit row of a finished capture (ONE per finish — the deterministic id). */
export async function recordAlbumCaptureAudit(
  executor: DbExecutor,
  input: {
    readonly sessionId: string;
    readonly actorId: string;
    readonly storyId: string;
    readonly itemCount: number;
    readonly nowMs: number;
  },
): Promise<void> {
  try {
    await executor.run({
      sql: `INSERT INTO audit_events (id, actor_type, actor_id, action, target_type,
              target_id, trace_id, metadata_json, created_at)
            VALUES (?, 'admin', ?, 'album_captured', 'album_capture_session', ?, NULL, ?, ?)`,
      params: [
        `album-capture:${input.sessionId}`,
        input.actorId,
        input.sessionId,
        JSON.stringify({
          captureVersion: 'ac1',
          storyId: input.storyId,
          itemCount: input.itemCount,
        }),
        input.nowMs,
      ],
    });
  } catch (error) {
    if (!(isAppError(error) && error.code === 'db_constraint_violation')) {
      throw error;
    }
    // The duplicate audit id absorption (see the docblock).
  }
}
