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

import { classifyGrouped, type ClassifiedItem, type ExecutorLike } from '../audit-tools/trace/candidate-classification';

/** Documented D1 limit: "Maximum bound parameters per query | 100". */
export const MAX_BOUND_PARAMS = 100;
/** Documented D1 limit: "Maximum SQL statement length | 100 KB". */
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

/** Shared binds in the OWNED multi-row statement (P + B1). */
export const OWNED_SHARED_BINDS = 7; // st.source_id, st.next_poll_at, st.poll_owner_job_id, j.id, j.aggregate_id, j.attempts, column2(=source)
/** Shared binds in the LEGACY multi-row statement (none — per-row values only). */
export const LEGACY_SHARED_BINDS = 0;

/**
 * Conservative scaffold overhead per statement (placeholders, keywords,
 * VALUES syntax, conflict clauses) measured from the builder output and
 * padded. The byte budget = MAX_SQL_STATEMENT_BYTES − scaffold − Σ binds.
 */
export const SCAFFOLD_BYTES = 2048;

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
  /** Rows in this chunk (last chunk may be smaller). */
  readonly chunks: readonly CandidateItemRow[][];
  /** Rows per statement used by the plan (diagnostic; last chunk may differ). */
  readonly rowsPerStatement: number;
  readonly limitedBy: 'binds' | 'bytes' | 'single';
}

/**
 * Chunk items into multi-row INSERT statements under BOTH documented
 * limits. At least one row per statement (a single oversized item is still
 * attempted — the statement-length row documents the actual size).
 */
export function planInsertChunks(
  items: readonly CandidateItemRow[],
  sharedBinds: number,
): InsertChunkPlan {
  if (items.length === 0) return { chunks: [], rowsPerStatement: 0, limitedBy: 'single' };
  const maxByBinds = Math.max(1, Math.floor((MAX_BOUND_PARAMS - sharedBinds) / ITEM_VALUE_COUNT));
  // Byte-bound rows: measure cumulatively with the shared scaffold once.
  let maxByBytes = 0;
  {
    let total = SCAFFOLD_BYTES;
    for (const item of items) {
      const rowBytes = rowValues(item).reduce((acc, v) => acc + bindBytes(v), 0);
      if (total + rowBytes > MAX_SQL_STATEMENT_BYTES) break;
      total += rowBytes;
      maxByBytes += 1;
    }
    if (maxByBytes === 0) maxByBytes = 1; // oversized single row still attempted
  }
  const rowsPerStatement = Math.min(maxByBinds, maxByBytes);
  const limitedBy = maxByBytes < maxByBinds ? 'bytes' : 'binds';
  const chunks: CandidateItemRow[][] = [];
  for (let i = 0; i < items.length; i += rowsPerStatement) {
    chunks.push(items.slice(i, i + rowsPerStatement));
  }
  return { chunks, rowsPerStatement, limitedBy };
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

  const plan = planInsertChunks(input.items, OWNED_SHARED_BINDS);
  const statements: unknown[] = [];
  for (const chunk of plan.chunks) {
    const sql = buildOwnedMultiRowInsertSql(chunk.length);
    const binds: unknown[] = [];
    for (const item of chunk) binds.push(...rowValues(item));
    binds.push(
      input.sourceId,
      input.observedHoldUntilMs,
      input.jobId,
      input.jobId,
      input.sourceId,
      input.generation,
      // B1 (multi-row form): every row's own source value = authoritative.
      input.sourceId,
    );
    statements.push(executor.prepare(sql).bind(...binds));
  }
  statements.push(executor.prepare(C_OWNED_STATE_WRITE).bind(...ownedStateBinds(input)));

  const metas = await executor.batch(statements);
  // RAW D1 batch results expose `meta.changes` (the accepted DbExecutor
  // normalizes this; the candidate reads the raw shape directly).
  const stateMeta = metas[metas.length - 1] as
    | { changes?: number; meta?: { changes?: number } }
    | undefined;
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
  const plan = planInsertChunks(input.items, LEGACY_SHARED_BINDS);
  const statements: unknown[] = [];
  for (const chunk of plan.chunks) {
    const sql = buildLegacyMultiRowInsertSql(chunk.length);
    const binds: unknown[] = [];
    for (const item of chunk) binds.push(...rowValues(item));
    statements.push(executor.prepare(sql).bind(...binds));
  }
  statements.push(executor.prepare(LEGACY_STATE_WRITE).bind(...legacyStateBinds(input)));

  const metas = await executor.batch(statements);
  // RAW D1 batch results expose `meta.changes` (see the owned commit note).
  const stateMeta = metas[metas.length - 1] as
    | { changes?: number; meta?: { changes?: number } }
    | undefined;
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
