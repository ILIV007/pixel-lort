import { describe, expect, it } from 'vitest';
import {
  MIN_PUBLICATION_RETRY_BACKOFF_MS,
  OUTBOX_LIFECYCLE_VERSION,
  OUTBOX_TRANSITIONS,
  PUBLICATION_STATUSES,
  POLICY_DEFER_REEVALUATE_MS,
  isSendableDraftStatus,
  planReleaseAfterScheduleDecision,
  planRetryAfterProvedFailure,
  publicationMaxAttempts,
  transitionPublication,
} from '../../src/domain/publishing/outbox-lifecycle';

/**
 * Phase 8.2 — the publication OUTBOX lifecycle state machine (pol1).
 *
 * The machine is a TOTAL function over the REAL schema-6 `publications`
 * status vocabulary (migration 0001 — consumed, never rebuilt). Every
 * transition is explicit data; every violation fails typed. The machine is
 * the authority the D1 store and the scheduler service both lean on: a
 * durable write whose (from, reason) pair the machine rejects is a BUG, not
 * a state.
 */

describe('publishing-82 outbox lifecycle: the status vocabulary', () => {
  it('carries exactly the nine schema-6 publications statuses', () => {
    expect(PUBLICATION_STATUSES).toEqual([
      'pending',
      'claimed',
      'publishing',
      'published',
      'retry_wait',
      'failed',
      'dead_letter',
      'cancelled',
      'superseded',
    ]);
  });

  it('exposes a policy version tag', () => {
    expect(OUTBOX_LIFECYCLE_VERSION).toBe('pol1');
  });

  it('the transition table covers every status', () => {
    for (const status of PUBLICATION_STATUSES) {
      expect(Array.isArray(OUTBOX_TRANSITIONS[status])).toBe(true);
    }
  });
});

describe('publishing-82 outbox lifecycle: the legal transition table', () => {
  it('claim: pending -> claimed and retry_wait -> claimed', () => {
    expect(transitionPublication('pending', 'claim')).toEqual({
      ok: true,
      from: 'pending',
      to: 'claimed',
    });
    expect(transitionPublication('retry_wait', 'claim')).toEqual({
      ok: true,
      from: 'retry_wait',
      to: 'claimed',
    });
  });

  it('release: claimed -> pending (the policy defer path — no send happened)', () => {
    expect(transitionPublication('claimed', 'release')).toEqual({
      ok: true,
      from: 'claimed',
      to: 'pending',
    });
  });

  it('publish: claimed -> published and failed -> published (the evidence heal)', () => {
    expect(transitionPublication('claimed', 'publish')).toEqual({
      ok: true,
      from: 'claimed',
      to: 'published',
    });
    expect(transitionPublication('failed', 'publish')).toEqual({
      ok: true,
      from: 'failed',
      to: 'published',
    });
  });

  it('the proved-failure family exits claimed: fail_hold / schedule_retry / dead_letter', () => {
    expect(transitionPublication('claimed', 'fail_hold')?.ok).toBe(true);
    expect(transitionPublication('claimed', 'schedule_retry')?.ok).toBe(true);
    expect(transitionPublication('claimed', 'dead_letter')?.ok).toBe(true);
  });

  it('the ambiguous outcome parks in failed: mark_uncertain reaches failed from claimed and publishing', () => {
    expect(transitionPublication('claimed', 'mark_uncertain')).toEqual({
      ok: true,
      from: 'claimed',
      to: 'failed',
    });
    expect(transitionPublication('publishing', 'mark_uncertain')).toEqual({
      ok: true,
      from: 'publishing',
      to: 'failed',
    });
  });

  it('the optional publishing status (schema vocabulary) reaches the same exits from claimed', () => {
    expect(transitionPublication('claimed', 'mark_send_started')).toEqual({
      ok: true,
      from: 'claimed',
      to: 'publishing',
    });
    for (const reason of [
      'publish',
      'fail_hold',
      'mark_uncertain',
      'schedule_retry',
      'dead_letter',
    ] as const) {
      const result = transitionPublication('publishing', reason);
      expect(result.ok).toBe(true);
    }
  });

  it('the human-disposition exits: failed/failed -> cancel|supersede; pending/retry_wait -> cancel|supersede|dead_letter', () => {
    expect(transitionPublication('failed', 'cancel')?.ok).toBe(true);
    expect(transitionPublication('failed', 'supersede')?.ok).toBe(true);
    expect(transitionPublication('pending', 'cancel')?.ok).toBe(true);
    expect(transitionPublication('retry_wait', 'cancel')?.ok).toBe(true);
    expect(transitionPublication('pending', 'supersede')?.ok).toBe(true);
    expect(transitionPublication('retry_wait', 'supersede')?.ok).toBe(true);
    expect(transitionPublication('pending', 'dead_letter')?.ok).toBe(true);
    expect(transitionPublication('retry_wait', 'dead_letter')?.ok).toBe(true);
  });

  it('published -> superseded (the Phase 8.4 correction path is reserved)', () => {
    expect(transitionPublication('published', 'supersede')).toEqual({
      ok: true,
      from: 'published',
      to: 'superseded',
    });
  });
});

describe('publishing-82 outbox lifecycle: the invalid transitions fail typed', () => {
  it('a parked (failed) row NEVER auto-retries or re-claims: schedule_retry/claim from failed are invalid', () => {
    expect(transitionPublication('failed', 'schedule_retry').ok).toBe(false);
    expect(transitionPublication('failed', 'claim').ok).toBe(false);
    expect(transitionPublication('failed', 'release').ok).toBe(false);
  });

  it('a terminal row has NO exits except the machine-listed ones: dead_letter/cancelled/superseded and published cannot claim', () => {
    for (const status of ['dead_letter', 'cancelled', 'superseded', 'published'] as const) {
      expect(transitionPublication(status, 'claim').ok).toBe(false);
    }
    for (const status of ['dead_letter', 'cancelled', 'superseded'] as const) {
      expect(transitionPublication(status, 'publish').ok).toBe(false);
    }
    expect(transitionPublication('dead_letter', 'cancel').ok).toBe(false);
    expect(transitionPublication('cancelled', 'dead_letter').ok).toBe(false);
    expect(transitionPublication('superseded', 'publish').ok).toBe(false);
  });

  it('a pending row cannot publish without a claim (the send-side guarantees hold)', () => {
    expect(transitionPublication('pending', 'publish').ok).toBe(false);
    expect(transitionPublication('pending', 'mark_uncertain').ok).toBe(false);
    expect(transitionPublication('pending', 'schedule_retry').ok).toBe(false);
  });

  it('an unknown status or reason fails typed (never guessed)', () => {
    expect(transitionPublication('queued', 'claim')).toEqual({
      ok: false,
      reason: 'invalid_status',
    });
    expect(transitionPublication('pending', 'resend')).toEqual({
      ok: false,
      reason: 'invalid_reason',
    });
    expect(transitionPublication('', '')).toEqual({ ok: false, reason: 'invalid_status' });
  });

  it('release from a non-claimed row is invalid', () => {
    expect(transitionPublication('pending', 'release').ok).toBe(false);
    expect(transitionPublication('published', 'release').ok).toBe(false);
  });
});

describe('publishing-82 outbox lifecycle: sendable draft statuses', () => {
  it('only approved and auto_approved drafts are sendable', () => {
    expect(isSendableDraftStatus('approved')).toBe(true);
    expect(isSendableDraftStatus('auto_approved')).toBe(true);
    expect(isSendableDraftStatus('validated')).toBe(false);
    expect(isSendableDraftStatus('rejected')).toBe(false);
    expect(isSendableDraftStatus('generating')).toBe(false);
    expect(isSendableDraftStatus('superseded')).toBe(false);
    expect(isSendableDraftStatus('')).toBe(false);
  });
});

describe('publishing-82 outbox lifecycle: the attempt budget', () => {
  it('the blueprint §7 budget: 3 normal, 5 for P0 (score >= 90)', () => {
    expect(publicationMaxAttempts(0)).toEqual({ ok: true, value: 3 });
    expect(publicationMaxAttempts(39)).toEqual({ ok: true, value: 3 });
    expect(publicationMaxAttempts(40)).toEqual({ ok: true, value: 3 });
    expect(publicationMaxAttempts(74)).toEqual({ ok: true, value: 3 });
    expect(publicationMaxAttempts(75)).toEqual({ ok: true, value: 3 });
    expect(publicationMaxAttempts(89)).toEqual({ ok: true, value: 3 });
    expect(publicationMaxAttempts(90)).toEqual({ ok: true, value: 5 });
    expect(publicationMaxAttempts(100)).toEqual({ ok: true, value: 5 });
  });

  it('an invalid score fails typed', () => {
    expect(publicationMaxAttempts(-1)).toEqual({ ok: false, reason: 'invalid_score' });
    expect(publicationMaxAttempts(101)).toEqual({ ok: false, reason: 'invalid_score' });
    expect(publicationMaxAttempts(1.5)).toEqual({ ok: false, reason: 'invalid_score' });
    expect(publicationMaxAttempts(Number.NaN)).toEqual({ ok: false, reason: 'invalid_score' });
  });
});

describe('publishing-82 outbox lifecycle: the retry plan after a PROVED failure', () => {
  const NOW = 1_000_000;

  it('a retryable proved failure with budget left plans retry_wait honoring the server retry_after', () => {
    const plan = planRetryAfterProvedFailure({
      attempts: 1,
      maxAttempts: 3,
      retryAfterMs: 120_000,
      nowMs: NOW,
    });
    expect(plan).toEqual({ ok: true, action: 'retry_wait', runAfterMs: NOW + 120_000 });
  });

  it('the retry_after is honored with a conservative floor (never earlier than 60s)', () => {
    const plan = planRetryAfterProvedFailure({
      attempts: 1,
      maxAttempts: 3,
      retryAfterMs: 5_000,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      action: 'retry_wait',
      runAfterMs: NOW + MIN_PUBLICATION_RETRY_BACKOFF_MS,
    });
    expect(MIN_PUBLICATION_RETRY_BACKOFF_MS).toBe(60_000);
  });

  it('a null retry_after uses the floor alone', () => {
    const plan = planRetryAfterProvedFailure({
      attempts: 2,
      maxAttempts: 3,
      retryAfterMs: null,
      nowMs: NOW,
    });
    expect(plan).toEqual({
      ok: true,
      action: 'retry_wait',
      runAfterMs: NOW + MIN_PUBLICATION_RETRY_BACKOFF_MS,
    });
  });

  it('the budget spent (attempts >= maxAttempts) dead-letters — never a max+1-th attempt', () => {
    expect(
      planRetryAfterProvedFailure({
        attempts: 3,
        maxAttempts: 3,
        retryAfterMs: 120_000,
        nowMs: NOW,
      }),
    ).toEqual({ ok: true, action: 'dead_letter' });
    expect(
      planRetryAfterProvedFailure({
        attempts: 5,
        maxAttempts: 5,
        retryAfterMs: 120_000,
        nowMs: NOW,
      }),
    ).toEqual({ ok: true, action: 'dead_letter' });
  });

  it('invalid inputs fail typed', () => {
    expect(
      planRetryAfterProvedFailure({ attempts: 0, maxAttempts: 0, retryAfterMs: null, nowMs: NOW }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      planRetryAfterProvedFailure({
        attempts: 1.5,
        maxAttempts: 3,
        retryAfterMs: null,
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
    expect(
      planRetryAfterProvedFailure({ attempts: 1, maxAttempts: 3, retryAfterMs: -1, nowMs: NOW }),
    ).toEqual({ ok: false, reason: 'invalid_input' });
  });
});

describe('publishing-82 outbox lifecycle: the release plan after a schedule decision', () => {
  const NOW = 2_000_000;

  it('a future dueAt releases with run_after = scheduled_at = dueAtMs (the durable deferral)', () => {
    const plan = planReleaseAfterScheduleDecision({ dueAtMs: NOW + 300_000, nowMs: NOW });
    expect(plan).toEqual({
      ok: true,
      runAfterMs: NOW + 300_000,
      scheduledAtMs: NOW + 300_000,
    });
  });

  it('a non-time-resolvable policy defer re-evaluates after a pinned bounded interval, scheduled_at stays NULL', () => {
    const plan = planReleaseAfterScheduleDecision({ dueAtMs: null, nowMs: NOW });
    expect(plan).toEqual({
      ok: true,
      runAfterMs: NOW + POLICY_DEFER_REEVALUATE_MS,
      scheduledAtMs: null,
    });
    expect(POLICY_DEFER_REEVALUATE_MS).toBe(10 * 60_000);
  });

  it('invalid inputs fail typed', () => {
    expect(planReleaseAfterScheduleDecision({ dueAtMs: -5, nowMs: NOW })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(planReleaseAfterScheduleDecision({ dueAtMs: 1.5, nowMs: NOW })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(planReleaseAfterScheduleDecision({ dueAtMs: 0, nowMs: -1 })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
  });
});
