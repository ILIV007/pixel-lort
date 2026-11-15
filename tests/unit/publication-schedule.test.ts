/**
 * Phase 8.1 — the PUBLICATION SCHEDULE COMPOSITION (the RED-first
 * adversarial suite).
 *
 * The composed TOTAL decision the Phase 8.2 durable scheduler will
 * consume: Tehran windows (twp1) × priority classes (pcp1) ×
 * anti-robot rules (arp1) under the composition version `psp1`.
 *
 * THE DOCUMENTED PRECEDENCE (every rule is evaluated and recorded;
 * the most restrictive wins; typed input failures propagate in rule
 * order):
 *   1. the layout run cap — NOT time-resolvable: no due shift can fix
 *      it, so a block is a typed DEFER (the caller must change the
 *      layout input);
 *   2. the category share cap — NOT time-resolvable by waiting alone
 *      (the rolling six changes only when new posts publish): a block
 *      is a typed DEFER unless the story layer asserted event-driven;
 *   3. the P3 mix gate — enforcement lands ONLY on filler discretion
 *      (over-target category ⇒ typed DEFER); P0/P1/P2 carry the mix
 *      report as an ADVISORY — news is never blocked by mix («never
 *      forced per day», honored);
 *   4. the time computation — the P1 latency bound (5–20 min) with the
 *      fixed P1 spacing floor (previous send + 8 min), the P0 gap
 *      (anti-flood when unrelated, normal when related), the P2/P3
 *      normal gap with the caller-supplied deterministic jitter,
 *      clamped so a due is NEVER in the past;
 *   5. the same-game cooldown shift (time-resolvable: due = max(due,
 *      eligibleAt));
 *   6. the window gate LAST (P2/P3 only — the blueprint names quiet
 *      «for P2/P3» and P0 explicitly bypasses; P1's 5–20 minute
 *      contract is incompatible with a quiet deferral): a P2/P3 due
 *      outside an ACTIVE window defers to the next active window
 *      start.
 *
 * A deferred decision carries dueAtMs NULL — no fabricated timestamp.
 * Every decision carries the four component policy versions. The same
 * input ALWAYS yields the JSON-equal decision (no randomness inside —
 * the jitter is always a caller-supplied deterministic input).
 */

import { describe, expect, it } from 'vitest';

import {
  SCHEDULE_POLICY_VERSION,
  planPublicationTime,
  type PublicationScheduleInputV1,
} from '../../src/domain/publishing/publication-schedule';

/** Tehran is the FIXED UTC+03:30 (no DST since 2022). */
const OFFSET_MS = 210 * 60 * 1000;

/** UTC epoch for a Tehran wall-clock time on a fixed civil date. */
function tehranAt(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, s) - OFFSET_MS;
}

const MIN = 60_000;

function baseInput(
  overrides: Partial<PublicationScheduleInputV1> = {},
): PublicationScheduleInputV1 {
  return {
    schemaVersion: 1,
    nowMs: tehranAt(2026, 11, 11, 10, 0), // inside morning_scan
    category: 'mainstream_industry',
    candidateLayout: 'hero',
    priorityScore: 60, // P2
    jitterMs: 0,
    previousSend: null,
    recentLayouts: [],
    recentCategories: [],
    sameGame: null,
    eventDriven: false,
    ...overrides,
  };
}

function schedule(decision: ReturnType<typeof planPublicationTime>) {
  if (!decision.ok || decision.outcome !== 'schedule') {
    throw new Error(`expected a schedule decision, got ${JSON.stringify(decision)}`);
  }
  return decision;
}

function defer(decision: ReturnType<typeof planPublicationTime>) {
  if (!decision.ok || decision.outcome !== 'defer') {
    throw new Error(`expected a defer decision, got ${JSON.stringify(decision)}`);
  }
  return decision;
}

describe('composition identity', () => {
  it('the composition policy version is pinned psp1', () => {
    expect(SCHEDULE_POLICY_VERSION).toBe('psp1');
  });

  it('every schedule decision carries the four component policy versions', () => {
    const decision = schedule(planPublicationTime(baseInput()));
    expect(decision.policyVersions).toEqual({
      windows: 'twp1',
      priority: 'pcp1',
      antiRobot: 'arp1',
      composition: 'psp1',
    });
  });
});

describe('P0 — anytime, quiet bypass, the gap by relatedness', () => {
  it('an UNRELATED P0 sends after the anti-flood jitter even in QUIET hours — the window is recorded honestly', () => {
    const now = tehranAt(2026, 11, 11, 3, 0); // quiet
    const decision = schedule(
      planPublicationTime(
        baseInput({
          nowMs: now,
          priorityScore: 95,
          jitterMs: 3 * MIN,
          previousSend: { atMs: now - MIN, related: false, priorityClass: 'P1' },
        }),
      ),
    );
    expect(decision.dueAtMs).toBe(now + 3 * MIN);
    expect(decision.window.name).toBe('quiet');
    expect(decision.window.kind).toBe('quiet');
    expect(decision.appliedRules).toContainEqual({
      rule: 'send_gap',
      gapRule: 'anti_flood_bypass',
    });
    expect(decision.appliedRules).not.toContainEqual(
      expect.objectContaining({ rule: 'window_gate' }),
    );
  });

  it('a RELATED P0 uses the conservative normal gap (25–45 min)', () => {
    const now = tehranAt(2026, 11, 11, 20, 30); // prime
    const decision = schedule(
      planPublicationTime(
        baseInput({
          nowMs: now,
          priorityScore: 100,
          jitterMs: 30 * MIN,
          previousSend: { atMs: now - MIN, related: true, priorityClass: 'P2' },
        }),
      ),
    );
    expect(decision.dueAtMs).toBe(now + 30 * MIN);
    expect(decision.appliedRules).toContainEqual({ rule: 'send_gap', gapRule: 'normal_gap' });
  });

  it('a P0 with no previous send is due NOW', () => {
    const now = tehranAt(2026, 11, 11, 20, 30);
    const decision = schedule(planPublicationTime(baseInput({ nowMs: now, priorityScore: 90 })));
    expect(decision.dueAtMs).toBe(now);
    expect(decision.appliedRules).toContainEqual({ rule: 'send_gap', gapRule: 'no_previous_send' });
  });
});

describe('P1 — the 5–20 minute latency with the fixed spacing floor, NOT quiet-gated', () => {
  it('a P1 with no previous send is due at now + jitter inside the latency bounds', () => {
    const now = tehranAt(2026, 11, 11, 3, 0); // quiet — P1 is NOT gated
    const decision = schedule(
      planPublicationTime(baseInput({ nowMs: now, priorityScore: 80, jitterMs: 10 * MIN })),
    );
    expect(decision.dueAtMs).toBe(now + 10 * MIN);
    expect(decision.window.kind).toBe('quiet');
    expect(decision.appliedRules).toContainEqual({ rule: 'latency_bound', class: 'P1' });
    expect(decision.appliedRules).toContainEqual({ rule: 'send_gap', gapRule: 'no_previous_send' });
  });

  it('the spacing floor wins when the previous send is too recent (prev + 8 min)', () => {
    const now = tehranAt(2026, 11, 11, 21, 0);
    const decision = schedule(
      planPublicationTime(
        baseInput({
          nowMs: now,
          priorityScore: 75,
          jitterMs: 5 * MIN,
          previousSend: { atMs: now, related: true, priorityClass: 'P1' },
        }),
      ),
    );
    expect(decision.dueAtMs).toBe(now + 8 * MIN);
    expect(decision.appliedRules).toContainEqual({ rule: 'latency_bound', class: 'P1' });
    expect(decision.appliedRules).toContainEqual({ rule: 'send_gap', gapRule: 'p1_gap' });
  });

  it('the P1 jitter is validated against the LATENCY bounds (5–20 min), not the gap band', () => {
    const now = tehranAt(2026, 11, 11, 21, 0);
    expect(
      planPublicationTime(baseInput({ nowMs: now, priorityScore: 80, jitterMs: 4 * MIN })),
    ).toEqual({
      ok: false,
      reason: 'jitter_out_of_bounds',
    });
    expect(
      planPublicationTime(baseInput({ nowMs: now, priorityScore: 80, jitterMs: 21 * MIN })),
    ).toEqual({
      ok: false,
      reason: 'jitter_out_of_bounds',
    });
  });
});

describe('P2 — the dynamic window gate', () => {
  it('inside an active window with no previous send ⇒ due NOW, recorded inside_active_window', () => {
    const now = tehranAt(2026, 11, 11, 10, 0); // morning_scan
    const decision = schedule(planPublicationTime(baseInput({ nowMs: now })));
    expect(decision.dueAtMs).toBe(now);
    expect(decision.window.name).toBe('morning_scan');
    expect(decision.appliedRules).toContainEqual({
      rule: 'window_gate',
      result: 'inside_active_window',
    });
  });

  it('in QUIET hours ⇒ deferred to the next active window start 09:30 (exact epoch)', () => {
    const now = tehranAt(2026, 11, 11, 3, 0); // quiet
    const decision = schedule(planPublicationTime(baseInput({ nowMs: now, jitterMs: 0 })));
    expect(decision.dueAtMs).toBe(tehranAt(2026, 11, 11, 9, 30));
    expect(decision.window.name).toBe('morning_scan');
    expect(decision.appliedRules).toContainEqual({
      rule: 'window_gate',
      result: 'deferred_to_window_start',
      deferredFromMs: now,
    });
  });

  it('in a named GAP (11:45) ⇒ deferred to the midday window start 13:00 (exact epoch)', () => {
    const now = tehranAt(2026, 11, 11, 11, 45);
    const decision = schedule(planPublicationTime(baseInput({ nowMs: now, jitterMs: 0 })));
    expect(decision.dueAtMs).toBe(tehranAt(2026, 11, 11, 13, 0));
    expect(decision.window.name).toBe('midday');
  });

  it('late_night_radar IS an active window: a P2 at 23:30 schedules inside it', () => {
    const now = tehranAt(2026, 11, 11, 23, 30);
    const decision = schedule(planPublicationTime(baseInput({ nowMs: now, jitterMs: 0 })));
    expect(decision.dueAtMs).toBe(now);
    expect(decision.window.name).toBe('late_night_radar');
  });

  it('a previous send far in the past is clamped: the due is NEVER in the past', () => {
    const now = tehranAt(2026, 11, 11, 10, 0);
    const decision = schedule(
      planPublicationTime(
        baseInput({
          nowMs: now,
          jitterMs: 25 * MIN,
          previousSend: { atMs: now - 2 * 60 * MIN, related: true, priorityClass: 'P2' },
        }),
      ),
    );
    expect(decision.dueAtMs).toBe(now);
  });

  it('a recent previous send pushes the due past its jitter and the gate re-checks the window', () => {
    const now = tehranAt(2026, 11, 11, 10, 0);
    const decision = schedule(
      planPublicationTime(
        baseInput({
          nowMs: now,
          jitterMs: 25 * MIN,
          previousSend: { atMs: now - 10 * MIN, related: true, priorityClass: 'P2' },
        }),
      ),
    );
    expect(decision.dueAtMs).toBe(now + 15 * MIN); // 10:15 — still inside morning_scan
  });

  it('the P2 jitter is validated against the normal band (25–45 min) when a previous send exists', () => {
    const now = tehranAt(2026, 11, 11, 10, 0);
    expect(
      planPublicationTime(
        baseInput({
          nowMs: now,
          jitterMs: 10 * MIN,
          previousSend: { atMs: now, related: true, priorityClass: 'P2' },
        }),
      ),
    ).toEqual({ ok: false, reason: 'jitter_out_of_bounds' });
  });
});

describe('the same-game cooldown shift (time-resolvable, evaluated BEFORE the window gate)', () => {
  it('a blocked cooldown shifts the due to eligibleAt; the gate then re-checks the window', () => {
    const now = tehranAt(2026, 11, 11, 9, 0); // gap_morning_lead
    const last = now - 30 * MIN;
    const decision = schedule(
      planPublicationTime(
        baseInput({
          nowMs: now,
          jitterMs: 0,
          sameGame: { gameKey: 'game-alpha', lastPublishMs: last, meaningfulUpdate: false },
        }),
      ),
    );
    // due0 = 09:00; cooldown eligible = 09:00 + 60min = 10:00; the gate
    // sees 10:00 INSIDE morning_scan — one decision, both records.
    expect(decision.dueAtMs).toBe(tehranAt(2026, 11, 11, 10, 0));
    expect(decision.appliedRules).toContainEqual({
      rule: 'same_game_cooldown',
      result: 'shifted_to_eligible_at',
    });
    expect(decision.appliedRules).toContainEqual({
      rule: 'window_gate',
      result: 'inside_active_window',
    });
  });

  it('a cooldown shift may land INSIDE the window on its own (19:00 last publish ⇒ 20:30 prime)', () => {
    const now = tehranAt(2026, 11, 11, 19, 45); // gap_evening_prime
    const decision = schedule(
      planPublicationTime(
        baseInput({
          nowMs: now,
          jitterMs: 0,
          sameGame: {
            gameKey: 'game-alpha',
            lastPublishMs: now - 45 * MIN,
            meaningfulUpdate: false,
          },
        }),
      ),
    );
    expect(decision.dueAtMs).toBe(tehranAt(2026, 11, 11, 20, 30)); // 19:00 + 90min
    expect(decision.window.name).toBe('prime');
  });

  it('a MEANINGFUL UPDATE bypass records the bypass and leaves the due untouched', () => {
    const now = tehranAt(2026, 11, 11, 10, 0);
    const decision = schedule(
      planPublicationTime(
        baseInput({
          nowMs: now,
          sameGame: { gameKey: 'game-alpha', lastPublishMs: now - 5 * MIN, meaningfulUpdate: true },
        }),
      ),
    );
    expect(decision.dueAtMs).toBe(now);
    expect(decision.appliedRules).toContainEqual({
      rule: 'same_game_cooldown',
      result: 'bypassed_meaningful_update',
    });
  });
});

describe('the mix gate — enforcement ONLY on P3 filler discretion', () => {
  // esports: target 30‰ — ONE post in a 3-post history is already far
  // over target (1000‰ vs 90‰) while the rolling-six share cap still
  // admits the candidate (count 1 + candidate = 2 ≤ 2). This isolates
  // the MIX gate from the SHARE cap.
  const overTargetEsports = [
    { category: 'esports', atMs: tehranAt(2026, 11, 11, 9, 0) },
    { category: 'mainstream_industry', atMs: tehranAt(2026, 11, 11, 8, 0) },
    { category: 'leak_rumor', atMs: tehranAt(2026, 11, 11, 7, 0) },
  ];

  it('a P3 filler from an OVER-target category is a typed DEFER (mix_target_cap)', () => {
    const decision = defer(
      planPublicationTime(
        baseInput({
          nowMs: tehranAt(2026, 11, 11, 10, 0),
          priorityScore: 30,
          category: 'esports',
          recentCategories: overTargetEsports,
        }),
      ),
    );
    expect(decision.reason).toBe('mix_target_cap');
    expect(decision.dueAtMs).toBeNull();
    expect(decision.appliedRules).toContainEqual(
      expect.objectContaining({
        rule: 'mix_target',
        category: 'esports',
        status: 'over_target',
        result: 'filler_blocked',
      }),
    );
  });

  it('a P3 filler from an under-target category schedules normally', () => {
    const decision = schedule(
      planPublicationTime(
        baseInput({
          priorityScore: 30,
          category: 'mainstream_industry',
          recentCategories: [{ category: 'leak_rumor', atMs: tehranAt(2026, 11, 11, 9, 0) }],
        }),
      ),
    );
    expect(decision.dueAtMs).toBe(baseInput().nowMs);
    expect(decision.appliedRules).toContainEqual(
      expect.objectContaining({ rule: 'mix_target', status: 'under_target', result: 'advisory' }),
    );
  });

  it('P0/P1/P2 carry the mix report as an ADVISORY only — news is never blocked by mix', () => {
    const decision = schedule(
      planPublicationTime(
        baseInput({
          priorityScore: 60,
          category: 'leak_rumor',
          recentCategories: overTargetEsports,
        }),
      ),
    );
    expect(decision.dueAtMs).toBe(baseInput().nowMs);
    expect(decision.appliedRules).toContainEqual(
      expect.objectContaining({ rule: 'mix_target', result: 'advisory', status: 'over_target' }),
    );
  });
});

describe('the non-time-resolvable caps defer with dueAtMs NULL', () => {
  it('a layout run of 3 defers (layout_run_cap) — no due shift can fix it', () => {
    const decision = defer(
      planPublicationTime(
        baseInput({ candidateLayout: 'hero', recentLayouts: ['hero', 'hero', 'hero'] }),
      ),
    );
    expect(decision.reason).toBe('layout_run_cap');
    expect(decision.dueAtMs).toBeNull();
    expect(decision.appliedRules).toContainEqual({
      rule: 'layout_run_cap',
      trailingRun: 3,
      result: 'blocked',
    });
  });

  it('two same-category posts in the rolling six defer (category_share_cap) unless event-driven', () => {
    const now = tehranAt(2026, 11, 11, 10, 0);
    const recentCategories = [
      { category: 'mods', atMs: now - 5 * MIN },
      { category: 'mods', atMs: now - 30 * MIN },
    ];
    const blocked = defer(
      planPublicationTime(baseInput({ nowMs: now, category: 'mods', recentCategories })),
    );
    expect(blocked.reason).toBe('category_share_cap');

    const allowed = schedule(
      planPublicationTime(
        baseInput({ nowMs: now, category: 'mods', recentCategories, eventDriven: true }),
      ),
    );
    expect(allowed.dueAtMs).toBe(now);
    expect(allowed.appliedRules).toContainEqual({
      rule: 'category_share_cap',
      rollingCount: 2,
      result: 'bypassed_event_driven',
    });
  });

  it('the documented precedence: layout beats category beats mix', () => {
    const now = tehranAt(2026, 11, 11, 10, 0);
    const decision = defer(
      planPublicationTime(
        baseInput({
          nowMs: now,
          priorityScore: 30, // P3 — the mix gate applies
          candidateLayout: 'hero',
          recentLayouts: ['hero', 'hero', 'hero'],
          recentCategories: [
            { category: 'mods', atMs: now - 5 * MIN },
            { category: 'mods', atMs: now - 30 * MIN },
          ],
        }),
      ),
    );
    expect(decision.reason).toBe('layout_run_cap');

    const decision2 = defer(
      planPublicationTime(
        baseInput({
          nowMs: now,
          priorityScore: 60, // P2 — the mix gate does NOT apply to news
          category: 'mods',
          recentCategories: [
            { category: 'mods', atMs: now - 5 * MIN },
            { category: 'mods', atMs: now - 30 * MIN },
          ],
          recentLayouts: ['a', 'b', 'a', 'b'], // no layout block
          candidateLayout: 'hero',
        }),
      ),
    );
    expect(decision2.reason).toBe('category_share_cap');
  });
});

describe('the typed input contract', () => {
  it('a missing schemaVersion is malformed; a wrong one is unsupported', () => {
    expect(
      planPublicationTime({ ...baseInput(), schemaVersion: undefined as unknown as 1 }),
    ).toEqual({
      ok: false,
      reason: 'schema_version_malformed',
    });
    expect(planPublicationTime({ ...baseInput(), schemaVersion: 2 as unknown as 1 })).toEqual({
      ok: false,
      reason: 'schema_version_unsupported',
    });
  });

  it('an out-of-vocabulary score propagates invalid_score', () => {
    expect(planPublicationTime(baseInput({ priorityScore: 101 }))).toEqual({
      ok: false,
      reason: 'invalid_score',
    });
  });

  it('a non-integer nowMs fails invalid_input', () => {
    expect(planPublicationTime(baseInput({ nowMs: 1.5 }))).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
  });

  it('an unknown category in the recent history fails unknown_category', () => {
    expect(
      planPublicationTime(
        baseInput({ recentCategories: [{ category: 'gossip', atMs: baseInput().nowMs }] }),
      ),
    ).toEqual({ ok: false, reason: 'unknown_category' });
  });

  it('an over-64-entry layout history fails invalid_input', () => {
    expect(
      planPublicationTime(baseInput({ recentLayouts: Array.from({ length: 65 }, () => 'hero') })),
    ).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('an unknown candidateLayout label is NOT in the closed category vocabulary check — any non-empty label is admissible', () => {
    const decision = schedule(planPublicationTime(baseInput({ candidateLayout: 'x'.repeat(64) })));
    expect(decision.dueAtMs).toBe(baseInput().nowMs);
  });
});

describe('determinism', () => {
  it('the same input always yields the JSON-equal decision', () => {
    const input = baseInput({
      previousSend: { atMs: baseInput().nowMs - 10 * MIN, related: true, priorityClass: 'P2' },
      jitterMs: 30 * MIN,
      sameGame: {
        gameKey: 'game-alpha',
        lastPublishMs: baseInput().nowMs - 200 * MIN,
        meaningfulUpdate: false,
      },
      recentCategories: [{ category: 'mods', atMs: baseInput().nowMs - 40 * MIN }],
    });
    const a = planPublicationTime(input);
    const b = planPublicationTime(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
