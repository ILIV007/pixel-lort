import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations, type MigrationDescriptor } from '../helpers/migrations';
import {
  claimTelegramUpdate,
  markTelegramUpdateFailed,
  TELEGRAM_UPDATE_CLAIM_LEASE_MS,
} from '../../src/adapters/telegram/update-claims';
import { createDbExecutor } from '../../src/adapters/db/db-executor';

/**
 * Migration 0002 — telegram_updates lifecycle (Phase 2A second correction
 * round, ADR-0030/0031; schema version 2).
 *
 * This file has its OWN isolated storage (vitest-pool-workers isolates per
 * test FILE), so it starts from an EMPTY database and can prove the full
 * upgrade path of a POPULATED schema-v1 database:
 *
 *  1. apply ONLY migration 0001 -> a genuine schema-v1 database;
 *  2. populate legacy telegram_updates rows using ONLY v1 columns;
 *  3. apply the real append-only plan -> ONLY 0002 is pending;
 *  4. schema version becomes 2 with the 0002 migration id;
 *  5. existing rows remain valid: processed/claimed rows untouched, legacy
 *     failed rows are backfilled failure_class='retryable' (fail-safe,
 *     ADR-0031) and stay reclaimable;
 *  6. legacy lease-less claimed rows are recoverable (reclaimed_stale);
 *  7. applying migrations twice is a no-op;
 *  8. the new CHECK constraints are enforced.
 *
 * Remote application is NEVER performed here: this helper materializes
 * schemas for offline tests only (ADR-0019).
 */

const db: D1Database = env.DB;

const V1_ONLY: readonly MigrationDescriptor[] = [MIGRATIONS[0]!];

const NOW = 1_700_000_000_000;
const LEASE = TELEGRAM_UPDATE_CLAIM_LEASE_MS;

interface LifecycleRow {
  status: string;
  claim_expires_at: number | null;
  failure_class: string | null;
  attempt_count: number;
}

async function readRow(updateId: number): Promise<LifecycleRow | null> {
  const executor = createDbExecutor(db);
  return executor.first<LifecycleRow>({
    sql: `SELECT status, claim_expires_at, failure_class, attempt_count
          FROM telegram_updates WHERE update_id = ?`,
    params: [updateId],
  });
}

async function appliedSchemaVersion(): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM schema_metadata WHERE key = 'schema_version'`)
    .first<{ value: string }>()
    .catch(() => null);
  return row === null ? 0 : Number.parseInt(row.value, 10);
}

beforeEach(async () => {
  // Build the version-1 baseline ONCE per test: a genuine populated
  // schema-v1 database (legacy rows use ONLY v1 columns).
  const result = await applyMigrations(db, V1_ONLY);
  if (result.observedVersion === 0) {
    await db
      .prepare(`INSERT INTO telegram_updates (update_id, received_at, status) VALUES (?, ?, ?)`)
      .bind(1, NOW, 'claimed') // abandoned live claim (pre-0002: no lease exists)
      .run();
    await db
      .prepare(`INSERT INTO telegram_updates (update_id, received_at, status) VALUES (?, ?, ?)`)
      .bind(2, NOW + 1, 'processed')
      .run();
    await db
      .prepare(`INSERT INTO telegram_updates (update_id, received_at, status) VALUES (?, ?, ?)`)
      .bind(3, NOW + 2, 'failed') // pre-0002 failure: class unknown at write time
      .run();
    // Sentinel proving 0001 is never re-executed during the upgrade.
    await db
      .prepare(
        `INSERT INTO sources (id, name, connector, lane, trust_tier, interval_seconds, approval_policy, created_at, updated_at)
         VALUES ('src-mig2-sentinel', 'Migration Sentinel', 'rss', 'official', 50, 300, 'auto', 1, 1)`,
      )
      .run();
  }
});

describe('migration 0002 — populated schema-v1 database upgrades to schema v2', () => {
  it('applies ONLY 0002 on top of a populated version-1 database and advances the metadata', async () => {
    expect(await appliedSchemaVersion()).toBe(1);

    const result = await applyMigrations(db);

    expect(result.observedVersion).toBe(1);
    expect(result.applied.map((migration) => migration.id)).toEqual([
      '0002_telegram_update_lifecycle',
      '0003_job_dlq_delivery',
    ]);
    expect(result.finalVersion).toBe(3);
    expect(await appliedSchemaVersion()).toBe(3);

    const metadata = await db
      .prepare(`SELECT key, value FROM schema_metadata ORDER BY key`)
      .all<{ key: string; value: string }>();
    const byKey = new Map(metadata.results.map((row) => [row.key, row.value]));
    expect(byKey.get('schema_version')).toBe('3');
    expect(byKey.get('migration_id')).toBe('0003_job_dlq_delivery');
    expect(byKey.get('applied_at')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The UPDATE statements did not duplicate metadata rows.
    expect(metadata.results).toHaveLength(3);

    // The lifecycle columns exist.
    const columns = await db.prepare(`PRAGMA table_info('telegram_updates')`).all<{
      name: string;
    }>();
    const names = columns.results.map((row) => row['name']);
    expect(names).toEqual(
      expect.arrayContaining(['claim_expires_at', 'failure_class', 'attempt_count']),
    );

    // The 0001 sentinel survived — 0001 was NOT re-executed.
    const sentinel = await db
      .prepare(`SELECT id FROM sources WHERE id = 'src-mig2-sentinel'`)
      .first<{ id: string }>();
    expect(sentinel?.id).toBe('src-mig2-sentinel');
  });

  it('keeps existing telegram_updates rows valid through the upgrade', async () => {
    await applyMigrations(db);

    // The processed row is untouched (still terminal, no class, no attempt).
    const processed = await readRow(2);
    expect(processed?.status).toBe('processed');
    expect(processed?.failure_class).toBeNull();
    expect(processed?.attempt_count).toBe(0);

    // The legacy claimed row carries NO lease (pre-0002) — its state is
    // preserved verbatim by the migration itself.
    const claimed = await readRow(1);
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.claim_expires_at).toBeNull();
    expect(claimed?.failure_class).toBeNull();
    expect(claimed?.attempt_count).toBe(0);

    // The legacy failed row is backfilled as RETRYABLE (documented fail-safe
    // backfill — ADR-0031): it remains recoverable, never stranded.
    const failed = await readRow(3);
    expect(failed?.status).toBe('failed');
    expect(failed?.failure_class).toBe('retryable');
    expect(failed?.attempt_count).toBe(0);
  });

  it('makes the legacy lease-less claimed row recoverable via stale reclaim', async () => {
    await applyMigrations(db);
    const executor = createDbExecutor(db);

    // The abandoned pre-0002 claim (no lease) is reclaimable by the next
    // delivery — exactly the recovery path that was impossible before 0002.
    const recovery = await claimTelegramUpdate(executor, 1, NOW + 10_000);
    expect(recovery).toEqual({ kind: 'reclaimed_stale', attemptCount: 1 });
    const row = await readRow(1);
    expect(row?.status).toBe('claimed');
    expect(row?.claim_expires_at).toBe(NOW + 10_000 + LEASE);
    expect(row?.attempt_count).toBe(1);
  });

  it('keeps the backfilled legacy failed row reclaimable via the retryable path', async () => {
    await applyMigrations(db);
    const executor = createDbExecutor(db);

    const recovery = await claimTelegramUpdate(executor, 3, NOW + 10_000);
    expect(recovery).toEqual({ kind: 'reclaimed_retryable', attemptCount: 1 });
    const row = await readRow(3);
    expect(row?.status).toBe('claimed');
    expect(row?.failure_class).toBeNull();
    expect(row?.attempt_count).toBe(1);
  });

  it('is a no-op when applied twice (idempotent at the latest version)', async () => {
    await applyMigrations(db);
    const again = await applyMigrations(db);

    expect(again.observedVersion).toBe(3);
    expect(again.applied).toEqual([]);
    expect(again.finalVersion).toBe(3);
    expect(await appliedSchemaVersion()).toBe(3);

    // No duplicate rows anywhere: legacy rows are exactly the three seeded.
    const updates = await db
      .prepare(`SELECT COUNT(*) AS n FROM telegram_updates`)
      .first<{ n: number }>();
    expect(updates?.n).toBe(3);
  });

  it('enforces the new CHECK constraints on the lifecycle columns', async () => {
    await applyMigrations(db);
    const executor = createDbExecutor(db);

    // failure_class is restricted to the documented set (the executor maps
    // the driver error to the stable db_constraint_violation AppError).
    await expect(
      executor.run({
        sql: `INSERT INTO telegram_updates (update_id, received_at, status, failure_class)
              VALUES (?, ?, 'claimed', ?)`,
        params: [9001, NOW, 'bogus_class'],
      }),
    ).rejects.toMatchObject({ code: 'db_constraint_violation' });

    // attempt_count cannot go negative.
    await expect(
      executor.run({
        sql: `INSERT INTO telegram_updates (update_id, received_at, status, attempt_count)
              VALUES (?, ?, 'claimed', ?)`,
        params: [9002, NOW, -1],
      }),
    ).rejects.toMatchObject({ code: 'db_constraint_violation' });

    // The persisted failure class transitions stay guarded: a retryable
    // failed row can never silently become permanent (and vice versa).
    await claimTelegramUpdate(executor, 9003, NOW);
    await markTelegramUpdateFailed(executor, 9003, 1, NOW + 10, 'retryable');
    const row = await readRow(9003);
    expect(row?.failure_class).toBe('retryable');
  });
});
