import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations, type MigrationDescriptor } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Migration 0003 — jobs DLQ-delivery reconciliation (Phase 3, ADR-0036;
 * schema version 3).
 *
 * This file has its OWN isolated storage (vitest-pool-workers isolates per
 * test FILE), so it proves the full upgrade path of a POPULATED schema-v2
 * database:
 *
 *  1. apply ONLY migrations 0001+0002 -> a genuine schema-v2 database;
 *  2. populate jobs rows using ONLY v2 columns (pre-0003 jobs carry no
 *     dlq_delivered_at);
 *  3. apply the real append-only plan -> ONLY 0003 is pending;
 *  4. schema version becomes 3 with the 0003 migration id;
 *  5. existing job rows remain valid and read dlq_delivered_at as NULL
 *     (reconcilable) — no data loss, no backfill needed (NULL is the
 *     correct "not yet delivered" semantic for legacy rows);
 *  6. the reconciliation index exists and serves the bounded scan;
 *  7. applying migrations twice is a no-op.
 *
 * Remote application is NEVER performed here: this helper materializes
 * schemas for offline tests only (ADR-0019).
 */

const db: D1Database = env.DB;

const V2_ONLY: readonly MigrationDescriptor[] = [MIGRATIONS[0]!, MIGRATIONS[1]!];

const executor = createDbExecutor(db);

interface JobRow {
  readonly id: string;
  readonly status: string;
  readonly dlq_delivered_at: number | null;
}

async function appliedSchemaVersion(): Promise<number> {
  const row = await executor
    .first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'schema_version'`,
    })
    .catch(() => null);
  return row === null ? 0 : Number.parseInt(row.value, 10);
}

beforeEach(async () => {
  // Build the version-2 baseline ONCE per test: a genuine populated
  // schema-v2 database (legacy jobs rows use ONLY v2 columns).
  const result = await applyMigrations(db, V2_ONLY);
  if (result.observedVersion === 0) {
    await db
      .prepare(
        `INSERT INTO jobs (id, type, status, run_after, attempts, max_attempts, idempotency_key, payload_json, created_at, updated_at)
         VALUES ('legacy-pending', 'fetch_source', 'pending', 1, 0, 3, 'idem-legacy-pending', '{}', 1, 1)`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO jobs (id, type, status, run_after, attempts, max_attempts, idempotency_key, payload_json, last_error, created_at, updated_at)
         VALUES ('legacy-dead', 'fetch_source', 'dead_letter', 1, 3, 3, 'idem-legacy-dead', '{}', 'job_exhausted', 1, 1)`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO jobs (id, type, status, run_after, attempts, max_attempts, idempotency_key, payload_json, created_at, updated_at)
         VALUES ('legacy-succeeded', 'fetch_source', 'succeeded', 1, 1, 3, 'idem-legacy-succeeded', '{}', 1, 1)`,
      )
      .run();
    await applyMigrations(db);
  }
});

describe('migration 0003 (jobs DLQ-delivery reconciliation)', () => {
  it('upgrades a populated schema-v2 database to version 3 with the 0003 id', async () => {
    expect(await appliedSchemaVersion()).toBe(3);
    const id = await executor.first<{ value: string }>({
      sql: `SELECT value FROM schema_metadata WHERE key = 'migration_id'`,
    });
    expect(id?.value).toBe('0003_job_dlq_delivery');
  });

  it('keeps legacy job rows valid; dlq_delivered_at reads NULL (reconcilable)', async () => {
    const rows = await executor.query<JobRow>({
      sql: `SELECT id, status, dlq_delivered_at FROM jobs ORDER BY id`,
    });
    const byId = new Map(rows.rows.map((row) => [row.id, row]));
    expect(byId.get('legacy-pending')?.status).toBe('pending');
    expect(byId.get('legacy-pending')?.dlq_delivered_at ?? null).toBeNull();
    expect(byId.get('legacy-dead')?.status).toBe('dead_letter');
    expect(byId.get('legacy-dead')?.dlq_delivered_at ?? null).toBeNull();
    expect(byId.get('legacy-succeeded')?.status).toBe('succeeded');
  });

  it('creates the bounded DLQ-reconciliation index on jobs(status, dlq_delivered_at)', async () => {
    const index = await executor.first<{ name: string; tbl_name: string }>({
      sql: `SELECT name, tbl_name FROM sqlite_master
            WHERE type = 'index' AND name = 'idx_jobs_dlq_pending'`,
    });
    expect(index?.tbl_name).toBe('jobs');

    // The index serves the bounded reconciliation scan without a full scan.
    const plan = await executor.query<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN
            SELECT id FROM jobs
            WHERE status = 'dead_letter' AND dlq_delivered_at IS NULL
            ORDER BY updated_at ASC, id ASC LIMIT 25`,
    });
    const planText = plan.rows.map((row) => row.detail).join(' | ');
    expect(planText).toContain('idx_jobs_dlq_pending');
  });

  it('is idempotent (re-applying the full plan is a no-op)', async () => {
    await applyMigrations(db);
    expect(await appliedSchemaVersion()).toBe(3);
    const rows = await executor.first<{ n: number }>({
      sql: `SELECT COUNT(*) AS n FROM jobs`,
    });
    expect(rows?.n).toBe(3);
  });
});
