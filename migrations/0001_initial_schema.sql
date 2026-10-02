-- PIXEL — D1 migration 0001: initial schema (Phase 1A).
--
-- Source of truth: docs/blueprint/v1/pixel_schema_v1.sql (immutable design
-- reference, preserved verbatim in the repository). This migration is the
-- executable form of that schema for Cloudflare D1.
--
-- Conversion rules (ADR-0019):
--   - All 27 approved tables, 29 approved indexes, CHECK constraints,
--     foreign keys and uniqueness rules are ported verbatim. No entity is
--     renamed and no product field is added or removed.
--   - The blueprint's `PRAGMA foreign_keys = ON;` line is intentionally NOT
--     ported: D1 enforces foreign keys by default and the PRAGMA is a
--     client-session directive, not schema content. Enforcement is proven by
--     migration tests (PRAGMA foreign_key_check + behavioral FK cases).
--   - The `schema_metadata` table at the end of this file is APPLICATION
--     schema metadata added by Phase 1A (ADR-0019). It is distinct from
--     Wrangler's own D1 migration bookkeeping (the `d1_migrations` table,
--     managed exclusively by wrangler migration commands).
--
-- Applied migrations are append-only: never edit or reorder applied files
-- (AGENTS.md §6). New schema changes go into a new file, e.g.
-- `migrations/0002_<name>.sql`.

CREATE TABLE IF NOT EXISTS admins (
  telegram_user_id INTEGER PRIMARY KEY,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','chief_editor','editor','reviewer','source_manager','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('claimed','processed','failed'))
);
CREATE INDEX IF NOT EXISTS idx_tg_updates_received ON telegram_updates(received_at);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL REFERENCES admins(telegram_user_id) ON DELETE CASCADE,
  flow TEXT NOT NULL,
  step TEXT NOT NULL,
  state_json TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_exp ON admin_sessions(telegram_user_id, expires_at);

CREATE TABLE IF NOT EXISTS admin_action_tokens (
  id TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL REFERENCES admins(telegram_user_id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_tokens_user_exp ON admin_action_tokens(telegram_user_id, expires_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES admins(telegram_user_id),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connector TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('official','editorial','radar','community','media','metadata')),
  trust_tier INTEGER NOT NULL CHECK (trust_tier BETWEEN 0 AND 100),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 60),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  daily_request_budget INTEGER NOT NULL DEFAULT 100,
  approval_policy TEXT NOT NULL CHECK (approval_policy IN ('auto','threshold','approval','signal_only','never_publish')),
  attribution_template TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sources_due_config ON sources(enabled, priority);

CREATE TABLE IF NOT EXISTS source_state (
  source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  cursor TEXT,
  etag TEXT,
  last_modified TEXT,
  next_poll_at INTEGER NOT NULL,
  last_polled_at INTEGER,
  last_changed_at INTEGER,
  last_success_at INTEGER,
  last_error_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  circuit_open_until INTEGER,
  requests_today INTEGER NOT NULL DEFAULT 0,
  budget_date TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_state_due ON source_state(next_poll_at, circuit_open_until);

CREATE TABLE IF NOT EXISTS source_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  external_id TEXT,
  canonical_url TEXT,
  title TEXT NOT NULL,
  body_excerpt TEXT,
  author TEXT,
  published_at INTEGER,
  fetched_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}',
  processing_status TEXT NOT NULL DEFAULT 'new' CHECK (processing_status IN ('new','queued','processed','duplicate','rejected','failed')),
  UNIQUE(source_id, external_id),
  UNIQUE(source_id, canonical_url)
);
CREATE INDEX IF NOT EXISTS idx_source_items_hash ON source_items(content_hash);
CREATE INDEX IF NOT EXISTS idx_source_items_time ON source_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_items_status ON source_items(processing_status, fetched_at);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('game','franchise','studio','publisher','platform','person','event','hardware','service','mod','emulator')),
  canonical_name TEXT NOT NULL,
  slug TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(type, slug)
);

CREATE TABLE IF NOT EXISTS entity_aliases (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  language TEXT,
  PRIMARY KEY(entity_id, normalized_alias)
);
CREATE INDEX IF NOT EXISTS idx_entity_alias_lookup ON entity_aliases(normalized_alias);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  story_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('discovered','collecting','assessed','draftable','published','updated','corrected','closed','duplicate','disputed','denied','held','rejected')),
  trust_status TEXT NOT NULL CHECK (trust_status IN ('official','verified','reported','rumor','leak','disputed','denied','unknown')),
  content_type TEXT NOT NULL CHECK (content_type IN ('official_news','breaking','industry','release','trailer','gameplay','patch','dlc','leak','rumor','crack_status','drm_update','mod','emulator','homebrew','jailbreak','indie','free_game','discount','mobile','hardware','esports','analysis','community')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  confidence INTEGER NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  working_headline TEXT,
  first_seen_at INTEGER NOT NULL,
  last_evidence_at INTEGER NOT NULL,
  last_published_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  merged_into_story_id TEXT REFERENCES stories(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_state_priority ON stories(status, priority DESC, last_evidence_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_type_time ON stories(content_type, first_seen_at DESC);

CREATE TABLE IF NOT EXISTS story_entities (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id),
  relation TEXT NOT NULL,
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  PRIMARY KEY(story_id, entity_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_story_entities_entity ON story_entities(entity_id, story_id);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  claim_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_text TEXT NOT NULL,
  normalized_value TEXT,
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  status TEXT NOT NULL CHECK (status IN ('unverified','supported','confirmed','disputed','denied','superseded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_story_status ON claims(story_id, status);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  stance TEXT NOT NULL CHECK (stance IN ('supports','contradicts','mentions','denies')),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  excerpt TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(claim_id, source_item_id, stance)
);
CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence(source_item_id);

CREATE TABLE IF NOT EXISTS story_fingerprints (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('url','external_id','content_hash','event_key','title_key','media_hash')),
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(kind, value)
);
CREATE INDEX IF NOT EXISTS idx_fingerprints_story ON story_fingerprints(story_id);

CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed','invalid','skipped')),
  latency_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_task_time ON ai_runs(task, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_health ON ai_runs(provider, model, status, created_at DESC);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES stories(id),
  status TEXT NOT NULL CHECK (status IN ('generating','ready','validated','approval_required','auto_approved','approved','rejected','superseded','failed')),
  language TEXT NOT NULL DEFAULT 'fa',
  layout TEXT NOT NULL,
  title TEXT NOT NULL,
  document_json TEXT NOT NULL,
  rendered_html TEXT,
  facts_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  ai_run_id TEXT REFERENCES ai_runs(id),
  version INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(story_id, version)
);
CREATE INDEX IF NOT EXISTS idx_drafts_status_time ON drafts(status, created_at DESC);

CREATE TABLE IF NOT EXISTS draft_revisions (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  document_json TEXT NOT NULL,
  rendered_html TEXT,
  change_reason TEXT,
  changed_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(draft_id, revision)
);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  source_item_id TEXT REFERENCES source_items(id),
  type TEXT NOT NULL CHECK (type IN ('photo','video','animation','document','audio','trailer_link')),
  canonical_url TEXT,
  source_url TEXT,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  duration_seconds INTEGER,
  file_size INTEGER,
  sha256 TEXT,
  visual_key TEXT,
  rights_status TEXT NOT NULL CHECK (rights_status IN ('official','licensed','attribution_required','unknown','blocked')),
  attribution TEXT,
  r2_key TEXT,
  telegram_file_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('candidate','validated','selected','uploaded','failed','blocked','expired')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_hash ON media_assets(sha256);
CREATE INDEX IF NOT EXISTS idx_media_visual ON media_assets(visual_key);
CREATE INDEX IF NOT EXISTS idx_media_expiry ON media_assets(expires_at);

CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES stories(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','publishing','published','retry_wait','failed','dead_letter','cancelled','superseded')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 100),
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('auto','safe_auto','approval')),
  scheduled_at INTEGER,
  run_after INTEGER NOT NULL,
  claimed_at INTEGER,
  lease_until INTEGER,
  published_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  idempotency_key TEXT NOT NULL UNIQUE,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publications_due ON publications(status, run_after, priority DESC);
CREATE INDEX IF NOT EXISTS idx_publications_story ON publications(story_id, created_at DESC);

CREATE TABLE IF NOT EXISTS publication_messages (
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  media_group_id TEXT,
  ordinal INTEGER NOT NULL DEFAULT 0,
  text_hash TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(publication_id, ordinal),
  UNIQUE(chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS media_usages (
  media_asset_id TEXT NOT NULL REFERENCES media_assets(id),
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(publication_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_media_usage_asset ON media_usages(media_asset_id, created_at DESC);

CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL REFERENCES stories(id),
  publication_id TEXT REFERENCES publications(id),
  previous_revision_id TEXT REFERENCES draft_revisions(id),
  corrected_revision_id TEXT REFERENCES draft_revisions(id),
  reason TEXT NOT NULL,
  source_item_id TEXT REFERENCES source_items(id),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  aggregate_type TEXT,
  aggregate_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','queued','claimed','succeeded','retry_wait','failed','dead_letter','cancelled')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  run_after INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_until INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_after, priority DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_aggregate ON jobs(aggregate_type, aggregate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS budgets (
  scope TEXT NOT NULL,
  budget_key TEXT NOT NULL,
  bucket_date TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  bytes_transferred INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope, budget_key, bucket_date)
);

CREATE TABLE IF NOT EXISTS source_reputation_events (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  event TEXT NOT NULL CHECK (event IN ('correct','incorrect','duplicate','late','broken','confirmed_first','retracted')),
  weight INTEGER NOT NULL,
  story_id TEXT REFERENCES stories(id),
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reputation_source_time ON source_reputation_events(source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('admin','system','source','ai')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  trace_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_events(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(created_at DESC);

-- ---------------------------------------------------------------------------
-- Application schema metadata (Phase 1A, ADR-0019).
--
-- This table is APPLICATION metadata describing the deployed schema. It is
-- intentionally separate from Wrangler's migration bookkeeping (the
-- `d1_migrations` table that wrangler migration commands manage): wrangler
-- tracks WHICH migration FILES it applied; this table describes WHAT the
-- application can expect from the schema at runtime (version contract used
-- by /health/ready and /version).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

INSERT INTO schema_metadata (key, value, updated_at_ms) VALUES
  ('schema_version', '1', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('migration_id', '0001_initial_schema', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('applied_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), CAST(strftime('%s', 'now') AS INTEGER) * 1000);
