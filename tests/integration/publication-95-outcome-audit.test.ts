import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  claimPublication,
  enqueuePublication,
  healClaimedToPublished,
  healFailedToPublished,
  markClaimedDeadLetter,
  markClaimedFailed,
  markClaimedPublished,
  markClaimedRetryWait,
  markClaimedUncertain,
  markWaitingPublicationDeadLetter,
  PUBLICATION_OUTCOME_ACTIONS,
  PUBLICATION_OUTCOME_AUDIT_ACTOR_ID,
  PUBLICATION_OUTCOME_AUDIT_ACTOR_TYPE,
  PUBLICATION_OUTCOME_AUDIT_VERSION,
} from '../../src/adapters/db/publication-outbox-store';

/**
 * The audit_events PER-OUTCOME integration for the durable publication
 * scheduler (the ADR-0058 deferred carry, closed as `po1`). Written FIRST:
 * on the un-instrumented store every audit-row assertion below is RED.
 *
 * The contract: every generation-CONSUMING terminal write and every
 * evidence heal records exactly ONE audit_events row —
 *  - the deterministic id `publication-outcome:<publicationId>:<generation>:<reason>`
 *    (the heals/boundary use their mutually-exclusive tag forms), so a
 *    logical outcome is written once even across crash retries;
 *  - the system actor `publication_scheduler:pol1` (actor_type 'system');
 *  - the metadata carries the MEASURED data only (outcomeVersion, reason,
 *    attempts, the classifier code, runAfterMs) — NEVER the destination,
 *    never document content, never a chat id;
 *  - a fence-rejected terminal (a concurrent winner) writes NO audit row;
 *  - an at-most-once heal writes its row exactly once.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

const NOW = 1_700_029_800_000;
const DESTINATION = '@pixel_lores';

async function insertStory(id: string): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'draftable', 'official', 'industry', 62, 80, NULL, ?, ?, 1, ?, ?)`,
    params: [id, `key-${id}`, NOW, NOW, NOW, NOW],
  });
}

async function insertApprovedDraft(id: string, storyId: string): Promise<void> {
  const document = JSON.stringify({
    schemaVersion: 1,
    headlineFa: 'تیتر خبر گیمینگ',
    summaryFa: 'خلاصهٔ خبر برای خوانندهٔ فارسی‌زبان',
    modelClaims: [],
  });
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'fa', 'standard', 'تیتر خبر گیمینگ', ?, '[]', '[]', 1, 'test', ?, ?)`,
    params: [id, storyId, 'approved', document, NOW, NOW],
  });
}

async function enqueueClaimable(publicationId: string, draftId: string): Promise<void> {
  const outcome = await enqueuePublication(executor, {
    publicationId,
    draftId,
    destination: DESTINATION,
    priorityScore: 62,
    approvalMode: 'approval',
    nowMs: NOW,
  });
  if (outcome.kind !== 'created' && outcome.kind !== 'duplicate') {
    throw new Error(`fixture enqueue failed: ${JSON.stringify(outcome)}`);
  }
}

/** Claims the row (generation 1) or throws. */
async function claim(publicationId: string): Promise<void> {
  const claimed = await claimPublication(executor, {
    publicationId,
    nowMs: NOW + 1,
    leaseMs: 60_000,
  });
  if (claimed.kind !== 'claimed' || claimed.generation !== 1) {
    throw new Error(`fixture claim failed: ${JSON.stringify(claimed)}`);
  }
}

type AuditRow = {
  readonly id: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly action: string;
  readonly target_type: string | null;
  readonly target_id: string | null;
  readonly metadata_json: string;
};

async function auditRowsFor(publicationId: string): Promise<AuditRow[]> {
  const result = await db
    .prepare(
      'SELECT id, actor_type, actor_id, action, target_type, target_id, metadata_json FROM audit_events WHERE target_id = ? ORDER BY id',
    )
    .bind(publicationId)
    .all<AuditRow>();
  return result.results ?? [];
}

async function publicationStatus(publicationId: string): Promise<string | null | undefined> {
  const row = await db
    .prepare('SELECT status FROM publications WHERE id = ?')
    .bind(publicationId)
    .first<{ readonly status: string }>();
  return row?.status;
}

beforeEach(async () => {
  await applyMigrations(env.DB, MIGRATIONS);
  const cleanup = [
    'DELETE FROM audit_events',
    'DELETE FROM publication_messages',
    'DELETE FROM publications',
    'DELETE FROM drafts',
    'DELETE FROM stories',
  ];
  for (const sql of cleanup) {
    await db.prepare(sql).run();
  }
});

describe('publication-95: the per-generation terminal audits (po1)', () => {
  it('the sent_confirmed terminal writes ONE system audit row with the deterministic id', async () => {
    await insertStory('story-a');
    await insertApprovedDraft('draft-a', 'story-a');
    await enqueueClaimable('pub-a', 'draft-a');
    await claim('pub-a');

    const written = await markClaimedPublished(executor, {
      publicationId: 'pub-a',
      generation: 1,
      nowMs: NOW + 2,
    });
    expect(written.kind).toBe('written');

    const rows = await auditRowsFor('pub-a');
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row?.id).toBe('publication-outcome:pub-a:1:publish');
    expect(row?.actor_type).toBe(PUBLICATION_OUTCOME_AUDIT_ACTOR_TYPE);
    expect(row?.actor_id).toBe(PUBLICATION_OUTCOME_AUDIT_ACTOR_ID);
    expect(row?.action).toBe(PUBLICATION_OUTCOME_ACTIONS.publish);
    expect(row?.target_type).toBe('publication');
    const metadata = JSON.parse(row?.metadata_json ?? '{}') as Record<string, unknown>;
    expect(metadata['outcomeVersion']).toBe(PUBLICATION_OUTCOME_AUDIT_VERSION);
    expect(metadata['reason']).toBe('publish');
    expect(metadata['attempts']).toBe(1);
    expect(await publicationStatus('pub-a')).toBe('published');
  });

  it('the uncertain park, the dead-letter, the retry and the hold each write their typed row', async () => {
    const cases = [
      {
        publication: 'pub-u',
        write: () =>
          markClaimedUncertain(executor, {
            publicationId: 'pub-u',
            generation: 1,
            errorCode: 'telegram_timeout',
            nowMs: NOW + 2,
          }),
        expectedAction: PUBLICATION_OUTCOME_ACTIONS.mark_uncertain,
        expectedStatus: 'failed',
        expectedMetadataKeys: ['outcomeVersion', 'reason', 'attempts', 'errorCode'],
        errorCode: 'telegram_timeout',
      },
      {
        publication: 'pub-d',
        write: () =>
          markClaimedDeadLetter(executor, {
            publicationId: 'pub-d',
            generation: 1,
            errorCode: 'document_unreadable',
            nowMs: NOW + 2,
          }),
        expectedAction: PUBLICATION_OUTCOME_ACTIONS.dead_letter,
        expectedStatus: 'dead_letter',
        expectedMetadataKeys: ['outcomeVersion', 'reason', 'attempts', 'errorCode'],
        errorCode: 'document_unreadable',
      },
      {
        publication: 'pub-r',
        write: () =>
          markClaimedRetryWait(executor, {
            publicationId: 'pub-r',
            generation: 1,
            errorCode: 'telegram_429',
            runAfterMs: NOW + 120_000,
            nowMs: NOW + 2,
          }),
        expectedAction: PUBLICATION_OUTCOME_ACTIONS.schedule_retry,
        expectedStatus: 'retry_wait',
        expectedMetadataKeys: ['outcomeVersion', 'reason', 'attempts', 'errorCode', 'runAfterMs'],
        errorCode: 'telegram_429',
      },
      {
        publication: 'pub-h',
        write: () =>
          markClaimedFailed(executor, {
            publicationId: 'pub-h',
            generation: 1,
            errorCode: 'telegram_403',
            nowMs: NOW + 2,
          }),
        expectedAction: PUBLICATION_OUTCOME_ACTIONS.fail_hold,
        expectedStatus: 'failed',
        expectedMetadataKeys: ['outcomeVersion', 'reason', 'attempts', 'errorCode'],
        errorCode: 'telegram_403',
      },
    ];
    for (const testCase of cases) {
      await insertStory(`story-${testCase.publication}`);
      await insertApprovedDraft(`draft-${testCase.publication}`, `story-${testCase.publication}`);
      await enqueueClaimable(testCase.publication, `draft-${testCase.publication}`);
      await claim(testCase.publication);

      const written = await testCase.write();
      expect(written.kind).toBe('written');

      const rows = await auditRowsFor(testCase.publication);
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row?.action).toBe(testCase.expectedAction);
      expect(row?.actor_type).toBe('system');
      const metadata = JSON.parse(row?.metadata_json ?? '{}') as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(testCase.expectedMetadataKeys.slice().sort());
      expect(metadata['errorCode']).toBe(testCase.errorCode);
      expect(await publicationStatus(testCase.publication)).toBe(testCase.expectedStatus);
    }
  });

  it('the retry row carries the runAfterMs; the metadata NEVER carries the destination or content', async () => {
    await insertStory('story-meta');
    await insertApprovedDraft('draft-meta', 'story-meta');
    await enqueueClaimable('pub-meta', 'draft-meta');
    await claim('pub-meta');
    await markClaimedRetryWait(executor, {
      publicationId: 'pub-meta',
      generation: 1,
      errorCode: 'telegram_429',
      runAfterMs: NOW + 90_000,
      nowMs: NOW + 2,
    });
    const rows = await auditRowsFor('pub-meta');
    const metadata = JSON.parse(rows[0]?.metadata_json ?? '{}') as Record<string, unknown>;
    expect(metadata['runAfterMs']).toBe(NOW + 90_000);
    const serialized = rows[0]?.metadata_json ?? '';
    expect(serialized).not.toContain(DESTINATION);
    expect(serialized).not.toContain('headlineFa');
    expect(serialized).not.toContain('تیتر');
  });

  it('a fence-rejected terminal (a concurrent winner) writes NO audit row', async () => {
    await insertStory('story-f');
    await insertApprovedDraft('draft-f', 'story-f');
    await enqueueClaimable('pub-f', 'draft-f');
    await claim('pub-f');
    const first = await markClaimedPublished(executor, {
      publicationId: 'pub-f',
      generation: 1,
      nowMs: NOW + 2,
    });
    expect(first.kind).toBe('written');
    // The second terminal of the SAME generation can only lose the fence —
    // and the fence loss writes no audit row.
    const second = await markClaimedDeadLetter(executor, {
      publicationId: 'pub-f',
      generation: 1,
      errorCode: 'late_terminal',
      nowMs: NOW + 3,
    });
    expect(second.kind).toBe('fence_rejected');
    const rows = await auditRowsFor('pub-f');
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe(PUBLICATION_OUTCOME_ACTIONS.publish);
  });

  it('the boundary budget dead-letter writes its own audited row', async () => {
    await insertStory('story-b');
    await insertApprovedDraft('draft-b', 'story-b');
    await enqueueClaimable('pub-b', 'draft-b');
    // Drive the budget spent directly (the claim-boundary condition).
    await db
      .prepare('UPDATE publications SET attempts = max_attempts WHERE id = ?')
      .bind('pub-b')
      .run();
    const outcome = await markWaitingPublicationDeadLetter(executor, {
      publicationId: 'pub-b',
      nowMs: NOW + 2,
    });
    expect(outcome.kind).toBe('dead_lettered');
    const rows = await auditRowsFor('pub-b');
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe(PUBLICATION_OUTCOME_ACTIONS.dead_letter);
    expect(rows[0]?.id).toBe('publication-outcome:pub-b:boundary:dead_letter');
    const metadata = JSON.parse(rows[0]?.metadata_json ?? '{}') as Record<string, unknown>;
    expect(metadata['errorCode']).toBe('attempt_budget_spent');
    expect(metadata['boundary']).toBe(true);
  });

  it('the reconciliation heal writes ONE row exactly once; the second heal is a no_heal with no row', async () => {
    await insertStory('story-heal');
    await insertApprovedDraft('draft-heal', 'story-heal');
    await enqueueClaimable('pub-heal', 'draft-heal');
    await claim('pub-heal');
    await markClaimedUncertain(executor, {
      publicationId: 'pub-heal',
      generation: 1,
      errorCode: 'telegram_timeout',
      nowMs: NOW + 2,
    });
    const first = await healFailedToPublished(executor, {
      publicationId: 'pub-heal',
      nowMs: NOW + 3,
    });
    expect(first.kind).toBe('healed');
    const second = await healFailedToPublished(executor, {
      publicationId: 'pub-heal',
      nowMs: NOW + 4,
    });
    expect(second.kind).toBe('no_heal');
    const rows = await auditRowsFor('pub-heal');
    expect(rows.length).toBe(2); // the park + the ONE heal
    const healRows = rows.filter((row) => row.id === 'publication-outcome:pub-heal:healed');
    expect(healRows.length).toBe(1);
    expect(healRows[0]?.action).toBe(PUBLICATION_OUTCOME_ACTIONS.healed);
    const metadata = JSON.parse(healRows[0]?.metadata_json ?? '{}') as Record<string, unknown>;
    expect(metadata['heal']).toBe('reconciliation');
    expect(await publicationStatus('pub-heal')).toBe('published');
  });

  it('the pre-send claimed heal writes the same deterministic heal id (the mutually exclusive pre-state)', async () => {
    await insertStory('story-cp');
    await insertApprovedDraft('draft-cp', 'story-cp');
    await enqueueClaimable('pub-cp', 'draft-cp');
    await claim('pub-cp');
    const healed = await healClaimedToPublished(executor, {
      publicationId: 'pub-cp',
      generation: 1,
      nowMs: NOW + 2,
    });
    expect(healed.kind).toBe('written');
    const rows = await auditRowsFor('pub-cp');
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe('publication-outcome:pub-cp:healed');
    const metadata = JSON.parse(rows[0]?.metadata_json ?? '{}') as Record<string, unknown>;
    expect(metadata['heal']).toBe('pre_send');
    expect(await publicationStatus('pub-cp')).toBe('published');
  });

  it('the full one-attempt chain audits EXACTLY one outcome row for the publication', async () => {
    await insertStory('story-e2e');
    await insertApprovedDraft('draft-e2e', 'story-e2e');
    await enqueueClaimable('pub-e2e', 'draft-e2e');
    await claim('pub-e2e');
    // The realistic order: the ledger record first, then the fenced terminal.
    await executor.run({
      sql: `INSERT INTO publication_messages (publication_id, ordinal, chat_id, message_id, text_hash, created_at)
            VALUES (?, 0, ?, 4242, ?, ?)`,
      params: ['pub-e2e', DESTINATION, 'a'.repeat(64), NOW + 2],
    });
    await markClaimedPublished(executor, {
      publicationId: 'pub-e2e',
      generation: 1,
      nowMs: NOW + 3,
    });
    const rows = await auditRowsFor('pub-e2e');
    expect(rows.length).toBe(1);
    expect(rows[0]?.action).toBe(PUBLICATION_OUTCOME_ACTIONS.publish);
  });
});
