/**
 * R1.20-R — admin post pipeline durable store (D1, ADR-0022 boundary).
 *
 * All statements are parameterized; SQL text, parameters, and rows are never
 * logged. Every state transition that decides a SIDE EFFECT (approve,
 * consume, publish claim/outcome, supersede) is a SINGLE GUARDED UPDATE whose
 * `changes` count is the outcome — concurrent callers produce exactly one
 * winner, and a stale/late caller can never mutate a newer owner's state.
 * Multi-row invariants (version insert + draft head update + older-approval
 * invalidation) are applied as ONE atomic `batch()` (implicit transaction).
 *
 * The store NEVER decides policy: it persists what the application service
 * validates, and returns honest typed outcomes.
 */
import type { DbExecutor } from './db-executor';
import { toDbAppError } from './d1-errors';
import { isAppError } from '../../shared/errors/app-error';

/** Bound on versions per open draft — conservative application cap. */
export const ADMIN_POST_MAX_VERSIONS = 50;

/** Draft lifecycle status (migration 0005 CHECK). */
export type AdminPostDraftStatus = 'open' | 'cancelled' | 'completed';

export interface AdminPostDraftRow {
  readonly id: string;
  readonly created_by_user_id: number;
  readonly status: string;
  readonly current_version: number;
}

export interface AdminPostVersionRow {
  readonly draft_id: string;
  readonly version: number;
  readonly envelope_json: string;
  readonly fingerprint: string;
}

export interface AdminPostApprovalRow {
  readonly draft_id: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly approved_by_user_id: number;
  readonly session_id: string;
  readonly state: string;
}

export interface AdminPostPublicationRow {
  readonly id: string;
  readonly draft_id: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly destination: string;
  readonly state: string;
  readonly attempt: number;
  readonly supersede_of: string | null;
  readonly claimed_by: string | null;
  readonly lease_expires_at_ms: number | null;
  readonly bot_message_id: number | null;
  readonly error_code: string | null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function requireUserId(value: number): number {
  if (!isPositiveSafeInteger(value)) {
    // Stable constant message only — the value is never echoed.
    throw new Error('admin post store rejected: invalid user id');
  }
  return value;
}

function requireFingerprint(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('admin post store rejected: invalid fingerprint');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Drafts + versions
// ---------------------------------------------------------------------------

export async function findOpenDraftByCreator(
  executor: DbExecutor,
  telegramUserId: number,
): Promise<AdminPostDraftRow | null> {
  return executor.first<AdminPostDraftRow>({
    sql: `SELECT id, created_by_user_id, status, current_version
          FROM admin_post_drafts
          WHERE created_by_user_id = ? AND status = 'open'
          ORDER BY updated_at_ms DESC
          LIMIT 1`,
    params: [requireUserId(telegramUserId)],
  });
}

export async function getDraft(
  executor: DbExecutor,
  draftId: string,
): Promise<AdminPostDraftRow | null> {
  return executor.first<AdminPostDraftRow>({
    sql: 'SELECT id, created_by_user_id, status, current_version FROM admin_post_drafts WHERE id = ?',
    params: [draftId],
  });
}

export async function getVersion(
  executor: DbExecutor,
  draftId: string,
  version: number,
): Promise<AdminPostVersionRow | null> {
  return executor.first<AdminPostVersionRow>({
    sql: `SELECT draft_id, version, envelope_json, fingerprint
          FROM admin_post_versions WHERE draft_id = ? AND version = ?`,
    params: [draftId, version],
  });
}

export async function findVersionBySourceUpdate(
  executor: DbExecutor,
  sourceUpdateId: number,
  telegramUserId: number,
): Promise<AdminPostVersionRow | null> {
  return executor.first<AdminPostVersionRow>({
    sql: `SELECT draft_id, version, envelope_json, fingerprint
          FROM admin_post_versions
          WHERE source_update_id = ? AND created_by_user_id = ?
          ORDER BY created_at_ms DESC
          LIMIT 1`,
    params: [sourceUpdateId, requireUserId(telegramUserId)],
  });
}

export type CaptureOutcome =
  | { readonly kind: 'created'; readonly draftId: string; readonly version: number }
  | { readonly kind: 'version_added'; readonly draftId: string; readonly version: number }
  | { readonly kind: 'limit_reached'; readonly draftId: string; readonly version: number };

/**
 * Capture one new version ATOMICALLY: version insert + draft head update +
 * invalidation of every still-active approval for OLDER versions run as one
 * batch — a content update can never leave a stale active approval behind,
 * even under concurrent captures (the guarded head UPDATE is the fence).
 */
export async function captureVersion(
  executor: DbExecutor,
  input: {
    readonly draftId: string;
    readonly existingDraftId: string | undefined;
    readonly envelopeJson: string;
    readonly fingerprint: string;
    readonly sourceUpdateId: number;
    readonly telegramUserId: number;
    readonly nowMs: number;
  },
): Promise<CaptureOutcome> {
  const userId = requireUserId(input.telegramUserId);
  const fingerprint = requireFingerprint(input.fingerprint);
  if (input.existingDraftId === undefined) {
    try {
      await executor.batch([
        {
          sql: `INSERT INTO admin_post_drafts
                  (id, created_by_user_id, status, current_version, created_at_ms, updated_at_ms)
                VALUES (?, ?, 'open', 1, ?, ?)`,
          params: [input.draftId, userId, input.nowMs, input.nowMs],
        },
        {
          sql: `INSERT INTO admin_post_versions
                  (draft_id, version, envelope_json, fingerprint, source_update_id, created_by_user_id, created_at_ms)
                VALUES (?, 1, ?, ?, ?, ?, ?)`,
          params: [
            input.draftId,
            input.envelopeJson,
            fingerprint,
            input.sourceUpdateId,
            userId,
            input.nowMs,
          ],
        },
      ]);
      return { kind: 'created', draftId: input.draftId, version: 1 };
    } catch (error) {
      // A concurrent capture created the same creator's open draft first —
      // honest retryable failure (the caller's update is redelivered and the
      // duplicate-source-update guard resolves it then).
      if (isAppError(error) && error.code === 'db_constraint_violation') {
        throw toDbAppError(new Error('admin post draft id collision'));
      }
      throw error;
    }
  }

  // Existing open draft: read the head, then write the next version fenced
  // by the observed head (a concurrent version bump makes our UPDATE match
  // zero rows and the whole batch rolls back).
  const draft = await getDraft(executor, input.existingDraftId);
  if (draft === null || draft.status !== 'open') {
    throw toDbAppError(new Error('admin post open draft vanished'));
  }
  const nextVersion = draft.current_version + 1;
  if (nextVersion > ADMIN_POST_MAX_VERSIONS) {
    return {
      kind: 'limit_reached',
      draftId: draft.id,
      version: draft.current_version,
    };
  }
  const metas = await executor.batch([
    {
      sql: `INSERT INTO admin_post_versions
              (draft_id, version, envelope_json, fingerprint, source_update_id, created_by_user_id, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        draft.id,
        nextVersion,
        input.envelopeJson,
        fingerprint,
        input.sourceUpdateId,
        userId,
        input.nowMs,
      ],
    },
    {
      sql: `UPDATE admin_post_drafts
              SET current_version = ?, updated_at_ms = ?
            WHERE id = ? AND status = 'open' AND current_version = ?`,
      params: [nextVersion, input.nowMs, draft.id, draft.current_version],
    },
    {
      sql: `UPDATE admin_post_approvals
              SET state = 'invalidated'
            WHERE draft_id = ? AND version < ? AND state = 'active'`,
      params: [draft.id, nextVersion],
    },
  ]);
  const headMeta = metas[1];
  if (headMeta === undefined || headMeta.changes !== 1) {
    // The fence rejected the head update: a concurrent capture moved the
    // draft forward first. The batch above is atomic, so our version insert
    // rolled back — surface a retryable storage failure (Telegram
    // redelivers, and the duplicate-source-update guard resolves it).
    throw toDbAppError(new Error('admin post capture lost the head race'));
  }
  return { kind: 'version_added', draftId: draft.id, version: nextVersion };
}

export type CancelOutcome = { readonly kind: 'cancelled' } | { readonly kind: 'not_open' };

/** Cancel the creator's open draft and invalidate its active approvals. */
export async function cancelOpenDraft(
  executor: DbExecutor,
  input: { readonly draftId: string; readonly telegramUserId: number; readonly nowMs: number },
): Promise<CancelOutcome> {
  const metas = await executor.batch([
    {
      sql: `UPDATE admin_post_drafts
              SET status = 'cancelled', updated_at_ms = ?
            WHERE id = ? AND created_by_user_id = ? AND status = 'open'`,
      params: [input.nowMs, input.draftId, requireUserId(input.telegramUserId)],
    },
    {
      sql: `UPDATE admin_post_approvals
              SET state = 'invalidated'
            WHERE draft_id = ? AND state = 'active'`,
      params: [input.draftId],
    },
  ]);
  const headMeta = metas[0];
  return headMeta !== undefined && headMeta.changes === 1
    ? { kind: 'cancelled' }
    : { kind: 'not_open' };
}

// ---------------------------------------------------------------------------
// Capture session (R1.20-R1) — the EXPLICIT registration session.
//
// Stored in the EXISTING blueprint `settings` table (ADR-0019) under the
// dedicated `admin_post_capture:<telegram_user_id>` key namespace — no
// schema change, strict separation from every other settings namespace
// (same pattern as the admin UI language preference). The value is a small
// validated JSON document; an unreadable row is treated as CLOSED (fail
// closed — a corrupt row can never silently enable capture).
//
//   { "state": "open", "started_at_ms": <epoch ms>, "started_update_id": <n> }
// ---------------------------------------------------------------------------

export const ADMIN_POST_CAPTURE_SETTINGS_PREFIX = 'admin_post_capture:';

export interface AdminPostCaptureSession {
  readonly open: boolean;
  readonly startedAtMs: number;
}

function captureSettingsKey(telegramUserId: number): string {
  return `${ADMIN_POST_CAPTURE_SETTINGS_PREFIX}${requireUserId(telegramUserId)}`;
}

function parseCaptureSession(valueJson: string): AdminPostCaptureSession | null {
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record['state'] !== 'open') {
      return null;
    }
    const startedAtMs = record['started_at_ms'];
    if (typeof startedAtMs !== 'number' || !Number.isSafeInteger(startedAtMs) || startedAtMs <= 0) {
      return null;
    }
    return { open: true, startedAtMs };
  } catch {
    return null;
  }
}

/**
 * Open (or re-open) the admin's capture session — ONE atomic upsert.
 * Idempotent: a redelivered /post re-applies the same state.
 */
export async function openCaptureSession(
  executor: DbExecutor,
  input: {
    readonly telegramUserId: number;
    readonly startedAtMs: number;
    readonly updateId: number;
  },
): Promise<void> {
  const valueJson = JSON.stringify({
    state: 'open',
    started_at_ms: input.startedAtMs,
    started_update_id: input.updateId,
  });
  await executor.run({
    sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
          VALUES (?, ?, 1, NULL, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at`,
    params: [captureSettingsKey(input.telegramUserId), valueJson, input.startedAtMs],
  });
}

/** The admin's capture session, or null when none is open (corrupt = closed). */
export async function findOpenCaptureSession(
  executor: DbExecutor,
  telegramUserId: number,
): Promise<AdminPostCaptureSession | null> {
  const row = await executor.first<{ value_json: string }>({
    sql: 'SELECT value_json FROM settings WHERE key = ?',
    params: [captureSettingsKey(telegramUserId)],
  });
  if (row === null) {
    return null;
  }
  const session = parseCaptureSession(row.value_json);
  return session !== null && session.open ? session : null;
}

/** Close the admin's capture session (idempotent DELETE). */
export async function closeCaptureSession(
  executor: DbExecutor,
  telegramUserId: number,
): Promise<void> {
  await executor.run({
    sql: 'DELETE FROM settings WHERE key = ?',
    params: [captureSettingsKey(telegramUserId)],
  });
}

// ---------------------------------------------------------------------------
// Preview sessions
// ---------------------------------------------------------------------------

export interface AdminPostPreviewSessionRow {
  readonly id: string;
  readonly draft_id: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly expires_at_ms: number;
}

export async function createPreviewSession(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly draftId: string;
    readonly version: number;
    readonly fingerprint: string;
    readonly previewChatId: number;
    readonly sourceUpdateId: number;
    readonly expiresAtMs: number;
    readonly nowMs: number;
  },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO admin_post_preview_sessions
            (id, draft_id, version, fingerprint, preview_chat_id, source_update_id, expires_at_ms, created_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      input.id,
      input.draftId,
      input.version,
      requireFingerprint(input.fingerprint),
      input.previewChatId,
      input.sourceUpdateId,
      input.expiresAtMs,
      input.nowMs,
    ],
  });
}

export async function findPreviewSessionBySourceUpdate(
  executor: DbExecutor,
  sourceUpdateId: number,
): Promise<AdminPostPreviewSessionRow | null> {
  return executor.first<AdminPostPreviewSessionRow>({
    sql: `SELECT id, draft_id, version, fingerprint, expires_at_ms
          FROM admin_post_preview_sessions
          WHERE source_update_id = ?
          ORDER BY created_at_ms DESC
          LIMIT 1`,
    params: [sourceUpdateId],
  });
}

export async function getPreviewSession(
  executor: DbExecutor,
  sessionId: string,
): Promise<AdminPostPreviewSessionRow | null> {
  return executor.first<AdminPostPreviewSessionRow>({
    sql: `SELECT id, draft_id, version, fingerprint, expires_at_ms
          FROM admin_post_preview_sessions WHERE id = ?`,
    params: [sessionId],
  });
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export async function getApproval(
  executor: DbExecutor,
  draftId: string,
  version: number,
): Promise<AdminPostApprovalRow | null> {
  return executor.first<AdminPostApprovalRow>({
    sql: `SELECT draft_id, version, fingerprint, approved_by_user_id, session_id, state
          FROM admin_post_approvals WHERE draft_id = ? AND version = ?`,
    params: [draftId, version],
  });
}

export type ApproveOutcome = { readonly kind: 'approved' } | { readonly kind: 'already_active' };

/**
 * Record an approval for the EXACT version/fingerprint. One ACTIVE approval
 * per (draft, version): a concurrent or duplicate approver loses the guarded
 * upsert and receives the honest `already_active` outcome.
 */
export async function recordApproval(
  executor: DbExecutor,
  input: {
    readonly draftId: string;
    readonly version: number;
    readonly fingerprint: string;
    readonly telegramUserId: number;
    readonly sessionId: string;
    readonly nowMs: number;
  },
): Promise<ApproveOutcome> {
  const meta = await executor.run({
    sql: `INSERT INTO admin_post_approvals
            (draft_id, version, fingerprint, approved_by_user_id, session_id, state, approved_at_ms)
          VALUES (?, ?, ?, ?, ?, 'active', ?)
          ON CONFLICT(draft_id, version) DO UPDATE SET
            fingerprint = excluded.fingerprint,
            approved_by_user_id = excluded.approved_by_user_id,
            session_id = excluded.session_id,
            state = 'active',
            approved_at_ms = excluded.approved_at_ms
          WHERE admin_post_approvals.state != 'active'`,
    params: [
      input.draftId,
      input.version,
      requireFingerprint(input.fingerprint),
      requireUserId(input.telegramUserId),
      input.sessionId,
      input.nowMs,
    ],
  });
  return meta.changes === 1 ? { kind: 'approved' } : { kind: 'already_active' };
}

export type ConsumeApprovalOutcome =
  { readonly kind: 'consumed' } | { readonly kind: 'not_active' };

/**
 * Consume the ACTIVE approval for (draft, version) — fenced by the exact
 * fingerprint so an approval can never be spent on different content.
 */
export async function consumeApproval(
  executor: DbExecutor,
  input: {
    readonly draftId: string;
    readonly version: number;
    readonly fingerprint: string;
  },
): Promise<ConsumeApprovalOutcome> {
  const meta = await executor.run({
    sql: `UPDATE admin_post_approvals
            SET state = 'consumed'
          WHERE draft_id = ? AND version = ? AND fingerprint = ? AND state = 'active'`,
    params: [input.draftId, input.version, requireFingerprint(input.fingerprint)],
  });
  return meta.changes === 1 ? { kind: 'consumed' } : { kind: 'not_active' };
}

export type ApproveFencedOutcome =
  | { readonly kind: 'approved' }
  | { readonly kind: 'already_active' }
  /** The draft head moved (or the draft closed) between the bind and the write. */
  | { readonly kind: 'stale' };

/**
 * R1.20-R1 — record an approval FENCED BY THE DRAFT HEAD, atomically: one
 * batch runs the head-fence UPDATE (matches only when the draft is open and
 * `current_version` is still the version being approved) and the approval
 * upsert together. This closes the approve-vs-capture race window: a
 * capture that commits between the application-level bind and this write
 * makes the fence match ZERO rows and the WHOLE batch rolls back — a stale
 * active approval for an old version can never be left behind.
 */
export async function recordApprovalFenced(
  executor: DbExecutor,
  input: {
    readonly draftId: string;
    readonly version: number;
    readonly fingerprint: string;
    readonly telegramUserId: number;
    readonly sessionId: string;
    readonly nowMs: number;
  },
): Promise<ApproveFencedOutcome> {
  const metas = await executor.batch([
    {
      sql: `UPDATE admin_post_drafts
              SET updated_at_ms = updated_at_ms
            WHERE id = ? AND status = 'open' AND current_version = ?`,
      params: [input.draftId, input.version],
    },
    {
      sql: `INSERT INTO admin_post_approvals
              (draft_id, version, fingerprint, approved_by_user_id, session_id, state, approved_at_ms)
            VALUES (?, ?, ?, ?, ?, 'active', ?)
            ON CONFLICT(draft_id, version) DO UPDATE SET
              fingerprint = excluded.fingerprint,
              approved_by_user_id = excluded.approved_by_user_id,
              session_id = excluded.session_id,
              state = 'active',
              approved_at_ms = excluded.approved_at_ms
            WHERE admin_post_approvals.state != 'active'`,
      params: [
        input.draftId,
        input.version,
        requireFingerprint(input.fingerprint),
        requireUserId(input.telegramUserId),
        input.sessionId,
        input.nowMs,
      ],
    },
  ]);
  const fenceMeta = metas[0];
  if (fenceMeta === undefined || fenceMeta.changes !== 1) {
    return { kind: 'stale' };
  }
  const upsertMeta = metas[1];
  return upsertMeta !== undefined && upsertMeta.changes === 1
    ? { kind: 'approved' }
    : { kind: 'already_active' };
}

// ---------------------------------------------------------------------------
// Publications (the outbox)
// ---------------------------------------------------------------------------

export async function getPublication(
  executor: DbExecutor,
  publicationId: string,
): Promise<AdminPostPublicationRow | null> {
  return executor.first<AdminPostPublicationRow>({
    sql: `SELECT id, draft_id, version, fingerprint, destination, state, attempt, supersede_of,
                 claimed_by, lease_expires_at_ms, bot_message_id, error_code
          FROM admin_post_publications WHERE id = ?`,
    params: [publicationId],
  });
}

export async function findPrimaryPublication(
  executor: DbExecutor,
  draftId: string,
  version: number,
): Promise<AdminPostPublicationRow | null> {
  return executor.first<AdminPostPublicationRow>({
    sql: `SELECT id, draft_id, version, fingerprint, destination, state, attempt, supersede_of,
                 claimed_by, lease_expires_at_ms, bot_message_id, error_code
          FROM admin_post_publications
          WHERE draft_id = ? AND version = ? AND supersede_of IS NULL`,
    params: [draftId, version],
  });
}

export type CreatePublicationOutcome =
  | { readonly kind: 'created'; readonly publicationId: string }
  | { readonly kind: 'already_exists' };

/** Enqueue one publication — the partial UNIQUE index admits exactly one primary row per version. */
export async function createPublication(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly draftId: string;
    readonly version: number;
    readonly fingerprint: string;
    readonly destination: string;
    readonly supersedeOf?: string;
    readonly attempt: number;
    readonly nowMs: number;
  },
): Promise<CreatePublicationOutcome> {
  try {
    await executor.run({
      sql: `INSERT INTO admin_post_publications
              (id, draft_id, version, fingerprint, destination, state, attempt, supersede_of,
               created_at_ms, updated_at_ms)
            VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      params: [
        input.id,
        input.draftId,
        input.version,
        requireFingerprint(input.fingerprint),
        input.destination,
        input.attempt,
        input.supersedeOf ?? null,
        input.nowMs,
        input.nowMs,
      ],
    });
    return { kind: 'created', publicationId: input.id };
  } catch (error) {
    if (isAppError(error) && error.code === 'db_constraint_violation') {
      return { kind: 'already_exists' };
    }
    throw error;
  }
}

export type ClaimPublicationOutcome =
  { readonly kind: 'claimed'; readonly claimedBy: string } | { readonly kind: 'not_queued' };

/**
 * Claim a queued publication for sending: `queued -> claimed` with a lease
 * and an owner identity. Exactly one concurrent caller wins; everyone else
 * observes `not_queued`.
 */
export async function claimPublication(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly claimedBy: string;
    readonly leaseMs: number;
    readonly nowMs: number;
  },
): Promise<ClaimPublicationOutcome> {
  const meta = await executor.run({
    sql: `UPDATE admin_post_publications
            SET state = 'claimed', claimed_by = ?, lease_expires_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'queued'`,
    params: [input.claimedBy, input.nowMs + input.leaseMs, input.nowMs, input.publicationId],
  });
  return meta.changes === 1
    ? { kind: 'claimed', claimedBy: input.claimedBy }
    : { kind: 'not_queued' };
}

export type FinishPublicationOutcome =
  { readonly kind: 'recorded' } | { readonly kind: 'fence_rejected' };

/**
 * Record the send outcome — FENCED by (state='claimed', claimed_by): a late
 * response from a worker whose lease expired or whose claim was superseded
 * can NEVER overwrite the newer state (it is observable as
 * `fence_rejected`, logged by the service; nothing else changes).
 */
export async function finishPublication(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly claimedBy: string;
    readonly state: 'sent' | 'failed_definitive' | 'uncertain';
    readonly botMessageId?: number;
    readonly errorCode?: string;
    readonly nowMs: number;
  },
): Promise<FinishPublicationOutcome> {
  const meta = await executor.run({
    sql: `UPDATE admin_post_publications
            SET state = ?, bot_message_id = ?, error_code = ?, updated_at_ms = ?
          WHERE id = ? AND state = 'claimed' AND claimed_by = ?`,
    params: [
      input.state,
      input.botMessageId ?? null,
      input.errorCode ?? null,
      input.nowMs,
      input.publicationId,
      input.claimedBy,
    ],
  });
  return meta.changes === 1 ? { kind: 'recorded' } : { kind: 'fence_rejected' };
}

export type SupersedeOutcome =
  { readonly kind: 'superseded' } | { readonly kind: 'not_resendable' };

/**
 * Mark a finished-but-unconfirmed publication (`uncertain`, or a `claimed`
 * row whose lease expired, or a definitive failure) as superseded — the
 * explicit human-confirmed gate that unlocks the ONLY legal re-send of a
 * version. Nothing else may create a second publication for a version.
 */
export async function supersedePublication(
  executor: DbExecutor,
  input: {
    readonly publicationId: string;
    readonly nowMs: number;
  },
): Promise<SupersedeOutcome> {
  const meta = await executor.run({
    sql: `UPDATE admin_post_publications
            SET state = 'superseded', updated_at_ms = ?
          WHERE id = ? AND (
            state = 'failed_definitive'
            OR state = 'uncertain'
            OR (state = 'claimed' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < ?)
          )`,
    params: [input.nowMs, input.publicationId, input.nowMs],
  });
  return meta.changes === 1 ? { kind: 'superseded' } : { kind: 'not_resendable' };
}

// ---------------------------------------------------------------------------
// R1.20-R1 — ATOMIC approval-consume + publication-create, and ATOMIC
// supersede + replacement-create. Each pair runs as ONE atomic batch (D1
// batches are implicit transactions) with the INSERT conditioned on the
// guarded transition ACTUALLY having happened (the second statement's
// subqueries see the first statement's intra-transaction effects). A crash
// or a losing race therefore can never leave a half transition behind:
//   - a consumed approval with NO publication is impossible from these
//     functions (and the conditional insert doubles as the honest RECOVERY
//     path for the historical crash state: a legitimately-consumed approval
//     whose publication creation never happened recreates the publication
//     for the SAME fingerprint — the consumed approval IS the proof);
//   - a superseded publication with NO replacement is impossible (the
//     insert happens only when the old row is already superseded inside
//     the same transaction).
// ---------------------------------------------------------------------------

export type ConsumeAndPublishOutcome =
  | { readonly kind: 'created'; readonly publicationId: string }
  | { readonly kind: 'not_active' }
  | { readonly kind: 'already_exists' };

export async function consumeApprovalAndCreatePublication(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly draftId: string;
    readonly version: number;
    readonly fingerprint: string;
    readonly destination: string;
    readonly attempt: number;
    readonly nowMs: number;
  },
): Promise<ConsumeAndPublishOutcome> {
  const fingerprint = requireFingerprint(input.fingerprint);
  try {
    const metas = await executor.batch([
      {
        sql: `UPDATE admin_post_approvals
                SET state = 'consumed'
              WHERE draft_id = ? AND version = ? AND fingerprint = ? AND state = 'active'`,
        params: [input.draftId, input.version, fingerprint],
      },
      {
        sql: `INSERT INTO admin_post_publications
                (id, draft_id, version, fingerprint, destination, state, attempt, supersede_of,
                 created_at_ms, updated_at_ms)
              SELECT ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, ?
              WHERE EXISTS (
                    SELECT 1 FROM admin_post_approvals
                     WHERE draft_id = ? AND version = ? AND fingerprint = ?
                       AND state = 'consumed')
                AND NOT EXISTS (
                    SELECT 1 FROM admin_post_publications
                     WHERE draft_id = ? AND version = ? AND supersede_of IS NULL)`,
        params: [
          input.id,
          input.draftId,
          input.version,
          fingerprint,
          input.destination,
          input.attempt,
          input.nowMs,
          input.nowMs,
          input.draftId,
          input.version,
          fingerprint,
          input.draftId,
          input.version,
        ],
      },
    ]);
    const insertMeta = metas[1];
    if (insertMeta !== undefined && insertMeta.changes === 1) {
      return { kind: 'created', publicationId: input.id };
    }
    // Nothing was inserted: distinguish the honest outcomes — a concurrent
    // winner's primary publication (the approval stays with the winner) vs
    // a genuinely missing/invalidated approval.
    const primary = await findPrimaryPublication(executor, input.draftId, input.version);
    return primary !== null ? { kind: 'already_exists' } : { kind: 'not_active' };
  } catch (error) {
    if (isAppError(error) && error.code === 'db_constraint_violation') {
      // A concurrent creator won the primary insert; the WHOLE batch (and
      // our consume) rolled back — the winner's own consumption stands.
      return { kind: 'already_exists' };
    }
    throw error;
  }
}

export type SupersedeAndCreateOutcome =
  | { readonly kind: 'created'; readonly publicationId: string }
  | { readonly kind: 'not_resendable' };

export async function supersedeAndCreatePublication(
  executor: DbExecutor,
  input: {
    readonly id: string;
    readonly draftId: string;
    readonly version: number;
    readonly fingerprint: string;
    readonly destination: string;
    readonly attempt: number;
    readonly supersedeOf: string;
    /**
     * A batch-unique marker (e.g. a fresh random token): the guarded
     * supersede stamps it on the row, and the conditional insert happens
     * ONLY for the row carrying THIS batch's marker — a second confirm can
     * never ride a PREVIOUS batch's supersede (the state alone would not
     * prove that).
     */
    readonly supersedeMarker: string;
    readonly nowMs: number;
  },
): Promise<SupersedeAndCreateOutcome> {
  const fingerprint = requireFingerprint(input.fingerprint);
  const metas = await executor.batch([
    {
      sql: `UPDATE admin_post_publications
              SET state = 'superseded', claimed_by = ?, updated_at_ms = ?
            WHERE id = ? AND (
              state = 'failed_definitive'
              OR state = 'uncertain'
              OR (state = 'claimed' AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms < ?)
            )`,
      params: [input.supersedeMarker, input.nowMs, input.supersedeOf, input.nowMs],
    },
    {
      sql: `INSERT INTO admin_post_publications
              (id, draft_id, version, fingerprint, destination, state, attempt, supersede_of,
               created_at_ms, updated_at_ms)
            SELECT ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?
            WHERE EXISTS (
                  SELECT 1 FROM admin_post_publications
                   WHERE id = ? AND state = 'superseded' AND claimed_by = ?)`,
      params: [
        input.id,
        input.draftId,
        input.version,
        fingerprint,
        input.destination,
        input.attempt,
        input.supersedeOf,
        input.nowMs,
        input.nowMs,
        input.supersedeOf,
        input.supersedeMarker,
      ],
    },
  ]);
  const insertMeta = metas[1];
  return insertMeta !== undefined && insertMeta.changes === 1
    ? { kind: 'created', publicationId: input.id }
    : { kind: 'not_resendable' };
}
