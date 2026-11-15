/**
 * Editorial-review query adapter (R1.18 — ADR-0046): the ONLY editorial SQL
 * the read-only `/drafts` surface may execute.
 *
 * STRICT READ-ONLY DISCIPLINE:
 * - exactly TWO statement shapes exist here: the bounded ready-list probe
 *   and the byte-guarded PK detail lookup. Both are SELECTs; there is no
 *   INSERT/UPDATE/DELETE and no DDL anywhere in this module.
 * - The list NEVER loads `document_json`/`facts_json` and never counts all
 *   rows: ONE parameterized, INDEXED SELECT with a LIMIT of 6 — five visible
 *   rows plus one extra probe row that only establishes `more_available`
 *   (no COUNT(*), no OFFSET, no pagination machinery).
 * - Deterministic order BEFORE the limit: `ORDER BY created_at DESC` over
 *   `idx_drafts_status_time (status, created_at DESC)` — verified with a
 *   real EXPLAIN to be a pure index search (no temp B-tree, no full scan).
 *   Equal timestamps resolve in the index's implicit SQLite rowid tie order
 *   (stable per database state) — the tie-break explicitly allowed for this
 *   first-page query; rowid is NOT a public/business identity and never
 *   leaves this module.
 * - The detail lookup binds the validated opaque id as ONE parameter
 *   (never SQL structure) and applies a SQL byte-length guard so an
 *   oversized foreign row is never fully transferred: the document column
 *   is projected ONLY when it fits the budget; otherwise the caller gets
 *   the measured byte size with a NULL document and renders the typed
 *   too-large state. `length(CAST(x AS BLOB))` measures UTF-8 bytes.
 * - Projected text columns are bounded in SQL (substr on characters) so a
 *   hostile oversized title cannot dominate the transfer.
 */
import type { DbExecutor } from './db-executor';

/** Visible rows per ready-list page. */
export const REVIEW_LIST_VISIBLE_ROWS = 5;
/** Probe limit (visible + 1) — establishes `more_available` without COUNT(*). */
export const REVIEW_LIST_PROBE_LIMIT = REVIEW_LIST_VISIBLE_ROWS + 1;
/** Character bound of the projected list/detail title (SQLite substr). */
export const REVIEW_TITLE_PROJECTION_CHARS = 200;
/** UTF-8 byte budget for a transferable detail document (128 KiB). */
export const REVIEW_DETAIL_DOCUMENT_MAX_BYTES = 128 * 1024;

export interface EditorialReviewDraftListRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly createdAt: number;
}

export interface EditorialReviewDraftDetailRow {
  readonly id: string;
  readonly storyId: string;
  readonly status: string;
  readonly version: number;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Measured UTF-8 byte size of the stored document_json. */
  readonly documentBytes: number;
  /** The document ONLY when it fits the byte budget; null otherwise. */
  readonly documentJson: string | null;
}

export interface EditorialReviewStore {
  /**
   * ONE bounded indexed SELECT for the ready first page. Returns AT MOST
   * `REVIEW_LIST_PROBE_LIMIT` rows; callers show the first
   * `REVIEW_LIST_VISIBLE_ROWS` and report `moreAvailable` from the probe.
   */
  listReadyFirstPage(): Promise<{
    readonly rows: readonly EditorialReviewDraftListRow[];
    readonly moreAvailable: boolean;
  }>;
  /**
   * ONE parameterized PK SELECT with the SQL byte guard. Returns null when
   * no row has this exact id (not_found is the CALLER's typed state — never
   * conflated here with a storage failure, which throws).
   */
  findDraftDetail(
    draftId: string,
    documentByteBudget?: number,
  ): Promise<EditorialReviewDraftDetailRow | null>;
}

interface DraftListRawRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly created_at: number;
}

interface DraftDetailRawRow {
  readonly id: string;
  readonly story_id: string;
  readonly status: string;
  readonly version: number;
  readonly title: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly document_bytes: number;
  readonly document_json_bounded: string | null;
}

/**
 * The exact list statement shape — exported ONLY for the EXPLAIN evidence
 * test (the plan must stay a pure index search with no temp B-tree).
 */
export const REVIEW_LIST_SQL =
  'SELECT id, substr(title, 1, ' +
  String(REVIEW_TITLE_PROJECTION_CHARS) +
  ') AS title, status, created_at FROM drafts WHERE status = ? ORDER BY created_at DESC LIMIT ' +
  String(REVIEW_LIST_PROBE_LIMIT);

/** The exact detail statement shape (EXPLAIN evidence + byte-guard audit). */
export const REVIEW_DETAIL_SQL_HEAD =
  'SELECT id, story_id, status, version, substr(title, 1, ' +
  String(REVIEW_TITLE_PROJECTION_CHARS) +
  ') AS title, created_at, updated_at, length(CAST(document_json AS BLOB)) AS document_bytes, ' +
  'CASE WHEN length(CAST(document_json AS BLOB)) <= ? THEN document_json ELSE NULL END AS document_json_bounded ' +
  'FROM drafts WHERE id = ?';

export function createEditorialReviewStore(executor: DbExecutor): EditorialReviewStore {
  async function listReadyFirstPage(): Promise<{
    readonly rows: readonly EditorialReviewDraftListRow[];
    readonly moreAvailable: boolean;
  }> {
    // ONE parameterized, indexed, LIMIT-bounded SELECT — no JSON columns.
    const result = await executor.query<DraftListRawRow>({
      sql: REVIEW_LIST_SQL,
      params: ['ready'],
    });
    const rows = result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
    }));
    // The extra probe row only establishes has-more; it is never shown.
    const moreAvailable = rows.length > REVIEW_LIST_VISIBLE_ROWS;
    return {
      rows: moreAvailable ? rows.slice(0, REVIEW_LIST_VISIBLE_ROWS) : rows,
      moreAvailable,
    };
  }

  async function findDraftDetail(
    draftId: string,
    documentByteBudget: number = REVIEW_DETAIL_DOCUMENT_MAX_BYTES,
  ): Promise<EditorialReviewDraftDetailRow | null> {
    // ONE parameterized PK lookup; the byte guard keeps an oversized
    // document from ever being transferred before the caller decides.
    const row = await executor.first<DraftDetailRawRow>({
      sql: REVIEW_DETAIL_SQL_HEAD,
      params: [documentByteBudget, draftId],
    });
    if (row === null) {
      return null;
    }
    return {
      id: row.id,
      storyId: row.story_id,
      status: row.status,
      version: row.version,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      documentBytes: row.document_bytes,
      documentJson: row.document_json_bounded,
    };
  }

  return { listReadyFirstPage, findDraftDetail };
}
