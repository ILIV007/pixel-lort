# PROJECT_STATUS

> Durable Autopilot state file (PROJECT_GUIDE.md §3). No secrets, tokens, or
> private content here. Values not independently observed are recorded UNKNOWN.
> Maintained by the GLM agent; a file write is not a lock or a transaction.

```text
PhaseB-item1 (master-guide Phase 4 recon: source/connector inventory re-verified; R1.22 Phase A remains delivered)
state: RUNNING (Phase-B-1 recon DONE and recorded; gates green on the re-restored tree; backup + FF push + CI observation happen later in this same tick)
base_sha: 1731528601edde9704aa87da52fe02e34ca32e5b (remote head of review/r1.10.3-sql-design observed via API at tick start; = R1.22 Phase A + review round)
head_sha: 1731528 (last delivered checkpoint; this tick appends a PROJECT_STATUS recon-record commit on top — see git log -1)
remote_sha: observed via API 2026-11-06: review/r1.10.3-sql-design @ 1731528 (the R1.22 review round 5a436bd + its status record, both FF-pushed by the previous tick; no force ever used)
pr: #11 (open, draft UNCHANGED, base phase/04-corrections-round191, head 1731528 — all observed via API 2026-11-06)
ci_sha_and_result: Phase 0 quality gate on 1731528 = completed:success (observed via API 2026-11-06 BEFORE restore, on the same SHA this tree was restored from)
last_tests: npm run check exit 0 (1941/1941 tests, 151 files; secret scan 499 files 0 findings; version gate 1.17.0/schema 6) + npm run test:db exit 0 (544/544, 49 files) — re-run independently 2026-11-05T18:3xZ on the freshly re-restored tree
active_run_id: autopilot-2026-11-06-0230-cron (hourly tick; environment had been recycled between ticks)
lock_owner_and_heartbeat: none (single active session; no cross-process lock facility — recorded honestly)
open_blockers_and_review_items: none blocking. Environment recycle LOST the local PROJECT_GUIDE.md extract and the prior download/ backup artifacts (recorded honestly; the remote branch is the durable source of truth and was used for the re-restore). Cloudflare live state remains UNKNOWN (no Cloudflare operations allowed). Free-plan ingestion verdict NOT_READY_FOR_INGESTION_ON_FREE stands (DESIGN-only; lifting requires the accepted design + explicit owner decision).
next_action: Phase B item 1 DONE this tick — all 14 registry sources re-verified against CURRENT code @ 1731528 with ZERO drift vs docs/RUNBOOK_PHASE4_SOURCES.md (recon notes below). Next tick: Phase B item 2 candidates — Free-plan resource-ledger reconciliation from free-plan/FREE_PLAN_RESOURCE_LEDGER.json + audit/ (LOCAL-only, no Cloudflare ops), or harden any Phase A review finding; real watchlists (Steam apps / YouTube playlists / GitHub repos) are OWNER-supplied data and stay honestly blocked until provided; /help advertisement of /post_from_draft only when the owner asks for surfacing.
backup_and_restore_check: DELIVERED /home/z/my-project/download/Pixel-Lores_R1.22-PhaseB1_e2939fd_FULL-BACKUP.zip (SHA-256 60d3f2e6cb5da1469e55f5a933e114eba687c50ee13c3f5bd18c5dd0abcf392d; 501/501 checksums OK from the ZIP; bundle clone git fsck --strict clean; restored in an empty dir HEAD=e2939fd matches; restored tree byte-identical to the source archive). Covers 1731528 + this tick's recon record. The previous ZIP artifacts no longer exist locally (environment recycle — recorded honestly).
updated_at_utc: 2026-11-05T18:38:52Z
```

## R1.22 recon notes (2026-11-05, verified against code @ 1a375ed)

- Two separate draft families exist: editorial drafts (`drafts` table, full document_json with Persian body, story/evidence/reports; read-only via `/drafts`, R1.18 ADR-0046) and admin post drafts (`admin_post_drafts`/`admin_post_versions` migration 0005; capture→preview→approve→publish, R1.20-R1/R1.21). No bridge exists today — that is the R1.22 Phase A gap.
- `admin_post_versions.source_update_id` is NOT NULL: for a converted version the converting COMMAND's own Telegram update id is the honest source (no schema change needed for that field). Provenance to the editorial draft (id+version) requires migration 0006 (append-only ADD COLUMNs, schema 5→6, default NULL for legacy rows, origin_kind default 'capture').
- Post content identity: PostContentDocument (text envelope | media+caption), fingerprint covers everything; conversion produces a TEXT-ONLY document; media conversion stays out of scope (editorial drafts carry no file_id). Text limits enforced by RICH_TEXT_LIMITS — over-limit editorial body = explicit typed failure, never truncation.
- Editorial draft projection must go through the EXISTING strict typed readers (`readPostContentDocument`-style discipline; draft-review-view's defensive document projection) — a malformed/too-large/unready editorial draft is an explicit honest failure, never a fabricated post.
- Publication path unchanged: approval binding, fingerprint re-derivation before every send, uncertain/failed states and human-confirmed re-send all stay exactly as R1.21 built them.

## Phase B item 1 recon — source/connector inventory re-verified (2026-11-06, code @ 1731528, v1.17.0/schema 6)

Method: every claim below was re-derived from CURRENT code and the
byte-identical registry JSON this tick — the v1.4.0-era runbook was NOT
trusted blindly. Result: ZERO drift; the RUNBOOK_PHASE4_SOURCES.md matrix
remains accurate at 1.17.0/schema 6.

- Catalog: `docs/blueprint/v1/pixel_source_registry_v1.json` = 14 sources,
  imported VERBATIM and Zod-validated fail-safe (any invalid record disables
  the whole pass — `src/domain/source/source-registry.ts`).
- Implemented connectors, exactly 5, explicit construction, no fake handlers
  (`src/connectors/registry.ts`): `rss`, `steam-news`, `youtube-playlists`,
  `reddit-oauth`, `github-releases`. Catalog-only, never scheduled:
  `bluesky-public`, `igdb`.
- Gate: `SOURCE_INGESTION_ENABLED` default `'false'` fail-closed
  (`src/shared/config/phase4.ts`); per-source `sources.enabled` is a separate
  owner control; NO source is enabled in the delivered tree (local or preview
  claim unchanged — live Cloudflare state stays UNKNOWN by policy).
- Per-source status (all 14 verified against readiness code, not the doc):
  - implemented + configured, DISABLED (7 RSS sources, endpoints present in
    the registry): playstation_blog, xbox_wire, ign_games, eurogamer_news,
    moddb_news, moddb_headlines, itch_discovery — first activation candidates
    remain playstation_blog + xbox_wire per the runbook.
  - implemented, BLOCKED `watchlist_empty`: steam_news_watchlist (registry
    config carries knobs but NO `apps` — `steam-news.ts:103`),
    github_release_watchlist (`repositories: []` — `github-releases.ts:72`;
    `GITHUB_TOKEN` optional), youtube_official_watchlist (no `playlists` in
    registry config + `YOUTUBE_API_KEY` missing — `youtube-playlists.ts`).
  - implemented, BLOCKED `credentials_missing`: reddit_crack_signals,
    reddit_leak_signals (`REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET` —
    `reddit-oauth.ts:99`; the subreddits ARE in the registry:
    CrackWatch, GamingLeaksAndRumours).
  - catalog-only (`connector_not_implemented`): bluesky_watchlist,
    igdb_metadata.
- Free-plan: the standing verdict `NOT_READY_FOR_INGESTION_ON_FREE` for the
  advertised full-poll profile is re-confirmed
  (`free-plan/FREE_SAFE_EXECUTION_DESIGN.md` v3, R1.10.4.1: measured
  100 new items = 110 execution-API-call attempts / 211 statements vs the
  documented Free row "Queries per Worker invocation … 50"). The Free-safe
  design is DESIGN REVIEW / lab evidence ONLY — nothing implemented, and no
  later round lifted it; lifting requires the accepted design + an explicit
  owner decision (docs/ROADMAP.md Phase 4 header).
- Honest blockers for real ingestion: watchlists are OWNER-supplied data
  (the project must not invent app IDs, playlist IDs or repositories);
  credentials are Cloudflare secrets only; any activation additionally
  needs the Free-safe design accepted + owner decision. No Cloudflare
  operation was performed or is allowed by this workflow.

## Hourly tick log (newest first)

- 2026-11-05T18:38Z — hourly cron tick: environment had been recycled AGAIN (pixel-work, the restore dir and the prior download/ backup artifacts all gone; only upload/ survived). Re-restored from the remote branch review/r1.10.3-sql-design @ 1731528 (tip + PR #11 state + CI completed:success on that exact SHA all observed via API first), created branch work at the tip, tree clean, git fsck --strict clean. Gates re-run green on the fresh tree (1941 + 544, real exit codes 0). Phase B item 1 (master-guide Phase 4 item 1) executed: the source/connector inventory re-verified against CURRENT code — zero drift vs the v1.4.0 runbook; Free-plan NOT_READY verdict re-confirmed from the design doc. No Cloudflare operation, no real send, no source enabled, no flag changed. Backup + FF push with the owner PAT + CI observation follow this commit.
- 2026-11-05T17:50Z — R1.22 review round (master guide immediate step item 2 — compatibility of the manual R1.20-R1/R1.21/R1.22 versions): re-verified the migration chain/legacy-data/RBAC/callback/media/integrity coverage (all pinned by existing suites); the ONE uncovered gap found was concurrency fencing for the NEW editorial path — added tests/integration/admin-post-editorial-atomicity.test.ts (+4): losing conversions roll back with ZERO side effects (unique-index fence, whole-batch atomicity), the REAL bind->convert->approve interleaving answers stale, and a different-creator second conversion is the honest pointer. Environment had been RECYCLED between ticks: repo re-restored from the remote branch (a011b70, fsck clean) per the idempotent-restart rule; guides re-extracted from the owner-provided R1.21 package. Gates re-run green (1941 + 544). No Cloudflare operation, no real send.

- 2026-11-05T16:25Z — R1.22 Phase A DELIVERED: FF push 25d965d..d5a3162 to review/r1.10.3-sql-design (PR #11 head updated, Draft state untouched); CI "Phase 0 quality gate" on d5a3162 observed completed:success via API; backup ZIP Pixel-Lores_R1.22-PhaseA_d5a3162_FULL-BACKUP.zip delivered with full restore+fsck evidence (500/500, SHA-256 above). No Cloudflare operation, no real send, token never persisted.

- 2026-11-05T16:05Z — R1.22 Phase A IMPLEMENTED end-to-end (M1–M5): migration 0006 (rebuilt admin_post_versions: nullable source_update_id + editorial_draft_id/editorial_draft_version + EXACTLY-ONE-origin CHECK + partial UNIQUE per-editorial-draft-version index; legacy rows copied byte-identically; schema 5→6), pure deterministic render (unverified structural, no fabrication, typed no-truncation), /post_from_draft command (flag EDITORIAL_TO_POST_ENABLED default OFF + draft.create + private chat), service conversion with idempotent already-derived pointer and existing-draft version bump invalidating older approvals, ingress/webhook wiring, capability resolver v6. Tests: +8 render unit, +6 migration-0006 (upgrade from populated schema-5 incl. CHECK/UNIQUE negatives), +5 REAL-path bridge integration (ids/tokens only from real bot replies; live-OFF honest stop; live-ON exact single channel send). Schema-pinning suites updated coherently (d1-schema 38 indexes, chain-to-6, capability detection v5-stopped + v6). Gates re-run green (1937 + 544). Next: backup ZIP + FF push + CI observation.

- 2026-11-05T15:20Z — R1.22 recon completed (notes above); CI on final pushed SHA 1a375ed observed completed:success; PR #11 open/draft @ 1a375ed. Next tick: start M1 (RED tests).
- 2026-11-05T15:05Z — R1.21 DELIVERED: FF push 6d76503..752667f to review/r1.10.3-sql-design (PR #11 head updated, Draft state untouched); CI "Phase 0 quality gate" on 752667f observed completed:success via API; backup ZIP delivered with full restore+fsck evidence (SHA-256 above). Beginning Phase A (R1.22) recon.
- 2026-11-05T14:55Z — initial round (manual): pre-checks done (guides read, R1.21 bundle restored to /home/z/pixel-work on branch `work`, HEAD fd04f7f verified, fsck clean, clean tree, 491 tracked files). PAT validated via API (push permission confirmed on ILIV007/pixel-lort). Gates re-run green (1917 + 538). Hourly cron registered in the platform (top of each hour, Asia/Tehran). Next: FF push + CI observation + backup, then Phase A (R1.22) recon.
