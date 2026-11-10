/**
 * Phase 7.2 — the R2 TEMPORARY-storage policy + lifecycle state machine
 * (the RED-first adversarial suite).
 *
 * Blueprint §23 (temporary R2: 72 hours), §14 step 10 (after Telegram
 * upload, save file_id and delete the temporary object on the retention
 * schedule), step 9 (no CPU-heavy transcoding) and the 7.3 roadmap bullet
 * (`file_id` reuse BEFORE any new upload) — pinned here as the PURE
 * policy layer the 7.3 upload adapter must obey:
 *
 * - the lifecycle is a TOTAL typed state machine: every transition is
 *   explicit, every other combination is an invalid_r2_transition;
 * - a SAVED file_id never re-uploads (file_id_saved → upload_started is
 *   invalid BY POLICY — the reuse-before-upload economy rule);
 * - both terminal states are terminal (r2_object_deleted,
 *   retention_expired);
 * - the retention deadline is a deterministic +72h ISO computation over
 *   the STAGED timestamp, with invalid input failing typed;
 * - constants carry NO measured free-tier claims — the real usage
 *   numbers are Posidon's to measure (the Phase 6 gate condition).
 */

import { describe, expect, it } from 'vitest';

import {
  R2_TEMPORARY_POLICY_V1,
  retentionDeadline,
  transitionR2Temporary,
  type R2TemporaryEventV1,
} from '../../src/domain/media/r2-temporary';

describe('the fixed R2 temporary policy contract', () => {
  it('pins the 72-hour retention and the lifecycle policy flags', () => {
    expect(R2_TEMPORARY_POLICY_V1.policyVersion).toBe('rtp1');
    expect(R2_TEMPORARY_POLICY_V1.retentionHours).toBe(72);
    expect(R2_TEMPORARY_POLICY_V1.deleteAfterFileIdSave).toBe(true);
    expect(R2_TEMPORARY_POLICY_V1.fileIdReuseBeforeUpload).toBe(true);
    expect(R2_TEMPORARY_POLICY_V1.transcodingForbidden).toBe(true);
  });

  it('the policy carries NO measured-usage claim (no byte/percent fields at all)', () => {
    const keys = Object.keys(R2_TEMPORARY_POLICY_V1).map((key) => key.toLowerCase());
    for (const key of keys) {
      expect(key).not.toContain('measured');
      expect(key).not.toContain('percent');
      expect(key).not.toContain('accuracy');
    }
  });
});

describe('the happy-path lifecycle (staged → upload_in_progress → file_id_saved → r2_object_deleted)', () => {
  it('walks the full chain recording the saved file_id at the upload step', () => {
    const step1 = transitionR2Temporary('staged', { kind: 'upload_started' });
    expect(step1).toMatchObject({ ok: true, state: 'upload_in_progress' });

    const step2 = transitionR2Temporary('upload_in_progress', {
      kind: 'upload_succeeded',
      fileId: 'AgAC-good-file-id',
    });
    expect(step2).toMatchObject({ ok: true, state: 'file_id_saved', fileId: 'AgAC-good-file-id' });

    const step3 = transitionR2Temporary('file_id_saved', { kind: 'r2_object_deleted' });
    expect(step3).toMatchObject({ ok: true, state: 'r2_object_deleted' });
  });
});

describe('the failure paths (upload_failed keeps the object for retry or expiry)', () => {
  it('upload_failed → retry_scheduled → staged (a bounded retry re-STAGES, never re-uploads a saved id)', () => {
    const failed = transitionR2Temporary('upload_in_progress', { kind: 'upload_failed' });
    expect(failed).toMatchObject({ ok: true, state: 'upload_failed' });
    const retried = transitionR2Temporary('upload_failed', { kind: 'retry_scheduled' });
    expect(retried).toMatchObject({ ok: true, state: 'staged' });
  });

  it('upload_failed → retention_lapsed → retention_expired (a dead upload still cleans up on schedule)', () => {
    const expired = transitionR2Temporary('upload_failed', { kind: 'retention_lapsed' });
    expect(expired).toMatchObject({ ok: true, state: 'retention_expired' });
  });
});

describe('the invalid transitions are INVALID BY POLICY (the reuse rule is enforced by the machine)', () => {
  it('file_id_saved → upload_started is rejected: a saved file_id NEVER re-uploads', () => {
    expect(transitionR2Temporary('file_id_saved', { kind: 'upload_started' })).toMatchObject({
      ok: false,
      reason: 'invalid_r2_transition',
    });
  });

  it('both terminal states reject every event (r2_object_deleted, retention_expired)', () => {
    for (const state of ['r2_object_deleted', 'retention_expired'] as const) {
      for (const event of [
        { kind: 'upload_started' },
        { kind: 'upload_succeeded', fileId: 'AgAC-x' },
        { kind: 'upload_failed' },
        { kind: 'retry_scheduled' },
        { kind: 'r2_object_deleted' },
        { kind: 'retention_lapsed' },
      ] as const) {
        expect(transitionR2Temporary(state, event as R2TemporaryEventV1)).toMatchObject({
          ok: false,
          reason: 'invalid_r2_transition',
        });
      }
    }
  });

  it('skipping steps is invalid (staged → upload_succeeded directly; staged → r2_object_deleted)', () => {
    expect(
      transitionR2Temporary('staged', { kind: 'upload_succeeded', fileId: 'AgAC-x' }),
    ).toMatchObject({
      ok: false,
      reason: 'invalid_r2_transition',
    });
    expect(transitionR2Temporary('staged', { kind: 'r2_object_deleted' })).toMatchObject({
      ok: false,
      reason: 'invalid_r2_transition',
    });
    expect(
      transitionR2Temporary('upload_in_progress', { kind: 'r2_object_deleted' }),
    ).toMatchObject({
      ok: false,
      reason: 'invalid_r2_transition',
    });
  });

  it('an invalid fileId on upload_succeeded fails typed BEFORE any state changes', () => {
    expect(
      transitionR2Temporary('upload_in_progress', { kind: 'upload_succeeded', fileId: '' }),
    ).toMatchObject({
      ok: false,
      reason: 'file_id_invalid',
    });
    expect(
      transitionR2Temporary('upload_in_progress', {
        kind: 'upload_succeeded',
        fileId: 'a'.repeat(257),
      }),
    ).toMatchObject({
      ok: false,
      reason: 'file_id_invalid',
    });
    expect(
      transitionR2Temporary('upload_in_progress', { kind: 'upload_succeeded', fileId: 'bad\nid' }),
    ).toMatchObject({
      ok: false,
      reason: 'file_id_invalid',
    });
  });
});

describe('the 72-hour retention deadline (deterministic ISO math over the staged timestamp)', () => {
  it('computes exactly +72 hours preserving sub-second precision', () => {
    const outcome = retentionDeadline('2026-01-01T00:00:00.123Z');
    expect(outcome).toMatchObject({ ok: true, deadlineIso: '2026-01-04T00:00:00.123Z' });
  });

  it('a leap-day span computes correctly (Feb 28 + 72h over Feb 29)', () => {
    const outcome = retentionDeadline('2028-02-28T12:00:00Z');
    expect(outcome).toMatchObject({ ok: true, deadlineIso: '2028-03-02T12:00:00.000Z' });
  });

  it('an invalid or empty timestamp fails typed (never a NaN deadline)', () => {
    expect(retentionDeadline('')).toMatchObject({ ok: false, reason: 'invalid_timestamp' });
    expect(retentionDeadline('not-a-date')).toMatchObject({
      ok: false,
      reason: 'invalid_timestamp',
    });
    expect(retentionDeadline('2026-13-45T99:99:99Z')).toMatchObject({
      ok: false,
      reason: 'invalid_timestamp',
    });
  });
});
