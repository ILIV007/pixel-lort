import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  captureEditorialVersion,
  cancelOpenDraft,
  findVersionByEditorialSource,
  getApproval,
  getDraft,
} from '../../src/adapters/db/admin-post-store';
import { createAdminPostService } from '../../src/application/admin-post/admin-post-service';
import { captureVersion, getVersion } from '../../src/adapters/db/admin-post-store';
import { issueActionToken } from '../../src/adapters/telegram/action-tokens';
import { createRichTextEnvelope } from '../../src/domain/telegram/rich-text-envelope';
import { serializeAndFingerprint, randomToken } from '../../src/domain/admin-post/fingerprint';
import type { Clock } from '../../src/shared/time/clock';
import type { Logger } from '../../src/observability/logger';

/**
 * R1.22 Phase A review round — atomicity and fencing for the EDITORIAL
 * bridge (`captureEditorialVersion`), over REAL workerd D1, in the exact
 * interleaving style of the R1.20-R1 atomicity suite:
 * - the migration-0006 partial UNIQUE index is the HARD fence: a losing
 *   conversion (same editorial draft version already derived — even into a
 *   DIFFERENT admin post draft) rolls its WHOLE batch back — no loser draft
 *   row, no head bump, no approval invalidation side effects;
 * - an editorial conversion invalidates older approvals through the SAME
 *   fenced atomic batch as a manual capture — proven through the REAL
 *   callback path (bind -> convert -> approve = honest stale answer);
 * - a second conversion by a DIFFERENT authorized creator is the honest
 *   already-derived POINTER reply — never a duplicate of the news.
 */

const EDITOR_A = 2000000010;
const EDITOR_B = 2000000011;
const START = 1_700_000_000_000;
const EDITORIAL_DRAFT_ID = 'eddr_0123456789abcdef0123456789abcdef';

function silentLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;
}

function mutableClock(startMs: number): Clock & { readonly advance: (ms: number) => void } {
  let nowMs = startMs;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

async function textEnvelope(
  text: string,
): Promise<{ readonly json: string; readonly fingerprint: string }> {
  const canonical = createRichTextEnvelope({ kind: 'text', text, entities: [] });
  if (!canonical.ok) throw new Error('fixture envelope rejected');
  const outcome = await serializeAndFingerprint(canonical.envelope);
  if (!outcome.ok) throw new Error('fixture envelope serialization rejected');
  return outcome;
}

async function seedEditorialDraft(
  executor: DbExecutor,
  draftId = EDITORIAL_DRAFT_ID,
): Promise<void> {
  // drafts.story_id FK target.
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority, confidence,
            working_headline, first_seen_at, last_evidence_at, version, created_at, updated_at)
          VALUES ('story-ed-1', 'key-ed-1', 'discovered', 'reported', 'official_news', 50, 10,
                  'سرتیتر دمو', ?, ?, 1, ?, ?)`,
    params: [START, START, START, START],
  });
  // A REAL renderable document (the exact shape the R1.12 mapper writes) —
  // the service-level tests render it deterministically.
  const document = JSON.stringify({
    schemaVersion: 1,
    locale: 'fa',
    headlineFa: 'سرتیتر دمو',
    summaryFa: 'خلاصهٔ دمو برای رندر پل.',
    sourceReport: {
      sourceItemId: 'item-ed-1',
      sourceName: 'منبع دمو',
      stance: 'mentions',
      excerptText: 'گزیده',
      truncated: false,
    },
    modelClaims: [{ text: 'ادعای مدل دمو', evidenceIds: ['item-ed-1'], status: 'unverified' }],
  });
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json, version,
            created_by, created_at, updated_at)
          VALUES (?, 'story-ed-1', 'ready', 'fa', 'news_v1', 'سرتیتر دمو', ?, 1,
                  'editorial.prepare_draft', ?, ?)`,
    params: [draftId, document, START, START],
  });
}

async function seedCapturedOpenDraft(
  executor: DbExecutor,
  telegramUserId: number,
): Promise<{ draftId: string; fingerprint: string }> {
  const envelope = await textEnvelope('پست دستی اول');
  const draftId = randomToken();
  const capture = await captureVersion(executor, {
    draftId,
    existingDraftId: undefined,
    envelopeJson: envelope.json,
    fingerprint: envelope.fingerprint,
    sourceUpdateId: 11,
    telegramUserId,
    nowMs: START,
  });
  if (capture.kind !== 'created') throw new Error('fixture capture failed');
  return { draftId, fingerprint: envelope.fingerprint };
}

let executor: DbExecutor;

beforeEach(async () => {
  await applyMigrations(env.DB);
  executor = createDbExecutor(env.DB);
  for (const table of [
    'admin_action_tokens',
    'admin_post_publications',
    'admin_post_approvals',
    'admin_post_preview_sessions',
    'admin_post_versions',
    'admin_post_drafts',
    'drafts',
    'stories',
    'telegram_updates',
    'settings',
    'admins',
  ]) {
    await executor.run({ sql: `DELETE FROM ${table}` });
  }
  // admin_action_tokens.telegram_user_id has an FK to admins — the
  // service-level callback tests need their actors to EXIST.
  for (const [id, role] of [
    [EDITOR_A, 'editor'],
    [EDITOR_B, 'editor'],
  ] as const) {
    await executor.run({
      sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
            VALUES (?, ?, ?, 'active', 1, 1)`,
      params: [id, `Editor ${id}`, role],
    });
  }
});

describe('R1.22 review — the editorial bridge is FENCED by the migration-0006 unique index', () => {
  it('a losing NEW-draft conversion rolls its WHOLE batch back (no loser draft row, no version row)', async () => {
    await seedEditorialDraft(executor);

    // The WINNER: a conversion that already derived version 1 from the
    // editorial draft (into another creator's post draft).
    const winnerEnvelope = await textEnvelope('نسخهٔ برنده');
    const winnerDraftId = randomToken();
    const winner = await captureEditorialVersion(executor, {
      draftId: winnerDraftId,
      existingDraftId: undefined,
      envelopeJson: winnerEnvelope.json,
      fingerprint: winnerEnvelope.fingerprint,
      editorialDraftId: EDITORIAL_DRAFT_ID,
      editorialDraftVersion: 1,
      telegramUserId: EDITOR_A,
      nowMs: START,
    });
    expect(winner.kind).toBe('created');

    // The LOSER: a concurrent conversion of the SAME editorial draft
    // version — the unique index must refuse it.
    const loserEnvelope = await textEnvelope('نسخهٔ بازنده');
    const loserDraftId = randomToken();
    await expect(
      captureEditorialVersion(executor, {
        draftId: loserDraftId,
        existingDraftId: undefined,
        envelopeJson: loserEnvelope.json,
        fingerprint: loserEnvelope.fingerprint,
        editorialDraftId: EDITORIAL_DRAFT_ID,
        editorialDraftVersion: 1,
        telegramUserId: EDITOR_B,
        nowMs: START + 1,
      }),
    ).rejects.toThrow();

    // Rollback proof: the loser's draft row does NOT exist and the loser's
    // version row does NOT exist — the batch is atomic.
    expect(await getDraft(executor, loserDraftId)).toBeNull();
    expect(await getVersion(executor, loserDraftId, 1)).toBeNull();
    // The winner is untouched and remains the ONLY derivation.
    const pointer = await findVersionByEditorialSource(executor, EDITORIAL_DRAFT_ID, 1);
    expect(pointer?.draft_id).toBe(winnerDraftId);
  });

  it('a losing conversion into an EXISTING draft bumps NOTHING (head fence + unique index, whole-batch rollback)', async () => {
    await seedEditorialDraft(executor);
    const seeded = await seedCapturedOpenDraft(executor, EDITOR_B);

    // Seed an ACTIVE approval for v1 — a loser conversion must NOT
    // invalidate it (its whole batch rolls back).
    await executor.run({
      sql: `INSERT INTO admin_post_approvals
              (draft_id, version, fingerprint, approved_by_user_id, session_id, state, approved_at_ms)
            VALUES (?, 1, ?, ?, ?, 'active', ?)`,
      params: [seeded.draftId, seeded.fingerprint, EDITOR_B, randomToken(), START],
    });

    // The WINNER holds the editorial pair already (another draft).
    const winnerEnvelope = await textEnvelope('نسخهٔ برنده');
    const winner = await captureEditorialVersion(executor, {
      draftId: randomToken(),
      existingDraftId: undefined,
      envelopeJson: winnerEnvelope.json,
      fingerprint: winnerEnvelope.fingerprint,
      editorialDraftId: EDITORIAL_DRAFT_ID,
      editorialDraftVersion: 1,
      telegramUserId: EDITOR_A,
      nowMs: START,
    });
    expect(winner.kind).toBe('created');

    // The LOSER converts into ITS OWN open draft — the version INSERT hits
    // the unique index and the WHOLE batch (insert + head bump + approval
    // invalidation) must roll back.
    const loserEnvelope = await textEnvelope('نسخهٔ بازندهٔ موجود');
    await expect(
      captureEditorialVersion(executor, {
        draftId: randomToken(),
        existingDraftId: seeded.draftId,
        envelopeJson: loserEnvelope.json,
        fingerprint: loserEnvelope.fingerprint,
        editorialDraftId: EDITORIAL_DRAFT_ID,
        editorialDraftVersion: 1,
        telegramUserId: EDITOR_B,
        nowMs: START + 1,
      }),
    ).rejects.toThrow();

    // The draft head is UNCHANGED (still version 1) and the v1 approval is
    // STILL ACTIVE — a losing conversion leaves zero side effects.
    const draft = await getDraft(executor, seeded.draftId);
    expect(draft?.current_version).toBe(1);
    const approval = await getApproval(executor, seeded.draftId, 1);
    expect(approval?.state).toBe('active');
  });
});

describe('R1.22 review — the editorial conversion invalidates approvals like a manual capture', () => {
  it('bind -> convert -> approve: the approve click answers STALE through the REAL callback path', async () => {
    await seedEditorialDraft(executor);
    const seeded = await seedCapturedOpenDraft(executor, EDITOR_A);
    const sessionId = randomToken();
    await executor.run({
      sql: `INSERT INTO admin_post_preview_sessions
              (id, draft_id, version, fingerprint, preview_chat_id, source_update_id, expires_at_ms, created_at_ms)
            VALUES (?, ?, 1, ?, ?, 99, ?, ?)`,
      params: [sessionId, seeded.draftId, seeded.fingerprint, EDITOR_A, START + 30 * 60_000, START],
    });

    // The EDITOR converts v2 (bumps the head + invalidates v1 approvals in
    // the same atomic batch).
    const v2 = await textEnvelope('محتوای ادیتوریال به‌عنوان نسخهٔ دوم');
    const conversion = await captureEditorialVersion(executor, {
      draftId: randomToken(),
      existingDraftId: seeded.draftId,
      envelopeJson: v2.json,
      fingerprint: v2.fingerprint,
      editorialDraftId: EDITORIAL_DRAFT_ID,
      editorialDraftVersion: 1,
      telegramUserId: EDITOR_A,
      nowMs: START + 5,
    });
    expect(conversion.kind).toBe('version_added');

    // The approve click happens LAST (a stale preview session/token).
    const clock = mutableClock(START + 20);
    const token = randomToken();
    await issueActionToken(executor, {
      token,
      telegramUserId: EDITOR_A,
      permission: 'draft.approve',
      action: 'admin_post.approve',
      targetType: 'admin_post_draft',
      targetId: seeded.draftId,
      payloadJson: JSON.stringify({
        version: 1,
        fingerprint: seeded.fingerprint,
        sessionId,
      }),
      expiresAtMs: START + 30 * 60_000,
      nowMs: clock.now(),
    });
    const service = createAdminPostService({
      executor,
      clock,
      logger: silentLogger(),
      config: { livePublishEnabled: false, destination: '@pixel_channel' },
    });
    const result = await service.handleCallback({
      telegramUserId: EDITOR_A,
      role: 'owner',
      uiLanguage: 'en',
      token,
    });
    expect(result.kind).toBe('answer');
    if (result.kind === 'answer') {
      // The head moved: the honest stale answer — never a wrong approval.
      expect(result.callbackText).toContain('newer version');
    }
    // The stale approval was never written: the fence rolled the batch back.
    expect(await getApproval(executor, seeded.draftId, 1)).toBeNull();
  });

  it('a second conversion by a DIFFERENT authorized creator is the honest pointer reply', async () => {
    await seedEditorialDraft(executor);
    const winnerEnvelope = await textEnvelope('نسخهٔ برنده');
    const winnerDraftId = randomToken();
    await captureEditorialVersion(executor, {
      draftId: winnerDraftId,
      existingDraftId: undefined,
      envelopeJson: winnerEnvelope.json,
      fingerprint: winnerEnvelope.fingerprint,
      editorialDraftId: EDITORIAL_DRAFT_ID,
      editorialDraftVersion: 1,
      telegramUserId: EDITOR_A,
      nowMs: START,
    });

    // EDITOR_B (no open draft) converts the SAME editorial draft — the
    // service answers with the honest pointer to the winner's post, never a
    // duplicate version.
    const service = createAdminPostService({
      executor,
      clock: mutableClock(START + 30),
      logger: silentLogger(),
      config: { livePublishEnabled: false, destination: '@pixel_channel' },
    });
    const result = await service.createFromEditorial({
      telegramUserId: EDITOR_B,
      role: 'editor',
      uiLanguage: 'en',
      updateId: 777,
      editorialDraftId: EDITORIAL_DRAFT_ID,
    });
    expect(result.kind).toBe('reply');
    if (result.kind === 'reply') {
      expect(result.text).toContain('already prepared as post version 1');
      expect(result.text).toContain(winnerDraftId);
    }
    // Exactly ONE derived version exists.
    const pointer = await findVersionByEditorialSource(executor, EDITORIAL_DRAFT_ID, 1);
    expect(pointer?.draft_id).toBe(winnerDraftId);
  });
});

describe('independent review: cancelled-draft interleaving', () => {
  it('does not commit an editorial version if the draft is cancelled before the batch', async () => {
    await seedEditorialDraft(executor);
    const seeded = await seedCapturedOpenDraft(executor, EDITOR_A);
    const serialized = await textEnvelope('editorial version');
    const racing: DbExecutor = {
      ...executor,
      batch: async (statements) => {
        const cancelled = await cancelOpenDraft(executor, {
          draftId: seeded.draftId,
          telegramUserId: EDITOR_A,
          nowMs: START + 1,
        });
        expect(cancelled.kind).toBe('cancelled');
        return executor.batch(statements);
      },
    };
    await expect(
      captureEditorialVersion(racing, {
        draftId: randomToken(),
        existingDraftId: seeded.draftId,
        envelopeJson: serialized.json,
        fingerprint: serialized.fingerprint,
        editorialDraftId: EDITORIAL_DRAFT_ID,
        editorialDraftVersion: 1,
        telegramUserId: EDITOR_A,
        nowMs: START + 1,
      }),
    ).rejects.toThrow();
    expect(await getVersion(executor, seeded.draftId, 2)).toBeNull();
    expect(await findVersionByEditorialSource(executor, EDITORIAL_DRAFT_ID, 1)).toBeNull();
  });
});

describe('independent review: cancelled manual capture interleaving', () => {
  it('does not commit a manual version if cancelled before the batch', async () => {
    const seeded = await seedCapturedOpenDraft(executor, EDITOR_A);
    const serialized = await textEnvelope('next manual version');
    const racing: DbExecutor = {
      ...executor,
      batch: async (statements) => {
        const cancelled = await cancelOpenDraft(executor, {
          draftId: seeded.draftId,
          telegramUserId: EDITOR_A,
          nowMs: START + 1,
        });
        expect(cancelled.kind).toBe('cancelled');
        return executor.batch(statements);
      },
    };
    await expect(
      captureVersion(racing, {
        draftId: randomToken(),
        existingDraftId: seeded.draftId,
        envelopeJson: serialized.json,
        fingerprint: serialized.fingerprint,
        sourceUpdateId: 12,
        telegramUserId: EDITOR_A,
        nowMs: START + 1,
      }),
    ).rejects.toThrow();
    expect(await getVersion(executor, seeded.draftId, 2)).toBeNull();
  });
});

// GLM independent-review round (issue #12 acceptance): the two reviewer
// tests above prove NO version commits for a cancelled draft. These three
// prove the REST of the acceptance contract: zero approval mutation and
// zero partial state for a stale/cancelled draft (head untouched; the
// final approval state is EXACTLY what cancelOpenDraft alone produces —
// verified against a cancel-only control fixture), plus the fenced
// SUCCESS path staying intact.
describe('independent review: cancelled capture mutates NO approvals and NO head', () => {
  it('a cancelled MANUAL capture: no v2, head stays 1, approvals end EXACTLY as the cancel alone leaves them', async () => {
    // CONTROL: the same fixture with the cancel ONLY — no racing capture —
    // records what cancelOpenDraft itself does to approvals (it invalidates
    // active ones by design). The racing capture must add ZERO mutations
    // beyond that effect.
    const control = await seedCapturedOpenDraft(executor, EDITOR_A);
    await executor.run({
      sql: `INSERT INTO admin_post_approvals
              (draft_id, version, fingerprint, approved_by_user_id, session_id, state, approved_at_ms)
            VALUES (?, 1, ?, ?, ?, 'active', ?)`,
      params: [control.draftId, control.fingerprint, EDITOR_A, randomToken(), START],
    });
    const cancelOnly = await cancelOpenDraft(executor, {
      draftId: control.draftId,
      telegramUserId: EDITOR_A,
      nowMs: START + 1,
    });
    expect(cancelOnly.kind).toBe('cancelled');
    const controlApproval = await getApproval(executor, control.draftId, 1);

    // RACING: identical fixture, the cancel wins between the pre-read and
    // the capture batch.
    const seeded = await seedCapturedOpenDraft(executor, EDITOR_A);
    await executor.run({
      sql: `INSERT INTO admin_post_approvals
              (draft_id, version, fingerprint, approved_by_user_id, session_id, state, approved_at_ms)
            VALUES (?, 1, ?, ?, ?, 'active', ?)`,
      params: [seeded.draftId, seeded.fingerprint, EDITOR_A, randomToken(), START],
    });
    const serialized = await textEnvelope('نسخهٔ لغوشدهٔ دستی');
    const racing: DbExecutor = {
      ...executor,
      batch: async (statements) => {
        const cancelled = await cancelOpenDraft(executor, {
          draftId: seeded.draftId,
          telegramUserId: EDITOR_A,
          nowMs: START + 1,
        });
        expect(cancelled.kind).toBe('cancelled');
        return executor.batch(statements);
      },
    };
    await expect(
      captureVersion(racing, {
        draftId: randomToken(),
        existingDraftId: seeded.draftId,
        envelopeJson: serialized.json,
        fingerprint: serialized.fingerprint,
        sourceUpdateId: 13,
        telegramUserId: EDITOR_A,
        nowMs: START + 1,
      }),
    ).rejects.toThrow();
    expect(await getVersion(executor, seeded.draftId, 2)).toBeNull();
    const draft = await getDraft(executor, seeded.draftId);
    expect(draft?.current_version).toBe(1);
    // Zero mutations BEYOND the cancel's own effect — same final approval
    // state and untouched fingerprint (the capture never rewrote anything).
    const approval = await getApproval(executor, seeded.draftId, 1);
    expect(approval?.state).toBe(controlApproval?.state);
    expect(approval?.fingerprint).toBe(controlApproval?.fingerprint);
  });

  it('a cancelled EDITORIAL conversion: no v2, no mapping, head stays 1, approvals end EXACTLY as the cancel alone leaves them', async () => {
    // CONTROL: cancel ONLY, no racing conversion.
    await seedEditorialDraft(executor);
    const control = await seedCapturedOpenDraft(executor, EDITOR_A);
    await executor.run({
      sql: `INSERT INTO admin_post_approvals
              (draft_id, version, fingerprint, approved_by_user_id, session_id, state, approved_at_ms)
            VALUES (?, 1, ?, ?, ?, 'active', ?)`,
      params: [control.draftId, control.fingerprint, EDITOR_A, randomToken(), START],
    });
    const cancelOnly = await cancelOpenDraft(executor, {
      draftId: control.draftId,
      telegramUserId: EDITOR_A,
      nowMs: START + 1,
    });
    expect(cancelOnly.kind).toBe('cancelled');
    const controlApproval = await getApproval(executor, control.draftId, 1);

    // RACING: identical fixture, the cancel wins before the batch.
    const seeded = await seedCapturedOpenDraft(executor, EDITOR_A);
    await executor.run({
      sql: `INSERT INTO admin_post_approvals
              (draft_id, version, fingerprint, approved_by_user_id, session_id, state, approved_at_ms)
            VALUES (?, 1, ?, ?, ?, 'active', ?)`,
      params: [seeded.draftId, seeded.fingerprint, EDITOR_A, randomToken(), START],
    });
    const serialized = await textEnvelope('نسخهٔ لغوشدهٔ ادیتوریال');
    const racing: DbExecutor = {
      ...executor,
      batch: async (statements) => {
        const cancelled = await cancelOpenDraft(executor, {
          draftId: seeded.draftId,
          telegramUserId: EDITOR_A,
          nowMs: START + 1,
        });
        expect(cancelled.kind).toBe('cancelled');
        return executor.batch(statements);
      },
    };
    await expect(
      captureEditorialVersion(racing, {
        draftId: randomToken(),
        existingDraftId: seeded.draftId,
        envelopeJson: serialized.json,
        fingerprint: serialized.fingerprint,
        editorialDraftId: EDITORIAL_DRAFT_ID,
        editorialDraftVersion: 1,
        telegramUserId: EDITOR_A,
        nowMs: START + 1,
      }),
    ).rejects.toThrow();
    expect(await getVersion(executor, seeded.draftId, 2)).toBeNull();
    expect(await findVersionByEditorialSource(executor, EDITORIAL_DRAFT_ID, 1)).toBeNull();
    const draft = await getDraft(executor, seeded.draftId);
    expect(draft?.current_version).toBe(1);
    const approval = await getApproval(executor, seeded.draftId, 1);
    expect(approval?.state).toBe(controlApproval?.state);
    expect(approval?.fingerprint).toBe(controlApproval?.fingerprint);
  });

  it('the fenced SUCCESS path is intact: v2 commits, head bumps to 2, the v1 approval is invalidated', async () => {
    const seeded = await seedCapturedOpenDraft(executor, EDITOR_A);
    await executor.run({
      sql: `INSERT INTO admin_post_approvals
              (draft_id, version, fingerprint, approved_by_user_id, session_id, state, approved_at_ms)
            VALUES (?, 1, ?, ?, ?, 'active', ?)`,
      params: [seeded.draftId, seeded.fingerprint, EDITOR_A, randomToken(), START],
    });
    const v2 = await textEnvelope('نسخهٔ دوم سالم');
    const capture = await captureVersion(executor, {
      draftId: randomToken(),
      existingDraftId: seeded.draftId,
      envelopeJson: v2.json,
      fingerprint: v2.fingerprint,
      sourceUpdateId: 14,
      telegramUserId: EDITOR_A,
      nowMs: START + 2,
    });
    expect(capture.kind).toBe('version_added');
    expect(await getVersion(executor, seeded.draftId, 2)).not.toBeNull();
    const draft = await getDraft(executor, seeded.draftId);
    expect(draft?.current_version).toBe(2);
    expect((await getApproval(executor, seeded.draftId, 1))?.state).toBe('invalidated');
  });
});
