/**
 * Phase 8.4 — the EDIT/CORRECTION policy (ecl1): the pure, deterministic,
 * TOTAL decision layer the correction workflow consumes (the blueprint §15
 * scenarios). The engine
 * (src/application/publishing/edit-correction-engine.ts) turns the decision
 * into durable, at-most-once effects; this module owns ONLY the decision.
 *
 * The blueprint §15 scenarios pinned here:
 *  - «Same story, minor detail» — no new post, no channel effect (the
 *    internal story/draft update is the caller's concern, not the
 *    publication outbox's);
 *  - «Same story, meaningful update» — the policy chooses edit, follow-up,
 *    or both based on elapsed time and claim significance;
 *  - «Rumor confirmed» — edit the old message label/uncertainty when
 *    possible; publish the follow-up when the confirmation is materially
 *    newsworthy;
 *  - «Rumor denied» — edit the old post to show the denial and optionally
 *    publish the correction; NEVER a silent delete (no delete path exists
 *    anywhere in the outbox);
 *  - «correction» — the explicit editorial correction of already-published
 *    content mirrors the denial semantics.
 *
 * The EDIT REACH WINDOW (pinned 48h): an in-place edit only reaches readers
 * while the post is still on their screens; after the pinned window an edit
 * is invisible churn, so the plan falls back to the follow-up. The window
 * is a DOCUMENTED policy constant, not a fact about Telegram.
 *
 * The machine rules (pol1 is the authority — the 8.2 outbox lifecycle):
 *  - pending/retry_wait/published/failed are the supersedable set (every
 *    member has the machine-legal (status, 'supersede') transition);
 *  - a claimed/publishing row is OWNED by an in-flight generation — the
 *    correction workflow refuses to act on it (`not_supersedable`); the
 *    supersede of the DRAFT (markDraftSuperseded) is the crash-safe route
 *    for such rows: the eligibility check dead-letters them without a send;
 *  - the terminal rows (dead_letter/cancelled/superseded) have no machine
 *    exits — a follow-up over them skips the supersede (honest:
 *    `prior_inactive_supersede_skipped`), it never resurrects them.
 *
 * Pure: no I/O, no clock, no SQL, no randomness; JSON-equal deterministic
 * (the 7.2/8.1/8.2 house pattern).
 */

import { isPublicationStatus } from './outbox-lifecycle';
import { sha256Hex } from '../../shared/ids/idempotency-key';

export const EDIT_CORRECTION_POLICY_VERSION = 'ecl1' as const;

/**
 * The pinned edit reach window: an in-place edit is planned only when the
 * prior delivery is younger than this. After the window the post is off the
 * readers' screens — the plan prefers the follow-up post.
 */
export const EDIT_REACH_WINDOW_MS = 48 * 3_600_000;

/** The blueprint §15 correction classes (the TOTAL decision vocabulary). */
export const CORRECTION_CLASSES = [
  'minor_detail',
  'meaningful_update',
  'rumor_confirmed',
  'rumor_denied',
  'correction',
] as const;

export type CorrectionClass = (typeof CORRECTION_CLASSES)[number];

export function isCorrectionClass(value: string): value is CorrectionClass {
  return (CORRECTION_CLASSES as readonly string[]).includes(value);
}

/**
 * The dispositions. `edit_and_follow_up` means BOTH effects are planned
 * (each applied independently — a failed edit never blocks the follow-up).
 */
export type CorrectionDisposition = 'none' | 'edit' | 'follow_up' | 'edit_and_follow_up';

/** The prior publication context the decision reads. */
export interface CorrectionPriorContext {
  /** The prior publication's status (a REAL pol1 vocabulary value). */
  readonly status: string;
  /** The recorded `publication_messages` rows (the edit targets). */
  readonly recordedMessages: number;
  /** The prior delivery time; null for never-published rows. */
  readonly publishedAtMs: number | null;
}

export interface CorrectionPlanInput {
  readonly correctionClass: string;
  readonly prior: CorrectionPriorContext;
  /** The draft-level «materially newsworthy» assessment (blueprint §15). */
  readonly followUpMaterial: boolean;
  /** The editorial choice for a correction follow-up (blueprint §15 denial). */
  readonly correctionFollowUpDesired: boolean;
  readonly nowMs: number;
}

export type CorrectionPlan =
  | {
      readonly ok: true;
      readonly disposition: CorrectionDisposition;
      /** Whether an in-place edit was REACHABLE for this decision. */
      readonly editWithinWindow: boolean;
      /** The applied rule names, in application order. */
      readonly reasons: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid_input' | 'not_supersedable' | 'no_edit_target';
    };

/**
 * The machine-legal supersedable statuses: every member has the
 * (status, 'supersede') transition in pol1's table.
 */
export const SUPERSEDABLE_PUBLICATION_STATUSES = [
  'pending',
  'retry_wait',
  'published',
  'failed',
] as const;

/**
 * Why an in-place edit is unavailable. `no_edit_target` — nothing was
 * recorded in `publication_messages`; `prior_not_published` — the prior row
 * was never confirmed delivered; `edit_window_expired` — outside the pinned
 * reach window (or a future published_at: clock skew is conservative).
 */
export type EditUnavailabilityReason =
  'no_edit_target' | 'prior_not_published' | 'edit_window_expired';

function editUnavailabilityReason(input: CorrectionPlanInput): EditUnavailabilityReason {
  const prior = input.prior;
  if (prior.recordedMessages < 1) {
    return 'no_edit_target';
  }
  if (prior.status !== 'published' || prior.publishedAtMs === null) {
    return 'prior_not_published';
  }
  const elapsed = input.nowMs - prior.publishedAtMs;
  if (elapsed < 0 || elapsed > EDIT_REACH_WINDOW_MS) {
    return 'edit_window_expired';
  }
  return 'edit_window_expired'; // unreachable when !editable — exhaustiveness
}

function isEditReachable(input: CorrectionPlanInput): boolean {
  const prior = input.prior;
  if (prior.recordedMessages < 1) return false;
  if (prior.status !== 'published' || prior.publishedAtMs === null) return false;
  return isEditWithinWindow(input);
}

/** The TIME reachability only (the reported `editWithinWindow` field). */
function isEditWithinWindow(input: CorrectionPlanInput): boolean {
  const prior = input.prior;
  if (prior.publishedAtMs === null) return false;
  const elapsed = input.nowMs - prior.publishedAtMs;
  return elapsed >= 0 && elapsed <= EDIT_REACH_WINDOW_MS;
}

/**
 * The TOTAL decision function. Order of authority:
 *  1. typed validation (unknown class/status, malformed numbers ⇒
 *     `invalid_input` — never a guessed plan);
 *  2. the minor-detail short-circuit (no row action at all — safe even for
 *     an in-flight prior);
 *  3. the in-flight refusal (claimed/publishing ⇒ `not_supersedable` — the
 *     engine must not touch a row a generation owns);
 *  4. the blueprint §15 matrix over active vs terminal priors.
 */
export function planCorrectionDisposition(input: CorrectionPlanInput): CorrectionPlan {
  const prior = input.prior;
  if (!isCorrectionClass(input.correctionClass)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!isPublicationStatus(prior.status)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!Number.isInteger(prior.recordedMessages) || prior.recordedMessages < 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (
    prior.publishedAtMs !== null &&
    (!Number.isInteger(prior.publishedAtMs) || prior.publishedAtMs < 0)
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!Number.isInteger(input.nowMs) || input.nowMs < 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (
    typeof input.followUpMaterial !== 'boolean' ||
    typeof input.correctionFollowUpDesired !== 'boolean'
  ) {
    return { ok: false, reason: 'invalid_input' };
  }

  if (input.correctionClass === 'minor_detail') {
    return {
      ok: true,
      disposition: 'none',
      editWithinWindow: isEditWithinWindow(input),
      reasons: ['minor_detail_no_reader_value'],
    };
  }

  if (prior.status === 'claimed' || prior.status === 'publishing') {
    return { ok: false, reason: 'not_supersedable' };
  }

  const priorActive = (SUPERSEDABLE_PUBLICATION_STATUSES as readonly string[]).includes(
    prior.status,
  );
  const editable = isEditReachable(input);
  const editReason: string = editable ? 'edit_window_open' : editUnavailabilityReason(input);

  // A terminal prior (dead_letter/cancelled/superseded) has no machine exit:
  // the edit is structurally unavailable and the supersede is skipped — the
  // reasons carry that honestly instead of an edit-window technicality.
  if (!priorActive) {
    if (input.correctionClass === 'meaningful_update') {
      if (!input.followUpMaterial) {
        return {
          ok: true,
          disposition: 'none',
          editWithinWindow: false,
          reasons: ['prior_inactive_supersede_skipped', 'follow_up_not_material'],
        };
      }
      return {
        ok: true,
        disposition: 'follow_up',
        editWithinWindow: false,
        reasons: ['prior_inactive_supersede_skipped', 'follow_up_material'],
      };
    }
    if (input.correctionClass === 'rumor_confirmed') {
      if (!input.followUpMaterial) {
        return {
          ok: true,
          disposition: 'none',
          editWithinWindow: false,
          reasons: ['prior_inactive_supersede_skipped', 'confirmation_not_material'],
        };
      }
      return {
        ok: true,
        disposition: 'follow_up',
        editWithinWindow: false,
        reasons: ['prior_inactive_supersede_skipped', 'follow_up_material'],
      };
    }
    if (!input.correctionFollowUpDesired) {
      return {
        ok: true,
        disposition: 'none',
        editWithinWindow: false,
        reasons: ['prior_inactive_supersede_skipped', 'correction_follow_up_not_desired'],
      };
    }
    return {
      ok: true,
      disposition: 'follow_up',
      editWithinWindow: false,
      reasons: ['denial_follow_up_desired', 'prior_inactive_supersede_skipped'],
    };
  }

  switch (input.correctionClass) {
    case 'meaningful_update': {
      if (!input.followUpMaterial) {
        return {
          ok: true,
          disposition: 'none',
          editWithinWindow: isEditWithinWindow(input),
          reasons: ['follow_up_not_material'],
        };
      }
      if (editable) {
        return {
          ok: true,
          disposition: 'edit_and_follow_up',
          editWithinWindow: true,
          reasons: [editReason, 'follow_up_material'],
        };
      }
      return {
        ok: true,
        disposition: 'follow_up',
        editWithinWindow: isEditWithinWindow(input),
        reasons: [editReason, 'follow_up_material'],
      };
    }
    case 'rumor_confirmed': {
      if (input.followUpMaterial && editable) {
        return {
          ok: true,
          disposition: 'edit_and_follow_up',
          editWithinWindow: true,
          reasons: [editReason, 'follow_up_material'],
        };
      }
      if (input.followUpMaterial) {
        return {
          ok: true,
          disposition: 'follow_up',
          editWithinWindow: isEditWithinWindow(input),
          reasons: [editReason, 'follow_up_material'],
        };
      }
      if (editable) {
        return {
          ok: true,
          disposition: 'edit',
          editWithinWindow: true,
          reasons: [editReason, 'confirmation_not_material'],
        };
      }
      return {
        ok: true,
        disposition: 'none',
        editWithinWindow: false,
        reasons: [editReason, 'confirmation_not_material'],
      };
    }
    case 'rumor_denied':
    case 'correction': {
      if (editable && input.correctionFollowUpDesired) {
        return {
          ok: true,
          disposition: 'edit_and_follow_up',
          editWithinWindow: true,
          reasons: [editReason, 'denial_follow_up_desired'],
        };
      }
      if (editable) {
        return {
          ok: true,
          disposition: 'edit',
          editWithinWindow: true,
          reasons: [editReason],
        };
      }
      if (input.correctionFollowUpDesired) {
        return {
          ok: true,
          disposition: 'follow_up',
          editWithinWindow: isEditWithinWindow(input),
          reasons: [editReason, 'denial_follow_up_desired'],
        };
      }
      return {
        ok: true,
        disposition: 'none',
        editWithinWindow: false,
        reasons: [editReason, 'correction_follow_up_not_desired'],
      };
    }
  }
}

/**
 * The versioned deterministic correction audit id (`caid1` format tag inside
 * the hashed bytes): `edit:1:<sha256>` or `link:1:<sha256>`. The same
 * (revision, chat, message) always yields the same id — the PK of
 * audit_events is the at-most-once claim for an edit, and the deduplication
 * anchor for the supersede link. TOTAL: invalid inputs fail typed.
 */
export async function deriveCorrectionAuditEventId(input: {
  readonly action: 'edit' | 'link';
  readonly revisionId: string;
  readonly chatId: string;
  readonly messageId: number;
}): Promise<{ ok: true; id: string } | { ok: false; reason: 'invalid_input' }> {
  const MAX_ID_LENGTH = 256;
  if (
    typeof input.revisionId !== 'string' ||
    input.revisionId.length === 0 ||
    input.revisionId.length > MAX_ID_LENGTH
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (
    typeof input.chatId !== 'string' ||
    input.chatId.length === 0 ||
    input.chatId.length > MAX_ID_LENGTH
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!Number.isSafeInteger(input.messageId) || input.messageId <= 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  const digest = await sha256Hex(
    `correction-audit:caid1:${input.action}:${input.revisionId}:${input.chatId}:${input.messageId}`,
  );
  return { ok: true, id: `${input.action}:1:${digest}` };
}
