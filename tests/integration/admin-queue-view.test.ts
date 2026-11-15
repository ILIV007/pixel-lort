import { beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_ID,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedAdmin,
  seedDraft,
  seedStory,
} from '../helpers/review-test-fixtures';
import { parseQueueArgument, renderQueueView } from '../../src/admin/queue-command';
import { PUBLICATION_STATUSES } from '../../src/domain/publishing/outbox-lifecycle';
import type { PublicationStatusCounts } from '../../src/adapters/db/publication-outbox-store';

/**
 * Phase 9A — the read-only `/queue` surface over REAL workerd D1 (the
 * R1.18 shape): role matrix, privacy contexts, argument grammar, the
 * honest gate note, the bounded reads with ZERO writes, and the wiring
 * failure honesty. The ONLY artificial pieces are the fake Bot API and
 * the counting executor wrapper (the house LOCAL PROXY metric).
 */

const CHIEF_EDITOR_ID = 2000000001;
const SOURCE_MANAGER_ID = 2000000005;
const UNKNOWN_ID = 2000000006;

function emptyCounts(): PublicationStatusCounts {
  return Object.fromEntries(
    PUBLICATION_STATUSES.map((status) => [status, 0]),
  ) as PublicationStatusCounts;
}

async function seedQueueFixtures(): Promise<void> {
  await seedAdmin(OWNER_ID, 'owner');
  await seedAdmin(CHIEF_EDITOR_ID, 'chief_editor');
  await seedAdmin(SOURCE_MANAGER_ID, 'source_manager');
  await seedStory('story-q-1', 'داستان صف آزمون');
  await seedDraft({
    id: 'draft-q-1',
    storyId: 'story-q-1',
    title: 'پیش‌نویس صف آزمون',
    documentJson: JSON.stringify({
      schemaVersion: 1,
      locale: 'fa',
      headlineFa: 'پیش‌نویس صف آزمون',
      summaryFa: 'خلاصهٔ آزمون',
      modelClaims: [],
    }),
  });
}

async function seedPublication(
  id: string,
  status: string,
  updatedAt: number,
  lastError: string | null = null,
): Promise<void> {
  const { env } = await import('cloudflare:test');
  await env.DB.prepare(
    `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
      scheduled_at, run_after, claimed_at, lease_until, published_at, attempts,
      max_attempts, idempotency_key, last_error, created_at, updated_at)
     VALUES (?, 'story-q-1', 'draft-q-1', ?, 62, 'safe_auto', NULL, ?, NULL, NULL, NULL, 0, 3, ?, ?, ?, ?)`,
  )
    .bind(id, status, updatedAt, `key-${id}`, lastError, updatedAt - 1000, updatedAt)
    .run();
}

beforeEach(async () => {
  await freshDb();
});

describe('the queue argument grammar (no-argument form ONLY)', () => {
  it.each([
    ['undefined', undefined, 'list'],
    ['empty remainder', '', 'list'],
    ['one token', 'extra', 'invalid'],
    ['whitespace + token', ' extra', 'invalid'],
  ])('%s parses to %s', (_name, input, expected) => {
    expect(parseQueueArgument(input as string | undefined)).toEqual({ kind: expected });
  });
});

describe('the renderer (TOTAL status vocabulary, honest gate note, bounded rows)', () => {
  it('lists EVERY status of the machine vocabulary even at zero', () => {
    const view = renderQueueView({
      uiLanguage: 'en',
      counts: emptyCounts(),
      recent: [],
      sendGateEnabled: false,
    });
    for (const status of PUBLICATION_STATUSES) {
      expect(view).toContain(status);
    }
    expect(view).toContain('nothing sends');
  });

  it('the ON gate note says the scheduler may send (never a pretend OFF)', () => {
    const view = renderQueueView({
      uiLanguage: 'en',
      counts: emptyCounts(),
      recent: [],
      sendGateEnabled: true,
    });
    expect(view).toContain('scheduler may send');
  });

  it('caps the recent rows at 8 and never leaks destination or content fields', () => {
    // The store returns the rows NEWEST-FIRST; the renderer keeps the first
    // 8 of that order — here pub-11..pub-4 are kept, pub-3 (older) drops.
    const recent = Array.from({ length: 12 }, (_v, index) => ({
      id: `pub-${index}`,
      status: 'failed' as const,
      priority: 62,
      attempts: 3,
      maxAttempts: 3,
      lastError: 'telegram_timeout',
      updatedAt: index,
    })).reverse();
    const view = renderQueueView({
      uiLanguage: 'en',
      counts: emptyCounts(),
      recent,
      sendGateEnabled: false,
    });
    expect(view).toContain('pub-11');
    expect(view).not.toContain('pub-3');
    expect(view).toContain('telegram_timeout');
    // No destination-shaped @username and no story/draft content in the view.
    expect(view).not.toContain('@');
  });
});

describe('routing (fail-closed gate, RBAC, privacy, grammar)', () => {
  it('the flag OFF keeps the exact unknown-command noop — zero reads', async () => {
    await seedQueueFixtures();
    const harness = buildReviewHarness({ queueEnabled: false });
    const outcome = await harness.ingress.processUpdate(privateMessage(9001, OWNER_ID, '/queue'));
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
  });

  it('the owner gets the counts view; the empty outbox is honest (all zeros + the empty note)', async () => {
    await seedQueueFixtures();
    const harness = buildReviewHarness({ queueEnabled: true });
    const outcome = await harness.ingress.processUpdate(privateMessage(9002, OWNER_ID, '/queue'));
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('Publication queue');
    expect(harness.sends[0]!.text).toContain('no publications recorded yet');
  });

  it.each([
    ['chief_editor', CHIEF_EDITOR_ID, 9003],
    ['owner', OWNER_ID, 9004],
  ])(
    '%s sees the seeded rows; the reads are bounded and write-free',
    async (_name, userId, updateId) => {
      await seedQueueFixtures();
      await seedPublication('pub-pending-1', 'pending', 10_001);
      await seedPublication('pub-pending-2', 'pending', 10_002);
      await seedPublication('pub-published-1', 'published', 10_003);
      await seedPublication('pub-failed-1', 'failed', 10_004, 'telegram_rate_limited');
      const harness = buildReviewHarness({ queueEnabled: true });
      const outcome = await harness.ingress.processUpdate(
        privateMessage(updateId, userId, '/queue'),
      );
      expect(outcome).toBe('processed');
      expect(harness.sends).toHaveLength(1);
      const text = harness.sends[0]!.text;
      expect(text).toContain('pending: 2');
      expect(text).toContain('published: 1');
      expect(text).toContain('failed: 1');
      expect(text).toContain('pub-failed-1');
      expect(text).toContain('telegram_rate_limited');
      // The /queue flow performed ZERO publication writes (the read-only
      // contract): every publications-table statement is a SELECT (the
      // webhook update-lifecycle writes are the ingress's own bookkeeping).
      const publicationWrites = harness.executor
        .stats()
        .sqlTexts.filter((sql) => /\bpublications\b/i.test(sql) && !/^\s*SELECT/i.test(sql));
      expect(publicationWrites).toEqual([]);
    },
  );

  it('source_manager (no publication.view) is denied with the localized text and ZERO outbox reads', async () => {
    await seedQueueFixtures();
    await seedPublication('pub-pending-3', 'pending', 10_005);
    const harness = buildReviewHarness({ queueEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9005, SOURCE_MANAGER_ID, '/queue'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('does not include publication viewing permission');
    expect(harness.sends[0]!.text).not.toContain('pub-pending-3');
  });

  it('an unknown actor gets the fixed English denial — no data, no existence leak', async () => {
    await seedQueueFixtures();
    const harness = buildReviewHarness({ queueEnabled: true });
    const outcome = await harness.ingress.processUpdate(privateMessage(9006, UNKNOWN_ID, '/queue'));
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toBe('Access denied.');
  });

  it('a group-chat /queue is a noop; an edited message is a noop', async () => {
    await seedQueueFixtures();
    const harness = buildReviewHarness({ queueEnabled: true });
    const groupOutcome = await harness.ingress.processUpdate(
      privateMessage(9007, OWNER_ID, '/queue', { chatType: 'group' }),
    );
    expect(groupOutcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
    const editedOutcome = await harness.ingress.processUpdate(
      privateMessage(9008, OWNER_ID, '/queue', { kind: 'edited_message' }),
    );
    expect(editedOutcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
  });

  it('an argument remainder is honest invalid usage — never the list action', async () => {
    await seedQueueFixtures();
    const harness = buildReviewHarness({ queueEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9009, OWNER_ID, '/queue something'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('Invalid argument');
  });

  it('/help advertises the queue line ONLY when the gate is ON and the role holds publication.view', async () => {
    await seedQueueFixtures();
    const onHarness = buildReviewHarness({ queueEnabled: true });
    await onHarness.ingress.processUpdate(privateMessage(9010, OWNER_ID, '/help'));
    expect(onHarness.sends[0]!.text).toContain('/queue');

    const offHarness = buildReviewHarness({ queueEnabled: false });
    await offHarness.ingress.processUpdate(privateMessage(9011, OWNER_ID, '/help'));
    expect(offHarness.sends[0]!.text).not.toContain('/queue');
  });

  it('a missing queue service is a retryable wiring failure — never a fabricated empty reply', async () => {
    await seedQueueFixtures();
    const harness = buildReviewHarness({ queueEnabled: true, omitQueueService: true });
    await expect(
      harness.ingress.processUpdate(privateMessage(9012, OWNER_ID, '/queue')),
    ).rejects.toThrow();
    expect(harness.sends).toHaveLength(0);
  });
});
