/**
 * R1.10.3 DESIGN LAB — candidate SQL for the FIRST Free preview profile
 * (DESIGN-LAB CODE — NOT accepted product source, NOT implemented in the
 * product, NOT authorized for product use; NEXT_GLM_PROMPT_R1_10_3.md
 * step 5).
 *
 * WHAT THIS IS: a parameter-bounded MULTI-ROW insert/select candidate that
 * is exercised on REAL disposable workerd D1 in design-lab/lab-suite.test.ts
 * (semantics parity vs the accepted store) and design-lab/cost-ledger.test.ts
 * (measured cost ledger). It is labeled DESIGN-LAB everywhere; the accepted
 * real-path baselines (T-13: 110 xAPI / 211 STMT) are retained separately
 * with their own provenance and are never replaced by these numbers.
 *
 * THE RETAINED-INSERT PROBLEM (R112-01): the R1.10.2 grouped-read-only
 * design kept the atomic per-item INSERT batch UNCHANGED, so 100 items
 * alone cost ≥ 100 statements + state + budget + probes (measured floor:
 * manager CONTROL + Q-01 = 3 API / 102 STMT before any overhead). The
 * candidate below therefore ALSO rewrites the WRITE side: multi-row
 * INSERT..SELECT statements, chunked to respect BOTH documented limits —
 * "Maximum bound parameters per query: 100" AND "Maximum SQL statement
 * length: 100 KB" (the byte budget is applied CONSERVATIVELY to the SQL
 * text PLUS all bound values, a strictly stronger assumption than the
 * documented row).
 *
 * PRESERVED ACCEPTED PROPERTIES (frozen by R112-04 and the review):
 *  - ONE atomic batch still carries ALL item mutations + the terminal
 *    state write (all-or-nothing; losing fence ⇒ zero items, zero state).
 *  - The two TARGETED conflict clauses are byte-identical
 *    (ON CONFLICT (source_id, external_id) DO NOTHING /
 *     ON CONFLICT (source_id, canonical_url) DO NOTHING). A PRIMARY-KEY
 *    collision, NOT NULL or CHECK violation still RAISES and aborts the
 *    whole batch — never reinterpreted as a silent skip.
 *  - OWNED path (schema 4): EVERY row still passes the ownership
 *    predicate P (durable hold + owner + job identity/claimed/exact
 *    generation) AND the B1 source binding (`v.c1 = ?` — each row's own
 *    source value must equal the authoritative source). In the multi-row
 *    form the predicate is a statement-level WHERE over every VALUES row;
 *    the binds are the SAME per-row values the accepted statement bound,
 *    evaluated against the same durable state inside ONE statement.
 *  - Mixed-source batches are rejected BEFORE any statement executes
 *    (OwnedCommitRejectionError parity).
 *  - Classification: grouped, SOURCE-BOUND probes (see
 *    audit-tools/trace/candidate-classification.ts) preserving per-item
 *    outcome order and all accepted quirks.
 *  - processing_status stays the literal 'new' (no bind needed).
 */

import {
  classifyGrouped,
  type ClassifiedItem,
  type ExecutorLike,
} from '../audit-tools/trace/candidate-classification';

/** Documented D1 limit: "Maximum bound parameters per query | 100". */
export const MAX_BOUND_PARAMS = 100;
/**
 * Documented D1 limit: "Maximum SQL statement length | 100,000 bytes
 * (100 KB)". The retrieved official excerpt (manager-evidence provenance;
 * see free-plan/FREE_PLAN_OFFICIAL_SOURCES.md) applies this row to EACH
 * statement inside a batch, and it constrains the SQL TEXT — NOT the
 * separately transmitted bound values. The budget below is therefore an
 * INTERNAL CONSERVATIVE POLICY (SQL text + ALL bound values ≤ 100 KB),
 * strictly stronger than the documented row; see
 * free-plan/FREE_SAFE_EXECUTION_DESIGN.md §9 for the justification and
 * the remaining payload/CPU risks of that choice.
 */
export const MAX_SQL_STATEMENT_BYTES = 100 * 1024;

/** Columns explicitly bound per item row (processing_status is a literal). */
export const ITEM_VALUE_COLUMNS = [
  'id',
  'source_id',
  'external_id',
  'canonical_url',
  'title',
  'body_excerpt',
  'author',
  'published_at',
  'fetched_at',
  'content_hash',
  'raw_json',
] as const;

export const ITEM_VALUE_COUNT = ITEM_VALUE_COLUMNS.length; // 11

/**
 * Shared binds in the OWNED multi-row statement (P + B1): st.source_id,
 * st.next_poll_at, st.poll_owner_job_id, j.id, j.aggregate_id, j.attempts,
 * column2(=source). Count constant kept for documentation; the planner
 * audits the ACTUAL values (see `ownedSharedGuardBinds`).
 */
export const OWNED_SHARED_BINDS = 7;
/** Shared binds in the LEGACY multi-row statement (none — per-row values only). */
export const LEGACY_SHARED_BINDS = 0;

/**
 * R1.10.3.1: the byte budget is no longer a fixed scaffold estimate. Every
 * chunk is validated against its ACTUAL built SQL text plus the ACTUAL
 * shared guard bind bytes (see planInsertChunks).
 */
export interface StatementByteAudit {
  /** Rows in the audited chunk. */
  readonly rows: number;
  /** UTF-8 bytes of the EXACT SQL text for this chunk size. */
  readonly sqlBytes: number;
  /** UTF-8 bytes of the chunk's own row binds. */
  readonly rowBindBytes: number;
  /** UTF-8 bytes of the shared guard binds (0 for the legacy form). */
  readonly sharedBindBytes: number;
  /** sqlBytes + rowBindBytes + sharedBindBytes — the audited total. */
  readonly totalBytes: number;
}

export interface CandidateItemRow {
  readonly id: string;
  readonly sourceId: string;
  readonly externalId: string | null;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly excerpt: string | null;
  readonly author: string | null;
  readonly publishedAtMs: number | null;
  readonly fetchedAtMs: number;
  readonly contentHash: string;
  readonly rawJson: string;
}

function rowValues(item: CandidateItemRow): unknown[] {
  return [
    item.id,
    item.sourceId,
    item.externalId,
    item.canonicalUrl,
    item.title,
    item.excerpt,
    item.author,
    item.publishedAtMs,
    item.fetchedAtMs,
    item.contentHash,
    item.rawJson,
  ];
}

const TEXT_ENCODER = new TextEncoder();

function bindBytes(value: unknown): number {
  if (typeof value === 'string') return TEXT_ENCODER.encode(value).length;
  return 8; // conservative fixed size for numeric binds
}

export interface InsertChunkPlan {
  /** Rows in each chunk, in order. Chunk sizes VARY (per-chunk validated). */
  readonly chunks: readonly (readonly CandidateItemRow[])[];
  /** Row count of each chunk, in order (diagnostic mirror of `chunks`). */
  readonly rowsPerStatement: readonly number[];
  /** Largest chunk row count (diagnostic). */
  readonly maxRowsPerStatement: number;
  /**
   * What ended the chunking decisions: 'binds' (parameter count), 'bytes'
   * (combined byte budget), 'mixed' (both across chunks), 'none' (every
   * remaining row fit without hitting a limit).
   */
  readonly limitedBy: 'binds' | 'bytes' | 'mixed' | 'none';
  /** ACTUAL per-chunk audits (SQL text + row binds + shared guard binds). */
  readonly statementAudits: readonly StatementByteAudit[];
}

/**
 * Raised BEFORE any statement is built or executed when ONE row cannot fit
 * into a statement by itself under the conservative combined-byte policy.
 * This is the explicit single-oversized-row handling: the WHOLE commit is
 * rejected at plan time (zero statements, zero durable effects — atomic),
 * the row is never truncated, dropped, or silently skipped, and the typed
 * error carries the row identity plus measured bytes for operator-facing
 * failure persistence (future implementation round maps it to the accepted
 * failure-class surface).
 */
export class OversizedRowPlanError extends Error {
  readonly code = 'row_exceeds_statement_budget';
  constructor(
    readonly itemIndex: number,
    readonly itemId: string,
    readonly totalBytes: number,
    readonly budgetBytes: number,
  ) {
    super(
      `item "${itemId}" (index ${itemIndex}) needs ${totalBytes} bytes of SQL text + binds in a single-row statement, exceeding the ${budgetBytes}-byte conservative budget; the whole commit is rejected atomically (no truncation, no silent drop)`,
    );
    this.name = 'OversizedRowPlanError';
  }
}

export interface PlanInsertOptions {
  /**
   * ACTUAL shared guard bind VALUES appended after the row binds (owned
   * form: P + B1 — see ownedSharedGuardBinds). Their bytes are part of
   * every chunk's audit.
   */
  readonly sharedBinds?: readonly unknown[];
  /** Builds the EXACT SQL text for a k-row chunk. */
  readonly buildSql: (k: number) => string;
}

/**
 * R1.10.3.1 CORRECTION (manager counterexample): chunk sizes are decided
 * INDEPENDENTLY for EVERY chunk — a single rows-per-statement value derived
 * from the input prefix is NOT applied blindly to later chunks. Each chunk
 * is built greedily and audited against BOTH limits using its ACTUAL SQL
 * text (built by `options.buildSql(k)`) plus the ACTUAL bind bytes (the
 * chunk's own row binds AND the shared guard binds), so heterogeneous item
 * sizes (e.g. a short-URL prefix followed by percent-encoded CJK URL rows)
 * can never overflow a later statement.
 *
 * Atomicity/fences are untouched: planning happens before any statement is
 * prepared, so a rejection (oversized single row) leaves zero effects.
 */
export function planInsertChunks(
  items: readonly CandidateItemRow[],
  options: PlanInsertOptions,
): InsertChunkPlan {
  const shared = options.sharedBinds ?? [];
  const sharedBindBytes = shared.reduce((acc, v) => acc + bindBytes(v), 0);
  if (items.length === 0) {
    return {
      chunks: [],
      rowsPerStatement: [],
      maxRowsPerStatement: 0,
      limitedBy: 'none',
      statementAudits: [],
    };
  }
  const auditChunk = (rows: readonly CandidateItemRow[]): StatementByteAudit => {
    const sqlBytes = TEXT_ENCODER.encode(options.buildSql(rows.length)).length;
    const rowBindBytes = rows.reduce(
      (acc, item) => acc + rowValues(item).reduce((a, v) => a + bindBytes(v), 0),
      0,
    );
    return {
      rows: rows.length,
      sqlBytes,
      rowBindBytes,
      sharedBindBytes,
      totalBytes: sqlBytes + rowBindBytes + sharedBindBytes,
    };
  };
  const maxRowsByBinds = Math.max(
    1,
    Math.floor((MAX_BOUND_PARAMS - shared.length) / ITEM_VALUE_COUNT),
  );

  const chunks: CandidateItemRow[][] = [];
  const rowsPerStatement: number[] = [];
  const audits: StatementByteAudit[] = [];
  const endedBy: Array<'binds' | 'bytes'> = [];
  let i = 0;
  while (i < items.length) {
    // The chunk's FIRST row must fit ALONE — else explicit rejection.
    let k = 1;
    let audit = auditChunk(items.slice(i, i + k));
    if (audit.totalBytes > MAX_SQL_STATEMENT_BYTES) {
      throw new OversizedRowPlanError(i, items[i].id, audit.totalBytes, MAX_SQL_STATEMENT_BYTES);
    }
    // Greedily extend THIS chunk while BOTH documented limits hold for it.
    while (i + k < items.length) {
      if (k + 1 > maxRowsByBinds) {
        endedBy.push('binds');
        break;
      }
      const nextAudit = auditChunk(items.slice(i, i + k + 1));
      if (nextAudit.totalBytes > MAX_SQL_STATEMENT_BYTES) {
        endedBy.push('bytes');
        break;
      }
      k += 1;
      audit = nextAudit;
    }
    chunks.push(items.slice(i, i + k));
    rowsPerStatement.push(k);
    audits.push(audit);
    i += k;
  }
  const limitedBy: InsertChunkPlan['limitedBy'] =
    endedBy.length === 0
      ? 'none'
      : endedBy.every((v) => v === 'binds')
        ? 'binds'
        : endedBy.every((v) => v === 'bytes')
          ? 'bytes'
          : 'mixed';
  return {
    chunks,
    rowsPerStatement,
    maxRowsPerStatement: Math.max(...rowsPerStatement),
    limitedBy,
    statementAudits: audits,
  };
}

/** VALUES clause rows: (?, ?, ..., ?) repeated k times. */
function valuesClause(k: number): string {
  const row = `(${ITEM_VALUE_COLUMNS.map(() => '?').join(', ')})`;
  return Array.from({ length: k }, () => row).join(', ');
}

/** SQLite default column names for a VALUES table (column1..columnN). */
function valueColumnNames(): string {
  return ITEM_VALUE_COLUMNS.map((_, i) => `column${i + 1}`).join(', ');
}

const TARGETED_CONFLICTS = `ON CONFLICT (source_id, external_id) DO NOTHING
ON CONFLICT (source_id, canonical_url) DO NOTHING`;

/**
 * OWNED multi-row INSERT..SELECT — per-row ownership predicate P as a
 * statement-level WHERE over the VALUES rows + the B1 source binding
 * (`column2 = ?` — the multi-row form of the accepted per-row `? = ?`;
 * column2 IS the row's own source_id value). Provenance: the predicate
 * text is byte-copied from the accepted ITEM_OWNED_INSERT
 * (src/adapters/db/source-ingest-store.ts ≈793–814); only the row source
 * changes from a single VALUES row to the chunked VALUES table. The WHERE
 * clause also disambiguates the UPSERT parsing (SQLite requires a WHERE
 * before ON CONFLICT on an INSERT..SELECT).
 *
 * NOTE (measured): SQLite does NOT support a column-alias list on a
 * VALUES table (`(VALUES …) AS v(c0,c1)` is a syntax error), so the
 * statements reference the engine's DEFAULT names column1..column11.
 */
export function buildOwnedMultiRowInsertSql(k: number): string {
  return `INSERT INTO source_items
              (id, source_id, external_id, canonical_url, title, body_excerpt, author,
               published_at, fetched_at, content_hash, raw_json, processing_status)
            SELECT ${valueColumnNames()}, 'new'
              FROM (VALUES ${valuesClause(k)})
             WHERE EXISTS (
                   SELECT 1 FROM source_state st
                    WHERE st.source_id = ?
                      AND st.next_poll_at = ?
                      AND st.poll_owner_job_id = ?
                   )
               AND EXISTS (
                   SELECT 1 FROM jobs j
                    WHERE j.id = ?
                      AND j.type = 'sources.fetch_poll'
                      AND j.aggregate_type = 'source'
                      AND j.aggregate_id = ?
                      AND j.status = 'claimed'
                      AND j.attempts = ?
                   )
               AND column2 = ?
            ${TARGETED_CONFLICTS}`;
}

/**
 * LEGACY multi-row INSERT (schema-3 accepted path shape — no ownership
 * predicate, matching the accepted legacy INSERT with its two targeted
 * conflict clauses; provenance: commitPollResults ≈192–197). `WHERE true`
 * disambiguates the UPSERT parsing (mandatory on an INSERT..SELECT whose
 * SELECT carries no other WHERE).
 */
export function buildLegacyMultiRowInsertSql(k: number): string {
  return `INSERT INTO source_items
              (id, source_id, external_id, canonical_url, title, body_excerpt, author,
               published_at, fetched_at, content_hash, raw_json, processing_status)
            SELECT ${valueColumnNames()}, 'new'
              FROM (VALUES ${valuesClause(k)})
            WHERE true
            ${TARGETED_CONFLICTS}`;
}

/**
 * C-last OWNERSHIP-FENCED terminal state write — VERBATIM copy of the
 * accepted C_OWNED_STATE_WRITE (provenance:
 * src/adapters/db/source-ingest-store.ts ≈754–774). The candidate NEVER
 * alters the fence; a losing fence rolls back the WHOLE batch.
 */
export const C_OWNED_STATE_WRITE = `UPDATE source_state
           SET cursor = ?, etag = ?, last_modified = ?,
               next_poll_at = ?, last_polled_at = ?,
               last_changed_at = COALESCE(?, last_changed_at),
               last_success_at = COALESCE(?, last_success_at),
               last_error_at = ?, last_error = ?,
               consecutive_failures = ?, circuit_open_until = ?,
               requests_today = ?, budget_date = ?,
               poll_owner_job_id = NULL, updated_at = ?
         WHERE source_id = ?
           AND next_poll_at = ?
           AND poll_owner_job_id = ?
           AND EXISTS (
                 SELECT 1 FROM jobs j
                  WHERE j.id = ?
                    AND j.type = 'sources.fetch_poll'
                    AND j.aggregate_type = 'source'
                    AND j.aggregate_id = ?
                    AND j.status = 'claimed'
                    AND j.attempts = ?
               )`;

/**
 * LEGACY fenced terminal state write — VERBATIM copy of the accepted
 * legacy UPDATE (provenance: commitPollResults ≈214–223).
 */
export const LEGACY_STATE_WRITE = `UPDATE source_state
             SET cursor = ?, etag = ?, last_modified = ?,
                 next_poll_at = ?, last_polled_at = ?,
                 last_changed_at = COALESCE(?, last_changed_at),
                 last_success_at = COALESCE(?, last_success_at),
                 last_error_at = ?, last_error = ?,
                 consecutive_failures = ?, circuit_open_until = ?,
                 requests_today = ?, budget_date = ?, updated_at = ?
           WHERE source_id = ? AND next_poll_at = ?`;

/** Minimal statement shape the candidate executes through. */
export type CandidateExecutor = {
  prepare(sql: string): {
    bind(...values: unknown[]): unknown;
  };
  batch(statements: unknown[]): Promise<{ changes?: number }[]>;
};

export interface OwnedCommitInput {
  readonly sourceId: string;
  readonly jobId: string;
  readonly generation: number;
  readonly observedHoldUntilMs: number;
  readonly items: readonly CandidateItemRow[];
  readonly state: Record<string, unknown>;
  readonly nowMs: number;
}

/** Rejection raised BEFORE any statement when attribution mismatches. */
export class CandidateOwnedRejectionError extends Error {
  readonly code = 'item_source_mismatch';
  constructor(message: string) {
    super(message);
    this.name = 'CandidateOwnedRejectionError';
  }
}

/**
 * The ACTUAL shared guard bind values (P + B1) appended after every chunk's
 * row binds, in the order the owned statement's guard placeholders appear.
 * The planner audits these BYTES together with each chunk's row binds.
 */
export function ownedSharedGuardBinds(input: OwnedCommitInput): unknown[] {
  return [
    input.sourceId,
    input.observedHoldUntilMs,
    input.jobId,
    input.jobId,
    input.sourceId,
    input.generation,
    // B1 (multi-row form): every row's own source value = authoritative.
    input.sourceId,
  ];
}

/**
 * R1.10.3.1 defense-in-depth: re-audit ONE fully built statement (exact SQL
 * text + the EXACT binds that will be sent, including shared guards) so a
 * planner/builder drift can never reach the engine. Runs before prepare().
 */
function assertStatementWithinBudget(sql: string, binds: readonly unknown[]): void {
  const audit = statementByteAudit(sql, binds);
  if (audit.totalBytes > MAX_SQL_STATEMENT_BYTES) {
    throw new OversizedRowPlanError(
      -1,
      '(built statement)',
      audit.totalBytes,
      MAX_SQL_STATEMENT_BYTES,
    );
  }
  if (binds.length > MAX_BOUND_PARAMS) {
    throw new Error(
      `statement binds ${binds.length} exceed the documented ${MAX_BOUND_PARAMS}-parameter limit`,
    );
  }
}

function ownedStateBinds(input: OwnedCommitInput): unknown[] {
  const s = input.state as Record<string, unknown>;
  return [
    s.cursor,
    s.etag,
    s.lastModified,
    s.nextPollAtMs,
    input.nowMs,
    s.lastChangedAtMs,
    s.success ? input.nowMs : null,
    s.success ? null : input.nowMs,
    s.lastError,
    s.consecutiveFailures,
    s.circuitOpenUntilMs,
    s.requestsToday,
    s.budgetDate,
    input.nowMs,
    input.sourceId,
    input.observedHoldUntilMs,
    input.jobId,
    input.jobId,
    input.sourceId,
    input.generation,
  ];
}

/**
 * Candidate OWNED commit: ONE atomic batch of multi-row INSERT..SELECT
 * statements + the verbatim fenced state write; then grouped source-bound
 * classification. Parity surface = the accepted commitOwnedPollResults.
 */
export async function commitOwnedPollResultsCandidate(
  executor: CandidateExecutor,
  input: OwnedCommitInput,
): Promise<{
  inserted: number;
  duplicateExternal: number;
  duplicateUrl: number;
  stateWriteWon: boolean;
  plan: InsertChunkPlan;
  classified: readonly ClassifiedItem[];
}> {
  // B1 pre-execution rejection — byte-equal semantics to the accepted store.
  for (const item of input.items) {
    if (item.sourceId !== input.sourceId) {
      throw new CandidateOwnedRejectionError(
        `item "${item.id}" is attributed to source "${item.sourceId}", but authority for this commit is source "${input.sourceId}" — the whole operation is rejected`,
      );
    }
  }

  const plan = planInsertChunks(input.items, {
    sharedBinds: ownedSharedGuardBinds(input),
    buildSql: buildOwnedMultiRowInsertSql,
  });
  const statements: unknown[] = [];
  for (const chunk of plan.chunks) {
    const sql = buildOwnedMultiRowInsertSql(chunk.length);
    const binds: unknown[] = [];
    for (const item of chunk) binds.push(...rowValues(item));
    binds.push(...ownedSharedGuardBinds(input));
    // R1.10.3.1: every built statement is re-audited before prepare().
    assertStatementWithinBudget(sql, binds);
    statements.push(executor.prepare(sql).bind(...binds));
  }
  statements.push(executor.prepare(C_OWNED_STATE_WRITE).bind(...ownedStateBinds(input)));

  const metas = await executor.batch(statements);
  // RAW D1 batch results expose `meta.changes` (the accepted DbExecutor
  // normalizes this; the candidate reads the raw shape directly).
  const stateMeta = metas[metas.length - 1] as
    { changes?: number; meta?: { changes?: number } } | undefined;
  const stateWriteWon = (stateMeta?.changes ?? stateMeta?.meta?.changes ?? 0) > 0;

  const classified = await classifyGrouped(executor as unknown as ExecutorLike, input.items);
  const inserted = classified.filter((c) => c.outcome === 'inserted').length;
  const duplicateExternal = classified.filter((c) => c.outcome === 'duplicateExternal').length;
  const duplicateUrl = classified.filter((c) => c.outcome === 'duplicateUrl').length;
  return { inserted, duplicateExternal, duplicateUrl, stateWriteWon, plan, classified };
}

export interface LegacyCommitInput {
  readonly sourceId: string;
  readonly items: readonly CandidateItemRow[];
  readonly state: Record<string, unknown>;
  readonly holdUntilMs: number;
  readonly nowMs: number;
}

function legacyStateBinds(input: LegacyCommitInput): unknown[] {
  const s = input.state as Record<string, unknown>;
  return [
    s.cursor,
    s.etag,
    s.lastModified,
    s.nextPollAtMs,
    input.nowMs,
    s.lastChangedAtMs,
    s.success ? input.nowMs : null,
    s.success ? null : input.nowMs,
    s.lastError,
    s.consecutiveFailures,
    s.circuitOpenUntilMs,
    s.requestsToday,
    s.budgetDate,
    input.nowMs,
    input.sourceId,
    input.holdUntilMs,
  ];
}

/**
 * Candidate LEGACY commit (schema-3): ONE atomic batch of multi-row
 * INSERTs + the verbatim legacy state write. A losing legacy fence keeps
 * the accepted semantics EXACTLY: items persist, stateWriteWon=false
 * (never reinterpreted).
 */
export async function commitPollResultsCandidate(
  executor: CandidateExecutor,
  input: LegacyCommitInput,
): Promise<{
  inserted: number;
  duplicateExternal: number;
  duplicateUrl: number;
  stateWriteWon: boolean;
  plan: InsertChunkPlan;
  classified: readonly ClassifiedItem[];
}> {
  const plan = planInsertChunks(input.items, {
    sharedBinds: [],
    buildSql: buildLegacyMultiRowInsertSql,
  });
  const statements: unknown[] = [];
  for (const chunk of plan.chunks) {
    const sql = buildLegacyMultiRowInsertSql(chunk.length);
    const binds: unknown[] = [];
    for (const item of chunk) binds.push(...rowValues(item));
    // R1.10.3.1: every built statement is re-audited before prepare().
    assertStatementWithinBudget(sql, binds);
    statements.push(executor.prepare(sql).bind(...binds));
  }
  statements.push(executor.prepare(LEGACY_STATE_WRITE).bind(...legacyStateBinds(input)));

  const metas = await executor.batch(statements);
  // RAW D1 batch results expose `meta.changes` (see the owned commit note).
  const stateMeta = metas[metas.length - 1] as
    { changes?: number; meta?: { changes?: number } } | undefined;
  const stateWriteWon = (stateMeta?.changes ?? stateMeta?.meta?.changes ?? 0) > 0;

  const classified = await classifyGrouped(executor as unknown as ExecutorLike, input.items);
  const inserted = classified.filter((c) => c.outcome === 'inserted').length;
  const duplicateExternal = classified.filter((c) => c.outcome === 'duplicateExternal').length;
  const duplicateUrl = classified.filter((c) => c.outcome === 'duplicateUrl').length;
  return { inserted, duplicateExternal, duplicateUrl, stateWriteWon, plan, classified };
}

/**
 * Byte audit of ONE prepared statement (diagnostic for the ledger): SQL
 * text length + total bind bytes, proving the conservative budget held.
 */
export function statementByteAudit(
  sql: string,
  binds: readonly unknown[],
): { sqlBytes: number; bindBytes: number; totalBytes: number } {
  const sqlBytes = TEXT_ENCODER.encode(sql).length;
  const bindsBytes = binds.reduce((acc, v) => acc + bindBytes(v), 0);
  return { sqlBytes, bindBytes: bindsBytes, totalBytes: sqlBytes + bindsBytes };
}
