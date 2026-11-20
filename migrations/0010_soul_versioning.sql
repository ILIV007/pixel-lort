-- PIXEL — D1 migration 0010: Soul v1 versioning (slice 8).
--
-- The owner-ordered first-posts slice needs the DESIGN §9.3 Soul policy
-- made durable: the Pixel persona lives in a VERSIONED document, the
-- version is recorded in D1, and every published post carries the
-- `soul_version` it was published under.
--
--   souls               ONE row per Soul version: the full persona text,
--                       its SHA-256 (the repo file docs/soul/SOUL_v1.md
--                       is canonical; the stored text must hash to the
--                       recorded value), the creator and the timestamp.
--                       Versions are append-only: a Soul change is a NEW
--                       row, never an edit of a published version.
--   settings            key `soul.current_version` points at the ACTIVE
--                       version (JSON {"version": N, ...}); the pointer
--                       is written by the operator seed step, not by this
--                       migration — a database with souls rows but no
--                       pointer resolves to the highest version, and a
--                       database with no souls rows resolves to NULL.
--   published_posts     new NULLABLE column `soul_version` (NULL = legacy
--                       row published before Soul versioning; a stamped
--                       row carries a positive integer). The inbound
--                       publish path stamps it; the admin-post path does
--                       NOT (its posts are owner-authored verbatim, not
--                       Soul-shaped) — recorded as a known carry, not an
--                       oversight.
--
-- LINEAR MIGRATION PATH (append-only, AGENTS.md §6): 0001 (v1) -> 0002 (v2)
-- -> 0003 (v3) -> 0004 (v4) -> 0005 (v5) -> 0006 (v6) -> 0007 (v7)
-- -> 0008 (v8) -> 0009 (v9) -> THIS FILE (v10).
-- Version 10 therefore MEANS "post-management + near-dup present AND the
-- Soul versioning tables present". Remote application is performed
-- exclusively by `wrangler d1 migrations apply` with explicit owner
-- approval.

CREATE TABLE souls (
  version INTEGER PRIMARY KEY CHECK (version >= 1),
  text TEXT NOT NULL CHECK (length(text) > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  created_by INTEGER NOT NULL CHECK (created_by > 0),
  created_at_ms INTEGER NOT NULL
);

ALTER TABLE published_posts
  ADD COLUMN soul_version INTEGER CHECK (soul_version IS NULL OR soul_version >= 1);

UPDATE schema_metadata
   SET value = '10',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0010_soul_versioning',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
