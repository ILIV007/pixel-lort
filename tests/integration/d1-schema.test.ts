import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations, splitSqlStatements } from '../helpers/migrations';

/**
 * Schema-contract tests (ADR-0019, extended by ADR-0030/0031 — schema v2).
 *
 * These tests run inside workerd against an isolated local D1 database
 * (wrangler.jsonc placeholder binding — no Cloudflare resource). They prove:
 * - the migration set (0001 + 0002) applies atomically and idempotently;
 * - the resulting schema contains EXACTLY the approved tables and indexes;
 * - foreign keys, CHECK constraints and uniqueness rules are enforced,
 *   including the migration-0002 lifecycle columns on telegram_updates;
 * - representative insert/read/update flows work end-to-end;
 * - application schema metadata is present and distinct from wrangler's
 *   migration bookkeeping.
 */

const db: D1Database = env.DB;

/** All 27 approved blueprint tables + the application `schema_metadata` table. */
const EXPECTED_TABLES: readonly string[] = [
  'admins',
  'admin_action_tokens',
  'admin_sessions',
  'ai_runs',
  'audit_events',
  'budgets',
  'claims',
  'corrections',
  'draft_revisions',
  'drafts',
  'entities',
  'entity_aliases',
  'evidence',
  'jobs',
  'media_assets',
  'media_usages',
  'publications',
  'publication_messages',
  'schema_metadata',
  'settings',
  'source_items',
  'source_reputation_events',
  'source_state',
  'sources',
  'stories',
  'story_entities',
  'story_fingerprints',
  'telegram_updates',
];

/** All 29 approved blueprint indexes + the Phase 2A lifecycle index (0002). */
const EXPECTED_INDEXES: readonly string[] = [
  'idx_action_tokens_user_exp',
  'idx_admin_sessions_user_exp',
  'idx_ai_runs_health',
  'idx_ai_runs_task_time',
  'idx_audit_target',
  'idx_audit_time',
  'idx_claims_story_status',
  'idx_drafts_status_time',
  'idx_evidence_source',
  'idx_entity_alias_lookup',
  'idx_fingerprints_story',
  'idx_jobs_aggregate',
  'idx_jobs_due',
  'idx_media_expiry',
  'idx_media_hash',
  'idx_media_usage_asset',
  'idx_media_visual',
  'idx_publications_due',
  'idx_publications_story',
  'idx_reputation_source_time',
  'idx_source_items_hash',
  'idx_source_items_status',
  'idx_source_items_time',
  'idx_source_state_due',
  'idx_sources_due_config',
  'idx_stories_state_priority',
  'idx_stories_type_time',
  'idx_story_entities_entity',
  'idx_tg_updates_lifecycle',
  'idx_tg_updates_received',
];

async function namedTables(): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
         AND name NOT LIKE '_cf\\_%' ESCAPE '\\'
         AND name NOT LIKE 'd1\\_migrations' ESCAPE '\\'
       ORDER BY name`,
    )
    .all<{ name: string }>();
  return result.results.map((row) => row['name']!);
}

async function namedIndexes(): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all<{ name: string }>();
  return result.results.map((row) => row['name']!);
}

beforeEach(async () => {
  await applyMigrations(db);
});

describe('migration application', () => {
  it('applies every migration as an atomic batch and reports metadata (schema v2)', async () => {
    expect(await namedTables()).toEqual([...EXPECTED_TABLES].sort());

    const metadata = await db
      .prepare(`SELECT key, value FROM schema_metadata ORDER BY key`)
      .all<{ key: string; value: string }>();
    const byKey = new Map(metadata.results.map((row) => [row.key, row.value]));
    expect(byKey.get('schema_version')).toBe('2');
    expect(byKey.get('migration_id')).toBe('0002_telegram_update_lifecycle');
    expect(byKey.get('applied_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is idempotent within a storage scope (re-apply is a no-op)', async () => {
    await applyMigrations(db);
    expect(await namedTables()).toEqual([...EXPECTED_TABLES].sort());
    const rows = await db.prepare(`SELECT COUNT(*) AS n FROM schema_metadata`).first<{
      n: number;
    }>();
    expect(rows?.n).toBe(3);
  });

  it('splits the migration SQL into complete, non-empty statements', () => {
    for (const migration of MIGRATIONS) {
      const statements = splitSqlStatements(migration.sql);
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement).not.toContain(';');
        expect(statement.startsWith('--')).toBe(false);
      }
    }
  });
});

describe('schema contracts', () => {
  it('creates exactly the 28 expected tables (27 approved + schema_metadata)', async () => {
    const tables = await namedTables();
    expect(tables).toHaveLength(28);
    expect(tables).toEqual([...EXPECTED_TABLES].sort());
  });

  it('creates exactly the 30 expected indexes (29 approved + lifecycle index)', async () => {
    const indexes = await namedIndexes();
    expect(indexes).toHaveLength(30);
    expect(indexes).toEqual([...EXPECTED_INDEXES].sort());
  });

  it('carries the telegram_updates lifecycle columns with enforced CHECKs (migration 0002)', async () => {
    const columns = await db.prepare(`PRAGMA table_info('telegram_updates')`).all<{
      name: string;
    }>();
    const names = columns.results.map((row) => row['name']);
    expect(names).toEqual(
      expect.arrayContaining(['claim_expires_at', 'failure_class', 'attempt_count']),
    );

    // failure_class CHECK: only the documented classes (or NULL) are legal.
    const insertWithClass = (failureClass: string | null, attemptCount: number) =>
      db
        .prepare(
          `INSERT INTO telegram_updates (update_id, received_at, status, failure_class, attempt_count)
           VALUES (?, ?, 'claimed', ?, ?)`,
        )
        .bind(8800, 1, failureClass, attemptCount)
        .run();
    await expect(insertWithClass('bogus', 0)).rejects.toThrow(/CHECK/i);
    await insertWithClass(null, 0);
    await db.prepare(`DELETE FROM telegram_updates WHERE update_id = 8800`).run();

    // attempt_count CHECK: non-negative.
    await expect(
      db
        .prepare(
          `INSERT INTO telegram_updates (update_id, received_at, status, attempt_count)
           VALUES (?, ?, 'claimed', ?)`,
        )
        .bind(8801, 1, -1)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it('reports no foreign-key violations after migration', async () => {
    const violations = await db.prepare(`PRAGMA foreign_key_check`).all();
    expect(violations.results).toHaveLength(0);
  });

  it('rejects inserts that violate critical foreign keys', async () => {
    // claims.story_id -> stories(id)
    await expect(
      db
        .prepare(
          `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text, confidence, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          'claim-orphan',
          'no-such-story',
          'release_date',
          'Game X',
          'releases_on',
          '2026-12-01',
          50,
          'unverified',
          1,
          1,
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);

    // drafts.story_id -> stories(id)
    await expect(
      db
        .prepare(
          `INSERT INTO drafts (id, story_id, status, layout, title, document_json, version, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind('draft-orphan', 'no-such-story', 'ready', 'post', 't', '{}', 1, 'system', 1, 1)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('enforces ON DELETE CASCADE on dependent rows', async () => {
    await db
      .prepare(
        `INSERT INTO admins (telegram_user_id, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(1001, 'owner', 'active', 1, 1)
      .run();
    await db
      .prepare(
        `INSERT INTO admin_sessions (id, telegram_user_id, flow, step, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('session-1', 1001, 'setup', 'start', 9999, 1, 1)
      .run();

    await db.prepare(`DELETE FROM admins WHERE telegram_user_id = ?`).bind(1001).run();

    const remaining = await db
      .prepare(`SELECT COUNT(*) AS n FROM admin_sessions WHERE telegram_user_id = ?`)
      .bind(1001)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it('rejects duplicate idempotency-sensitive records', async () => {
    // jobs.idempotency_key UNIQUE
    const insertJob = db
      .prepare(
        `INSERT INTO jobs (id, type, status, run_after, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('job-1', 'fetch_source', 'pending', 1, 'idem-job-001', 1, 1);
    await insertJob.run();
    await expect(
      db
        .prepare(
          `INSERT INTO jobs (id, type, status, run_after, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind('job-2', 'fetch_source', 'pending', 1, 'idem-job-001', 1, 1)
        .run(),
    ).rejects.toThrow(/UNIQUE/i);

    // publications.idempotency_key UNIQUE
    await db
      .prepare(
        `INSERT INTO stories (id, story_key, status, trust_status, content_type, first_seen_at, last_evidence_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('story-1', 'sk-1', 'discovered', 'reported', 'breaking', 1, 1, 1, 1)
      .run();
    await db
      .prepare(
        `INSERT INTO drafts (id, story_id, status, layout, title, document_json, version, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('draft-1', 'story-1', 'ready', 'post', 't', '{}', 1, 'system', 1, 1)
      .run();
    const insertPublication = db
      .prepare(
        `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode, run_after, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('pub-1', 'story-1', 'draft-1', 'pending', 50, 'auto', 1, 'idem-pub-001', 1, 1);
    await insertPublication.run();
    await expect(
      db
        .prepare(
          `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode, run_after, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind('pub-2', 'story-1', 'draft-1', 'pending', 50, 'auto', 1, 'idem-pub-001', 1, 1)
        .run(),
    ).rejects.toThrow(/UNIQUE/i);

    // source_items UNIQUE(source_id, external_id)
    await db
      .prepare(
        `INSERT INTO sources (id, name, connector, lane, trust_tier, interval_seconds, approval_policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('src-1', 'Source One', 'rss', 'radar', 50, 300, 'auto', 1, 1)
      .run();
    const insertItem = db
      .prepare(
        `INSERT INTO source_items (id, source_id, external_id, title, fetched_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind('item-1', 'src-1', 'ext-1', 'Title', 1, 'hash-1');
    await insertItem.run();
    await expect(
      db
        .prepare(
          `INSERT INTO source_items (id, source_id, external_id, title, fetched_at, content_hash)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind('item-2', 'src-1', 'ext-1', 'Title again', 2, 'hash-2')
        .run(),
    ).rejects.toThrow(/UNIQUE/i);

    // entities UNIQUE(type, slug)
    await db
      .prepare(
        `INSERT INTO entities (id, type, canonical_name, slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind('ent-1', 'game', 'Game One', 'game-one', 1, 1)
      .run();
    await expect(
      db
        .prepare(
          `INSERT INTO entities (id, type, canonical_name, slug, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind('ent-2', 'game', 'Game One Duplicate', 'game-one', 2, 2)
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it('rejects CHECK constraint violations', async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO sources (id, name, connector, lane, trust_tier, interval_seconds, approval_policy, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind('src-bad', 'Bad', 'rss', 'radar', 101, 300, 'auto', 1, 1)
        .run(),
    ).rejects.toThrow(/CHECK/i);

    await expect(
      db
        .prepare(
          `INSERT INTO stories (id, story_key, status, trust_status, content_type, first_seen_at, last_evidence_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind('story-bad', 'sk-bad', 'not-a-status', 'reported', 'breaking', 1, 1, 1, 1)
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it('supports representative insert / read / update flows across the FK graph', async () => {
    // Insert a coherent chain: source -> source_item -> story -> claim -> evidence.
    await db
      .prepare(
        `INSERT INTO sources (id, name, connector, lane, trust_tier, interval_seconds, approval_policy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('src-flow', 'Flow Source', 'rss', 'official', 90, 120, 'threshold', 10, 10)
      .run();
    await db
      .prepare(
        `INSERT INTO source_items (id, source_id, external_id, title, fetched_at, content_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind('item-flow', 'src-flow', 'ext-flow', 'Official news', 20, 'hash-flow')
      .run();
    await db
      .prepare(
        `INSERT INTO stories (id, story_key, status, trust_status, content_type, first_seen_at, last_evidence_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind('story-flow', 'sk-flow', 'discovered', 'official', 'release', 20, 20, 20, 20)
      .run();
    await db
      .prepare(
        `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text, confidence, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        'claim-flow',
        'story-flow',
        'release_date',
        'Game',
        'releases_on',
        '2026-12-01',
        80,
        'unverified',
        30,
        30,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO evidence (id, claim_id, source_item_id, stance, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind('ev-flow', 'claim-flow', 'item-flow', 'supports', 85, 40)
      .run();

    const story = await db
      .prepare(`SELECT status, priority FROM stories WHERE id = ?`)
      .bind('story-flow')
      .first<{ status: string; priority: number }>();
    expect(story?.status).toBe('discovered');
    expect(story?.priority).toBe(50);

    const updated = await db
      .prepare(`UPDATE stories SET status = ? WHERE id = ?`)
      .bind('assessed', 'story-flow')
      .run();
    expect(updated.meta.changes).toBe(1);

    const reread = await db
      .prepare(`SELECT status FROM stories WHERE id = ?`)
      .bind('story-flow')
      .first<{ status: string }>();
    expect(reread?.status).toBe('assessed');

    const evidenceCount = await db
      .prepare(`SELECT COUNT(*) AS n FROM evidence WHERE claim_id = ?`)
      .bind('claim-flow')
      .first<{ n: number }>();
    expect(evidenceCount?.n).toBe(1);
  });
});
