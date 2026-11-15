-- PIXEL — D1 migration 0006: editorial→post provenance (R1.22 Phase A).
--
-- The admin post pipeline gains a SECOND, explicit content origin: an
-- editorial draft produced by the REAL news pipeline (source item ->
-- editorial.prepare_draft job -> drafts row, ADR-0042) can be converted
-- into an admin post version through the /post_from_draft bridge command.
-- The conversion is HONEST about where its content came from: every
-- editorial-derived version carries a DURABLE, PER-VERSION provenance link
-- to the exact editorial draft (id + version) it was rendered from — never
-- a fabricated telegram update id, never a silent re-import.
--
-- What changes:
--   admin_post_versions.source_update_id becomes NULLABLE. It stays the
--     capture idempotency anchor for CAPTURED versions (exactly as R1.20-R
--     built it); an editorial-DERIVED version has no Telegram capture
--     update, so writing any update id there would be fabrication — the
--     honest state is NULL with the editorial columns populated instead.
--   admin_post_versions gains two nullable provenance columns:
--     editorial_draft_id       the converted drafts.id value.
--     editorial_draft_version  the converted drafts.version value.
--   A table-level CHECK admits EXACTLY ONE origin per version:
--     a captured version has source_update_id set and both editorial
--     columns NULL; an editorial-derived version has both editorial
--     columns set and source_update_id NULL. Neither/both is invalid —
--     the database itself refuses a fabricated or origin-less version.
--   A partial UNIQUE index on (editorial_draft_id, editorial_draft_version)
--     WHERE editorial_draft_id IS NOT NULL makes the bridge idempotent at
--     the storage layer: at most ONE admin post version can ever be derived
--     from ONE editorial draft version — a second conversion attempt (even
--     a concurrent one) fails loudly instead of duplicating the news.
--
-- MECHANICS (SQLite has no ALTER COLUMN): the table is rebuilt in this
-- atomic batch — create the new-shaped table, copy every legacy row with
-- the provenance columns NULL, drop the old table, rename, recreate the
-- existing source-update index, add the new partial unique index. No FK is
-- added (the R1.20-R discipline: cross-table consistency is enforced by the
-- service inside atomic batches, and a deleted editorial draft must never
-- retroactively break reading a published post's history). Legacy rows keep
-- their exact bytes: the copy projects the same columns and nothing else.
--
-- LINEAR MIGRATION PATH (append-only, AGENTS.md §6): 0001 (v1) -> 0002 (v2)
-- -> 0003 (v3) -> 0004 (v4) -> 0005 (v5) -> THIS FILE (v6). Version 6
-- therefore MEANS "ownership present AND admin post present AND the
-- editorial→post provenance present". Remote application is performed
-- exclusively by `wrangler d1 migrations apply` with explicit owner
-- approval — NONE has been requested or executed.

CREATE TABLE admin_post_versions_v6 (
  draft_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  envelope_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  source_update_id INTEGER,
  created_by_user_id INTEGER NOT NULL CHECK (created_by_user_id > 0),
  created_at_ms INTEGER NOT NULL,
  editorial_draft_id TEXT,
  editorial_draft_version INTEGER,
  PRIMARY KEY (draft_id, version),
  -- EXACTLY ONE origin per version: a captured version carries its real
  -- Telegram update id and NULL editorial provenance; an editorial-derived
  -- version carries NULL update id and the COMPLETE editorial pair. Any
  -- mixed/neither shape is a fabrication the database itself refuses.
  CHECK (
    (
      source_update_id IS NOT NULL
      AND editorial_draft_id IS NULL
      AND editorial_draft_version IS NULL
    )
    OR (
      source_update_id IS NULL
      AND editorial_draft_id IS NOT NULL
      AND editorial_draft_version IS NOT NULL
      AND editorial_draft_version >= 1
    )
  )
);

INSERT INTO admin_post_versions_v6
  (draft_id, version, envelope_json, fingerprint, source_update_id,
   created_by_user_id, created_at_ms, editorial_draft_id, editorial_draft_version)
SELECT
  draft_id, version, envelope_json, fingerprint, source_update_id,
  created_by_user_id, created_at_ms, NULL, NULL
FROM admin_post_versions;

DROP TABLE admin_post_versions;

ALTER TABLE admin_post_versions_v6 RENAME TO admin_post_versions;

CREATE INDEX idx_admin_post_versions_source_update
  ON admin_post_versions(source_update_id, created_by_user_id);

CREATE UNIQUE INDEX idx_admin_post_versions_editorial
  ON admin_post_versions(editorial_draft_id, editorial_draft_version)
  WHERE editorial_draft_id IS NOT NULL;

UPDATE schema_metadata
   SET value = '6',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0006_admin_post_editorial_source',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
