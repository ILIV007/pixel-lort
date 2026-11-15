import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  evaluateShadowGates,
  generateShadowReport,
  SHADOW_REPORT_VERSION,
} from '../../src/application/shadow/shadow-report';

/**
 * Phase 11.1 — the shadow-mode report generator over REAL workerd D1.
 * The report is a PURE read layer: the tests prove the numbers are REAL
 * (seeded rows -> exact counts), the window semantics are exact, the
 * zero-valued report over an empty DB is honestly zero (never
 * simulated), the gates are typed data (pass/insufficient_data/stop),
 * and the whole flow performs ZERO writes.
 */

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

const WINDOW_START = 1_760_000_000_000;
const WINDOW_END = WINDOW_START + 7 * 86_400_000;

async function insertStory(id: string, createdAt: number = WINDOW_START): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'discovered', 'reported', 'official_news', 50, 10, NULL, ?, ?, 1, ?, ?)`,
    params: [id, `key-${id}`, createdAt, createdAt, createdAt, createdAt],
  });
}

let sourceItemCount = 0;

async function insertSourceItem(
  id: string,
  processingStatus: string,
  fetchedAt: number,
): Promise<void> {
  sourceItemCount += 1;
  await executor.run({
    sql: `INSERT INTO source_items (id, source_id, external_id, canonical_url, title,
            content_hash, processing_status, fetched_at, published_at)
          VALUES (?, 'src-x', ?, ?, 't', ?, ?, ?, NULL)`,
    params: [
      id,
      `ext-${id}`,
      `https://example.com/x/${sourceItemCount}`,
      `hash-${id}`,
      processingStatus,
      fetchedAt,
    ],
  });
}

beforeEach(async () => {
  await applyMigrations(db);
  for (const table of [
    'publication_messages',
    'publications',
    'drafts',
    'claims',
    'evidence',
    'stories',
    'source_items',
    'sources',
    'ai_runs',
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  sourceItemCount = 0;
  await executor.run({
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, enabled,
            interval_seconds, priority, daily_request_budget, approval_policy,
            created_at, updated_at)
          VALUES ('src-x', 'Source X', 'rss', 'official', 80, 0, 3600, 50, 100,
            'auto', ?, ?)`,
    params: [WINDOW_START, WINDOW_START],
  });
});

describe('the shadow report over REAL D1', () => {
  it('an empty database yields the honest zero-valued report and the insufficient-data gates', async () => {
    const report = await generateShadowReport(executor, {
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(report.version).toBe(SHADOW_REPORT_VERSION);
    expect(report.publications.publishedInWindow).toBe(0);
    expect(report.publications.failedParkedAllTime).toBe(0);
    expect(report.pipeline.storiesAllTime).toBe(0);
    expect(report.ingestion.itemsProcessedInWindow).toBe(0);
    expect(report.ai.runsInWindow).toBe(0);
    const gates = evaluateShadowGates(report);
    expect(gates.map((gate) => gate.verdict)).toEqual([
      'insufficient_data',
      'pass',
      'insufficient_data',
    ]);
  });

  it('the counts are EXACT over the seeded window (in-window vs out-of-window never mix)', async () => {
    await insertStory('s1');
    const { env } = await import('cloudflare:test');
    await env.DB.prepare(
      `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
        facts_json, warnings_json, version, created_by, created_at, updated_at)
       VALUES ('draft-x', 's1', 'ready', 'fa', 'standard', 't', '{}', '[]', '[]', 1, 'test', ?, ?)`,
    )
      .bind(WINDOW_START, WINDOW_START)
      .run();
    await env.DB.prepare(
      `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
        facts_json, warnings_json, version, created_by, created_at, updated_at)
       VALUES ('draft-y', 's1', 'ready', 'fa', 'standard', 't', '{}', '[]', '[]', 2, 'test', ?, ?)`,
    )
      .bind(WINDOW_START, WINDOW_START)
      .run();
    await env.DB.prepare(
      `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
        facts_json, warnings_json, version, created_by, created_at, updated_at)
       VALUES ('draft-z', 's1', 'ready', 'fa', 'standard', 't', '{}', '[]', '[]', 3, 'test', ?, ?)`,
    )
      .bind(WINDOW_START, WINDOW_START)
      .run();
    await insertSourceItem('i1', 'processed', WINDOW_START + 1000);
    await insertSourceItem('i2', 'duplicate', WINDOW_START + 2000);
    await insertSourceItem('i3', 'failed', WINDOW_START + 3000);
    await insertSourceItem('i4', 'processed', WINDOW_END + 86_400_000); // OUT of window
    await executor.run({
      sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
              scheduled_at, run_after, claimed_at, lease_until, published_at, attempts,
              max_attempts, idempotency_key, last_error, created_at, updated_at)
            VALUES ('p-in', 's1', 'draft-x', 'published', 62, 'safe_auto', NULL, ?,
              NULL, NULL, ?, 0, 3, 'k-in', NULL, ?, ?)`,
      params: [WINDOW_START + 1000, WINDOW_START + 1000, WINDOW_START, WINDOW_START + 1000],
    });
    await executor.run({
      sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
              scheduled_at, run_after, claimed_at, lease_until, published_at, attempts,
              max_attempts, idempotency_key, last_error, created_at, updated_at)
            VALUES ('p-out', 's1', 'draft-y', 'published', 62, 'safe_auto', NULL, ?,
              NULL, NULL, ?, 0, 3, 'k-out', NULL, ?, ?)`,
      params: [WINDOW_START, WINDOW_START - 1000, WINDOW_START, WINDOW_START - 1000],
    });
    await executor.run({
      sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
              scheduled_at, run_after, claimed_at, lease_until, published_at, attempts,
              max_attempts, idempotency_key, last_error, created_at, updated_at)
            VALUES ('p-parked', 's1', 'draft-z', 'failed', 62, 'safe_auto', NULL, ?,
              NULL, NULL, NULL, 1, 3, 'k-parked', 'telegram_timeout', ?, ?)`,
      params: [WINDOW_START, WINDOW_START, WINDOW_START],
    });
    const report = await generateShadowReport(executor, {
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    expect(report.publications.publishedInWindow).toBe(1); // p-in only
    expect(report.publications.failedParkedAllTime).toBe(1); // the parked family
    expect(report.pipeline.storiesAllTime).toBe(1);
    expect(report.ingestion.itemsProcessedInWindow).toBe(1); // i1 only (i4 out)
    expect(report.ingestion.itemsDuplicateInWindow).toBe(1);
    expect(report.ingestion.itemsFailedInWindow).toBe(1);
    const gates = evaluateShadowGates(report);
    expect(gates.find((gate) => gate.name === 'parked_uncertainty')?.verdict).toBe('stop');
    expect(gates.find((gate) => gate.name === 'publication_throughput')?.verdict).toBe('pass');
    // 1 processed / 1 duplicate in the window = a 1.0 share — over the
    // pinned 0.5 ceiling (the gate is honest even in a tiny window).
    expect(gates.find((gate) => gate.name === 'duplicate_pressure')?.verdict).toBe('stop');
  });

  it('the duplicate-pressure STOP fires over the pinned 0.5 ceiling', async () => {
    await insertSourceItem('j1', 'processed', WINDOW_START + 1000);
    await insertSourceItem('j2', 'duplicate', WINDOW_START + 1000);
    await insertSourceItem('j3', 'duplicate', WINDOW_START + 1000);
    const report = await generateShadowReport(executor, {
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    const gates = evaluateShadowGates(report);
    expect(gates.find((gate) => gate.name === 'duplicate_pressure')?.verdict).toBe('stop');
  });

  it('the report flow performs ZERO writes (a pure read layer)', async () => {
    const before = await db
      .prepare(`SELECT COUNT(*) AS total FROM audit_events`)
      .first<{ readonly total: number }>();
    await generateShadowReport(executor, {
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
    });
    const after = await db
      .prepare(`SELECT COUNT(*) AS total FROM audit_events`)
      .first<{ readonly total: number }>();
    expect(after?.total).toBe(before?.total ?? 0);
  });
});
