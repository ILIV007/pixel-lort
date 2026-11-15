import { beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_ID,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedAdmin,
  seedDraft,
} from '../helpers/review-test-fixtures';
import {
  STORY_ID_MAX_BYTES,
  parseStoryArgument,
  renderStoryView,
  type StoryViewPublicationRow,
  type StoryViewRow,
} from '../../src/admin/story-command';
import { parseAdminReviewConfig } from '../../src/shared/config/phase9';
import { ROLE_PERMISSIONS, roleHasPermission } from '../../src/admin/roles';
import { STORY_PUBLICATIONS_SQL, STORY_VIEW_SQL } from '../../src/adapters/db/story-view-store';

/**
 * Phase 9B — the read-only `/story` surface over REAL workerd D1 (the EXACT
 * R1.18/9A shape): the REQUIRED one-token argument grammar, the independent
 * fail-closed `ADMIN_STORY_ENABLED` flag, the blueprint-pinned `story.view`
 * RBAC map, the reserved-skeleton renderer with the honest not-found and
 * empty states, the bounded index-verified reads with ZERO writes, and the
 * wiring-failure honesty. The ONLY artificial pieces are the fake Bot API
 * and the counting executor wrapper (the house LOCAL PROXY metric).
 *
 * The screen performs EXACTLY TWO bounded SELECTs (the story identity PK
 * lookup + the capped per-story publications list over
 * idx_publications_story) and NEVER reads drafts (no index exists on
 * drafts.story_id — a per-story drafts listing would be a full scan, so the
 * screen does not have one; the honest boundary is recorded in
 * docs/reviews/PHASE_9B_STORY_SCREEN.md).
 */

const VIEWER_ID = 2000000011;
const UNKNOWN_ID = 2000000012;

function richStoryRow(overrides: Partial<StoryViewRow> = {}): StoryViewRow {
  return {
    id: 'story-9b-1',
    storyKey: 'key-story-9b-1',
    status: 'published',
    trustStatus: 'verified',
    contentType: 'release',
    priority: 72,
    confidence: 84,
    workingHeadline: 'بازی آزمون منتشر شد',
    firstSeenAt: 1_760_000_000_000,
    lastEvidenceAt: 1_760_000_100_000,
    lastPublishedAt: 1_760_000_200_000,
    version: 3,
    mergedIntoStoryId: null,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_300_000,
    ...overrides,
  };
}

function publicationRow(overrides: Partial<StoryViewPublicationRow> = {}): StoryViewPublicationRow {
  return {
    id: 'pub-9b-1',
    status: 'published',
    priority: 62,
    attempts: 1,
    maxAttempts: 3,
    lastError: null,
    createdAt: 1_760_000_150_000,
    publishedAt: 1_760_000_200_000,
    ...overrides,
  };
}

async function seedRichStory(
  overrides: {
    readonly id?: string;
    readonly status?: string;
    readonly trustStatus?: string;
    readonly contentType?: string;
    readonly mergedIntoStoryId?: string | null;
    readonly headline?: string | null;
  } = {},
): Promise<string> {
  const { env } = await import('cloudflare:test');
  const id = overrides.id ?? 'story-9b-1';
  await env.DB.prepare(
    `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority, confidence,
       working_headline, first_seen_at, last_evidence_at, last_published_at, version,
       merged_into_story_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 72, 84, ?, ?, ?, ?, 3, ?, ?, ?)`,
  )
    .bind(
      id,
      `key-${id}`,
      overrides.status ?? 'published',
      overrides.trustStatus ?? 'verified',
      overrides.contentType ?? 'release',
      overrides.headline ?? 'بازی آزمون منتشر شد',
      1_760_000_000_000,
      1_760_000_100_000,
      1_760_000_200_000,
      overrides.mergedIntoStoryId ?? null,
      1_760_000_000_000,
      1_760_000_300_000,
    )
    .run();
  return id;
}

async function seedStoryPublication(
  id: string,
  status: string,
  createdAt: number,
  lastError: string | null = null,
  storyId = 'story-9b-1',
): Promise<void> {
  const { env } = await import('cloudflare:test');
  await env.DB.prepare(
    `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
      scheduled_at, run_after, claimed_at, lease_until, published_at, attempts,
      max_attempts, idempotency_key, last_error, created_at, updated_at)
     VALUES (?, ?, 'draft-story-9b', ?, 62, 'safe_auto', NULL, ?, NULL, NULL, NULL, 1, 3, ?, ?, ?, ?)`,
  )
    .bind(id, storyId, status, createdAt, `key-${id}`, lastError, createdAt - 1000, createdAt)
    .run();
}

beforeEach(async () => {
  await freshDb();
});

/** The publications FK targets drafts(id) — one stored draft for the story. */
async function seedStoryDraft(): Promise<void> {
  await seedDraft({
    id: 'draft-story-9b',
    storyId: 'story-9b-1',
    title: 'پیش‌نویس داستان آزمون',
    documentJson: JSON.stringify({
      schemaVersion: 1,
      locale: 'fa',
      headlineFa: 'پیش‌نویس داستان آزمون',
      summaryFa: 'خلاصهٔ آزمون',
      modelClaims: [],
    }),
  });
}

describe('the story argument grammar (exactly ONE opaque token REQUIRED)', () => {
  it.each([
    ['undefined (no argument)', undefined],
    ['empty remainder', ''],
    ['two tokens', 'abc def'],
    ['internal whitespace', 'abc\tdef'],
    ['over the byte cap', 'x'.repeat(STORY_ID_MAX_BYTES + 1)],
    ['control character', 'abc\x01def'],
  ])('%s is invalid — there is NO list form', (_name, input) => {
    expect(parseStoryArgument(input as string | undefined)).toEqual({ kind: 'invalid' });
  });

  it('a single opaque token (unicode included) parses to the view action verbatim', () => {
    expect(parseStoryArgument('story-9b-1')).toEqual({ kind: 'view', storyId: 'story-9b-1' });
    expect(parseStoryArgument('شناسه-داستان')).toEqual({
      kind: 'view',
      storyId: 'شناسه-داستان',
    });
    expect(parseStoryArgument('x'.repeat(STORY_ID_MAX_BYTES)).kind).toBe('view');
  });
});

describe('the independent fail-closed ADMIN_STORY_ENABLED parse', () => {
  it('absent keeps the surface disabled (ok result, flag false)', () => {
    const parsed = parseAdminReviewConfig({});
    expect(parsed.result.ok).toBe(true);
    expect(parsed.config.storyEnabled).toBe(false);
  });

  it("exactly 'true' enables; 'false' stays disabled", () => {
    expect(parseAdminReviewConfig({ ADMIN_STORY_ENABLED: 'true' }).config.storyEnabled).toBe(true);
    expect(parseAdminReviewConfig({ ADMIN_STORY_ENABLED: 'false' }).config.storyEnabled).toBe(
      false,
    );
  });

  it.each([
    ['TRUE', 'TRUE'],
    ['numeric one', '1'],
    ['yes', 'yes'],
  ])(
    'a present-but-invalid value (%s) is NEVER coerced — the flag stays disabled',
    (_name, value) => {
      const parsed = parseAdminReviewConfig({ ADMIN_STORY_ENABLED: value as string });
      expect(parsed.config.storyEnabled).toBe(false);
      expect(parsed.result.ok).toBe(false);
      expect(parsed.result.issues.some((issue) => issue.field === 'ADMIN_STORY_ENABLED')).toBe(
        true,
      );
    },
  );

  it('the whole-spec fail-closed rule: an invalid sibling flag value keeps the story flag disabled too', () => {
    const parsed = parseAdminReviewConfig({
      ADMIN_QUEUE_ENABLED: 'bogus',
      ADMIN_STORY_ENABLED: 'true',
    });
    expect(parsed.result.ok).toBe(false);
    expect(parsed.config.storyEnabled).toBe(false);
    expect(parsed.config.queueEnabled).toBe(false);
    expect(parsed.result.issues.some((issue) => issue.field === 'ADMIN_QUEUE_ENABLED')).toBe(true);
  });
});

describe('the blueprint-pinned story.view RBAC map', () => {
  it('EVERY non-owner role holds story.view (the TOTAL map pin — a blueprint change fails loudly)', () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      expect(permissions, `role ${role} must hold story.view`).toContain('story.view');
    }
    expect(roleHasPermission('owner', 'story.view')).toBe(true);
    expect(roleHasPermission('viewer', 'story.view')).toBe(true);
  });
});

describe('the renderer (reserved skeleton, honest states, bounded rows)', () => {
  it('renders the identity verbatim and the publications section EVEN when empty (a zero is information)', () => {
    const view = renderStoryView({
      uiLanguage: 'en',
      story: richStoryRow(),
      publications: [],
      morePublications: false,
      sendGateEnabled: false,
    });
    expect(view).toContain('Story (read-only)');
    expect(view).toContain('story-9b-1');
    expect(view).toContain('key-story-9b-1');
    expect(view).toContain('published');
    expect(view).toContain('verified');
    expect(view).toContain('release');
    expect(view).toContain('بازی آزمون منتشر شد');
    expect(view).toContain('no publications recorded for this story yet');
    expect(view).toContain('decision-only');
  });

  it('the merged state is surfaced honestly; a null headline is stated, never fabricated', () => {
    const merged = renderStoryView({
      uiLanguage: 'en',
      story: richStoryRow({ mergedIntoStoryId: 'story-canonical-1', workingHeadline: null }),
      publications: [],
      morePublications: false,
      sendGateEnabled: false,
    });
    expect(merged).toContain('story-canonical-1');
    expect(merged).not.toContain('بازی آزمون منتشر شد');
  });

  it('the ON gate note says the scheduler may send (never a pretend OFF)', () => {
    const view = renderStoryView({
      uiLanguage: 'en',
      story: richStoryRow(),
      publications: [],
      morePublications: false,
      sendGateEnabled: true,
    });
    expect(view).toContain('scheduler may send');
  });

  it('caps the publication rows at 8, keeps the newest first, and reports more-available', () => {
    const rows = Array.from({ length: 12 }, (_v, index) =>
      publicationRow({
        id: `pub-${String(index + 1).padStart(2, '0')}`,
        createdAt: 1_760_000_100_000 + index * 1000,
      }),
    ).reverse();
    const view = renderStoryView({
      uiLanguage: 'en',
      story: richStoryRow(),
      publications: rows,
      morePublications: true,
      sendGateEnabled: false,
    });
    expect(view).toContain('pub-12');
    expect(view).toContain('pub-05');
    expect(view).not.toContain('pub-04');
    expect(view).toContain('older publications exist');
    expect(view).not.toContain('@');
  });

  it('the row carries ONLY identity/status/counters/stable codes — never content or destinations', () => {
    const view = renderStoryView({
      uiLanguage: 'fa',
      story: richStoryRow(),
      publications: [
        publicationRow({ lastError: 'telegram_timeout', publishedAt: null, status: 'failed' }),
      ],
      morePublications: false,
      sendGateEnabled: false,
    });
    expect(view).toContain('pub-9b-1');
    expect(view).toContain('failed');
    expect(view).toContain('telegram_timeout');
    expect(view).toContain('1/3');
  });

  it('the not-found state is honest and never echoes the requested id', () => {
    const view = renderStoryView({
      uiLanguage: 'en',
      story: null,
      publications: [],
      morePublications: false,
      sendGateEnabled: false,
    });
    expect(view).toContain('No story found');
    expect(view).not.toContain('story-9b-1');
  });
});

describe('routing over REAL D1 (fail-closed gate, RBAC, privacy, grammar, zero writes)', () => {
  it('the flag OFF keeps the exact unknown-command noop — ZERO stories-table statements', async () => {
    await seedRichStory();
    const harness = buildReviewHarness({ storyEnabled: false });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9101, OWNER_ID, '/story story-9b-1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
    const storyStatements = harness.executor
      .stats()
      .sqlTexts.filter((sql) => /\bstories\b/i.test(sql));
    expect(storyStatements).toEqual([]);
  });

  it('the owner gets the story view: the identity lines and the seeded publications (newest first)', async () => {
    await seedRichStory();
    await seedStoryDraft();
    await seedStoryPublication('pub-old-1', 'published', 10_001);
    await seedStoryPublication('pub-new-1', 'pending', 20_002);
    await seedStoryPublication('pub-bad-1', 'failed', 30_003, 'telegram_timeout');
    const harness = buildReviewHarness({ storyEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9102, OWNER_ID, '/story story-9b-1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    const text = harness.sends[0]!.text;
    expect(text).toContain('story-9b-1');
    expect(text).toContain('published');
    expect(text).toContain('verified');
    expect(text).toContain('pub-bad-1');
    expect(text).toContain('telegram_timeout');
    expect(text.indexOf('pub-new-1')).toBeLessThan(text.indexOf('pub-old-1'));
    // ZERO publications-table writes on the whole flow (the read-only
    // contract; the ingress update-lifecycle writes are its own bookkeeping).
    const publicationWrites = harness.executor
      .stats()
      .sqlTexts.filter((sql) => /\bpublications\b/i.test(sql) && !/^\s*SELECT/i.test(sql));
    expect(publicationWrites).toEqual([]);
    // The screen NEVER reads drafts (no index exists on drafts.story_id —
    // the honest bounded-read boundary).
    const draftReads = harness.executor
      .stats()
      .sqlTexts.filter((sql) => /\bFROM drafts\b/i.test(sql));
    expect(draftReads).toEqual([]);
  });

  it('an unknown story id is the honest not-found state — no crash, no fabrication', async () => {
    await seedRichStory();
    const harness = buildReviewHarness({ storyEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9103, OWNER_ID, '/story story-does-not-exist'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('No story found');
  });

  it('an unknown actor gets the fixed English denial — no data, no existence leak', async () => {
    await seedRichStory();
    const harness = buildReviewHarness({ storyEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9104, UNKNOWN_ID, '/story story-9b-1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toBe('Access denied.');
  });

  it('the least-privileged role (viewer) reads the story view — the blueprint grants story.view', async () => {
    await seedAdmin(VIEWER_ID, 'viewer');
    await seedRichStory();
    const harness = buildReviewHarness({ storyEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9105, VIEWER_ID, '/story story-9b-1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('story-9b-1');
  });

  it('a group-chat /story is a noop; an edited message is a noop', async () => {
    await seedRichStory();
    const harness = buildReviewHarness({ storyEnabled: true });
    const groupOutcome = await harness.ingress.processUpdate(
      privateMessage(9106, OWNER_ID, '/story story-9b-1', { chatType: 'group' }),
    );
    expect(groupOutcome).toBe('processed');
    const editedOutcome = await harness.ingress.processUpdate(
      privateMessage(9107, OWNER_ID, '/story story-9b-1', { kind: 'edited_message' }),
    );
    expect(editedOutcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
  });

  it('a missing argument and an oversized token are honest invalid usage — ZERO story SQL', async () => {
    await seedRichStory();
    const harness = buildReviewHarness({ storyEnabled: true });
    const invalidInputs = [
      [9108, '/story'],
      [9109, `/story ${'x'.repeat(STORY_ID_MAX_BYTES + 1)}`],
      [9110, '/story two tokens'],
    ] as const;
    for (const [updateId, text] of invalidInputs) {
      const outcome = await harness.ingress.processUpdate(privateMessage(updateId, OWNER_ID, text));
      expect(outcome).toBe('processed');
      expect(harness.sends[harness.sends.length - 1]!.text).toContain('Invalid argument');
    }
    expect(harness.sends).toHaveLength(invalidInputs.length);
    const storyReads = harness.executor
      .stats()
      .sqlTexts.filter((sql) => /\bFROM stories\b/i.test(sql));
    expect(storyReads).toEqual([]);
  });

  it('/help advertises the story line ONLY when the gate is ON', async () => {
    await seedRichStory();
    const onHarness = buildReviewHarness({ storyEnabled: true });
    await onHarness.ingress.processUpdate(privateMessage(9111, OWNER_ID, '/help'));
    expect(onHarness.sends[0]!.text).toContain('/story');

    const offHarness = buildReviewHarness({ storyEnabled: false });
    await offHarness.ingress.processUpdate(privateMessage(9112, OWNER_ID, '/help'));
    expect(offHarness.sends[0]!.text).not.toContain('/story');
  });

  it('a missing story service is a retryable wiring failure — never a fabricated empty reply', async () => {
    await seedRichStory();
    const harness = buildReviewHarness({ storyEnabled: true, omitStoryService: true });
    await expect(
      harness.ingress.processUpdate(privateMessage(9113, OWNER_ID, '/story story-9b-1')),
    ).rejects.toThrow();
    expect(harness.sends).toHaveLength(0);
  });

  it('the per-story publications read is capped in SQL (LIMIT present in the statement text)', async () => {
    await seedRichStory();
    await seedStoryDraft();
    for (let index = 1; index <= 11; index += 1) {
      await seedStoryPublication(
        `pub-cap-${String(index).padStart(2, '0')}`,
        'published',
        index * 1000,
      );
    }
    const harness = buildReviewHarness({ storyEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(9114, OWNER_ID, '/story story-9b-1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    const text = harness.sends[0]!.text;
    expect(text).toContain('pub-cap-11');
    expect(text).not.toContain('pub-cap-02');
    expect(text).toContain('older publications exist');
  });
});

describe('REAL EXPLAIN QUERY PLAN (LOCAL PROXY): index searches only, no full scans', () => {
  it('the story identity lookup is a PK-index search', async () => {
    const { env } = await import('cloudflare:test');
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${STORY_VIEW_SQL}`)
      .bind('story-9b-1')
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join(' | ');
    expect(details).toMatch(/SEARCH stories USING INDEX/);
    expect(details).not.toMatch(/SCAN/);
  });

  it('the per-story publications list is an idx_publications_story search — no temp B-tree', async () => {
    const { env } = await import('cloudflare:test');
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${STORY_PUBLICATIONS_SQL}`)
      .bind('story-9b-1')
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join(' | ');
    expect(details).toMatch(/SEARCH publications USING INDEX idx_publications_story/);
    expect(details).not.toMatch(/SCAN/);
    expect(details).not.toMatch(/TEMP/);
  });
});
