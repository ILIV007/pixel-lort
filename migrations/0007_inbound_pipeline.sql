-- PIXEL — D1 migration 0007: inbound AI-admin pipeline (slice 4).
--
-- The owner-sent inbound flow (DESIGN §10.1/§10.2, MERGE_MAP §7) needs
-- durable records the admin post pipeline does not have:
--
--   published_posts     ONE row per post the inbound pipeline published
--                       to the channel: the SOURCE message identity
--                       (private-chat id + source message id — the edit
--                       key), the CHANNEL message ids in part order (a
--                       multi-part post edits each part in place), the
--                       media kind + file id (a media file can never be
--                       swapped by an edit — only its caption), the gaming
--                       category and the presentation (rich/classic). The
--                       UNIQUE index on (source_chat_id,
--                       source_message_id) makes the source message the
--                       single edit anchor: an edited source message
--                       re-runs the pipeline and edits THIS row's channel
--                       post in place.
--   inbound_approvals   ONE row per approval-mode preview: the processed
--                       content (parts + media, JSON) with its stable
--                       fingerprint, the 24-hour expiry, and the guarded
--                       state machine pending -> approved/rejected/expired/
--                       published. The partial UNIQUE index admits ONE
--                       pending approval per source message, so a
--                       redelivered update can never create a second live
--                       preview for the same post.
--
-- No FKs are added (the R1.20-R discipline: cross-table consistency is
-- enforced by the service inside atomic batches). Owner-sent posts are
-- exempt from the daily cap (DESIGN §9.2 proposal) and counted separately
-- in the existing `budgets` table under the `daily_posts_owner` key —
-- that needs NO schema change.
--
-- LINEAR MIGRATION PATH (append-only, AGENTS.md §6): 0001 (v1) -> 0002 (v2)
-- -> 0003 (v3) -> 0004 (v4) -> 0005 (v5) -> 0006 (v6) -> THIS FILE (v7).
-- Version 7 therefore MEANS "ownership present AND admin post present AND
-- the editorial→post provenance present AND the inbound pipeline present".
-- Remote application is performed exclusively by `wrangler d1 migrations
-- apply` with explicit owner approval.

CREATE TABLE published_posts (
  id TEXT PRIMARY KEY,
  source_chat_id INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL,
  channel_message_ids TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'photo', 'video')),
  media_file_id TEXT,
  category TEXT NOT NULL,
  presentation TEXT NOT NULL CHECK (presentation IN ('rich', 'classic')),
  created_by_user_id INTEGER NOT NULL CHECK (created_by_user_id > 0),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_published_posts_source
  ON published_posts(source_chat_id, source_message_id);

CREATE INDEX idx_published_posts_created
  ON published_posts(created_at_ms);

CREATE TABLE inbound_approvals (
  id TEXT PRIMARY KEY,
  source_chat_id INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL,
  source_update_id INTEGER NOT NULL,
  created_by_user_id INTEGER NOT NULL CHECK (created_by_user_id > 0),
  content_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  category TEXT NOT NULL,
  presentation TEXT NOT NULL CHECK (presentation IN ('rich', 'classic')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved', 'rejected', 'expired', 'published')),
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_inbound_approvals_pending
  ON inbound_approvals(source_chat_id, source_message_id) WHERE state = 'pending';

CREATE INDEX idx_inbound_approvals_state
  ON inbound_approvals(state, expires_at_ms);

UPDATE schema_metadata
   SET value = '7',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0007_inbound_pipeline',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
