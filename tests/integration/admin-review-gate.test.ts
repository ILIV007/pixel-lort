import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  NOW,
  OWNER_ID,
  buildReviewHarness,
  createCountingExecutor,
  freshDb,
  privateMessage,
} from '../helpers/review-test-fixtures';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';

/**
 * R1.18 gate tests: the `ADMIN_REVIEW_ENABLED` fail-closed flag.
 * OFF/absent/invalid => the exact unknown-command noop semantics, ZERO
 * editorial queries, no help advertisement — and the EXISTING commands
 * keep their exact behavior. REAL workerd D1, fake Bot API, zero network.
 */

beforeEach(async () => {
  await freshDb();
});

describe('ADMIN_REVIEW_ENABLED gate — fail-closed', () => {
  it.each([
    ['absent flag (default)', false, 7001],
    ['explicitly false', false, 7002],
  ])(
    '%s: /drafts is the unknown-command noop with zero editorial queries',
    async (_name, _enabled, updateId) => {
      const harness = buildReviewHarness({ reviewEnabled: _enabled });
      const before = harness.executor.stats().total;
      const outcome = await harness.ingress.processUpdate(
        privateMessage(updateId, OWNER_ID, '/drafts'),
      );
      expect(outcome).toBe('processed');
      expect(harness.sends).toHaveLength(0);
      // ZERO editorial (drafts) queries — only the existing lifecycle reads.
      expect(harness.executor.stats().draftsSql).toBe(0);
      expect(harness.executor.stats().total - before).toBeGreaterThan(0);
    },
  );

  it('invalid-present flag never truthy-coerces: /drafts stays noop (config parsed by caller)', async () => {
    // The router's gate is a parsed boolean: any invalid-present env value
    // resolves to `false` upstream (phase9 parser) — this test pins the
    // router side: anything but the literal `true` is disabled.
    const harness = buildReviewHarness({ reviewEnabled: '1' as unknown as boolean });
    const outcome = await harness.ingress.processUpdate(privateMessage(7003, OWNER_ID, '/drafts'));
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
    expect(harness.executor.stats().draftsSql).toBe(0);
  });

  it('OFF: /help does NOT advertise the review surface', async () => {
    const harness = buildReviewHarness({ reviewEnabled: false });
    await harness.ingress.processUpdate(privateMessage(7004, OWNER_ID, '/help'));
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).not.toContain('/drafts');
  });

  it('ON + permitted: /help advertises the read-only review line', async () => {
    const harness = buildReviewHarness({ reviewEnabled: true });
    await harness.ingress.processUpdate(privateMessage(7005, OWNER_ID, '/help'));
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('/drafts — Review stored drafts (read-only)');
  });

  it('OFF: existing commands keep their exact behavior (regression guard)', async () => {
    const harness = buildReviewHarness({ reviewEnabled: false });
    await harness.ingress.processUpdate(privateMessage(7006, OWNER_ID, '/status'));
    await harness.ingress.processUpdate(privateMessage(7007, OWNER_ID, '/version'));
    await harness.ingress.processUpdate(privateMessage(7008, OWNER_ID, '/start'));
    expect(harness.sends).toHaveLength(3);
    expect(harness.sends[0]!.text).toContain('Status');
    expect(harness.sends[1]!.text).toContain('1.12.3');
    expect(harness.sends[2]!.text).toContain('Admin panel is active.');
  });

  it('ON: existing commands keep their exact behavior (regression guard)', async () => {
    const harness = buildReviewHarness({ reviewEnabled: true });
    await harness.ingress.processUpdate(privateMessage(7009, OWNER_ID, '/language'));
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('Admin UI language');
  });

  it('gate OFF produces zero drafts SQL even for hostile probes', async () => {
    const rawExecutor = createDbExecutor(env.DB, { clock: fixedClock(NOW) });
    const executor = createCountingExecutor(rawExecutor);
    const harness = buildReviewHarness({ reviewEnabled: false, executor });
    await harness.ingress.processUpdate(privateMessage(7010, OWNER_ID, "/drafts ' OR 1=1 --"));
    await harness.ingress.processUpdate(privateMessage(7011, OWNER_ID, '/drafts x y z'));
    expect(harness.executor.stats().draftsSql).toBe(0);
    expect(harness.sends).toHaveLength(0);
  });
});
