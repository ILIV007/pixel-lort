# Operator Runbook — Phase 4 Source Ingestion (v1.4.0)

Status: **implemented, gate DISABLED** — no source is active in the
delivered tree (local AND preview). Every activation below is a
post-review operator procedure. Application version 1.4.0, schema **3**
(no new migration).

## 1. Source capability / configuration / credential matrix

Registry catalog (`docs/blueprint/v1/pixel_source_registry_v1.json`, 14
definitions, byte-identical). Statuses are EXPLICIT and separate:

- **implemented** — connector code exists.
- **configured** — implemented AND its runtime preconditions hold.
- **enabled** — configured AND `sources.enabled = 1` (owner control).
- **blocked** — implemented-but-unconfigured (`watchlist_empty`,
  `credentials_missing`) or catalog-only (`connector_not_implemented`).

| Source id                  | Connector         | Lane      | Trust | Interval | Budget/day | Credentials needed (secret name)                            | Runtime watchlist needed                                 | Status in v1.4.0                                                            |
| -------------------------- | ----------------- | --------- | ----- | -------- | ---------- | ----------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| playstation_blog           | rss               | official  | 96    | 300 s    | 300        | NONE                                                        | NONE (endpoint in registry)                              | implemented + configured, **disabled** — first activation candidate         |
| xbox_wire                  | rss               | official  | 96    | 300 s    | 300        | NONE                                                        | NONE (endpoint in registry)                              | implemented + configured, **disabled** — first activation candidate         |
| ign_games                  | rss               | editorial | 84    | 900 s    | 150        | NONE                                                        | NONE (endpoint in registry)                              | implemented + configured, disabled (later batch)                            |
| eurogamer_news             | rss               | editorial | 86    | 900 s    | 150        | NONE                                                        | NONE (endpoint in registry)                              | implemented + configured, disabled (later batch)                            |
| moddb_news                 | rss               | community | 70    | 1800 s   | 80         | NONE                                                        | NONE (endpoint in registry)                              | implemented + configured, disabled                                          |
| moddb_headlines            | rss               | community | 76    | 1800 s   | 80         | NONE                                                        | NONE (endpoint in registry)                              | implemented + configured, disabled                                          |
| itch_discovery             | rss               | community | 66    | 3600 s   | 50         | NONE                                                        | NONE (two endpointTemplates in registry)                 | implemented + configured, disabled                                          |
| steam_news_watchlist       | steam-news        | official  | 92    | 600 s    | 500        | NONE (GetNewsForApp v2 is keyless)                          | **apps: number[]** (Steam AppIDs) — NOT supplied         | implemented, **blocked** (`watchlist_empty`) until owner supplies watchlist |
| youtube_official_watchlist | youtube-playlists | media     | 90    | 600 s    | 250        | `YOUTUBE_API_KEY`                                           | **playlists: string[]** (playlist IDs) — NOT supplied    | implemented, **blocked** until credentials + watchlist                      |
| reddit_crack_signals       | reddit-oauth      | radar     | 38    | 600 s    | 200        | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET`                 | subreddits: `["CrackWatch"]` (in registry)               | implemented, **blocked** (`credentials_missing`) until OAuth app creds      |
| reddit_leak_signals        | reddit-oauth      | radar     | 32    | 600 s    | 200        | `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET`                 | subreddits: `["GamingLeaksAndRumours"]` (in registry)    | implemented, **blocked** (`credentials_missing`)                            |
| github_release_watchlist   | github-releases   | official  | 88    | 900 s    | 300        | `GITHUB_TOKEN` (OPTIONAL — unauthenticated works, low rate) | **repositories: string[]** (`owner/repo`) — NOT supplied | implemented, **blocked** (`watchlist_empty`)                                |
| bluesky_watchlist          | bluesky-public    | radar     | 45    | 600 s    | 250        | —                                                           | —                                                        | **catalog-only** (`connector_not_implemented`); never enable in this phase  |
| igdb_metadata              | igdb              | metadata  | 86    | 86400 s  | 500        | —                                                           | —                                                        | **catalog-only** (`connector_not_implemented`); never enable in this phase  |

Nothing here fabricates app IDs, playlist IDs or repositories: adapters
are fully fixture-tested, and their runtime sources stay visibly blocked
until the owner supplies the watchlists.

## 2. What the delivered configuration does

- `SOURCE_INGESTION_ENABLED=false` (local defaults AND preview env).
  The flag gates due-source scheduling + the `sources.fetch_poll`
  handler ONLY — the reviewed Phase 3 engine (`JOBS_ENABLED=true` on
  preview) is untouched.
- Seeding runs automatically on the FIRST gated cron pass with an empty
  `sources` table (14 rows, all `enabled=0`). Repeated imports never
  re-enable disabled sources and never overwrite owner-managed
  `enabled`/`priority` or runtime state.
- Required core bindings while ingestion is ENABLED: the jobs engine
  must be enabled and valid (`DB` + `JOBS` + `DLQ`). Missing core
  bindings fail closed (`ingestion_requires_jobs` / readiness 503).
  A missing OPTIONAL provider secret only blocks THAT source
  (`credentials_missing`) — the rest of the system stays available.

## 3. Initial RSS activation procedure (PlayStation Blog + Xbox Wire)

Perform ONLY after independent review approval. Preview is the first
target; production stays untouched.

1. Verify the phase branch is deployed to preview (separate operational
   step, owner-authorized) and `GET /health/ready` is 200 with the gate
   still off.
2. Ensure migration 0003 is applied on the target D1 (it already is on
   preview; schema stays 3 — no new migration in this phase).
3. Set the gate on the preview environment ONLY:
   `wrangler versions secret put` is NOT needed (non-secret var) — use
   the dashboard/Versions or `wrangler deploy` with the preview var
   `SOURCE_INGESTION_ENABLED="true"`. Keep `JOBS_ENABLED="true"`.
4. Trigger one cron tick (or wait ≤ 5 minutes). Verify seeding:
   `wrangler d1 execute DB --env preview --remote --command
"SELECT id, enabled FROM sources ORDER BY id"` → 14 rows, enabled=0.
5. Enable EXACTLY the two reviewed sources:
   `wrangler d1 execute DB --env preview --remote --command
"UPDATE sources SET enabled = 1 WHERE id IN ('playstation_blog','xbox_wire')"`
6. Observe the next cron passes: durable `sources.fetch_poll` jobs move
   pending → queued → succeeded; `source_items` fills with normalized
   rows; `source_state` shows `last_success_at` and advancing
   `next_poll_at`; `budgets` rows appear under `scope='ingestion'`.
7. Second poll (≈5 min later) should be mostly 304/not_modified — no new
   items, no duplicates. Verify:
   `SELECT status, COUNT(*) FROM jobs WHERE type='sources.fetch_poll' GROUP BY status;`
   and `SELECT COUNT(*) FROM source_items;` stays stable across 304 polls.
8. Health/failure behavior: a source in failure shows a stable
   `last_error` reason and backs off adaptively; 401/403 opens a 30-min
   circuit (`circuit_open_until`); 429 honors Retry-After exactly.
9. Rollback: set `SOURCE_INGESTION_ENABLED="false"` on preview (no new
   scheduling, no poll handler; in-flight poll jobs are poisoned safely —
   drain first if possible). To pause one source:
   `UPDATE sources SET enabled = 0 WHERE id = ?` — owner-managed, never
   touched by re-seeding.

## 4. Watchlist provisioning (later, per source — owner-supplied values only)

Runtime watchlists live in the source's `config_json` (owner operation):

```sql
-- Steam app watchlist (numbers, validated 1..2^31-1):
UPDATE sources SET config_json = json_set(config_json, '$.apps', json('[570,440]'))
 WHERE id = 'steam_news_watchlist';

-- YouTube playlist watchlist (IDs validated ^[A-Za-z0-9_-]{12,64}$):
UPDATE sources SET config_json = json_set(config_json, '$.playlists', json('["PLxxxxxxxxxxxx"]'))
 WHERE id = 'youtube_official_watchlist';

-- GitHub repository watchlist (owner/repo pairs):
UPDATE sources SET config_json = json_set(config_json, '$.repositories', json('["owner/repo"]'))
 WHERE id = 'github_release_watchlist';
```

Credentials (when their source's activation is approved) are Cloudflare
secrets ONLY — `wrangler secret put YOUTUBE_API_KEY` etc. on the target
environment. Secret names are contract (`src/shared/types/env.ts`);
values never appear in logs, audit metadata, queue messages, callback
data, or URLs. Authentication is header-based for every provider
(`X-Goog-Api-Key`, `Authorization: Basic` for the Reddit token POST,
`Authorization: Bearer` for Reddit listings / GitHub).

## 5. Observability (this phase)

No owner-facing screens are added in Phase 4. Durable health lives in
`source_state` (last_error stable codes, consecutive_failures,
circuit_open_until, requests_today/budget_date) and `budgets`; audit
history rides the Phase 3 job rows (jobs + DLQ references). Useful
readbacks:

```sql
SELECT id, connector, enabled,
       (SELECT last_error FROM source_state WHERE source_id = sources.id) AS last_error,
       (SELECT consecutive_failures FROM source_state WHERE source_id = sources.id) AS failures
  FROM sources ORDER BY enabled DESC, id;

SELECT budget_key, bucket_date, requests FROM budgets WHERE scope='ingestion'
 ORDER BY bucket_date DESC LIMIT 20;
```

## 6. Honest boundaries

- The parser, request contracts and rate limits reflect the providers'
  documented behavior at implementation time; drift surfaces as bounded
  `failed` polls with stable codes (never crashes, never hot loops).
- Workers cannot resolve DNS: the host allowlist is the SSRF boundary;
  per-host literal checks are defense in depth only (ADR-0039 §2).
- The seeding tick of a never-polled source (window key from
  `next_poll_at = 0`) may produce one duplicate harmless job reference
  in that same tick; claim fencing + item dedup absorb it (ADR-0038 §3).
- No AI, no channel publishing, no publication confidence is implied by
  ingestion; community signals remain signals (`signal_only`).
