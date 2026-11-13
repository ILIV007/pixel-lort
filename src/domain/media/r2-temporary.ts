/**
 * Phase 7.2 — the R2 TEMPORARY-storage policy + lifecycle state machine
 * (blueprint §23 retention `temporary R2: 72 hours`, §14 steps 9–10,
 * architecture decision 5 `R2 stores temporary, rights-cleared media
 * only`, and the 7.3 roadmap bullet `file_id reuse` as the POLICY core).
 *
 * PURE — no R2 binding, no fetch, no I/O, no clock. This module is the
 * CONTRACT the (7.3+/Posidon-only) upload adapter must obey:
 *
 * - the retention is a FIXED 72-hour window over the STAGED timestamp
 *   (deterministic ISO math; invalid input fails typed);
 * - the lifecycle is a TOTAL typed state machine — every valid
 *   transition is explicit, EVERY other combination is
 *   `invalid_r2_transition`:
 *       staged ──upload_started──▶ upload_in_progress
 *       upload_in_progress ──upload_succeeded──▶ file_id_saved
 *       upload_in_progress ──upload_failed──▶ upload_failed
 *       upload_failed ──retry_scheduled──▶ staged        (bounded retry)
 *       upload_failed ──retention_lapsed──▶ retention_expired
 *       file_id_saved ──r2_object_deleted──▶ r2_object_deleted
 *   with BOTH r2_object_deleted and retention_expired TERMINAL;
 * - the REUSE RULE is enforced BY THE MACHINE: a saved file_id never
 *   re-uploads (`file_id_saved → upload_started` is an invalid
 *   transition — the adapter MUST reuse the saved file_id before any
 *   new download/upload; that is the free-tier economy);
 * - no CPU-heavy transcoding (the blueprint step-9 rule, pinned as a
 *   policy flag the adapter can assert against);
 * - NO measured free-tier usage claims anywhere — the caps are contract
 *   inputs, the real numbers are Posidon's to measure (the Phase 6 gate
 *   condition applies verbatim).
 */

export type R2TemporaryStateV1 =
  | 'staged'
  | 'upload_in_progress'
  | 'file_id_saved'
  | 'r2_object_deleted'
  | 'retention_expired'
  | 'upload_failed';

export type R2TemporaryEventV1 =
  | { readonly kind: 'upload_started' }
  | { readonly kind: 'upload_succeeded'; readonly fileId: string }
  | { readonly kind: 'upload_failed' }
  | { readonly kind: 'retry_scheduled' }
  | { readonly kind: 'r2_object_deleted' }
  | { readonly kind: 'retention_lapsed' };

export type R2TemporaryTransitionOutcomeV1 =
  | { ok: true; state: R2TemporaryStateV1; fileId?: string }
  | { ok: false; reason: 'invalid_r2_transition' | 'file_id_invalid' };

/** The FIXED R2 temporary-storage policy contract. */
export const R2_TEMPORARY_POLICY_V1 = {
  policyVersion: 'rtp1',
  retentionHours: 72,
  deleteAfterFileIdSave: true,
  fileIdReuseBeforeUpload: true,
  transcodingForbidden: true,
} as const;

const OPAQUE_FILE_ID_BOUND = 256;

function isBoundedFileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= OPAQUE_FILE_ID_BOUND &&
    /^[ -~]+$/.test(value)
  );
}

const RETENTION_MS = R2_TEMPORARY_POLICY_V1.retentionHours * 60 * 60 * 1000;

/**
 * The deterministic +72h retention deadline over the STAGED timestamp.
 */
export function retentionDeadline(
  stagedAtIso: string,
): { ok: true; deadlineIso: string } | { ok: false; reason: 'invalid_timestamp' } {
  if (typeof stagedAtIso !== 'string' || stagedAtIso.length === 0) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  const staged = new Date(stagedAtIso);
  if (Number.isNaN(staged.getTime())) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  return { ok: true, deadlineIso: new Date(staged.getTime() + RETENTION_MS).toISOString() };
}

/**
 * The total lifecycle transition (the reuse rule and the terminal
 * states are enforced BY THE MACHINE, not by caller discipline).
 */
export function transitionR2Temporary(
  state: R2TemporaryStateV1,
  event: R2TemporaryEventV1,
): R2TemporaryTransitionOutcomeV1 {
  if (
    typeof state !== 'string' ||
    typeof event !== 'object' ||
    event === null ||
    typeof event.kind !== 'string'
  ) {
    return { ok: false, reason: 'invalid_r2_transition' };
  }
  switch (state) {
    case 'staged':
      if (event.kind === 'upload_started') return { ok: true, state: 'upload_in_progress' };
      return { ok: false, reason: 'invalid_r2_transition' };
    case 'upload_in_progress':
      if (event.kind === 'upload_succeeded') {
        if (!isBoundedFileId(event.fileId)) return { ok: false, reason: 'file_id_invalid' };
        return { ok: true, state: 'file_id_saved', fileId: event.fileId };
      }
      if (event.kind === 'upload_failed') return { ok: true, state: 'upload_failed' };
      return { ok: false, reason: 'invalid_r2_transition' };
    case 'upload_failed':
      if (event.kind === 'retry_scheduled') return { ok: true, state: 'staged' };
      if (event.kind === 'retention_lapsed') return { ok: true, state: 'retention_expired' };
      return { ok: false, reason: 'invalid_r2_transition' };
    case 'file_id_saved':
      // The REUSE RULE: a saved file_id never re-uploads; the only exit
      // is the retention-scheduled deletion of the temporary object.
      if (event.kind === 'r2_object_deleted') return { ok: true, state: 'r2_object_deleted' };
      return { ok: false, reason: 'invalid_r2_transition' };
    case 'r2_object_deleted':
    case 'retention_expired':
      return { ok: false, reason: 'invalid_r2_transition' };
    default:
      return { ok: false, reason: 'invalid_r2_transition' };
  }
}
