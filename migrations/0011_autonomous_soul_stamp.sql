-- PIXEL — D1 migration 0011: autonomous soul stamp (slice 9).
--
-- The slice-8 Soul contract ("every published post carries the
-- `soul_version` it was published under", migration 0010) covered only
-- the inbound `published_posts` table: the inbound publish path stamps
-- it, the admin-post path does NOT (owner-authored verbatim — a known
-- carry). The autonomous chain had NO column to stamp at all: the
-- `publications` outbox (schema 6) records the send ledger but never the
-- Soul version the draft was published under.
--
--   publications    new NULLABLE column `soul_version` (NULL = legacy
--                   row enqueued before Soul stamping; a stamped row
--                   carries a positive integer). The slice-9
--                   auto-publish bridge stamps the ACTIVE Soul version
--                   (the `soul.current_version` pointer, fail-soft) at
--                   enqueue time and refuses to enqueue when no Soul
--                   version is resolvable — a publication without a
--                   Soul stamp is never created quietly.
--
-- LINEAR MIGRATION PATH (append-only, AGENTS.md §6): 0001 (v1) -> 0002 (v2)
-- -> 0003 (v3) -> 0004 (v4) -> 0005 (v5) -> 0006 (v6) -> 0007 (v7)
-- -> 0008 (v8) -> 0009 (v9) -> 0010 (v10) -> THIS FILE (v11).
-- Version 11 therefore MEANS "Soul versioning present AND the
-- autonomous publications outbox carries the Soul stamp". Remote
-- application is performed exclusively by `wrangler d1 migrations apply`
-- with explicit owner approval.

ALTER TABLE publications
  ADD COLUMN soul_version INTEGER CHECK (soul_version IS NULL OR soul_version >= 1);

UPDATE schema_metadata
   SET value = '11',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0011_autonomous_soul_stamp',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
