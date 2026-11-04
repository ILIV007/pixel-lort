-- PIXEL — D1 migration 0005: admin post pipeline (R1.20-R).
--
-- Durable, versioned storage for the ADMIN-AUTHORED channel-post pipeline:
-- capture (rich text preserved verbatim), faithful preview, version-bound
-- approval, and the safe/recoverable publication outbox. Five tables:
--
--   admin_post_drafts           one OPEN draft per creator; lifecycle status.
--   admin_post_versions         immutable (draft, version) envelope snapshots:
--                               the CANONICAL serialized rich-text envelope
--                               (text preserved byte-for-byte + validated
--                               entities, R1.19 contract) plus its stable
--                               content fingerprint and the source update_id
--                               (capture idempotency — a redelivered update
--                               can never create a duplicate version).
--   admin_post_preview_sessions server-side preview binding: a preview is a
--                               REAL message sent for ONE exact version with
--                               ONE exact fingerprint. Approve/publish tokens
--                               resolve through this row, so knowing only the
--                               version number can never approve un-previewed
--                               content (the fingerprint check is SERVER-side
--                               and mandatory in the resolution path).
--   admin_post_approvals        ONE row per (draft, version): state
--                               active|consumed|invalidated. A content update
--                               (new version) invalidates older approvals; a
--                               publish consumes the active approval; all
--                               transitions are guarded UPDATEs.
--   admin_post_publications     the publication outbox. UNIQUE partial index
--                               on (draft_id, version) WHERE supersede_of IS
--                               NULL — at most ONE primary publication per
--                               version, so double clicks, concurrent
--                               deliveries and duplicate tokens can never
--                               enqueue a second send. The explicit supersede
--                               path (supersede_of NOT NULL) is the ONLY way
--                               a version is re-sent, and it requires a human
--                               confirm action after an uncertain/failed
--                               outcome — nothing is ever auto-resent. State
--                               machine: queued -> claimed (lease +
--                               claimed_by fencing) -> sent | failed_definitive
--                               | uncertain. Outcomes are recorded HONESTLY:
--                               timeout/network/5xx/invalid-response are
--                               `uncertain` (the message MAY have arrived);
--                               there is NO exactly-once delivery claim.
--
-- Integrity is enforced by CHECK constraints + the guarded transitions in
-- src/adapters/db/admin-post-store.ts; cross-table consistency (draft ->
-- versions -> approvals/publications) is maintained by the service inside
-- atomic D1 batches. Applied migrations are append-only (AGENTS.md §6);
-- this migration advances the APPLICATION schema metadata (schema_metadata —
-- ADR-0019) to version 4 inside the same atomic batch. Wrangler's own
-- `d1_migrations` bookkeeping is untouched by application code. Remote
-- application is performed exclusively by `wrangler d1 migrations apply`
-- with explicit owner approval — NONE has been requested or executed.

CREATE TABLE admin_post_drafts (
  id TEXT PRIMARY KEY,
  created_by_user_id INTEGER NOT NULL CHECK (created_by_user_id > 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled', 'completed')),
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_admin_post_drafts_creator
  ON admin_post_drafts(created_by_user_id, status, updated_at_ms);

CREATE TABLE admin_post_versions (
  draft_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  envelope_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  source_update_id INTEGER NOT NULL,
  created_by_user_id INTEGER NOT NULL CHECK (created_by_user_id > 0),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (draft_id, version)
);

CREATE INDEX idx_admin_post_versions_source_update
  ON admin_post_versions(source_update_id, created_by_user_id);

CREATE TABLE admin_post_preview_sessions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  preview_chat_id INTEGER NOT NULL,
  source_update_id INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_admin_post_preview_sessions_source
  ON admin_post_preview_sessions(source_update_id);

CREATE TABLE admin_post_approvals (
  draft_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  approved_by_user_id INTEGER NOT NULL CHECK (approved_by_user_id > 0),
  session_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'consumed', 'invalidated')),
  approved_at_ms INTEGER NOT NULL,
  PRIMARY KEY (draft_id, version)
);

CREATE TABLE admin_post_publications (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  destination TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'claimed', 'sent', 'failed_definitive', 'uncertain', 'superseded')),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  supersede_of TEXT,
  claimed_by TEXT,
  lease_expires_at_ms INTEGER,
  bot_message_id INTEGER,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_admin_post_pub_primary
  ON admin_post_publications(draft_id, version) WHERE supersede_of IS NULL;

CREATE INDEX idx_admin_post_pub_state
  ON admin_post_publications(state, updated_at_ms);

UPDATE schema_metadata
   SET value = '4',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0005_admin_post_pipeline',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
