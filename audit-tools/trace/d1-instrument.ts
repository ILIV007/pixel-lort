/**
 * R1.10.3 AUDIT TOOLING — D1 instrumenting wrapper v3 (NOT accepted source).
 *
 * Location is deliberately OUTSIDE the accepted tree (audit-tools/). It wraps
 * the disposable local workerd D1 binding so a trace can count, per
 * invocation, with CORRECT UNITS.
 *
 * VERSION HISTORY (mandatory reading):
 *  - v1 (R1.10.1): counted `prepare()` as a query — WRONG; captured only
 *    batch result[0] metadata — WRONG.
 *  - v2 (R1.10.2, TR-01): prepares are construction only; execution-API-call
 *    attempts = terminal executions + batch() calls; statements attempted =
 *    terminal executions + statements submitted into batches; every
 *    available result metadata captured; unavailable metadata LABELED.
 *    KNOWN DEFECTS found by the R1.10.2 independent review (R112-03):
 *    (a) `statementsCompleted` counted a FAILED batch's submitted
 *        statements as completed (a rolled-back transaction completes
 *        NOTHING observable);
 *    (b) after the 4096-record reservoir saturated, captureMeta still
 *        MUTATED the last RETAINED sample to attach a newer result's
 *        metadata — misattributing record N+1 onto record N.
 *  - v3 (R1.10.3, R112-03): BOTH defects fixed:
 *    (a) NEW counter `batchStatementsCompleted` — incremented ONLY when a
 *        batch COMPLETES (D1 batches are implicit all-or-nothing
 *        transactions; a failed batch contributes ZERO completed
 *        statements). `deriveCounts().statementsCompleted` now =
 *        terminalCompleted + batchStatementsCompleted. The gap
 *        `statementsAttempted - statementsCompleted` is reported as
 *        `statementsNotConfirmedCompleted` and is LABELED: workerd does
 *        not expose per-statement rollback internals, so submitted-but-
 *        unconfirmed statements are UNKNOWN-outcome, never "completed",
 *        and never silently called "failed" either.
 *    (b) captureMeta builds the COMPLETE record FIRST, then either
 *        retains it (capacity permitting) or drops it with an explicit
 *        `metaDroppedFromReservoir` counter. An already-retained record
 *        is NEVER mutated afterwards. All-result aggregates
 *        (`metaAvailableTotal`/`metaUnavailableTotal` and per-field
 *        presence/sums) are maintained INDEPENDENTLY of the reservoir, so
 *        totals stay COMPLETE even when per-record retention truncates;
 *        a truncated reservoir is flagged (`metaReservoirTruncated`).
 *
 * UNITS (unchanged from v2, mandatory vocabulary):
 *   - `prepares` — `prepare()` CONSTRUCTION only. A prepare executes
 *     NOTHING by itself (official API: "Prepares a query statement to be
 *     later executed"). Never counted as an execution, RPC, or query.
 *   - terminal method executions — `run()` / `all()` / `first()` / `raw()`
 *     invocations on a prepared statement: each is ONE execution-API call
 *     (attempted; completed/failed tracked separately).
 *   - `batches` — `batch()` invocations: each is ONE execution-API call
 *     regardless of how many statements it carries.
 *   - `batchStatements` — statements submitted INTO batches.
 *   - completed vs failed execution-API calls (a throw is an ATTEMPT that
 *     FAILED — it is never silently dropped from the attempted total).
 *
 * DERIVED (documented in audit-tools/README.md):
 *   executionApiCallAttempts   = terminalAttempts + batchAttempts
 *   executionApiCallsCompleted = terminalCompleted + batchCompleted
 *   executionApiCallsFailed    = terminalFailed + batchFailed
 *   statementsAttempted        = terminalAttempts + batchStatements
 *   statementsCompleted        = terminalCompleted +
 *                                batchStatementsCompleted (completed
 *                                batches only — R112-03)
 *
 * LABEL RULE (unchanged, mandatory): every number produced here is a LOCAL
 * workerd proxy measurement on a disposable SQLite-backed D1. It is NOT a
 * Cloudflare-side billable counter and proves nothing about the real
 * account's quota consumption. rows_read/rows_written, when present, are
 * the local engine's own estimates. The mapping between these LOCAL
 * execution-API-call counts and the documented Cloudflare "queries per
 * Worker invocation" Free quota is a SEPARATE documented question (both
 * interpretations are carried in free-plan/ documents; see §4 there).
 *
 * DECLARED UNSUPPORTED SURFACES: `exec()` and `withSession()` are passed
 * through UNINSTRUMENTED (the accepted DbExecutor never exercises them;
 * if a future trace exercises them they MUST be declared here with their
 * own counters first — passing through silently is the documented,
 * deliberate behavior, visible in this file and in the README).
 */

export type TerminalMethod = 'run' | 'all' | 'first' | 'raw';

export interface D1MethodStats {
  attempts: number;
  completed: number;
  failed: number;
}

export interface D1MetaRecord {
  /** Where this metadata came from. */
  readonly origin: 'terminal' | 'batch';
  /** Terminal method name when origin === 'terminal'. */
  readonly method?: TerminalMethod;
  /** Statement position inside the batch when origin === 'batch'. */
  readonly statementIndex?: number;
  /**
   * TRUE when the raw result exposed a `meta` object. When FALSE the
   * record only documents that metadata was EXPECTED but UNAVAILABLE —
   * numeric fields below are then absent (never zero-filled).
   */
  readonly hasRawMeta: boolean;
  readonly unavailableReason?: 'no_meta_object' | 'null_result' | 'non_object_result';
  readonly durationMs?: number;
  readonly changes?: number;
  readonly rowsRead?: number;
  readonly rowsWritten?: number;
}

/** All-result aggregate counters — COMPLETE regardless of reservoir truncation. */
export interface D1MetaAggregates {
  /** Results whose raw `meta` object was available (retained OR dropped). */
  availableTotal: number;
  /** Results where metadata was expected but unavailable (labeled). */
  unavailableTotal: number;
  /** Per-field presence counts (results carrying that field). */
  presence: {
    durationMs: number;
    changes: number;
    rowsRead: number;
    rowsWritten: number;
  };
  /** Per-field sums over ALL results carrying that field. */
  sums: {
    durationMs: number;
    changes: number;
    rowsRead: number;
    rowsWritten: number;
  };
}

export interface D1Stats {
  /** `prepare()` construction calls. NOT executions. */
  prepares: number;
  /** Terminal method execution attempts (run/all/first/raw). */
  terminalAttempts: number;
  terminalCompleted: number;
  terminalFailed: number;
  /** Per-method breakdown (attempts/completed/failed). */
  terminalByMethod: Record<TerminalMethod, D1MethodStats>;
  /** `batch()` execution-API call attempts. */
  batchAttempts: number;
  batchCompleted: number;
  batchFailed: number;
  /** Statements submitted INTO batches (across all batch attempts). */
  batchStatements: number;
  /**
   * R112-03: statements carried by batches that COMPLETED. A failed
   * (rolled-back) batch contributes ZERO here — its statements' outcome
   * is unobservable and is NEVER reported as completed.
   */
  batchStatementsCompleted: number;
  /** Result objects returned by completed batches. */
  batchResultRecords: number;
  /**
   * Bounded per-record metadata reservoir (FIRST 4096 records retained).
   * Records here are immutable once retained — later results NEVER
   * rewrite an earlier record (R112-03).
   */
  metaRecords: D1MetaRecord[];
  /** Records past the reservoir capacity: counted, never retained. */
  metaDroppedFromReservoir: number;
  /** Reservoir capacity (documented constant, mirrored by the tests). */
  metaReservoirLimit: number;
  /** Complete all-result aggregates (independent of the reservoir). */
  metaAggregates: D1MetaAggregates;
  /** Distinct normalized SQL shapes (bounded list for the report). */
  shapes: string[];
}

export const META_RESERVOIR_LIMIT = 4096;

export function createD1Stats(): D1Stats {
  return {
    prepares: 0,
    terminalAttempts: 0,
    terminalCompleted: 0,
    terminalFailed: 0,
    terminalByMethod: {
      run: { attempts: 0, completed: 0, failed: 0 },
      all: { attempts: 0, completed: 0, failed: 0 },
      first: { attempts: 0, completed: 0, failed: 0 },
      raw: { attempts: 0, completed: 0, failed: 0 },
    },
    batchAttempts: 0,
    batchCompleted: 0,
    batchFailed: 0,
    batchStatements: 0,
    batchStatementsCompleted: 0,
    batchResultRecords: 0,
    metaRecords: [],
    metaDroppedFromReservoir: 0,
    metaReservoirLimit: META_RESERVOIR_LIMIT,
    metaAggregates: {
      availableTotal: 0,
      unavailableTotal: 0,
      presence: { durationMs: 0, changes: 0, rowsRead: 0, rowsWritten: 0 },
      sums: { durationMs: 0, changes: 0, rowsRead: 0, rowsWritten: 0 },
    },
    shapes: [],
  };
}

/** Derived counters — the honest unit vocabulary for reports. */
export interface D1DerivedCounts {
  executionApiCallAttempts: number;
  executionApiCallsCompleted: number;
  executionApiCallsFailed: number;
  statementsAttempted: number;
  /** R112-03: completed = terminal completions + completed-batch statements ONLY. */
  statementsCompleted: number;
  /**
   * Submitted statements whose outcome was NOT confirmed completed: the
   * statements of failed (rolled-back) batches. workerd does not expose
   * per-statement rollback internals — label these UNKNOWN-outcome, never
   * "completed", and never silently "failed" either.
   */
  statementsNotConfirmedCompleted: number;
  /** Complete all-result counters (independent of reservoir truncation). */
  metaRecordsAvailable: number;
  metaRecordsUnavailable: number;
  /** Reservoir state (per-record detail may truncate; totals never do). */
  metaReservoirRetained: number;
  metaReservoirDropped: number;
  metaReservoirTruncated: boolean;
}

export function deriveCounts(stats: D1Stats): D1DerivedCounts {
  const statementsAttempted = stats.terminalAttempts + stats.batchStatements;
  const statementsCompleted = stats.terminalCompleted + stats.batchStatementsCompleted;
  return {
    executionApiCallAttempts: stats.terminalAttempts + stats.batchAttempts,
    executionApiCallsCompleted: stats.terminalCompleted + stats.batchCompleted,
    executionApiCallsFailed: stats.terminalFailed + stats.batchFailed,
    statementsAttempted,
    statementsCompleted,
    statementsNotConfirmedCompleted: statementsAttempted - statementsCompleted,
    metaRecordsAvailable: stats.metaAggregates.availableTotal,
    metaRecordsUnavailable: stats.metaAggregates.unavailableTotal,
    metaReservoirRetained: stats.metaRecords.length,
    metaReservoirDropped: stats.metaDroppedFromReservoir,
    metaReservoirTruncated: stats.metaDroppedFromReservoir > 0,
  };
}

/** Reset every mutable counter/accumulator in place (between windows). */
export function resetStats(stats: D1Stats): void {
  const fresh = createD1Stats();
  stats.prepares = fresh.prepares;
  stats.terminalAttempts = fresh.terminalAttempts;
  stats.terminalCompleted = fresh.terminalCompleted;
  stats.terminalFailed = fresh.terminalFailed;
  for (const key of Object.keys(fresh.terminalByMethod) as TerminalMethod[]) {
    stats.terminalByMethod[key] = { ...fresh.terminalByMethod[key] };
  }
  stats.batchAttempts = fresh.batchAttempts;
  stats.batchCompleted = fresh.batchCompleted;
  stats.batchFailed = fresh.batchFailed;
  stats.batchStatements = fresh.batchStatements;
  stats.batchStatementsCompleted = fresh.batchStatementsCompleted;
  stats.batchResultRecords = fresh.batchResultRecords;
  stats.metaRecords = [];
  stats.metaDroppedFromReservoir = fresh.metaDroppedFromReservoir;
  stats.metaReservoirLimit = fresh.metaReservoirLimit;
  stats.metaAggregates = {
    availableTotal: 0,
    unavailableTotal: 0,
    presence: { durationMs: 0, changes: 0, rowsRead: 0, rowsWritten: 0 },
    sums: { durationMs: 0, changes: 0, rowsRead: 0, rowsWritten: 0 },
  };
  stats.shapes = [];
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function recordShape(stats: D1Stats, sql: string): void {
  const shape = normalizeSql(sql);
  if (!stats.shapes.includes(shape) && stats.shapes.length < 128) {
    stats.shapes.push(shape);
  }
}

/**
 * R112-03 captureMeta v3: build the COMPLETE record FIRST, then retain or
 * drop it. An already-retained record is NEVER mutated afterwards, and a
 * dropped record still feeds the COMPLETE all-result aggregates.
 */
function captureMeta(stats: D1Stats, record: D1MetaRecord, result: unknown): void {
  // Work on a mutable draft of the record for THIS result only.
  const draft: {
    -readonly [K in keyof D1MetaRecord]: D1MetaRecord[K];
  } = { ...record };

  if (result === null || result === undefined) {
    draft.unavailableReason = 'null_result';
    stats.metaAggregates.unavailableTotal += 1;
    retainOrDrop(stats, draft);
    return;
  }
  if (typeof result !== 'object') {
    draft.unavailableReason = 'non_object_result';
    stats.metaAggregates.unavailableTotal += 1;
    retainOrDrop(stats, draft);
    return;
  }
  const meta = (result as Record<string, unknown>).meta;
  if (meta === undefined || meta === null || typeof meta !== 'object') {
    draft.unavailableReason = 'no_meta_object';
    stats.metaAggregates.unavailableTotal += 1;
    retainOrDrop(stats, draft);
    return;
  }
  const m = meta as Record<string, unknown>;
  draft.hasRawMeta = true;
  delete draft.unavailableReason;
  const agg = stats.metaAggregates;
  agg.availableTotal += 1;
  if (typeof m.duration === 'number') {
    draft.durationMs = m.duration;
    agg.presence.durationMs += 1;
    agg.sums.durationMs += m.duration;
  }
  if (typeof m.changes === 'number') {
    draft.changes = m.changes;
    agg.presence.changes += 1;
    agg.sums.changes += m.changes;
  }
  if (typeof m.rows_read === 'number') {
    draft.rowsRead = m.rows_read;
    agg.presence.rowsRead += 1;
    agg.sums.rowsRead += m.rows_read;
  }
  if (typeof m.rows_written === 'number') {
    draft.rowsWritten = m.rows_written;
    agg.presence.rowsWritten += 1;
    agg.sums.rowsWritten += m.rows_written;
  }
  retainOrDrop(stats, draft);
}

function retainOrDrop(
  stats: D1Stats,
  draft: { -readonly [K in keyof D1MetaRecord]: D1MetaRecord[K] },
): void {
  if (stats.metaRecords.length < stats.metaReservoirLimit) {
    // Retain an immutable snapshot. Never touched again by any later result.
    stats.metaRecords.push({ ...draft });
  } else {
    // Explicit truncation: counted in aggregates, never retained, and no
    // earlier record is rewritten to make room (R112-03).
    stats.metaDroppedFromReservoir += 1;
  }
}

interface Underlying {
  readonly target: D1PreparedStatement;
  readonly sql: string;
}

/**
 * Wrap a D1 binding so every raw invocation is counted with honest units.
 * The wrapper is transparent to application code (createDbExecutor receives
 * it unchanged). Statements are unwrapped back to their ORIGINAL underlying
 * statement objects before reaching the real `batch()`/terminal calls, so
 * bind identity and workerd semantics are preserved exactly.
 */
export function instrumentD1(db: D1Database, stats: D1Stats): D1Database {
  // Underlying-statement registry: proxy → {target, sql}.
  const underlying = new WeakMap<object, Underlying>();

  function unwrap(s: D1PreparedStatement): D1PreparedStatement {
    const u = underlying.get(s as unknown as object);
    return u ? u.target : s;
  }

  function sqlOf(s: D1PreparedStatement): string | undefined {
    return underlying.get(s as unknown as object)?.sql;
  }

  function wrapStatement(stmt: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(stmt, {
      get(target, prop, receiver) {
        if (prop === 'bind') {
          return (...args: unknown[]) => {
            // bind() derives a NEW statement; construction only, no execution.
            const bound = (target.bind as (...a: unknown[]) => D1PreparedStatement)(...args);
            return wrapStatement(bound, sql);
          };
        }
        if (prop === 'run' || prop === 'all' || prop === 'first' || prop === 'raw') {
          const method = prop as TerminalMethod;
          return async (...args: unknown[]) => {
            stats.terminalAttempts += 1;
            const bucket = stats.terminalByMethod[method];
            bucket.attempts += 1;
            try {
              const result = await (target[prop] as (...a: unknown[]) => Promise<unknown>)(...args);
              stats.terminalCompleted += 1;
              bucket.completed += 1;
              const record: D1MetaRecord = {
                origin: 'terminal',
                method,
                hasRawMeta: false,
                unavailableReason: 'no_meta_object',
              };
              captureMeta(stats, record, result);
              return result;
            } catch (error) {
              stats.terminalFailed += 1;
              bucket.failed += 1;
              throw error;
            }
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1PreparedStatement;
    underlying.set(proxy as unknown as object, { target: stmt, sql });
    return proxy;
  }

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          // CONSTRUCTION ONLY — never an execution/RPC/query.
          stats.prepares += 1;
          recordShape(stats, sql);
          return wrapStatement(target.prepare(sql), sql);
        };
      }
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          stats.batchAttempts += 1;
          stats.batchStatements += statements.length;
          for (const s of statements) {
            const sql = sqlOf(s);
            if (sql !== undefined) recordShape(stats, sql);
          }
          try {
            // Unwrap to the ORIGINAL underlying statements: the real
            // workerd batch receives exactly what an unwrapped caller
            // would have passed (bind identity preserved).
            const result = await (target.batch as (s: D1PreparedStatement[]) => Promise<unknown>)(
              statements.map(unwrap),
            );
            stats.batchCompleted += 1;
            // R112-03: only a COMPLETED batch's statements count as
            // completed (D1 batch = implicit all-or-nothing transaction).
            stats.batchStatementsCompleted += statements.length;
            if (Array.isArray(result)) {
              stats.batchResultRecords += result.length;
              result.forEach((r, i) => {
                const record: D1MetaRecord = {
                  origin: 'batch',
                  statementIndex: i,
                  hasRawMeta: false,
                  unavailableReason: 'no_meta_object',
                };
                captureMeta(stats, record, r);
              });
            }
            return result;
          } catch (error) {
            stats.batchFailed += 1;
            // A failed (rolled-back) batch contributes ZERO completed
            // statements; its submitted statements remain counted in
            // batchStatements (attempted) and surface through
            // statementsNotConfirmedCompleted (UNKNOWN outcome).
            throw error;
          }
        };
      }
      if (prop === 'exec' || prop === 'withSession') {
        // DECLARED UNSUPPORTED SURFACES: passed through UNINSTRUMENTED.
        // The accepted DbExecutor never exercises them (see file header).
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
}

/** Snapshot helper — a deep-enough copy for per-invocation reporting. */
export function snapshot(stats: D1Stats): Readonly<D1Stats> {
  return {
    prepares: stats.prepares,
    terminalAttempts: stats.terminalAttempts,
    terminalCompleted: stats.terminalCompleted,
    terminalFailed: stats.terminalFailed,
    terminalByMethod: {
      run: { ...stats.terminalByMethod.run },
      all: { ...stats.terminalByMethod.all },
      first: { ...stats.terminalByMethod.first },
      raw: { ...stats.terminalByMethod.raw },
    },
    batchAttempts: stats.batchAttempts,
    batchCompleted: stats.batchCompleted,
    batchFailed: stats.batchFailed,
    batchStatements: stats.batchStatements,
    batchStatementsCompleted: stats.batchStatementsCompleted,
    batchResultRecords: stats.batchResultRecords,
    metaRecords: stats.metaRecords.map((m) => ({ ...m })),
    metaDroppedFromReservoir: stats.metaDroppedFromReservoir,
    metaReservoirLimit: stats.metaReservoirLimit,
    metaAggregates: {
      availableTotal: stats.metaAggregates.availableTotal,
      unavailableTotal: stats.metaAggregates.unavailableTotal,
      presence: { ...stats.metaAggregates.presence },
      sums: { ...stats.metaAggregates.sums },
    },
    shapes: [...stats.shapes],
  };
}
