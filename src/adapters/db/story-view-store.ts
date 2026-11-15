/**
 * Story-view query adapter (Phase 9B — the read-only `/story` surface):
 * the ONLY story SQL that surface may execute.
 *
 * STRICT READ-ONLY DISCIPLINE (the R1.18 house shape):
 * - exactly TWO statement shapes exist here, both SELECTs; there is no
 *   INSERT/UPDATE/DELETE and no DDL anywhere in this module.
 * - The identity lookup binds the validated opaque id as ONE parameter
 *   (never SQL structure) over the stories PRIMARY KEY; the headline is
 *   projected bounded in SQL (substr on characters) so a hostile oversized
 *   headline cannot dominate the transfer. No editorial draft content is
 *   ever read by this module.
 * - The per-story publications list is ONE parameterized, INDEXED SELECT
 *   over `idx_publications_story (story_id, created_at DESC)` with a LIMIT
 *   of 9 — eight visible rows plus one extra probe row that only
 *   establishes `more_available` (no COUNT(*), no OFFSET, no pagination
 *   machinery). Deterministic order BEFORE the limit; equal timestamps
 *   resolve in the index's implicit tie order — the tie-break explicitly
 *   allowed for this first-page query.
 * - Drafts are NEVER read here: NO index exists on `drafts.story_id`, so a
 *   per-story drafts listing would be a full table scan — the honest
 *   bounded-read boundary recorded in docs/reviews/PHASE_9B_STORY_SCREEN.md.
 */
import type { DbExecutor } from './db-executor';
import type { StoryViewPublicationRow, StoryViewRow } from '../../admin/story-command';
import {
  STORY_PUBLICATIONS_PROBE_LIMIT,
  STORY_PUBLICATIONS_VISIBLE_LIMIT,
} from '../../admin/story-command';

/** Character bound of the projected working headline (SQLite substr). */
export const STORY_HEADLINE_PROJECTION_CHARS = 200;

/**
 * The exact identity statement shape — exported ONLY for the EXPLAIN
 * evidence test (the plan must stay a pure index search with no temp
 * B-tree and no full scan) and the SQL-audit tests.
 */
export const STORY_VIEW_SQL =
  'SELECT id, story_key, status, trust_status, content_type, priority, confidence, ' +
  'substr(working_headline, 1, ' +
  String(STORY_HEADLINE_PROJECTION_CHARS) +
  ') AS working_headline_bounded, first_seen_at, last_evidence_at, last_published_at, ' +
  'version, merged_into_story_id, created_at, updated_at FROM stories WHERE id = ?';

/** The exact per-story publications statement shape (EXPLAIN evidence too). */
export const STORY_PUBLICATIONS_SQL =
  'SELECT id, status, priority, attempts, max_attempts, last_error, created_at, published_at ' +
  'FROM publications WHERE story_id = ? ORDER BY created_at DESC LIMIT ' +
  String(STORY_PUBLICATIONS_PROBE_LIMIT);

interface StoryViewRawRow {
  readonly id: string;
  readonly story_key: string;
  readonly status: string;
  readonly trust_status: string;
  readonly content_type: string;
  readonly priority: number;
  readonly confidence: number;
  readonly working_headline_bounded: string | null;
  readonly first_seen_at: number;
  readonly last_evidence_at: number;
  readonly last_published_at: number | null;
  readonly version: number;
  readonly merged_into_story_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface StoryPublicationRawRow {
  readonly id: string;
  readonly status: string;
  readonly priority: number;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly published_at: number | null;
}

export interface StoryViewStore {
  /**
   * ONE parameterized PK SELECT with the bounded headline projection.
   * Returns null when no story has this exact id (not_found is the
   * CALLER's typed state — never conflated here with a storage failure,
   * which throws).
   */
  findStoryViewRow(storyId: string): Promise<StoryViewRow | null>;
  /**
   * ONE bounded indexed SELECT for the story's publication history. Returns
   * AT MOST `STORY_PUBLICATIONS_PROBE_LIMIT` rows; callers show the first
   * `STORY_PUBLICATIONS_VISIBLE_LIMIT` and report `moreAvailable` from the
   * probe.
   */
  listStoryPublications(storyId: string): Promise<{
    readonly rows: readonly StoryViewPublicationRow[];
    readonly moreAvailable: boolean;
  }>;
}

export function createStoryViewStore(executor: DbExecutor): StoryViewStore {
  async function findStoryViewRow(storyId: string): Promise<StoryViewRow | null> {
    const row = await executor.first<StoryViewRawRow>({
      sql: STORY_VIEW_SQL,
      params: [storyId],
    });
    if (row === null) {
      return null;
    }
    return {
      id: row.id,
      storyKey: row.story_key,
      status: row.status,
      trustStatus: row.trust_status,
      contentType: row.content_type,
      priority: row.priority,
      confidence: row.confidence,
      workingHeadline: row.working_headline_bounded,
      firstSeenAt: row.first_seen_at,
      lastEvidenceAt: row.last_evidence_at,
      lastPublishedAt: row.last_published_at,
      version: row.version,
      mergedIntoStoryId: row.merged_into_story_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function listStoryPublications(storyId: string): Promise<{
    readonly rows: readonly StoryViewPublicationRow[];
    readonly moreAvailable: boolean;
  }> {
    const result = await executor.query<StoryPublicationRawRow>({
      sql: STORY_PUBLICATIONS_SQL,
      params: [storyId],
    });
    const rows = result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      priority: row.priority,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      lastError: row.last_error,
      createdAt: row.created_at,
      publishedAt: row.published_at,
    }));
    // The extra probe row only establishes has-more; it is never shown.
    const moreAvailable = rows.length > STORY_PUBLICATIONS_VISIBLE_LIMIT;
    return {
      rows: moreAvailable ? rows.slice(0, STORY_PUBLICATIONS_VISIBLE_LIMIT) : rows,
      moreAvailable,
    };
  }

  return { findStoryViewRow, listStoryPublications };
}
