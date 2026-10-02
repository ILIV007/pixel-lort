import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { isAppError } from '../../src/shared/errors/app-error';
import { createLogger, type LogSink } from '../../src/observability/logger';
import type { LogLevel } from '../../src/shared/types/log-level';

/**
 * Phase 1A database-boundary tests, executed against the isolated local D1
 * test database (wrangler.jsonc placeholder binding — no Cloudflare resource).
 *
 * Proves: typed execution, atomic batches, safe D1 error mapping, and the
 * observability contract (ADR-0022): only stable operation names, durations,
 * result counts and error codes are logged — SQL text and bind parameters
 * (which may carry user/source content) are never logged.
 */

const db: D1Database = env.DB;

interface CapturedLine {
  readonly level: LogLevel;
  readonly parsed: Record<string, unknown>;
}

function createCaptureLogger(): { lines: CapturedLine[]; logger: ReturnType<typeof createLogger> } {
  const lines: CapturedLine[] = [];
  const sink: LogSink = (level, line) => {
    lines.push({ level, parsed: JSON.parse(line) as Record<string, unknown> });
  };
  return { lines, logger: createLogger({ level: 'debug', sink }) };
}

function createSourceRow(id: string): { sql: string; params: unknown[] } {
  return {
    sql: `INSERT INTO sources (id, name, connector, lane, trust_tier, interval_seconds, approval_policy, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [id, `Source ${id}`, 'rss', 'radar', 50, 300, 'auto', 1, 1],
  };
}

let executor: DbExecutor;
let capture: { lines: CapturedLine[]; logger: ReturnType<typeof createLogger> };

beforeEach(async () => {
  await applyMigrations(db);
  capture = createCaptureLogger();
  executor = createDbExecutor(db, { logger: capture.logger });
});

describe('DbExecutor — typed execution', () => {
  it('returns typed rows and timing metadata', async () => {
    const result = await executor.query<{ one: number }>({ sql: 'SELECT 1 AS one' });
    expect(result.rows).toEqual([{ one: 1 }]);
    expect(result.meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('first() returns the first row or null', async () => {
    const present = await executor.first<{ one: number }>({ sql: 'SELECT 1 AS one' });
    expect(present?.one).toBe(1);
    const absent = await executor.first<{ one: number }>({
      sql: 'SELECT 1 AS one WHERE 1 = 0',
    });
    expect(absent).toBeNull();
  });

  it('first() survives destructuring (no dependence on method binding)', async () => {
    // The executor is closure-based: extracting the method must not detach it
    // from its database binding or change behavior.
    const { first } = createDbExecutor(db);
    const row = await first<{ one: number }>({ sql: 'SELECT 42 AS one' });
    expect(row?.one).toBe(42);
    const absent = await first<{ one: number }>({ sql: 'SELECT 42 AS one WHERE 1 = 0' });
    expect(absent).toBeNull();
  });

  it('batch([]) resolves to [] without calling D1 and without throwing', async () => {
    // A stub D1Database whose prepare/batch would explode if touched: the
    // documented empty-batch no-op must short-circuit before any D1 call.
    const untouchedDb = {
      prepare: () => {
        throw new Error('prepare must not be called for an empty batch');
      },
      batch: () => {
        throw new Error('D1 batch must not be called for an empty statement list');
      },
    } as unknown as D1Database;
    const isolatedExecutor = createDbExecutor(untouchedDb);

    await expect(isolatedExecutor.batch([])).resolves.toEqual([]);
    // The real binding behaves identically.
    await expect(executor.batch([])).resolves.toEqual([]);
  });

  it('run() reports change counts for mutations', async () => {
    const meta = await executor.run(createSourceRow('src-exec-1'));
    expect(meta.changes).toBe(1);

    const updated = await executor.run({
      sql: 'UPDATE sources SET enabled = 0 WHERE id = ?',
      params: ['src-exec-1'],
    });
    expect(updated.changes).toBe(1);
  });

  it('applies an atomic batch: all statements succeed together', async () => {
    const metas = await executor.batch([
      createSourceRow('src-batch-1'),
      createSourceRow('src-batch-2'),
    ]);
    expect(metas).toHaveLength(2);

    const count = await executor.first<{ n: number }>({
      sql: "SELECT COUNT(*) AS n FROM sources WHERE id IN ('src-batch-1', 'src-batch-2')",
    });
    expect(count?.n).toBe(2);
  });

  it('rolls back the WHOLE batch when any statement fails', async () => {
    // Second statement violates jobs.idempotency_key UNIQUE — the first
    // statement's insert must be rolled back (D1 batches are transactions).
    await expect(
      executor.batch([
        {
          sql: `INSERT INTO jobs (id, type, status, run_after, idempotency_key, created_at, updated_at)
                VALUES ('job-batch-1', 'fetch_source', 'pending', 1, 'idem-batch-001', 1, 1)`,
        },
        {
          sql: `INSERT INTO jobs (id, type, status, run_after, idempotency_key, created_at, updated_at)
                VALUES ('job-batch-2', 'fetch_source', 'pending', 1, 'idem-batch-001', 1, 1)`,
        },
      ]),
    ).rejects.toMatchObject({ code: 'db_constraint_violation' });

    const row = await executor.first<{ n: number }>({
      sql: "SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = 'idem-batch-001'",
    });
    expect(row?.n).toBe(0);
  });
});

describe('DbExecutor — safe error mapping', () => {
  it('maps unique violations to a stable 409-class AppError', async () => {
    await executor.run(createSourceRow('src-map-1'));
    let thrown: unknown;
    try {
      await executor.run(createSourceRow('src-map-1'));
      thrown = undefined;
    } catch (error) {
      thrown = error;
    }
    expect(isAppError(thrown)).toBe(true);
    const appError = thrown as { code: string; status: number; message: string };
    expect(appError.code).toBe('db_constraint_violation');
    expect(appError.status).toBe(409);
    expect(appError.message).toBe('Database Constraint Violation');
  });

  it('maps missing tables to db_schema_invalid', async () => {
    await expect(executor.query({ sql: 'SELECT key FROM not_a_real_table' })).rejects.toMatchObject(
      { code: 'db_schema_invalid', status: 503 },
    );
  });

  it('maps syntax errors to db_query_failed', async () => {
    await expect(executor.query({ sql: 'SELEC nope' })).rejects.toMatchObject({
      code: 'db_query_failed',
      status: 500,
    });
  });
});

describe('DbExecutor — observability contract (ADR-0022)', () => {
  it('logs only stable operation names, durations and result counts', async () => {
    await executor.query({ sql: 'SELECT 1' });
    const okLines = capture.lines.filter((line) => line.parsed['msg'] === 'db.query.ok');
    expect(okLines).toHaveLength(1);
    const fields = okLines[0]!.parsed;
    expect(typeof fields['durationMs']).toBe('number');
    expect(fields['rowCount']).toBe(1);
    expect(JSON.stringify(capture.lines)).not.toContain('SELECT');
  });

  it('never logs bind parameters that may carry user or source content', async () => {
    const marker = 'USER-CONTENT-MARKER-9c41';
    await executor.query({ sql: 'SELECT ? AS marker', params: [marker] });

    const serialized = JSON.stringify(capture.lines);
    expect(serialized).not.toContain(marker);
  });

  it('logs stable error codes on failure without raw driver messages', async () => {
    const marker = 'PARAM-LEAK-CHECK-b7d2';
    await expect(
      executor.query({ sql: 'SELECT key FROM missing_table_xyz WHERE x = ?', params: [marker] }),
    ).rejects.toMatchObject({ code: 'db_schema_invalid' });

    const failedLines = capture.lines.filter((line) => line.parsed['msg'] === 'db.query.failed');
    expect(failedLines).toHaveLength(1);
    expect(failedLines[0]!.parsed['errorCode']).toBe('db_schema_invalid');

    const serialized = JSON.stringify(capture.lines);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('missing_table_xyz');
    expect(serialized).not.toContain('no such table');
  });
});
