-- PIXEL — D1 migration 0008: live watchlists (slice 5).
--
-- Live watchlists (DESIGN §9.4/§10.1, providers/live-watchlists-design.md
-- §5): watchlists are a DERIVED VIEW of live data (Steam charts, trends,
-- new releases, Epic free-games API), NOT static lists. The owner only
-- adds/removes specific games/publishers; the machine adds/removes the
-- live core by thresholds.
--
--   watchlist_entries   ONE row per watched thing (game, publisher, YouTube
--                       channel, GitHub repo, Bluesky account, Nexus domain,
--                       ModDB slug, Workshop appid, esports title/team,
--                       crack view, free-game offer, mod candidate). Two
--                       layers, never mixed: source='live' (machine-owned,
--                       auto-add/auto-prune by the §4 thresholds) vs
--                       source='manual' (owner-owned, NEVER auto-pruned).
--                       status: active | cooling | dormant | expired |
--                       proposed | rejected | suppressed. UNIQUE(kind, key)
--                       — one thing = one entry (design §6.1).
--   chart_snapshots     ONE row per weekly Steam Top-100 snapshot
--                       (Sundays 10:00 Tehran). UNIQUE(snapshot_date, source)
--                       — a week is never snapshotted twice.
--   chart_snapshot_rows The Top-100 rows of one snapshot. Movers are ALWAYS
--                       diffed between two snapshots — never from the
--                       entries' rank columns (design §5.2).
--   watchlist_signals   Append-only signal log (chart rank/spike, news,
--                       trailer, free offer, ...). signal counts are
--                       derived from this table, never hand-counted.
--   watchlist_aliases   One thing, many source ids (Steam appid / Epic
--                       slug / IGDB id / normalized title).
--   watchlist_exclusions The owner's manual block-list (kind + key pattern);
--                       an exclusion BEATS auto-add.
--
-- No provider_health table is added (design §5.6): the existing source
-- health surface (source_state.last_error) is reused instead.
--
-- Repo conventions: epoch-ms integers for timestamps (like 0007), no FKs
-- (cross-table consistency is enforced by the service inside atomic
-- batches), no DELETE anywhere (status changes only). Timestamps in this
-- file are stored as INTEGER ms; snapshot_date is a Tehran YYYY-MM-DD
-- string (the civil date the snapshot belongs to).
--
-- LINEAR MIGRATION PATH (append-only, AGENTS.md §6): 0001 (v1) -> 0002 (v2)
-- -> 0003 (v3) -> 0004 (v4) -> 0005 (v5) -> 0006 (v6) -> 0007 (v7)
-- -> THIS FILE (v8). Version 8 therefore MEANS "ownership present AND
-- admin post present AND the editorial→post provenance present AND the
-- inbound pipeline present AND the live-watchlist tables present".
-- Remote application is performed exclusively by `wrangler d1 migrations
-- apply` with explicit owner approval.

CREATE TABLE watchlist_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'game', 'free_game', 'publisher', 'youtube_channel',
                    'github_repo', 'bsky_account', 'nexus_domain', 'moddb_slug',
                    'workshop_appid', 'esports_title', 'esports_team',
                    'crack_game', 'nexus_mod', 'modrinth_project', 'workshop_mod')),
  key             TEXT NOT NULL,
  label           TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('live', 'manual')),
  origin_detail   TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                    'active', 'cooling', 'dormant', 'expired',
                    'proposed', 'rejected', 'suppressed')),
  score           REAL NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  velocity        REAL NOT NULL DEFAULT 0,
  rank_current    INTEGER,
  rank_prev       INTEGER,
  players_current INTEGER,
  signal_count_7d  INTEGER NOT NULL DEFAULT 0 CHECK (signal_count_7d >= 0),
  signal_count_30d INTEGER NOT NULL DEFAULT 0 CHECK (signal_count_30d >= 0),
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms  INTEGER NOT NULL,
  last_signal_at_ms INTEGER,
  expires_at_ms   INTEGER,
  pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  pinned_until_ms INTEGER,
  suppressed_until_ms INTEGER,
  suppress_reason TEXT,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at_ms   INTEGER NOT NULL,
  updated_at_ms   INTEGER NOT NULL,
  UNIQUE(kind, key)
);

CREATE INDEX idx_wl_status ON watchlist_entries(status, kind);
CREATE INDEX idx_wl_seen ON watchlist_entries(last_seen_at_ms);
CREATE INDEX idx_wl_score ON watchlist_entries(score DESC);
CREATE INDEX idx_wl_expiry ON watchlist_entries(expires_at_ms) WHERE expires_at_ms IS NOT NULL;

CREATE TABLE chart_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'steam-mostplayed',
  row_count     INTEGER NOT NULL CHECK (row_count >= 0),
  created_at_ms INTEGER NOT NULL,
  UNIQUE(snapshot_date, source)
);

CREATE TABLE chart_snapshot_rows (
  snapshot_id   INTEGER NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'game',
  key           TEXT NOT NULL,
  rank          INTEGER NOT NULL CHECK (rank >= 1 AND rank <= 100),
  players_now   INTEGER,
  peak_today    INTEGER,
  PRIMARY KEY (snapshot_id, key)
);

CREATE TABLE watchlist_signals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id       INTEGER,
  kind           TEXT NOT NULL,
  key            TEXT NOT NULL,
  signal_type    TEXT NOT NULL,
  source         TEXT NOT NULL,
  value_json     TEXT NOT NULL DEFAULT '{}',
  observed_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_sig_entry ON watchlist_signals(entry_id, observed_at_ms DESC);
CREATE INDEX idx_sig_key ON watchlist_signals(kind, key, observed_at_ms DESC);

CREATE TABLE watchlist_aliases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  alias_key     TEXT NOT NULL,
  alias_source  TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(kind, alias_source, alias_key)
);

CREATE TABLE watchlist_exclusions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  key_pattern TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(kind, key_pattern)
);

UPDATE schema_metadata
   SET value = '8',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0008_live_watchlists',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
