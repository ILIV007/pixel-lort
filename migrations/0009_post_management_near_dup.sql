-- PIXEL — D1 migration 0009: post management + near-dup detection (slice 6).
--
-- Post management (DESIGN §10.7: the bot manages its own channel posts —
-- pin/unpin, housekeeping) + near-dup detection (DESIGN §10.1: the same
-- story from several sources is adjudicated as ONE story — update, not a
-- new post) + the negative cache for the quality gate (DESIGN §9.4: a
-- rejected item is cached 30 days and is not re-fed to AI each cycle).
--
--   channel_pins        ONE row per pin action on a channel message.
--                       status: active | released. The partial UNIQUE
--                       index admits ONE active pin per message; the
--                       EXPRESSION unique index admits ONE active pin in
--                       the whole channel (max one active pin — DESIGN
--                       §10.7). The service releases the previous pin
--                       BEFORE inserting the new one in the SAME atomic
--                       batch, so the index never trips on a legitimate
--                       re-pin; a concurrent second active pin is refused
--                       by the database, never silently kept.
--   story_merges        The near-dup story ledger: ONE row per
--                       adjudication of an incoming source item against
--                       a canonical story. disposition: merged_as_update
--                       (similarity >= merge threshold — the item becomes
--                       an UPDATE of the canonical story, never a second
--                       post) | needs_review (the middle band — held for
--                       AI/human adjudication, never posted) | distinct
--                       (no merge — the item takes its own path).
--                       UNIQUE(source_item_id, canonical_story_id) — one
--                       adjudication per (item, story) pair.
--   quality_rejections  The negative cache: ONE row per rejected
--                       fingerprint (the source item's content_hash).
--                       UNIQUE(fingerprint) — a rejection is refreshed,
--                       never duplicated. Expiry is a TIME predicate
--                       (expires_at_ms = rejected_at_ms + 30 days); rows
--                       are never deleted.
--   channel_post_deletes The durable record of a housekeeping deletion
--                       (the channel message itself is deleted through
--                       the Bot API; the row is the audit trail AND the
--                       exclusion from the housekeeping list).
--
-- Repo conventions: epoch-ms integers for timestamps (like 0007/0008),
-- no FKs (cross-table consistency is enforced by the service inside
-- atomic batches), no DELETE anywhere (status changes only).
--
-- LINEAR MIGRATION PATH (append-only, AGENTS.md §6): 0001 (v1) -> 0002 (v2)
-- -> 0003 (v3) -> 0004 (v4) -> 0005 (v5) -> 0006 (v6) -> 0007 (v7)
-- -> 0008 (v8) -> THIS FILE (v9). Version 9 therefore MEANS "ownership
-- present AND admin post present AND the editorial→post provenance present
-- AND the inbound pipeline present AND the live-watchlist tables present
-- AND the post-management / near-dup tables present".
-- Remote application is performed exclusively by `wrangler d1 migrations
-- apply` with explicit owner approval.

CREATE TABLE channel_pins (
  id                 TEXT PRIMARY KEY,
  channel_message_id INTEGER NOT NULL CHECK (channel_message_id > 0),
  post_ref_type      TEXT NOT NULL CHECK (post_ref_type IN ('publication', 'inbound')),
  post_ref_id        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  pinned_by          INTEGER NOT NULL,
  pinned_at_ms       INTEGER NOT NULL,
  unpinned_at_ms     INTEGER,
  unpinned_by        INTEGER,
  created_at_ms      INTEGER NOT NULL,
  updated_at_ms      INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_channel_pins_one_active_per_message
  ON channel_pins(channel_message_id) WHERE status = 'active';

CREATE UNIQUE INDEX idx_channel_pins_one_active_overall
  ON channel_pins((1)) WHERE status = 'active';

CREATE INDEX idx_channel_pins_history ON channel_pins(status, pinned_at_ms DESC);

CREATE TABLE story_merges (
  id                 TEXT PRIMARY KEY,
  canonical_story_id TEXT NOT NULL,
  merged_story_id    TEXT,
  source_item_id     TEXT NOT NULL,
  similarity_score   REAL NOT NULL CHECK (similarity_score >= 0 AND similarity_score <= 1),
  title_score        REAL NOT NULL CHECK (title_score >= 0 AND title_score <= 1),
  entity_score       REAL NOT NULL CHECK (entity_score >= 0 AND entity_score <= 1),
  method             TEXT NOT NULL CHECK (method IN ('deterministic', 'ai')),
  disposition        TEXT NOT NULL CHECK (disposition IN ('merged_as_update', 'needs_review', 'distinct')),
  decided_by         TEXT NOT NULL,
  reason_code        TEXT NOT NULL,
  created_at_ms      INTEGER NOT NULL,
  UNIQUE(source_item_id, canonical_story_id)
);

CREATE INDEX idx_story_merges_canonical ON story_merges(canonical_story_id, created_at_ms DESC);
CREATE INDEX idx_story_merges_disposition ON story_merges(disposition, created_at_ms DESC);

CREATE TABLE quality_rejections (
  id              TEXT PRIMARY KEY,
  fingerprint     TEXT NOT NULL UNIQUE,
  reason          TEXT NOT NULL,
  source_item_id  TEXT NOT NULL,
  rejected_at_ms  INTEGER NOT NULL,
  expires_at_ms   INTEGER NOT NULL,
  created_at_ms   INTEGER NOT NULL
);

CREATE INDEX idx_quality_rejections_expiry ON quality_rejections(expires_at_ms);

CREATE TABLE channel_post_deletes (
  id                 TEXT PRIMARY KEY,
  post_ref_type      TEXT NOT NULL CHECK (post_ref_type IN ('publication', 'inbound')),
  post_ref_id        TEXT NOT NULL,
  channel_message_id INTEGER NOT NULL CHECK (channel_message_id > 0),
  deleted_by         INTEGER NOT NULL,
  reason             TEXT NOT NULL,
  deleted_at_ms      INTEGER NOT NULL,
  UNIQUE(post_ref_type, post_ref_id, channel_message_id)
);

CREATE INDEX idx_channel_post_deletes_message ON channel_post_deletes(channel_message_id);

UPDATE schema_metadata
   SET value = '9',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0009_post_management_near_dup',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
