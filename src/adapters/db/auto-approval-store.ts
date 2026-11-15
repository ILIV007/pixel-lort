import type { DbExecutor } from './db-executor';
import { isAppError } from '../../shared/errors/app-error';
import type { AutoGateVerdict } from '../../domain/publishing/auto-gate';
import { AUTO_GATE_VERSION } from '../../domain/publishing/auto-gate';

/**
 * THE DURABLE AUTO-APPROVAL TRANSITION (plan slice 3) — the ONE fenced
 * route a measurable AUTO-gate verdict takes to become the draft status
 * the schema-6 outbox matrix already consumes (`auto_approved`).
 *
 * THE HONESTY BOUNDARY (pinned by the slice-3 suite):
 *  - ELIGIBILITY IS NOT ACTIVATION: the caller must pass BOTH the eligible
 *    verdict AND the independent enablement flag (the same fail-closed
 *    flag discipline as every ADMIN / EDITORIAL feature surface — ships OFF).
 *    Either one missing refuses with ZERO writes.
 *  - THE MACHINE MINTS NO SILENT APPROVAL: the transition is an explicit
 *    call over an eligible verdict; it records ONE system audit event
 *    carrying the gate identity and the MEASURED data (version, claim
 *    count, fact-guard version) — never document content, never secrets.
 *  - THE HUMAN PATH IS NEVER FLIPPED: the fence is
 *    `WHERE id = ? AND status = 'ready'` — an 'approved' (human) draft,
 *    a superseded/failed draft or any other status refuses `not_ready`
 *    with ZERO writes; the UPDATE rowcount is the authority, and the
 *    post-fence re-read distinguishes the honest `already_auto_approved`
 *    absorption (idempotent re-call, no second audit event) from a lost
 *    race.
 *  - A NON-ELIGIBLE VERDICT REFUSES BEFORE ANY WRITE: a requires_review
 *    or refused verdict can never flip a row — the human path stays.
 *
 * The status vocabulary is UNTOUCHED: `auto_approved` is the blueprint
 * drafts CHECK value the outbox MODE_STATUS_MATRIX already accepts for the
 * 'auto'/'safe_auto' modes — this store is the producer that vocabulary
 * was missing. ZERO DDL (schema 6 UNCHANGED).
 */

/** The gate the transition accepts — drift between the modules is a type error. */
export type AutoApprovalGateVerdict = AutoGateVerdict;

export type ApproveDraftForAutoPublicationOutcome =
  | { readonly kind: 'applied' }
  | { readonly kind: 'already_auto_approved' }
  | { readonly kind: 'gate_disabled' }
  | { readonly kind: 'gate_not_eligible' }
  | { readonly kind: 'draft_not_found' }
  | { readonly kind: 'not_ready' };

/** The deterministic audit action (the query surface of the slice-3 suite). */
export const AUTO_APPROVAL_AUDIT_ACTION = 'draft_auto_approved' as const;
/** The system actor id — the gate identity, versioned (ag1). */
export const AUTO_APPROVAL_ACTOR_ID = `auto_gate:${AUTO_GATE_VERSION}` as const;

export async function approveDraftForAutoPublication(
  executor: DbExecutor,
  input: {
    readonly draftId: string;
    readonly gateVerdict: AutoApprovalGateVerdict;
    /** The independent enablement flag (default OFF in every deployment). */
    readonly gateEnabled: boolean;
    readonly nowMs: number;
  },
): Promise<ApproveDraftForAutoPublicationOutcome> {
  // 1. ELIGIBILITY IS NOT ACTIVATION — the flag first, then the verdict,
  //    both BEFORE any write.
  if (input.gateEnabled !== true) {
    return { kind: 'gate_disabled' };
  }
  if (input.gateVerdict.kind !== 'eligible_auto') {
    return { kind: 'gate_not_eligible' };
  }

  // 2. THE FENCED TRANSITION: only a 'ready' draft may become
  //    'auto_approved'. The rowcount is the authority.
  const fence = await executor.run({
    sql: `UPDATE drafts SET status = 'auto_approved', updated_at = ?
          WHERE id = ? AND status = 'ready'`,
    params: [input.nowMs, input.draftId],
  });
  if (fence.changes === 0) {
    // The fence did not fire: re-read for the HONEST reason — an idempotent
    // re-call (already auto_approved) is absorbed, a human/terminal state
    // is refused, a missing draft is reported, never guessed.
    const existing = await executor.first<{ readonly status: string }>({
      sql: `SELECT status FROM drafts WHERE id = ?`,
      params: [input.draftId],
    });
    if (!existing) {
      return { kind: 'draft_not_found' };
    }
    return existing.status === 'auto_approved'
      ? { kind: 'already_auto_approved' }
      : { kind: 'not_ready' };
  }

  // 3. THE AUDIT: ONE system event with the measured data. The metadata
  //    carries ids and counts only — never document content, never
  //    secrets. The audit failure does NOT roll back the fence (the
  //    status is the authority); it is recorded as the honest gap.
  try {
    await executor.run({
      sql: `INSERT INTO audit_events (id, actor_type, actor_id, action, target_type,
              target_id, trace_id, metadata_json, created_at)
            VALUES (?, 'system', ?, ?, 'draft', ?, NULL, ?, ?)`,
      params: [
        `auto-approval:${input.draftId}`,
        AUTO_APPROVAL_ACTOR_ID,
        AUTO_APPROVAL_AUDIT_ACTION,
        input.draftId,
        JSON.stringify({
          gateVersion: AUTO_GATE_VERSION,
          claimCount: input.gateVerdict.claimCount,
          factGuardVersion: input.gateVerdict.factGuardVersion,
          limitationLabels: input.gateVerdict.limitationLabels,
        }),
        input.nowMs,
      ],
    });
  } catch (error) {
    if (!(isAppError(error) && error.code === 'db_constraint_violation')) {
      throw error;
    }
    // A duplicate audit id means the fence fired twice for the same draft
    // within the same millisecond window — the audit absorption, never a
    // second event.
  }
  return { kind: 'applied' };
}
