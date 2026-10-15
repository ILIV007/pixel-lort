/**
 * ROUND 1.5 DESIGN LAB — proposed migration 0004 preflight/remediation
 * proofs on REAL workerd D1, on the CURRENT schema 3 (default accepted
 * migrations 0001–0003 only).
 *
 * Round 1.5 instruction 6: IF a partial unique index is required, provide
 * its proposed migration, a duplicate preflight/remediation plan, and a
 * consistent schema capability matrix. The design declares the index
 * REQUIRED (A.5: without it, crash-after-commit re-drives can create a
 * second outstanding window). This file proves the C.3 operational facts:
 *
 *  - the C.3 FACT: creating the partial unique index FAILS while
 *    outstanding duplicates exist (measured on real workerd D1);
 *  - the C.3 preflight scan (read-only, bounded) DETECTS the duplicates on
 *    schema 3 — no DDL is needed to run the preflight;
 *  - the C.3 remediation primitive (guarded `cancelled` transition of the
 *    NON-authoritative duplicate only) clears the scan; cancellation is
 *    NOT dead-lettering (the row never enters the DLQ scan);
 *  - after remediation the proposed migration applies WHOLE and ATOMICALLY
 *    (one batch), advances schema_metadata 3 → 4, and the index then
 *    enforces single-outstanding-poll exclusivity;
 *  - the lab plan (0001–0003 + PROPOSED 0004) is idempotent: applying it
 *    over the migrated database is a no-op.
 *
 * What these proofs DO NOT prove: any authorization to execute the
 * migration anywhere but this disposable lab database. Migration execution
 * on real environments remains UNAUTHORIZED (C.1/C.3: owner approval, Time
 * Travel bookmark, scan-then-apply as separate steps).
 */
import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, splitSqlStatements } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { scanPendingDlqDeliveries } from '../../src/adapters/db/job-store';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
import { cryptoIdGenerator } from '../../src/shared/ids/id';
import {
  cancelSupersededPollJob,
  LAB_MIGRATION_PLAN,
  PROPOSED_MIGRATION_0004,
  scanOutstandingPollDuplicates,
} from '../design/round15-ownership';

const NOW = 1_771_000_000_000;
const db = createDbExecutor(env.DB);

async function insertPollJob(
  aggregateId: string,
  keySuffix: string,
  status = 'pending',
): Promise<string> {
  const id = cryptoIdGenerator.newId();
  await db.run({
    sql: `INSERT INTO jobs (id, type, aggregate_type, aggregate_id, status, priority,
                             run_after, attempts, max_attempts, lease_until,
                             idempotency_key, payload_json, last_error, created_at,
                             updated_at, dlq_delivered_at)
          VALUES (?, 'sources.fetch_poll', 'source', ?, ?, 40, ?, 0, 3, NULL, ?, ?, NULL, ?, ?, NULL)`,
    params: [
      id,
      aggregateId,
      status,
      NOW,
      `key-${aggregateId}-${keySuffix}`,
      canonicalizeJson({ sourceId: aggregateId, scheduledForMs: 0 }),
      NOW,
      NOW,
    ],
  });
  return id;
}

/** Apply the PROPOSED migration to this disposable database (lab only). */
async function applyProposed0004(): Promise<void> {
  const statements = splitSqlStatements(PROPOSED_MIGRATION_0004.sql).map((statement) =>
    env.DB.prepare(statement),
  );
  // Raw D1 batch (same mechanism as the migration helper): ONE atomic unit.
  await env.DB.batch(statements);
}

/**
 * File-order note: the lab D1 persists across tests WITHIN this file, so
 * the schema-3 facts (P-M1/P-M2) run FIRST, P-M3 performs the remediation
 * and the migration, and the later tests ensure idempotently that the
 * proposed schema is present.
 */
async function ensureProposed0004(): Promise<void> {
  const version = await db.first<{ value: string }>({
    sql: "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
  });
  if (version !== null && version.value === '3') {
    await applyProposed0004();
  }
}

beforeEach(async () => {
  await applyMigrations(env.DB); // DEFAULT plan — schema 3
  await db.run({ sql: 'DELETE FROM jobs' });
});

it('P-M1: the C.3 fact — creating the index fails while outstanding duplicates exist', async () => {
  await insertPollJob('src_a', '1');
  await insertPollJob('src_a', '2'); // second outstanding poll job, same source
  // The proposed DDL must FAIL on a database with outstanding duplicates.
  await expect(applyProposed0004()).rejects.toThrow();
  // The failure is atomic: nothing landed (schema_metadata still at 3, no
  // owner column, no index).
  const version = await db.first<{ value: string }>({
    sql: "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
  });
  expect(version!.value).toBe('3');
  const column = await db.first<{ n: number }>({
    sql: "SELECT COUNT(*) AS n FROM pragma_table_info('source_state') WHERE name = 'poll_owner_job_id'",
  });
  expect(column!.n).toBe(0);
});

it('P-M2: the C.3 preflight scan detects the duplicates on schema 3 (read-only, bounded)', async () => {
  await insertPollJob('src_a', '1');
  await insertPollJob('src_a', '2');
  await insertPollJob('src_b', '1'); // a clean source: never reported
  const duplicates = await scanOutstandingPollDuplicates(db, 100);
  expect(duplicates).toEqual([{ aggregate_type: 'source', aggregate_id: 'src_a', n: 2 }]);
});

it('P-M3: remediation (guarded cancel) clears the scan; the index then applies whole', async () => {
  const older = await insertPollJob('src_a', '1');
  const newer = await insertPollJob('src_a', '2');
  await insertPollJob('src_b', '1');
  expect(await scanOutstandingPollDuplicates(db, 100)).toHaveLength(1);
  // Owner-approved dedup: cancel the NON-authoritative duplicate only
  // (newest wins by created_at then id; every cancellation is logged).
  const cancelled = await cancelSupersededPollJob(db, older, NOW + 1);
  expect(cancelled).toBe(true);
  const row = await db.first<{
    status: string;
    last_error: string;
    dlq_delivered_at: number | null;
  }>({
    sql: 'SELECT status, last_error, dlq_delivered_at FROM jobs WHERE id = ?',
    params: [older],
  });
  expect(row!.status).toBe('cancelled');
  expect(row!.last_error).toBe('job_cancelled_superseded');
  expect(row!.dlq_delivered_at).toBeNull();
  // Cancellation is NOT dead-lettering: the DLQ reconciliation scan (which
  // selects ONLY dead_letter rows) never sees it.
  const dlq = await scanPendingDlqDeliveries(db, 100);
  expect(dlq.map((r) => r.id)).not.toContain(older);
  // Re-scan: empty. The outstanding job (newer) is untouched.
  expect(await scanOutstandingPollDuplicates(db, 100)).toEqual([]);
  const survivor = await db.first<{ status: string }>({
    sql: 'SELECT status FROM jobs WHERE id = ?',
    params: [newer],
  });
  expect(survivor!.status).toBe('pending');
  // NOW the proposed migration applies whole and atomically.
  await applyProposed0004();
  const version = await db.first<{ value: string }>({
    sql: "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
  });
  expect(version!.value).toBe('4');
  const migrationId = await db.first<{ value: string }>({
    sql: "SELECT value FROM schema_metadata WHERE key = 'migration_id'",
  });
  expect(migrationId!.value).toBe('0004_source_poll_ownership');
  const column = await db.first<{ n: number }>({
    sql: "SELECT COUNT(*) AS n FROM pragma_table_info('source_state') WHERE name = 'poll_owner_job_id'",
  });
  expect(column!.n).toBe(1);
});

it('P-M4: after the proposed migration the index enforces single-outstanding exclusivity', async () => {
  await ensureProposed0004();
  await insertPollJob('src_a', '1'); // first outstanding poll job: fine
  // A second outstanding poll job for the same source raises the index.
  await expect(insertPollJob('src_a', '2')).rejects.toThrow();
  // A terminal duplicate does NOT raise (the partial predicate excludes it).
  await insertPollJob('src_a', '2', 'succeeded');
  // A different source is unaffected.
  await insertPollJob('src_b', '1');
});

it('P-M5: the lab migration plan is idempotent over the migrated database', async () => {
  await ensureProposed0004();
  const result = await applyMigrations(env.DB, LAB_MIGRATION_PLAN);
  expect(result.observedVersion).toBe(4);
  expect(result.applied).toHaveLength(0);
  expect(result.finalVersion).toBe(4);
});
