/**
 * Phase 8.1 — PRIORITY CLASSES (the RED-first adversarial suite).
 *
 * Blueprint §16 «Priority» as a TOTAL typed classification over the
 * editorial score 0..100:
 *
 * - P0 (90–100): publish after verification, NO daily cap, bypasses
 *   quiet hours (the ONLY class the blueprint grants that bypass);
 * - P1 (75–89): within 5–20 minutes (the latency bound — the
 *   blueprint's quiet label does NOT name P1, and a quiet deferral
 *   would break the 5–20 minute contract; pinned and documented);
 * - P2 (40–74): dynamic window (the scheduling windows apply);
 * - P3 (0–39): evergreen filler only;
 * - the boundary values are pinned: 90 ⇒ P0, 89 ⇒ P1, 75 ⇒ P1,
 *   74 ⇒ P2, 40 ⇒ P2, 39 ⇒ P3;
 * - every out-of-vocabulary input (non-integer, <0, >100, NaN,
 *   ±Infinity) fails TYPED — never clamped, never guessed;
 * - the quiet-hours applicability matrix is EXPLICIT data: P2/P3 are
 *   quiet-gated (the blueprint names them), P0 bypasses (the
 *   blueprint says so), P1 is latency-bound (documented interpretation,
 *   recorded in the module header and the ADR).
 */

import { describe, expect, it } from 'vitest';

import {
  PRIORITY_CLASS_DESCRIPTORS,
  PRIORITY_POLICY_VERSION,
  classifyPriority,
  isQuietGated,
  type PublicationPriorityClass,
} from '../../src/domain/publishing/priority-classes';

describe('priority-classes policy identity', () => {
  it('the policy version is pinned pcp1', () => {
    expect(PRIORITY_POLICY_VERSION).toBe('pcp1');
  });
});

describe('classifyPriority — the pinned boundaries', () => {
  it('0 and 39 are P3; 40 and 74 are P2; 75 and 89 are P1; 90 and 100 are P0', () => {
    const expectations: ReadonlyArray<readonly [number, PublicationPriorityClass]> = [
      [0, 'P3'],
      [39, 'P3'],
      [40, 'P2'],
      [74, 'P2'],
      [75, 'P1'],
      [89, 'P1'],
      [90, 'P0'],
      [100, 'P0'],
    ];
    for (const [score, expected] of expectations) {
      const result = classifyPriority(score);
      if (!result.ok) throw new Error(`score ${score} failed: ${result.reason}`);
      expect(result.value.class).toBe(expected);
    }
  });

  it('the class descriptor echoes the score range that produced it', () => {
    const result = classifyPriority(88);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.descriptor.scoreMin).toBe(75);
    expect(result.value.descriptor.scoreMax).toBe(89);
  });
});

describe('classifyPriority — the typed input contract', () => {
  it('scores below 0 and above 100 fail invalid_score', () => {
    expect(classifyPriority(-1)).toEqual({ ok: false, reason: 'invalid_score' });
    expect(classifyPriority(101)).toEqual({ ok: false, reason: 'invalid_score' });
  });

  it('non-integer scores fail invalid_score — never rounded, never clamped', () => {
    expect(classifyPriority(74.5)).toEqual({ ok: false, reason: 'invalid_score' });
    expect(classifyPriority(0.0001)).toEqual({ ok: false, reason: 'invalid_score' });
  });

  it('NaN and ±Infinity fail invalid_score', () => {
    expect(classifyPriority(Number.NaN)).toEqual({ ok: false, reason: 'invalid_score' });
    expect(classifyPriority(Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
      reason: 'invalid_score',
    });
    expect(classifyPriority(Number.NEGATIVE_INFINITY)).toEqual({
      ok: false,
      reason: 'invalid_score',
    });
  });
});

describe('the class descriptors carry EXACTLY the blueprint §16 facts', () => {
  it('P0: no daily cap, bypasses quiet hours, anytime window policy, no latency bound', () => {
    const p0 = PRIORITY_CLASS_DESCRIPTORS.P0;
    expect(p0.scoreMin).toBe(90);
    expect(p0.scoreMax).toBe(100);
    expect(p0.dailyCap).toBe(false);
    expect(p0.bypassesQuietHours).toBe(true);
    expect(p0.quietGated).toBe(false);
    expect(p0.latencyBoundMs).toBeNull();
    expect(p0.windowPolicy).toBe('anytime');
  });

  it('P1: the 5–20 minute latency bound, latency-bound window policy, NOT quiet-gated', () => {
    const p1 = PRIORITY_CLASS_DESCRIPTORS.P1;
    expect(p1.scoreMin).toBe(75);
    expect(p1.scoreMax).toBe(89);
    expect(p1.latencyBoundMs).toEqual({ minMs: 5 * 60_000, maxMs: 20 * 60_000 });
    expect(p1.windowPolicy).toBe('latency_bound');
    expect(p1.quietGated).toBe(false);
    expect(p1.bypassesQuietHours).toBe(false);
  });

  it('P2: dynamic window, quiet-gated', () => {
    const p2 = PRIORITY_CLASS_DESCRIPTORS.P2;
    expect(p2.scoreMin).toBe(40);
    expect(p2.scoreMax).toBe(74);
    expect(p2.windowPolicy).toBe('dynamic_window');
    expect(p2.quietGated).toBe(true);
    expect(p2.latencyBoundMs).toBeNull();
  });

  it('P3: evergreen filler only, quiet-gated', () => {
    const p3 = PRIORITY_CLASS_DESCRIPTORS.P3;
    expect(p3.scoreMin).toBe(0);
    expect(p3.scoreMax).toBe(39);
    expect(p3.windowPolicy).toBe('filler_only');
    expect(p3.quietGated).toBe(true);
  });

  it('the quiet-hours applicability matrix: P2/P3 gated; P0 bypasses; P1 latency-bound (not gated)', () => {
    expect(isQuietGated('P0')).toBe(false);
    expect(isQuietGated('P1')).toBe(false);
    expect(isQuietGated('P2')).toBe(true);
    expect(isQuietGated('P3')).toBe(true);
  });

  it('the descriptor table covers exactly the four classes', () => {
    expect(Object.keys(PRIORITY_CLASS_DESCRIPTORS).sort()).toEqual(['P0', 'P1', 'P2', 'P3']);
  });
});

describe('determinism', () => {
  it('the same score always yields a JSON-equal classification', () => {
    const a = classifyPriority(63);
    const b = classifyPriority(63);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
