import { describe, expect, it, beforeEach, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, MIGRATIONS, splitSqlStatements } from '../helpers/migrations';

/**
 * Migration 0005 (admin post pipeline, R1.20-R): the default append-only
 * plan advances the APPLICATION schema to version 4 with the five admin-post
 * tables + indexes, atomically and idempotently. The migration is LOCAL
 * test infrastructure ONLY — no Cloudflare/wrangler command is ever run.
 */

beforeAll(async () => {
  // Materialize the full schema once (fresh per-file workerd D1).
  await applyMigrations(env.DB);
});

beforeEach(async () => {
  // Isolated per test: rebuild from scratch (workerd test D1 is per-file
  // persistent, so drop the tables the previous test created).
  const db = env.DB;
  await db.exec('DROP TABLE IF EXISTS admin_post_publications');
  await db.exec('DROP TABLE IF EXISTS admin_post_approvals');
  await db.exec('DROP TABLE IF EXISTS admin_post_preview_sessions');
  await db.exec('DROP TABLE IF EXISTS admin_post_versions');
  await db.exec('DROP TABLE IF EXISTS admin_post_drafts');
  await db.exec('DELETE FROM schema_metadata');
  await db.exec(
    "INSERT INTO schema_metadata (key, value, updated_at_ms) VALUES ('schema_version', '3', 0), ('migration_id', '0003_job_dlq_delivery', 0), ('applied_at', '1970-01-01T00:00:00.000Z', 0)",
  );
});

describe('migration 0005 — admin post pipeline (schema 3 -> 4)', () => {
  it('advances schema_metadata to version 4 and creates the five tables', async () => {
    const result = await applyMigrations(env.DB);
    expect(result.observedVersion).toBe(3);
    expect(result.applied.map((migration) => migration.id)).toEqual(['0005_admin_post_pipeline']);
    expect(result.finalVersion).toBe(4);

    const metadata = await env.DB.prepare('SELECT key, value FROM schema_metadata').all<{
      key: string;
      value: string;
    }>();
    const byKey = new Map(metadata.results.map((row) => [row.key, row.value]));
    expect(byKey.get('schema_version')).toBe('4');
    expect(byKey.get('migration_id')).toBe('0005_admin_post_pipeline');

    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'admin_post_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual([
      'admin_post_approvals',
      'admin_post_drafts',
      'admin_post_preview_sessions',
      'admin_post_publications',
      'admin_post_versions',
    ]);
  });

  it('creates the guarded indexes (partial UNIQUE primary publication per version)', async () => {
    await applyMigrations(env.DB);
    const indexes = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_admin_post_%' ORDER BY name",
    ).all<{ name: string; sql: string | null }>();
    const names = indexes.results.map((row) => row.name);
    expect(names).toContain('idx_admin_post_drafts_creator');
    expect(names).toContain('idx_admin_post_versions_source_update');
    expect(names).toContain('idx_admin_post_preview_sessions_source');
    expect(names).toContain('idx_admin_post_pub_primary');
    expect(names).toContain('idx_admin_post_pub_state');
    const partial = indexes.results.find((row) => row.name === 'idx_admin_post_pub_primary');
    expect(partial?.sql ?? '').toContain('WHERE supersede_of IS NULL');
  });

  it('is a no-op when re-applied at the latest version', async () => {
    await applyMigrations(env.DB);
    const second = await applyMigrations(env.DB);
    expect(second.applied).toEqual([]);
    expect(second.finalVersion).toBe(4);
  });

  it('upgrades a schema-v3 database by applying ONLY the pending migration', async () => {
    // beforeEach rebuilt the metadata at the accepted applied version 3
    // (migrations 0001-0003) and dropped the admin-post tables. The default
    // plan must apply ONLY the pending 0005 — never re-run applied history.
    const result = await applyMigrations(env.DB);
    expect(result.observedVersion).toBe(3);
    expect(result.applied.map((migration) => migration.id)).toEqual(['0005_admin_post_pipeline']);
    expect(result.finalVersion).toBe(4);
  });

  it('enforces the CHECK constraints on publication states', async () => {
    await applyMigrations(env.DB);
    const executor = env.DB;
    await executor
      .prepare(
        "INSERT INTO admin_post_drafts (id, created_by_user_id, status, current_version, created_at_ms, updated_at_ms) VALUES ('d1', 7, 'open', 1, 1, 1)",
      )
      .run();
    await executor
      .prepare(
        "INSERT INTO admin_post_versions (draft_id, version, envelope_json, fingerprint, source_update_id, created_by_user_id, created_at_ms) VALUES ('d1', 1, '{}', ?, 11, 7, 1)",
      )
      .bind('a'.repeat(64))
      .run();
    // Invalid publication state must be rejected by the CHECK constraint.
    await expect(
      executor
        .prepare(
          "INSERT INTO admin_post_publications (id, draft_id, version, fingerprint, destination, state, attempt, created_at_ms, updated_at_ms) VALUES ('p1', 'd1', 1, ?, '@channel', 'exploded', 1, 1, 1)",
        )
        .bind('a'.repeat(64))
        .run(),
    ).rejects.toThrow();
  });

  it('splits into clean atomic statements (no embedded semicolons)', () => {
    const migration = MIGRATIONS.find((entry) => entry.id === '0005_admin_post_pipeline');
    expect(migration).toBeDefined();
    const statements = splitSqlStatements(migration?.sql ?? '');
    expect(statements.length).toBeGreaterThan(10);
    expect(statements.some((statement) => statement.startsWith('UPDATE schema_metadata'))).toBe(
      true,
    );
  });
});
