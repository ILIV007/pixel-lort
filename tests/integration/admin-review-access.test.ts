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

/**
 * R1.18 access tests: role matrix, privacy contexts, argument validation —
 * all on the REAL path (real parser -> authorization -> router -> ingress),
 * zero editorial disclosure outside the allowed surface.
 */

const CHIEF_EDITOR_ID = 2000000001;
const EDITOR_ID = 2000000002;
const REVIEWER_ID = 2000000003;
const VIEWER_ID = 2000000004;
const SOURCE_MANAGER_ID = 2000000005;
const UNKNOWN_ID = 2000000006;
const DISABLED_EDITOR_ID = 2000000007;

beforeEach(async () => {
  await freshDb();
  await seedAdmin(CHIEF_EDITOR_ID, 'chief_editor');
  await seedAdmin(EDITOR_ID, 'editor');
  await seedAdmin(REVIEWER_ID, 'reviewer');
  await seedAdmin(VIEWER_ID, 'viewer');
  await seedAdmin(SOURCE_MANAGER_ID, 'source_manager');
  await seedAdmin(DISABLED_EDITOR_ID, 'editor', 'disabled');
  await seedStory('story-acc-1', 'داستان آزمون دسترسی');
  await seedDraft({
    id: 'draft-acc-1',
    storyId: 'story-acc-1',
    title: 'پیش‌نویس آزمون دسترسی',
    documentJson: JSON.stringify({
      schemaVersion: 1,
      locale: 'fa',
      headlineFa: 'پیش‌نویس آزمون دسترسی',
      summaryFa: 'خلاصهٔ آزمون',
      sourceReport: {
        sourceItemId: 'item-acc-1',
        sourceName: 'منبع آزمون',
        stance: 'mentions',
        excerptText: 'گزارهٔ آزمون',
        truncated: false,
      },
      modelClaims: [],
    }),
  });
});

describe('role matrix (blueprint map unchanged)', () => {
  it.each([
    ['owner (wildcard)', OWNER_ID, 7100],
    ['chief_editor', CHIEF_EDITOR_ID, 7101],
    ['editor', EDITOR_ID, 7102],
    ['reviewer', REVIEWER_ID, 7103],
    ['viewer', VIEWER_ID, 7104],
  ])('%s is allowed the ready list', async (_name, userId, updateId) => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(updateId, userId, '/drafts'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('draft-acc-1');
  });

  it('source_manager is denied with a localized permission denial — even for a guessed ID', async () => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7101, SOURCE_MANAGER_ID, '/drafts draft-acc-1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('does not include draft viewing permission');
    expect(harness.sends[0]!.text).not.toContain('draft-acc-1');
    expect(harness.executor.stats().draftsSql).toBe(0);
  });

  it('unknown actor gets the fixed English denial — no data, no existence leak', async () => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7102, UNKNOWN_ID, '/drafts draft-acc-1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toBe('Access denied.');
    expect(harness.executor.stats().draftsSql).toBe(0);
  });

  it('disabled admin resolves unauthorized — no privileged access', async () => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7103, DISABLED_EDITOR_ID, '/drafts'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toBe('Access denied.');
    expect(harness.executor.stats().draftsSql).toBe(0);
  });
});

describe('privacy and routing contexts', () => {
  it('group chat: silent noop — no editorial query, no disclosure', async () => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7110, OWNER_ID, '/drafts draft-acc-1', { chatType: 'group', chatId: -100123 }),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
    expect(harness.executor.stats().draftsSql).toBe(0);
  });

  it('channel chat: silent noop', async () => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7111, OWNER_ID, '/drafts', { chatType: 'channel', chatId: -100199 }),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
    expect(harness.executor.stats().draftsSql).toBe(0);
  });

  it('edited message: silent noop — no editorial query', async () => {
    const harness = buildReviewHarness();
    const update = privateMessage(7112, OWNER_ID, '/drafts draft-acc-1', {
      kind: 'edited_message',
    });
    const outcome = await harness.ingress.processUpdate(update);
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
    expect(harness.executor.stats().draftsSql).toBe(0);
  });

  it('explicitly-targeted other-bot command: ignored by the existing guard', async () => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7113, OWNER_ID, '/drafts@some_other_bot draft-acc-1', {
        commandTarget: 'some_other_bot',
      }),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
    expect(harness.executor.stats().draftsSql).toBe(0);
  });

  it('unsupported update kinds stay noop (callback queries unchanged)', async () => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate({
      kind: 'callback_query',
      updateId: 7114,
      callbackQueryId: 'cb-1',
      fromUserId: OWNER_ID,
      callbackData: 'a:test',
    });
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
    expect(harness.executor.stats().draftsSql).toBe(0);
  });
});

describe('argument validation — BEFORE any editorial SQL', () => {
  it.each([
    ['trailing extra arguments', '/drafts draft-acc-1 extra', 7120],
    ['embedded whitespace', '/drafts draft acc', 7121],
    ['oversized id (>128 bytes)', `/drafts ${'x'.repeat(129)}`, 7122],
    ['control characters', '/drafts draft\u0001acc', 7123],
    ['SQL-injection-shaped input', "/drafts x'; DROP TABLE drafts; --", 7124],
    ['id with tab inside', '/drafts a\tb', 7125],
    // R1.18.1 (V1): newline-bearing malformed arguments are grammar failures
    // — NEVER the list action — rejected before any editorial SQL.
    ['LF separates a trailing token', '/drafts draft-acc-1\nextra', 7126],
    ['CR inside the argument', '/drafts draft-acc-1\rextra', 7127],
    ['CRLF between tokens', '/drafts draft-acc-1\r\nextra', 7128],
    ['vertical tab is whitespace', '/drafts a\u000bb', 7130],
  ])('%s → honest usage reply, zero drafts queries', async (_name, text, updateId) => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(privateMessage(updateId, OWNER_ID, text));
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('Invalid argument');
    expect(harness.executor.stats().draftsSql).toBe(0);
  });

  it('LF directly after the command is a grammar failure, never the list (V1)', async () => {
    const harness = buildReviewHarness();
    // The REAL parser extracts `drafts` (the lookahead accepts any \s); the
    // remainder begins with a newline — an unsupported separator.
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7129, OWNER_ID, '/drafts\ndraft-acc-1', { command: 'drafts' }),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('Invalid argument');
    expect(harness.executor.stats().draftsSql).toBe(0);
  });

  it('exactly-128-byte id is accepted (byte-bound inclusive)', async () => {
    const harness = buildReviewHarness();
    const id = 'y'.repeat(128);
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7121, OWNER_ID, `/drafts ${id}`),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    // Reaches the (typed) not-found rendering path — the query RAN.
    expect(harness.sends[0]!.text).toContain('Draft not found');
  });

  it('bare trailing separator is the list form', async () => {
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(privateMessage(7122, OWNER_ID, '/drafts '));
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('draft-acc-1');
  });
});
