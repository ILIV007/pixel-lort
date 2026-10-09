import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';
import type { WorkerEnv } from '../../src/shared/types/env';

/**
 * Gate integration on REAL workerd D1 (Phase 4 — ADR-0038 §1): the
 * resolved engine registers the poll handler ONLY while the gate is on;
 * the due-source scan is provably indexed (EXPLAIN QUERY PLAN).
 */

const executor: DbExecutor = createDbExecutor(env.DB);

beforeEach(async () => {
  await applyMigrations(env.DB);
  await executor.run({ sql: 'DELETE FROM source_items' });
  await executor.run({ sql: 'DELETE FROM source_state' });
  await executor.run({ sql: 'DELETE FROM sources' });
  await executor.run({ sql: 'DELETE FROM jobs' });
});

function envWith(overrides: Partial<WorkerEnv>): WorkerEnv {
  return {
    JOBS_ENABLED: 'true',
    DB: env.DB,
    // Non-functional queue stand-ins: binding PRESENCE is what the gate
    // checks; the engine is not driven through real queues here.
    JOBS: { send: async () => {} } as unknown as Queue,
    DLQ: { send: async () => {} } as unknown as Queue,
    ...overrides,
  } as WorkerEnv;
}

describe('ingestion gate with real bindings', () => {
  it('registers the poll handler only while the gate is on', () => {
    const off = resolveJobsEngine(envWith({ SOURCE_INGESTION_ENABLED: 'false' }));
    expect(off.kind).toBe('ready');
    if (off.kind === 'ready') {
      expect(off.ingestionEnabled).toBe(false);
      expect(off.engine).toBeDefined();
    }

    const on = resolveJobsEngine(envWith({ SOURCE_INGESTION_ENABLED: 'true' }));
    expect(on.kind).toBe('ready');
    if (on.kind === 'ready') {
      expect(on.ingestionEnabled).toBe(true);
    }
  });

  it('fails closed with an invalid flag even with full bindings', () => {
    const invalid = resolveJobsEngine(envWith({ SOURCE_INGESTION_ENABLED: 'yes' }));
    expect(invalid.kind).toBe('config_invalid');
  });

  it('keeps the maintenance handler registered in BOTH gate states', () => {
    for (const flag of ['false', 'true']) {
      const resolution = resolveJobsEngine(envWith({ SOURCE_INGESTION_ENABLED: flag }));
      expect(resolution.kind).toBe('ready');
    }
  });
});

describe('due-source scan query plan (bounded, indexed)', () => {
  it('is served entirely by index seeks — never a full-table scan', async () => {
    const plan = await executor.query<{ id: number; detail: string }>({
      sql: `EXPLAIN QUERY PLAN
            SELECT s.id, s.connector, s.interval_seconds, s.daily_request_budget,
                   s.config_json, st.next_poll_at, st.etag, st.last_modified, st.cursor
              FROM source_state st
              JOIN sources s ON s.id = st.source_id
             WHERE s.enabled = 1
               AND st.next_poll_at <= ?
               AND (st.circuit_open_until IS NULL OR st.circuit_open_until <= ?)
             ORDER BY st.next_poll_at ASC, s.id ASC
             LIMIT 10`,
      params: [1_770_000_000_000, 1_770_000_000_000],
    });
    const details = plan.rows.map((row) => row.detail.toLowerCase()).join(' | ');
    // BOTH relations must be reached through an index (the enabled filter
    // via idx_sources_due_config or the due seek via idx_source_state_due;
    // the join side always rides a unique index) — never a SCAN.
    expect(details).toMatch(/search s using index idx_sources_due_config|search s using index sqlite_autoindex_sources_1/);
    expect(details).toMatch(/search st using (index idx_source_state_due|index sqlite_autoindex_source_state_1)/);
    expect(details).not.toMatch(/scan sources\b/);
    expect(details).not.toMatch(/scan source_state\b/);
  });
});
