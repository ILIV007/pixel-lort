/**
 * The ALBUM DRAFT STORE (the ADR-0060 carry closed): the durable write half
 * of the album draft producer over the blueprint-approved `drafts` table
 * (schema 6 — consumed, ZERO DDL).
 *
 * House discipline (the editorial/8.2 store rules, unchanged):
 * - parameterized SQL ONLY (values never logged; the DbExecutor contract);
 * - the draft row is the scheduler's send-side input: the album document
 *   rides `document_json` EXACTLY as the strict reader expects (the
 *   serialized bytes the producer derived — never a re-shape here);
 * - every outcome is honest: a PK conflict is `duplicate_draft_id`, the
 *   UNIQUE(story_id, version) race is `version_conflict` — surfaced typed,
 *   never swallowed, never a silent overwrite.
 */

import type { DbExecutor } from './db-executor';
import { isAppError } from '../../shared/errors/app-error';

/** The bounded identifier/title shapes (the drafts-table column realities). */
export const ALBUM_DRAFT_ID_MAX_UNITS = 128;
export const ALBUM_DRAFT_TITLE_MAX_UNITS = 300;
export const ALBUM_DRAFT_ACTOR_MAX_UNITS = 128;

export type InsertAlbumDraftOutcome =
  | { readonly kind: 'created' }
  | { readonly kind: 'duplicate_draft_id' }
  | { readonly kind: 'version_conflict' };

/**
 * The story's current max draft version (0 when the story has no drafts).
 * One bounded read over the story's own rows; the UNIQUE(story_id, version)
 * fence is the authority — a racing producer's insert conflicts typed.
 */
export async function findMaxDraftVersion(
  executor: DbExecutor,
  storyId: string,
): Promise<number | null> {
  if (typeof storyId !== 'string' || storyId.length === 0) return null;
  const row = await executor.first<{ readonly maxVersion: number | null }>({
    sql: `SELECT MAX(version) AS maxVersion FROM drafts WHERE story_id = ?`,
    params: [storyId],
  });
  return row?.maxVersion ?? null;
}

export interface AlbumDraftInsertInput {
  readonly id: string;
  readonly storyId: string;
  readonly title: string;
  readonly documentJson: string;
  readonly createdBy: string;
  readonly version: number;
  readonly nowMs: number;
}

/**
 * Insert ONE album draft row (status 'ready' — the machine mints no
 * approval; the language is the channel's Persian; the layout marks the
 * album kind for the honest read-side). The document JSON is stored
 * VERBATIM (the producer's serialized bytes — the fingerprint's anchor).
 */
export async function insertAlbumDraft(
  executor: DbExecutor,
  input: AlbumDraftInsertInput,
): Promise<InsertAlbumDraftOutcome> {
  try {
    await executor.run({
      sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
              facts_json, warnings_json, version, created_by, created_at, updated_at)
            VALUES (?, ?, 'ready', 'fa', 'album', ?, ?, '[]', '[]', ?, ?, ?, ?)`,
      params: [
        input.id,
        input.storyId,
        input.title,
        input.documentJson,
        input.version,
        input.createdBy,
        input.nowMs,
        input.nowMs,
      ],
    });
    return { kind: 'created' };
  } catch (error) {
    if (isAppError(error) && error.code === 'db_constraint_violation') {
      // Which fence fired? The PK (a duplicate id) vs the story+version
      // UNIQUE (a racing producer) — the honest distinction.
      const existing = await executor.first<{ readonly version: number }>({
        sql: `SELECT version FROM drafts WHERE id = ?`,
        params: [input.id],
      });
      if (existing) return { kind: 'duplicate_draft_id' };
      return { kind: 'version_conflict' };
    }
    throw error;
  }
}
