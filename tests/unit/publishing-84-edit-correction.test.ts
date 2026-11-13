import { describe, expect, it } from 'vitest';
import {
  CORRECTION_CLASSES,
  EDIT_CORRECTION_POLICY_VERSION,
  EDIT_REACH_WINDOW_MS,
  deriveCorrectionAuditEventId,
  planCorrectionDisposition,
  type CorrectionPriorContext,
} from '../../src/domain/publishing/edit-correction';

/**
 * Phase 8.4 — the EDIT/CORRECTION policy (ecl1): the pure, deterministic,
 * TOTAL decision layer the correction workflow consumes. RED-first suite —
 * written BEFORE the module exists (the real RED is
 * cannot-resolve-module).
 *
 * The blueprint §15 scenarios pinned here:
 *  - «Same story, minor detail» — no new post, no channel effect;
 *  - «Same story, meaningful update» — the policy chooses edit, follow-up,
 *    or both based on elapsed time and claim significance;
 *  - «Rumor confirmed» — edit the old message label/uncertainty when
 *    possible; publish the follow-up when the confirmation is materially
 *    newsworthy;
 *  - «Rumor denied» — edit the old post to show the denial and optionally
 *    publish the correction; NEVER a silent delete (no delete path exists).
 *
 * The machine rules pinned here (pol1 is the authority):
 *  - `published` only yields to `superseded` (the Phase 8.4 correction
 *    path) — plus pending/retry_wait/failed (the machine's supersedable
 *    set);
 *  - a CLAIMED row is owned by an in-flight generation — the correction
 *    workflow refuses to act on it (the eligibility path dead-letters it
 *    through the superseded DRAFT instead);
 *  - the terminal rows (dead_letter/cancelled/superseded) have no machine
 *    exits — a correction never tries to supersede them.
 */

const NOW = 1_700_000_000_000;

function prior(
  status: string,
  recordedMessages = 1,
  publishedAtMs: number | null = NOW - 60 * 60_000,
): CorrectionPriorContext {
  return { status, recordedMessages, publishedAtMs };
}

const EDITABLE = prior('published');

describe('edit-correction policy identity and shape', () => {
  it('carries the pinned policy version ecl1', () => {
    expect(EDIT_CORRECTION_POLICY_VERSION).toBe('ecl1');
  });

  it('exposes exactly the five blueprint correction classes', () => {
    expect([...CORRECTION_CLASSES]).toEqual([
      'minor_detail',
      'meaningful_update',
      'rumor_confirmed',
      'rumor_denied',
      'correction',
    ]);
  });

  it('pins the edit reach window at 48h', () => {
    expect(EDIT_REACH_WINDOW_MS).toBe(48 * 3_600_000);
  });
});

describe('planCorrectionDisposition — minor detail', () => {
  it('never touches the channel for a minor detail', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'minor_detail',
      prior: EDITABLE,
      followUpMaterial: true,
      correctionFollowUpDesired: true,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'none',
      editWithinWindow: true,
      reasons: ['minor_detail_no_reader_value'],
    });
  });

  it('stays none even when the prior is in-flight (claimed)', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'minor_detail',
      prior: prior('claimed', 0, null),
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.disposition).toBe('none');
  });
});

describe('planCorrectionDisposition — meaningful update', () => {
  it('chooses edit and follow-up when the edit window is open', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'meaningful_update',
      prior: EDITABLE,
      followUpMaterial: true,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'edit_and_follow_up',
      editWithinWindow: true,
      reasons: ['edit_window_open', 'follow_up_material'],
    });
  });

  it('falls back to follow-up only when the edit window has expired', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'meaningful_update',
      prior: prior('published', 1, NOW - EDIT_REACH_WINDOW_MS - 1),
      followUpMaterial: true,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'follow_up',
      editWithinWindow: false,
      reasons: ['edit_window_expired', 'follow_up_material'],
    });
  });

  it('falls back to follow-up only when the prior has no recorded delivery', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'meaningful_update',
      prior: prior('published', 0, NOW),
      followUpMaterial: true,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'follow_up',
      editWithinWindow: true,
      reasons: ['no_edit_target', 'follow_up_material'],
    });
  });

  it('is none when the update is not material', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'meaningful_update',
      prior: EDITABLE,
      followUpMaterial: false,
      correctionFollowUpDesired: true,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'none',
      editWithinWindow: true,
      reasons: ['follow_up_not_material'],
    });
  });
});

describe('planCorrectionDisposition — rumor confirmed', () => {
  it('edits the label AND publishes the follow-up when material', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'rumor_confirmed',
      prior: EDITABLE,
      followUpMaterial: true,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'edit_and_follow_up',
      editWithinWindow: true,
      reasons: ['edit_window_open', 'follow_up_material'],
    });
  });

  it('edits only the label when the confirmation is not material', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'rumor_confirmed',
      prior: EDITABLE,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'edit',
      editWithinWindow: true,
      reasons: ['edit_window_open', 'confirmation_not_material'],
    });
  });

  it('publishes only the follow-up when the post is stale', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'rumor_confirmed',
      prior: prior('published', 1, NOW - EDIT_REACH_WINDOW_MS - 1),
      followUpMaterial: true,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'follow_up',
      editWithinWindow: false,
      reasons: ['edit_window_expired', 'follow_up_material'],
    });
  });

  it('does nothing when neither the edit nor the follow-up applies', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'rumor_confirmed',
      prior: prior('published', 1, NOW - EDIT_REACH_WINDOW_MS - 1),
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'none',
      editWithinWindow: false,
      reasons: ['edit_window_expired', 'confirmation_not_material'],
    });
  });
});

describe('planCorrectionDisposition — rumor denied and explicit correction', () => {
  it('edits the denial and publishes the correction when desired', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'rumor_denied',
      prior: EDITABLE,
      followUpMaterial: false,
      correctionFollowUpDesired: true,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'edit_and_follow_up',
      editWithinWindow: true,
      reasons: ['edit_window_open', 'denial_follow_up_desired'],
    });
  });

  it('edits the denial only when no correction follow-up is desired', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'rumor_denied',
      prior: EDITABLE,
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'edit',
      editWithinWindow: true,
      reasons: ['edit_window_open'],
    });
  });

  it('publishes the denial when the post cannot be edited (never silently dropped)', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'rumor_denied',
      prior: prior('published', 1, NOW - EDIT_REACH_WINDOW_MS - 1),
      followUpMaterial: false,
      correctionFollowUpDesired: true,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'follow_up',
      editWithinWindow: false,
      reasons: ['edit_window_expired', 'denial_follow_up_desired'],
    });
  });

  it('mirrors the denial semantics for the explicit correction class', () => {
    const denied = planCorrectionDisposition({
      correctionClass: 'rumor_denied',
      prior: EDITABLE,
      followUpMaterial: false,
      correctionFollowUpDesired: true,
      nowMs: NOW,
    });
    const corrected = planCorrectionDisposition({
      correctionClass: 'correction',
      prior: EDITABLE,
      followUpMaterial: false,
      correctionFollowUpDesired: true,
      nowMs: NOW,
    });
    expect(corrected.ok).toBe(true);
    if (denied.ok && corrected.ok) {
      expect(corrected.disposition).toBe(denied.disposition);
      expect(corrected.reasons).toEqual(denied.reasons);
    }
  });
});

describe('planCorrectionDisposition — refusals', () => {
  it.each(['claimed', 'publishing'])(
    'refuses to act while a generation owns the row (%s)',
    (status) => {
      const plan = planCorrectionDisposition({
        correctionClass: 'meaningful_update',
        prior: prior(status, 1, null),
        followUpMaterial: true,
        correctionFollowUpDesired: false,
        nowMs: NOW,
      });
      expect(plan).toEqual({ ok: false, reason: 'not_supersedable' });
    },
  );

  it('treats a future published_at as outside the edit window (clock skew)', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'meaningful_update',
      prior: prior('published', 1, NOW + 60_000),
      followUpMaterial: true,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      disposition: 'follow_up',
      editWithinWindow: false,
      reasons: ['edit_window_expired', 'follow_up_material'],
    });
  });

  it.each(['dead_letter', 'cancelled', 'superseded'])(
    'skips the supersede for the terminal prior (%s) but still plans the follow-up',
    (status) => {
      const plan = planCorrectionDisposition({
        correctionClass: 'rumor_denied',
        prior: prior(status, 0, null),
        followUpMaterial: false,
        correctionFollowUpDesired: true,
        nowMs: NOW,
      });
      expect(plan).toEqual({
        ok: true,
        disposition: 'follow_up',
        editWithinWindow: false,
        reasons: ['denial_follow_up_desired', 'prior_inactive_supersede_skipped'],
      });
    },
  );

  it('fails typed on an unknown class', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'invented_class',
      prior: EDITABLE,
      followUpMaterial: true,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('fails typed on an unknown prior status', () => {
    const plan = planCorrectionDisposition({
      correctionClass: 'correction',
      prior: prior('invented_status'),
      followUpMaterial: true,
      correctionFollowUpDesired: false,
      nowMs: NOW,
    });
    expect(plan).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('fails typed on negative counts, non-integers and missing booleans', () => {
    const negatives: readonly CorrectionPlanBadInput[] = [
      {
        correctionClass: 'correction',
        prior: prior('published', -1),
        followUpMaterial: true,
        correctionFollowUpDesired: false,
        nowMs: NOW,
      },
      {
        correctionClass: 'correction',
        prior: prior('published', 1.5),
        followUpMaterial: true,
        correctionFollowUpDesired: false,
        nowMs: NOW,
      },
      {
        correctionClass: 'correction',
        prior: prior('published', 1, -5),
        followUpMaterial: true,
        correctionFollowUpDesired: false,
        nowMs: NOW,
      },
      {
        correctionClass: 'correction',
        prior: EDITABLE,
        followUpMaterial: true,
        correctionFollowUpDesired: false,
        nowMs: Number.NaN,
      },
    ];
    for (const input of negatives) {
      expect(planCorrectionDisposition(input)).toEqual({ ok: false, reason: 'invalid_input' });
    }
  });
});

type CorrectionPlanBadInput = Parameters<typeof planCorrectionDisposition>[0];

describe('planCorrectionDisposition — determinism', () => {
  it('is JSON-equal deterministic across repeated evaluation', () => {
    const input = {
      correctionClass: 'rumor_confirmed' as const,
      prior: EDITABLE,
      followUpMaterial: true,
      correctionFollowUpDesired: true,
      nowMs: NOW,
    };
    const a = planCorrectionDisposition(input);
    const b = planCorrectionDisposition(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('deriveCorrectionAuditEventId', () => {
  it('derives a versioned deterministic id per (revision, chat, message)', async () => {
    const a = await deriveCorrectionAuditEventId({
      action: 'edit',
      revisionId: 'draft-corr-1',
      chatId: '@pixel_lores',
      messageId: 42,
    });
    const b = await deriveCorrectionAuditEventId({
      action: 'edit',
      revisionId: 'draft-corr-1',
      chatId: '@pixel_lores',
      messageId: 42,
    });
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.id).toMatch(/^edit:1:[0-9a-f]{64}$/);
  });

  it('separates actions, revisions, chats and messages', async () => {
    const base = { revisionId: 'r1', chatId: '@c', messageId: 1 } as const;
    const ids = new Set<string>();
    for (const delta of [
      { ...base, action: 'edit' as const },
      { ...base, action: 'link' as const },
      { ...base, action: 'edit' as const, revisionId: 'r2' },
      { ...base, action: 'edit' as const, chatId: '@other' },
      { ...base, action: 'edit' as const, messageId: 2 },
    ]) {
      const derived = await deriveCorrectionAuditEventId(delta);
      expect(derived.ok).toBe(true);
      if (derived.ok) ids.add(derived.id);
    }
    expect(ids.size).toBe(5);
  });

  it('fails typed on empty or oversized identifiers', async () => {
    expect(
      await deriveCorrectionAuditEventId({
        action: 'edit',
        revisionId: '',
        chatId: '@c',
        messageId: 1,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      await deriveCorrectionAuditEventId({
        action: 'edit',
        revisionId: 'r'.repeat(300),
        chatId: '@c',
        messageId: 1,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      await deriveCorrectionAuditEventId({
        action: 'edit',
        revisionId: 'r',
        chatId: '',
        messageId: 1,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      await deriveCorrectionAuditEventId({
        action: 'edit',
        revisionId: 'r',
        chatId: '@c',
        messageId: 0,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
  });
});
