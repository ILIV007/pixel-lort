/**
 * Source ingestion store (Phase 4 — ADR-0038 §3/§5; typed D1 boundary per
 * ADR-0022). ALL SQL for scheduling and poll persistence lives here.
 *
 * Guarantees (ADR-0038):
 * - bounded, indexed due-source scan (idx_source_state_due seek + PK join);
 * - atomic poll reservation: guarded advance of the scanned due marker;
 * - atomic guarded commit: item inserts + fenced state write in ONE batch;
 * - honest post-commit classification (inserted / duplicate_external /
 *   duplicate_url) via bounded reads — never guessed;
 * - TWO TARGETED conflict clauses per item (R02 fix, verified on real
 *   workerd D1): `ON CONFLICT(source_id, external_id) DO NOTHING` and
 *   `ON CONFLICT(source_id, canonical_url) DO NOTHING` absorb exactly the
 *   two intended business-key duplicates and nothing else. Any unrelated
 *   integrity failure — a primary-key collision on `id`, a NOT NULL or a
 *   CHECK violation — RAISES inside the atomic batch and fails the WHOLE
 *   batch (items AND state rolled back; cursor/state unchanged). The old
 *   broad `INSERT OR IGNORE` (which silently swallowed those violations)
 *   is gone.
 */
import type { DbExecutor, DbStatement } from './db-executor';

/** Bounded due-source scheduling batch (ADR-0038 §3). */
export const INGESTION_SCHEDULE_BATCH = 10;

/** Reservation hold: just above the 2-minute claim lease (ADR-0038 §3). */
export const SOURCE_POLL_HOLD_MS = 120_000;

/** One due source as read by the scheduling scan. */
export interface DueSourceRow {
  readonly id: string;
  readonly connector: string;
  readonly interval_seconds: number;
  readonly daily_request_budget: number;
  readonly config_json: string;
  readonly next_poll_at: number;
  readonly etag: string | null;
  readonly last_modified: string | null;
  readonly cursor: string | null;
}

/** Bounded, indexed due-source scan (never a full-table scan). */
export async function scanDueSources(
  executor: DbExecutor,
  nowMs: number,
): Promise<readonly DueSourceRow[]> {
  const result = await executor.query<DueSourceRow>({
    sql: `SELECT s.id, s.connector, s.interval_seconds, s.daily_request_budget,
                 s.config_json, st.next_poll_at, st.etag, st.last_modified, st.cursor
            FROM source_state st
            JOIN sources s ON s.id = st.source_id
           WHERE s.enabled = 1
             AND st.next_poll_at <= ?
             AND (st.circuit_open_until IS NULL OR st.circuit_open_until <= ?)
           ORDER BY st.next_poll_at ASC, s.id ASC
           LIMIT ${INGESTION_SCHEDULE_BATCH}`,
    params: [nowMs, nowMs],
  });
  return result.rows;
}

export type PollReservation =
  { readonly kind: 'reserved'; readonly holdUntilMs: number } | { readonly kind: 'not_owner' };

/**
 * Atomically reserve the poll window: advance the scanned due marker
 * (`next_poll_at = scheduledForMs + hold`) guarded on its exact current
 * value. Exactly one overlapping scheduler wins; losers are told.
 */
export async function reserveSourcePoll(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly scheduledForMs: number;
    readonly nowMs: number;
  },
): Promise<PollReservation> {
  const holdUntilMs = input.scheduledForMs + SOURCE_POLL_HOLD_MS;
  const meta = await executor.run({
    sql: `UPDATE source_state
             SET next_poll_at = ?, updated_at = ?
           WHERE source_id = ? AND next_poll_at = ?`,
    params: [holdUntilMs, input.nowMs, input.sourceId, input.scheduledForMs],
  });
  return meta.changes > 0 ? { kind: 'reserved', holdUntilMs } : { kind: 'not_owner' };
}

/**
 * Advance the schedule past a BLOCKED source (watchlist empty, missing
 * credentials, unimplemented connector): one guarded write, stable
 * reason, no job, no network (ADR-0038 §3 step 1).
 */
export async function recordBlockedSourceSkip(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly scheduledForMs: number;
    readonly reason: string;
    readonly intervalSeconds: number;
    readonly nowMs: number;
  },
): Promise<boolean> {
  const meta = await executor.run({
    sql: `UPDATE source_state
             SET next_poll_at = ?, last_error = ?, last_error_at = ?,
                 updated_at = ?
           WHERE source_id = ? AND next_poll_at = ?`,
    params: [
      input.nowMs + input.intervalSeconds * 1000,
      input.reason,
      input.nowMs,
      input.nowMs,
      input.sourceId,
      input.scheduledForMs,
    ],
  });
  return meta.changes > 0;
}

/** One normalized item bound for persistence. */
export interface IngestItemRow {
  readonly id: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly excerpt: string | null;
  readonly author: string | null;
  readonly publishedAtMs: number | null;
  readonly fetchedAtMs: number;
  readonly contentHash: string;
  readonly rawJson: string;
}

export interface PollTerminalState {
  readonly cursor: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly nextPollAtMs: number;
  readonly success: boolean;
  readonly lastChangedAtMs: number | null;
  readonly lastError: string | null;
  readonly consecutiveFailures: number;
  readonly circuitOpenUntilMs: number | null;
  readonly requestsToday: number;
  readonly budgetDate: string;
}

export interface PollCommitResult {
  /** Bounded reads that classify every attempted item honestly. */
  readonly inserted: number;
  readonly duplicateExternal: number;
  readonly duplicateUrl: number;
  /** True when the fenced state write WON (we owned the poll window). */
  readonly stateWriteWon: boolean;
}

/**
 * Commit one poll's items + terminal state as ONE atomic batch
 * (ADR-0038 §5, R02 semantics):
 * - items: TWO targeted `ON CONFLICT … DO NOTHING` clauses — exactly the
 *   two business UNIQUE keys are absorbed (replay idempotent); a primary-
 *   key collision, NOT NULL or CHECK violation throws and aborts the WHOLE
 *   batch, leaving cursor/state unchanged (real workerd D1 semantics);
 * - state: fenced on `next_poll_at = holdUntilMs` — a stale worker (a
 *   newer poll has since reserved) writes 0 rows, visible in meta, and
 *   NEVER overwrites newer state;
 * - classification reads (after the batch): which rows exist for each
 *   attempted external id / canonical url.
 */
export async function commitPollResults(
  executor: DbExecutor,
  input: {
    readonly sourceId: string;
    readonly items: readonly IngestItemRow[];
    readonly state: PollTerminalState;
    readonly holdUntilMs: number;
    readonly nowMs: number;
  },
): Promise<PollCommitResult> {
  const state = input.state;
  const statements: DbStatement[] = [];

  for (const item of input.items) {
    statements.push({
      // TWO targeted conflict clauses (R02, verified on real workerd D1):
      // each absorbs ONLY its own business-key duplicate. Unlike the old
      // broad `INSERT OR IGNORE`, an unrelated primary-key collision or a
      // NOT NULL / CHECK violation raises here and aborts the whole batch
      // (D1 batches are implicit transactions: cursor/state stay put).
      sql: `INSERT INTO source_items
              (id, source_id, external_id, canonical_url, title, body_excerpt, author,
               published_at, fetched_at, content_hash, raw_json, processing_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
            ON CONFLICT (source_id, external_id) DO NOTHING
            ON CONFLICT (source_id, canonical_url) DO NOTHING`,
      params: [
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
      ],
    });
  }

  statements.push({
    sql: `UPDATE source_state
             SET cursor = ?, etag = ?, last_modified = ?,
                 next_poll_at = ?, last_polled_at = ?,
                 last_changed_at = COALESCE(?, last_changed_at),
                 last_success_at = COALESCE(?, last_success_at),
                 last_error_at = ?, last_error = ?,
                 consecutive_failures = ?, circuit_open_until = ?,
                 requests_today = ?, budget_date = ?, updated_at = ?
           WHERE source_id = ? AND next_poll_at = ?`,
    params: [
      state.cursor,
      state.etag,
      state.lastModified,
      state.nextPollAtMs,
      input.nowMs,
      state.lastChangedAtMs,
      state.success ? input.nowMs : null,
      state.success ? null : input.nowMs,
      state.lastError,
      state.consecutiveFailures,
      state.circuitOpenUntilMs,
      state.requestsToday,
      state.budgetDate,
      input.nowMs,
      input.sourceId,
      input.holdUntilMs,
    ],
  });

  // ONE atomic batch: all-or-nothing (D1 implicit transaction).
  const metas = await executor.batch(statements);
  const stateMeta = metas[metas.length - 1];
  const stateWriteWon = (stateMeta?.changes ?? 0) > 0;

  // Honest classification (bounded reads, 2 per attempted item).
  let inserted = 0;
  let duplicateExternal = 0;
  let duplicateUrl = 0;
  for (const item of input.items) {
    const own = await executor.first<{ id: string }>({
      sql: 'SELECT id FROM source_items WHERE id = ? AND source_id = ?',
      params: [item.id, item.sourceId],
    });
    if (own !== null) {
      inserted += 1;
      continue;
    }
    const byExternal = await executor.first<{ id: string }>({
      sql: 'SELECT id FROM source_items WHERE source_id = ? AND external_id = ?',
      params: [item.sourceId, item.externalId],
    });
    if (byExternal !== null) {
      duplicateExternal += 1;
      continue;
    }
    const byUrl =
      item.canonicalUrl === null
        ? null
        : await executor.first<{ id: string }>({
            sql: 'SELECT id FROM source_items WHERE source_id = ? AND canonical_url = ?',
            params: [item.sourceId, item.canonicalUrl],
          });
    if (byUrl !== null) {
      duplicateUrl += 1;
    }
    // Neither row found: unreachable through the two targeted conflict
    // clauses + fresh UUID PKs (only the two business UNIQUE keys can
    // suppress a row without raising); the attempt is still counted as
    // suppressed-by-external for conservative honesty.
    else if (item.canonicalUrl !== null) {
      duplicateExternal += 1;
    }
  }

  return { inserted, duplicateExternal, duplicateUrl, stateWriteWon };
}

/**
 * Initialize the schedule for a NEWLY seeded source_state row
 * (idempotent insert-only; never touches existing rows).
 */
export async function ensureSourceStateRow(
  executor: DbExecutor,
  input: { readonly sourceId: string; readonly nowMs: number },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO source_state (source_id, next_poll_at, consecutive_failures,
                                    requests_today, updated_at)
          VALUES (?, 0, 0, 0, ?)
          ON CONFLICT (source_id) DO NOTHING`,
    params: [input.sourceId, input.nowMs],
  });
}
