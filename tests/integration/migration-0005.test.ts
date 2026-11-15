import { describe, expect, it, beforeEach, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import {
  applyMigrations,
  MIGRATIONS,
  ROUND19_MIGRATION_PLAN,
  splitSqlStatements,
  type MigrationDescriptor,
} from '../helpers/migrations';
import {
  resolveSchemaCapability,
  type SchemaCapability,
} from '../../src/adapters/db/schema-health';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * R1.20-R1 — the LINEAR migration chain on real workerd D1 (the order real
 * Wrangler applies the files): 0001..0003 (applied history, schema 3) ->
 * 0004_source_poll_ownership (schema 4: ownership capability) ->
 * 0005_admin_post_pipeline (schema 5: admin post capability ON TOP of the
 * ownership migration) -> 0006_admin_post_editorial_source (schema 6: the
 * R1.22 editorial→post provenance ON TOP of the admin post pipeline). Every
 * state of the chain is honestly observable in `schema_metadata`, and a
 * sequential apply leaves ALL capabilities present. The migrations are
 * LOCAL test infrastructure ONLY — no Cloudflare/wrangler command is ever
 * run.
 */

const db: D1Database = env.DB;

/**
 * R1.22 TEST-ONLY plan: the linear chain stopped at the version-5
 * intermediate state (0001–0005) — the honest "admin post present, editorial
 * provenance absent" shape, still exactly resolvable by the capability
 * detector.
 */
const V5_STOPPED_PLAN: readonly MigrationDescriptor[] = MIGRATIONS.filter(
  (migration) => migration.version <= 5,
);

beforeAll(async () => {
  // Materialize the full schema once (fresh per-file workerd D1).
  await applyMigrations(db);
});

/**
 * Rebuild an HONEST schema-3 state: the admin-post tables dropped, the 0004
 * ownership column + index dropped, and the application metadata reset to
 * the accepted applied history (0001–0003). Used by every test so the chain
 * upgrade paths start from the real version-3 shape.
 */
async function rebuildSchema3State(): Promise<void> {
  await db.exec('DROP TABLE IF EXISTS admin_post_publications');
  await db.exec('DROP TABLE IF EXISTS admin_post_approvals');
  await db.exec('DROP TABLE IF EXISTS admin_post_preview_sessions');
  await db.exec('DROP TABLE IF EXISTS admin_post_versions');
  await db.exec('DROP TABLE IF EXISTS admin_post_drafts');
  await db.exec('DROP INDEX IF EXISTS idx_jobs_source_outstanding_poll');
  const columns = await db.prepare(`PRAGMA table_info('source_state')`).all<{ name: string }>();
  if (columns.results.some((row) => row['name'] === 'poll_owner_job_id')) {
    await db.exec('ALTER TABLE source_state DROP COLUMN poll_owner_job_id');
  }
  await db.exec('DELETE FROM schema_metadata');
  await db.exec(
    "INSERT INTO schema_metadata (key, value, updated_at_ms) VALUES ('schema_version', '3', 0), ('migration_id', '0003_job_dlq_delivery', 0), ('applied_at', '1970-01-01T00:00:00.000Z', 0)",
  );
}

beforeEach(async () => {
  await rebuildSchema3State();
});

async function metadataByKey(): Promise<Map<string, string>> {
  const rows = await db.prepare('SELECT key, value FROM schema_metadata').all<{
    key: string;
    value: string;
  }>();
  return new Map(rows.results.map((row) => [row.key, row.value]));
}

async function tableNamesLike(pattern: string): Promise<string[]> {
  const rows = await db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ORDER BY name`)
    .bind(pattern)
    .all<{ name: string }>();
  return rows.results.map((row) => row['name']!);
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  const rows = await db.prepare(`PRAGMA table_info('${table}')`).all<{ name: string }>();
  return rows.results.some((row) => row['name'] === column);
}

describe('migration 0004+0005+0006 — the linear chain (schema 3 -> 4 -> 5 -> 6)', () => {
  it('walks the WHOLE chain from honest schema 3: all capabilities present at version 6', async () => {
    // A genuinely 0004-less database: the ownership column is ABSENT right now.
    expect(await hasColumn('source_state', 'poll_owner_job_id')).toBe(false);
    expect(await tableNamesLike('admin_post_%')).toEqual([]);

    const result = await applyMigrations(db);
    expect(result.observedVersion).toBe(3);
    expect(result.applied.map((migration) => migration.id)).toEqual([
      '0004_source_poll_ownership',
      '0005_admin_post_pipeline',
      '0006_admin_post_editorial_source',
    ]);
    expect(result.finalVersion).toBe(6);

    // The metadata records the FINAL step of the linear chain — and the
    // final step PROVES every earlier step ran (strict continuity).
    const metadata = await metadataByKey();
    expect(metadata.get('schema_version')).toBe('6');
    expect(metadata.get('migration_id')).toBe('0006_admin_post_editorial_source');

    // BOTH capabilities are now physically present — the sequential SQL
    // apply (the real Wrangler order) leaves 0004's changes visible:
    expect(await hasColumn('source_state', 'poll_owner_job_id')).toBe(true);
    expect(await tableNamesLike('admin_post_%')).toEqual([
      'admin_post_approvals',
      'admin_post_drafts',
      'admin_post_preview_sessions',
      'admin_post_publications',
      'admin_post_versions',
    ]);
    const indexRows = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .bind('idx_jobs_source_outstanding_poll')
      .all<{ name: string }>();
    expect(indexRows.results).toHaveLength(1);
  });

  it('stops honestly at the schema-4 intermediate state (ownership only) under the ROUND19 plan', async () => {
    const result = await applyMigrations(db, ROUND19_MIGRATION_PLAN);
    expect(result.observedVersion).toBe(3);
    expect(result.applied.map((migration) => migration.id)).toEqual(['0004_source_poll_ownership']);
    expect(result.finalVersion).toBe(4);

    const metadata = await metadataByKey();
    expect(metadata.get('schema_version')).toBe('4');
    expect(metadata.get('migration_id')).toBe('0004_source_poll_ownership');

    // Ownership present, admin post ABSENT — the two capabilities are
    // honestly distinguishable at every state of the chain.
    expect(await hasColumn('source_state', 'poll_owner_job_id')).toBe(true);
    expect(await tableNamesLike('admin_post_%')).toEqual([]);
  });

  it('completes the chain from the schema-4 intermediate state by applying ONLY the 0005+0006 tail', async () => {
    await applyMigrations(db, ROUND19_MIGRATION_PLAN);
    const result = await applyMigrations(db);
    expect(result.observedVersion).toBe(4);
    expect(result.applied.map((migration) => migration.id)).toEqual([
      '0005_admin_post_pipeline',
      '0006_admin_post_editorial_source',
    ]);
    expect(result.finalVersion).toBe(6);
    expect((await metadataByKey()).get('schema_version')).toBe('6');
    expect(await hasColumn('source_state', 'poll_owner_job_id')).toBe(true);
    expect(await tableNamesLike('admin_post_%')).toHaveLength(5);
  });

  it('is a no-op when re-applied at the latest version', async () => {
    await applyMigrations(db);
    const second = await applyMigrations(db);
    expect(second.applied).toEqual([]);
    expect(second.finalVersion).toBe(6);
  });

  it('creates the guarded indexes (ownership + partial UNIQUE primary publication per version)', async () => {
    await applyMigrations(db);
    const indexes = await db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND (name LIKE 'idx_admin_post_%' OR name = 'idx_jobs_source_outstanding_poll') ORDER BY name",
      )
      .all<{ name: string; sql: string | null }>();
    const names = indexes.results.map((row) => row.name);
    expect(names).toContain('idx_admin_post_drafts_creator');
    expect(names).toContain('idx_admin_post_versions_source_update');
    expect(names).toContain('idx_admin_post_preview_sessions_source');
    expect(names).toContain('idx_admin_post_pub_primary');
    expect(names).toContain('idx_admin_post_pub_state');
    expect(names).toContain('idx_admin_post_versions_editorial');
    expect(names).toContain('idx_jobs_source_outstanding_poll');
    const partial = indexes.results.find((row) => row.name === 'idx_admin_post_pub_primary');
    expect(partial?.sql ?? '').toContain('WHERE supersede_of IS NULL');
  });

  it('enforces the CHECK constraints on publication states', async () => {
    await applyMigrations(db);
    await db
      .prepare(
        "INSERT INTO admin_post_drafts (id, created_by_user_id, status, current_version, created_at_ms, updated_at_ms) VALUES ('d1', 7, 'open', 1, 1, 1)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO admin_post_versions (draft_id, version, envelope_json, fingerprint, source_update_id, created_by_user_id, created_at_ms) VALUES ('d1', 1, '{}', ?, 11, 7, 1)",
      )
      .bind('a'.repeat(64))
      .run();
    // Invalid publication state must be rejected by the CHECK constraint.
    await expect(
      db
        .prepare(
          "INSERT INTO admin_post_publications (id, draft_id, version, fingerprint, destination, state, attempt, created_at_ms, updated_at_ms) VALUES ('p1', 'd1', 1, ?, '@channel', 'exploded', 1, 1, 1)",
        )
        .bind('a'.repeat(64))
        .run(),
    ).rejects.toThrow();
  });

  it('splits into clean atomic statements (no embedded semicolons)', () => {
    for (const id of ['0004_source_poll_ownership', '0005_admin_post_pipeline']) {
      const migration = MIGRATIONS.find((entry) => entry.id === id);
      expect(migration).toBeDefined();
      const statements = splitSqlStatements(migration?.sql ?? '');
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.some((statement) => statement.startsWith('UPDATE schema_metadata'))).toBe(
        true,
      );
    }
  });
});

describe('migration 0004+0005 — schema capability detection at every linear state', () => {
  const executor = () => createDbExecutor(db);

  it('resolves the honest capability at schema 3 (legacy)', async () => {
    const capability = await resolveSchemaCapability(executor());
    expect(capability).toEqual({ kind: 'known_v3_legacy', appliedSchemaVersion: 3 });
  });

  it('resolves ownership-ON at the schema-4 intermediate state (0004 id)', async () => {
    await applyMigrations(db, ROUND19_MIGRATION_PLAN);
    const capability = await resolveSchemaCapability(executor());
    expect(capability).toEqual({ kind: 'known_v4_ownership', appliedSchemaVersion: 4 });
  });

  it('resolves BOTH capabilities at the schema-5 intermediate state (0005 id, V5-stopped plan)', async () => {
    // R1.22: schema 5 is no longer the LINEAR FINAL state (0006 continues
    // the chain), but the version-5 shape stays exactly resolvable under
    // the plan that stops at 0005.
    await applyMigrations(db, V5_STOPPED_PLAN);
    const capability = await resolveSchemaCapability(executor());
    expect(capability).toEqual({ kind: 'known_v5_admin_post', appliedSchemaVersion: 5 });
  });

  it('resolves ALL capabilities at schema 6 (0006 id, linear final state)', async () => {
    await applyMigrations(db);
    const capability = await resolveSchemaCapability(executor());
    expect(capability).toEqual({ kind: 'known_v6_editorial_post', appliedSchemaVersion: 6 });
  });

  it('fails closed for the linear final version with an unknown migration_id', async () => {
    await applyMigrations(db);
    await db
      .prepare(
        `UPDATE schema_metadata SET value = 'someone_else_migration' WHERE key = 'migration_id'`,
      )
      .run();
    const capability: SchemaCapability = await resolveSchemaCapability(executor());
    expect(capability).toEqual({
      kind: 'unresolved',
      reason: 'schema_capability_migration_id_unknown',
    });
  });

  it('fails closed for the linear final version with a MISSING migration_id', async () => {
    await applyMigrations(db);
    await db.prepare(`DELETE FROM schema_metadata WHERE key = 'migration_id'`).run();
    const capability: SchemaCapability = await resolveSchemaCapability(executor());
    expect(capability).toEqual({
      kind: 'unresolved',
      reason: 'schema_capability_metadata_missing',
    });
  });

  it('still honestly resolves the RETIRED non-linear shape (version 4 recorded by 0005)', async () => {
    // Construct the retired pre-R1.20-R1 shape explicitly: version 4 + the
    // 0005 id. It resolves admin-post-present / ownership-ABSENT (legacy
    // ingestion) — never as an invented ownership state.
    await applyMigrations(db, ROUND19_MIGRATION_PLAN);
    await db
      .prepare(
        `UPDATE schema_metadata SET value = '0005_admin_post_pipeline' WHERE key = 'migration_id'`,
      )
      .run();
    const capability: SchemaCapability = await resolveSchemaCapability(executor());
    expect(capability).toEqual({ kind: 'known_v4_admin_post', appliedSchemaVersion: 4 });
  });
});

describe('migration 0004+0005 — failure atomicity and rollback on real D1', () => {
  it('rolls 0004 back COMPLETELY when the C.3 duplicate preflight is violated (outstanding duplicate poll jobs)', async () => {
    // Seed a source and TWO outstanding non-terminal fetch_poll jobs for it
    // (the C.3 violation): the partial UNIQUE index in 0004 must refuse
    // creation and the WHOLE migration batch must roll back.
    await db
      .prepare(
        `INSERT INTO sources(id,name,connector,lane,trust_tier,enabled,interval_seconds,priority,daily_request_budget,approval_policy,config_json,created_at,updated_at)
         VALUES ('dup-src','Duplicate Preflight Source','rss','official',80,1,3600,50,100,'auto','{}',1,1)`,
      )
      .run();
    for (const jobId of ['job-dup-1', 'job-dup-2']) {
      await db
        .prepare(
          `INSERT INTO jobs
            (id, type, aggregate_type, aggregate_id, status, priority, run_after,
             attempts, max_attempts, lease_until, idempotency_key, payload_json,
             last_error, created_at, updated_at)
           VALUES (?, 'sources.fetch_poll', 'source', 'dup-src', 'queued', 40, 1,
                   0, 3, NULL, ?, '{}', NULL, 1, 1)`,
        )
        .bind(jobId, `idem-${jobId}`)
        .run();
    }
    const versionBefore = await db
      .prepare(`SELECT value FROM schema_metadata WHERE key = 'schema_version'`)
      .first<{ value: string }>();

    await expect(applyMigrations(db, ROUND19_MIGRATION_PLAN)).rejects.toThrow();

    // Rollback proof: the metadata is UNCHANGED (still the pre-migration
    // version) and the ownership column does NOT exist.
    const versionAfter = await db
      .prepare(`SELECT value FROM schema_metadata WHERE key = 'schema_version'`)
      .first<{ value: string }>();
    expect(versionAfter?.value).toBe(versionBefore?.value);
    expect(await hasColumn('source_state', 'poll_owner_job_id')).toBe(false);
    expect(await tableNamesLike('admin_post_%')).toEqual([]);

    // Recovery path: remove the duplicate (make ONE job terminal) and the
    // migration applies cleanly — the preflight remains the real gate.
    await db.prepare(`UPDATE jobs SET status = 'succeeded' WHERE id = 'job-dup-2'`).run();
    const recovery = await applyMigrations(db);
    expect(recovery.finalVersion).toBeGreaterThanOrEqual(4);
    expect(await hasColumn('source_state', 'poll_owner_job_id')).toBe(true);
  });

  it('rolls 0005 back COMPLETELY when its first DDL collides, keeping the schema-4 state', async () => {
    await applyMigrations(db, ROUND19_MIGRATION_PLAN); // schema 4 (ownership only)

    // Pre-create one of 0005's tables: the CREATE TABLE must fail and the
    // WHOLE 0005 batch (including the metadata UPDATEs) must roll back.
    await db
      .prepare(
        `CREATE TABLE admin_post_drafts (
           id TEXT PRIMARY KEY,
           created_by_user_id INTEGER NOT NULL,
           status TEXT NOT NULL,
           current_version INTEGER NOT NULL,
           created_at_ms INTEGER NOT NULL,
           updated_at_ms INTEGER NOT NULL
         )`,
      )
      .run();

    await expect(applyMigrations(db)).rejects.toThrow();

    // The database is STILL at the schema-4 intermediate state: version 4,
    // the 0004 id, ownership present, admin-post pipeline NOT registered.
    const metadata = await metadataByKey();
    expect(metadata.get('schema_version')).toBe('4');
    expect(metadata.get('migration_id')).toBe('0004_source_poll_ownership');
    expect(await hasColumn('source_state', 'poll_owner_job_id')).toBe(true);

    // Recovery: drop the colliding table and the chain completes to 6.
    await db.exec('DROP TABLE admin_post_drafts');
    const recovery = await applyMigrations(db);
    expect(recovery.finalVersion).toBe(6);
    expect((await metadataByKey()).get('schema_version')).toBe('6');
  });
});
