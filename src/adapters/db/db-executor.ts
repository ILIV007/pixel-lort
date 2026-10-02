/**
 * Typed D1 execution boundary (Phase 1A — smallest useful abstraction).
 *
 * This is NOT an ORM and NOT a repository framework: it is a thin, typed
 * boundary over the raw D1Database binding that
 * - gives call sites a stable interface to mock and test against,
 * - measures operation durations,
 * - maps driver errors into stable AppError codes (d1-errors.ts),
 * - emits safe observability events ONLY: stable operation names, duration,
 *   result counts, and stable error codes. SQL text and bind parameters are
 *   NEVER logged — parameters may carry user/source content (ADR-0022).
 *
 * Bind parameters must be D1-bindable values (string | number | boolean |
 * null | ArrayBuffer); `undefined` is rejected by D1 and surfaces as a
 * mapped db_query_failed error.
 */
import type { Logger, LogFields } from '../../observability/logger';
import type { Clock } from '../../shared/time/clock';
import { systemClock } from '../../shared/time/clock';
import { toDbAppError } from './d1-errors';

export interface DbStatement {
  /** SQL text. Static or parameterized — never interpolate user content. */
  readonly sql: string;
  /** D1-bindable parameter values (never logged). */
  readonly params?: readonly unknown[];
}

export interface DbQueryMeta {
  readonly durationMs: number;
  readonly changes: number;
}

export interface DbRows<T> {
  readonly rows: readonly T[];
  readonly meta: DbQueryMeta;
}

export interface DbExecutor {
  /** Execute one statement and return all rows plus timing metadata. */
  query<T>(statement: DbStatement): Promise<DbRows<T>>;
  /** Execute one statement and return the first row or null. */
  first<T>(statement: DbStatement): Promise<T | null>;
  /** Execute one mutation statement; returns timing/changes metadata. */
  run(statement: DbStatement): Promise<DbQueryMeta>;
  /**
   * Execute statements as ONE atomic D1 batch (implicit transaction):
   * if any statement fails, the whole batch is rolled back.
   */
  batch(statements: readonly DbStatement[]): Promise<readonly DbQueryMeta[]>;
}

export interface DbExecutorOptions {
  /** Optional logger; safe events only (see module doc). */
  readonly logger?: Logger;
  /** Clock for durations; inject a fixed clock in tests. */
  readonly clock?: Clock;
}

function prepareBound(db: D1Database, statement: DbStatement): D1PreparedStatement {
  const prepared = db.prepare(statement.sql);
  const params = statement.params ?? [];
  return params.length > 0 ? prepared.bind(...params) : prepared;
}

export function createDbExecutor(db: D1Database, options: DbExecutorOptions = {}): DbExecutor {
  const clock = options.clock ?? systemClock;
  const logger = options.logger;

  function logSuccess(event: string, fields: LogFields): void {
    logger?.debug(event, fields);
  }

  function logFailure(event: string, errorCode: string, durationMs: number): void {
    logger?.warn(event, { errorCode, durationMs });
  }

  return {
    async query<T>(statement: DbStatement): Promise<DbRows<T>> {
      const startedAt = clock.now();
      try {
        const response = await prepareBound(db, statement).all<T>();
        const durationMs = clock.now() - startedAt;
        const meta: DbQueryMeta = {
          durationMs,
          changes: response.meta.changes ?? 0,
        };
        logSuccess('db.query.ok', { durationMs, rowCount: response.results.length });
        return { rows: response.results, meta };
      } catch (error) {
        const mapped = toDbAppError(error);
        logFailure('db.query.failed', mapped.code, clock.now() - startedAt);
        throw mapped;
      }
    },

    async first<T>(statement: DbStatement): Promise<T | null> {
      const { rows } = await this.query<T>(statement);
      return rows.length > 0 ? (rows[0] ?? null) : null;
    },

    async run(statement: DbStatement): Promise<DbQueryMeta> {
      const startedAt = clock.now();
      try {
        const response = await prepareBound(db, statement).run();
        const durationMs = clock.now() - startedAt;
        const meta: DbQueryMeta = {
          durationMs,
          changes: response.meta.changes ?? 0,
        };
        logSuccess('db.run.ok', { durationMs, changes: meta.changes });
        return meta;
      } catch (error) {
        const mapped = toDbAppError(error);
        logFailure('db.run.failed', mapped.code, clock.now() - startedAt);
        throw mapped;
      }
    },

    async batch(statements: readonly DbStatement[]): Promise<readonly DbQueryMeta[]> {
      const startedAt = clock.now();
      try {
        const prepared = statements.map((statement) => prepareBound(db, statement));
        const responses = await db.batch(prepared);
        const durationMs = clock.now() - startedAt;
        const metas: DbQueryMeta[] = responses.map((response) => ({
          durationMs,
          changes: response.meta.changes ?? 0,
        }));
        logSuccess('db.batch.ok', { durationMs, statementCount: metas.length });
        return metas;
      } catch (error) {
        const mapped = toDbAppError(error);
        logFailure('db.batch.failed', mapped.code, clock.now() - startedAt);
        throw mapped;
      }
    },
  };
}
