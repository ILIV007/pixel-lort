# Phase 4 Handoff — Source Registry and Initial Connectors (v1.4.0)

- **Branch:** `phase/04-source-ingestion` (created from verified main
  `e0cf7a525137d90f4d0f1fea31268edb423de3fd`)
- **Application version:** 1.4.0 (all touchpoints; `check:versions` green)
- **Schema version:** 3 — UNCHANGED. No migration 0004 was needed; applied
  migrations 0001–0003 are byte-identical.
- **Status:** implemented + fully tested; **ingestion gate ships
  DISABLED** (local AND preview). STOP for independent review. No push,
  no merge, no deploy, no remote migration, no source activation.

## 1. Recovery context

This delivery was rebuilt from the authoritative GitHub main after the
previously reported artifact was rejected (wrong baseline `0b5a658` on
old `833613d`; the claimed `cf856710…` artifact does not exist). The
rejected artifact is preserved as evidence and its history was not
rewritten; nothing was ported from it. Baseline verification on the
fresh clone: HEAD = `e0cf7a5` exactly; accepted engine ancestor
`7f3d3d5` IS an ancestor; Preview operational activation `57d6bd1` IS an
ancestor; baseline independently measured **632 tests / 49 files green**,
version consistency (1.3.1 / schema 3) green, secret scan 207 files /
0 findings.

## 2. What was built (ADR-0038/0039 — written BEFORE code)

### 2.1 Registry and seeding (ADR-0038 §2)

- Blueprint `pixel_source_registry_v1.json` imported VERBATIM (single
  source of truth; blueprint files byte-identical) and Zod-validated at
  runtime: version, brand, global policies, all 14 sources with strict
  per-connector config schemas. Fail-safe: any invalid record disables
  the whole pass (`registry_invalid`), never a partial catalog.
- Explicit separate statuses: implemented / configured / enabled /
  blocked. RSS is one generic connector covering all seven registry RSS
  entries (incl. itch_discovery's bounded `endpointTemplates`).
- Bluesky + IGDB: recognized catalog entries, NO runnable handlers
  (`connector_not_implemented`) — never scheduled, never fabricated.
- Idempotent typed-DB seeding (`seedSourcesFromRegistry`): new rows
  insert fully with `enabled = 0`; repeated imports refresh ONLY
  registry-descriptor facts; owner-managed `enabled`/`priority` and
  existing `source_state` rows are never overwritten. Seeding runs on
  the first gated cron pass with an empty `sources` table.

### 2.2 Connector families (ADR-0039 §1; blueprint §8/§9)

All five implemented with the blueprint FetchResult contract
(changed/not_modified/rate_limited/failed; bounded items; cursor/etag/
last-modified; retry-after; ACTUAL request counts), offline fixtures
only:

| Family            | Real request contract (documented + fixture-pinned)                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rss               | configured endpoint or ≤4 template feeds; `If-None-Match` + `If-Modified-Since`; 304 → scheduling-only; per-feed validators in the cursor JSON; ≤100 newest items/feed             |
| steam-news        | `GET ISteamNews/GetNewsForApp/v2/?appid&count&maxlength` (keyless); owner `apps` watchlist; appsPerBatch/maxItemsPerApp respected                                                  |
| youtube-playlists | `playlistItems` (+ ONE `videos` details call) with `X-Goog-Api-Key` HEADER — never `?key=`; search endpoint and video download schema-FORBIDDEN; one page/playlist/poll            |
| reddit-oauth      | `POST /api/v1/access_token` (`grant_type=client_credentials`, Basic header, bounded body) then `GET oauth.reddit.com/r/{sub}/new?limit&raw_json=1` Bearer; NO unauthenticated path |
| github-releases   | `GET /repos/{owner}/{repo}/releases?per_page=25&page=1`; per-repo etag conditional GET; prerelease/draft policy; optional `Authorization: Bearer`                                  |

### 2.3 Safe HTTP + safe XML (ADR-0039 §2/§3)

- `safeFetch`: HTTPS-only; 10 s deadline covering HEADERS AND BODY
  (slow-drip body test); streamed 2 MiB cap regardless of declared
  length; ≤ 2 manually validated redirects (per-hop scheme/host/port/
  userinfo/allowlist re-check; POST degrades to GET; limit enforced);
  `Authorization`/`Cookie`/API-key headers STRIPPED on origin change;
  per-connector positive host allowlists — the REAL SSRF boundary —
  plus literal-layer rejection of all IP literals incl. decimal/octal/
  hex encodings and IPv6. Honest Workers DNS limitation documented (no
  pretend DNS/IP check).
- Hand-rolled bounded XML scanner (zero new runtime dependencies — Zod
  remains the ONLY runtime dependency): `<!DOCTYPE`/`<!ENTITY`/conditional
  sections REJECTED; only predefined + numeric entities decoded; CDATA
  literal; hard depth/element/text/attribute bounds; malformed fails safe.
- Normalization: conservative deterministic canonical URLs (reviewed
  tracking denylist ONLY; query params sorted; path case preserved —
  distinct items never collapse); HTML-as-data plain-text excerpts;
  deterministic SHA-256 content hashes; synthesized external ids for
  id-less feeds; bounded raw provenance (≤ 8 KiB, structured fields);
  validated timestamps (bounded future/past); stripDownloadLinks.

### 2.4 Scheduling, ownership, D1 safety (ADR-0038 §3–§5)

- Cron (gate-gated) does ONE bounded indexed due scan (EXPLAIN-verified
  index seeks on BOTH relations) → durable job FIRST with the
  deterministic window key `sources.poll:<sha256(sourceId‖scheduledForMs)>`
  → atomic reservation (guarded advance to `scheduledForMs + 120 s`
  hold). Overlapping crons derive the SAME key (idempotent create
  absorbs); a later legitimate poll derives a FRESH key; crash between
  reservation and job creation self-heals (hold expiry).
- Blocked sources (empty watchlist / missing credentials / unimplemented
  connector) are skipped at SCHEDULING time with a stable guarded state
  write — no job, no network, no budget spend, no hot loop; the handler
  re-checks preconditions (defense in depth).
- ONE poll attempt per job; retry ownership SPLIT by failure class:
  provider conditions (timeout/5xx/429/malformed/auth) are owned by the
  SOURCE schedule (adaptive backoff `interval×2^failures` capped 30 min,
  ±10 % injected jitter, Retry-After as a TRUE lower bound, 401/403 →
  30-min circuit with stable `credentials_rejected`); the Phase 3
  job-retry path stays infrastructure-only. A pending job retry can
  never race a fresh cron poll into a provider (hold ≥ 120 s window).
- Atomic guarded commit: ALL item inserts + the fenced terminal state
  write in ONE D1 batch. Items: `INSERT OR IGNORE` (both UNIQUE
  constraints absorbed; replay-safe; a CHECK/NOT NULL violation fails
  the WHOLE batch — never partial success). State: fenced on
  `next_poll_at = scheduledForMs + hold` — a stale worker's state write
  changes 0 rows (visible in batch meta) while its items still land;
  a newer poll is NEVER overwritten. Honest post-commit classification
  (inserted / duplicate_external / duplicate_url) via bounded reads.
  304 writes ONLY scheduling/health metadata (validators/cursor pass
  through); a failed page never advances the cursor; per-item malformed
  drop counted.
- Budgets: `budgets(scope='ingestion', budget_key=source, bucket_date=
Asia/Tehran day)` is the single authority; atomic guarded reservation
  BEFORE network (existing-row UPDATE + same-cap INSERT..SELECT in one
  batch); observed extras (redirect hops) reconciled after the fact;
  exhaustion = `budget_exhausted` + 10-min retry, NO ladder increment,
  NO network; day rollover implicit via the PK (no reset write, no
  double-reset race); concurrent race test proves EXACTLY the cap is
  reservable.

### 2.5 Gate and integration (ADR-0038 §1)

- `SOURCE_INGESTION_ENABLED` ('true'|'false', default 'false'; validated
  whenever PRESENT; non-secret): gates due-source scheduling + poll
  handler registration ONLY. Gate off = byte-identical Phase 3 v1.3.1
  behavior (Preview keeps `JOBS_ENABLED=true` untouched). Ingestion on
  - jobs off/invalid → `ingestion_requires_jobs` (readiness 503);
    ingestion on + invalid registry → fail closed. Missing OPTIONAL
    provider secrets block ONLY that source.
- Queue envelopes remain reference-only; payloads carry
  `{sourceId, scheduledForMs}` (strict Zod) — no content, no credentials,
  no URLs. No new public endpoint of any kind.

## 3. Verification (measured on the FINAL tree)

Full gate `npm run check` (lint + format:check + typecheck + test +
test:telegram-setup + test:secrets + scan:secrets + check:versions +
default dry-run build) and `npm run test:db` — recorded numbers in §5.

## 4. Version / schema / dependency touchpoints

- 1.4.0 across package.json, package-lock.json (root + "" packages),
  wrangler.jsonc (root + preview), `DEFAULT_APP_VERSION`, .env.example,
  .dev.vars.example, test-env helper; `check:versions` enforces it.
- Schema stays 3; `SCHEMA_VERSION` touchpoints untouched; applied
  migrations byte-identical (no 0004).
- Runtime dependencies: UNCHANGED (zod only). The XML parser is
  hand-rolled specifically to avoid a dependency whose entity behavior
  must be re-audited per release (ADR-0039 §3). New devDependency: none.
- wrangler.jsonc: preview `SOURCE_INGESTION_ENABLED="false"` added;
  preview `JOBS_ENABLED="true"`, queue producers/consumer, Telegram
  wiring preserved byte-for-byte. Local defaults unchanged + new flag
  (false).

## 5. Measured acceptance evidence (final tree)

Recorded from the actual runs on this exact tree (see §7 for the exact
commands):

- Full test suite: **814 tests, 65 files, all passing** (baseline 632 in
  49 files remain green; +182 new Phase 4 tests).
- `npm run test:db` (13 integration files on real workerd D1): all
  green, including the 27 new Phase 4 integration tests (seed
  idempotency/no-re-enable, full pipeline, budget races/day rollover,
  gate matrix, EXPLAIN query plan).
- lint/format/typecheck: clean. Secret scan: 0 findings.
  check:versions: consistent (1.4.0 / schema 3).
- Builds: default dry-run + preview dry-run clean.

Key pipeline proofs (real workerd D1, scripted source HTTP):

- due → durable job → producer envelope body → engine consume → REAL
  poll handler → normalized `source_items` (+ canonical URL, excerpt,
  hash, bounded raw_json) + fenced `source_state` + budget row → job
  succeeded.
- redelivery + 304 + same-window replay: zero duplicate rows; 304 writes
  no items and no downstream jobs.
- stale-owner fencing: stale poll's items land, newer state untouched.
- crash windows: reservation-without-job recovers by hold expiry;
  consume-side fenced writes absorb replays.
- Retry-After 7200 s honored EXACTLY (never shortened by any cap);
  401/403 circuit blocks scheduling while open; budget-exhausted polls
  make NO network call and do not grow the failure ladder.
- overlapping scheduling passes on the same window: 1 job then 0.

## 6. Deliberate design decisions worth review attention

1. Handler "success after provider failure" — the job's contract is
   "one poll attempt durably recorded"; the SOURCE owns provider retry
   pacing (ADR-0038 §4). This prevents dual retry authorities.
2. The reservation hold (120 s) admits a bounded overlap window after a
   mid-poll crash (at most one reclaim re-execution plus one fresh
   window job); dedup + fencing absorb double fetches. No lease renewal
   was introduced.
3. Seeded sources (window key from `next_poll_at = 0`) may see ONE
   duplicate harmless reference in their seeding tick (hold is brief);
   claim fencing + item dedup absorb it (documented in the runbook).
4. Canonical URL collision across external ids keeps the FIRST-SEEN row
   (`duplicate_url`); changed-content detection under the same URL is
   explicitly deferred to Phase 5 story matching (content hashes are
   already stored for it).
5. YouTube publishedAt prefers the videos-details contract, falling back
   to playlistItems when details fail (degraded but honest provenance).
6. YouTube one-page-per-playlist-per-poll (newest-first) — a bounded
   strategy; deeper pagination is a reviewed future change, not silent.

## 7. Reproduction

```bash
git clone https://github.com/ILIV007/pixel-lort.git   # main = e0cf7a5…
git checkout phase/04-source-ingestion                # HEAD recorded below
npm ci && npm run check && npm run test:db
```

## 8. Remaining blocked configuration (explicit, per source)

- steam_news_watchlist: needs owner `apps` watchlist → `watchlist_empty`.
- youtube_official_watchlist: needs `YOUTUBE_API_KEY` + `playlists`
  watchlist → `credentials_missing` / `watchlist_empty`.
- reddit_crack_signals / reddit_leak_signals: need Reddit OAuth app
  credentials → `credentials_missing`.
- github_release_watchlist: needs owner `repositories` watchlist
  (`GITHUB_TOKEN` optional) → `watchlist_empty`.
- bluesky_watchlist / igdb_metadata: catalog-only this phase
  (`connector_not_implemented`).

Live Preview acceptance (real Cron/Queue path on the provisioned
preview) is performed SEPARATELY after review, using the exact RSS
activation procedure in `docs/RUNBOOK_PHASE4_SOURCES.md`.
