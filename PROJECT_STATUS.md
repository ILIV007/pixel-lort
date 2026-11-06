# PROJECT_STATUS

> Durable Autopilot state file (PROJECT_GUIDE.md §3). No secrets, tokens, or
> private content here. Values not independently observed are recorded UNKNOWN.
> Maintained by the GLM agent; a file write is not a lock or a transaction.

```text
PhaseB (V2 AUTOPILOT adopted: guide PIXEL_CONTINUATION_AND_PHASES_04_TO_13_FA.md + correction 01_CRON_AND_DURABLE_CHECKPOINTS_FA.md; issue #12 fix independently verified and EXTENDED; owner provided a fresh limited PAT in chat this tick)
state: DONE for this checkpoint (pushed 2dfba5a->31eee34 FF, CI success observed on 31eee34; V2 package verified 509/509 SHA256SUMS; bundle restored to a fresh dir, fsck --full clean, chain 2dfba5a -> 174c8d6 -> 9a72de2 ancestor-verified; #12 RED on 174c8d6 = 4 failed incl. orphan-version commit, GREEN on 9a72de2+extension = 9/9 with reviewer tests byte-identical; zod GHSA-mrhx-c7xc-m3w5 exposure assessed - every untrusted network boundary is byte-capped via safe-http readStreamBounded before parse/validate, so no unbounded collection reaches zod; zod@4 upgrade recorded as a separate gated dependency migration, npm audit fix --force NOT run; gates green)
phase / subphase: issue-#12 close-out -> next per V2 guide section 3.6 = B4 recheck, then Phase 4.2-4.4 continuous
active owner / lock mechanism / fencing generation / heartbeat / proof: none (single active session; no cross-process lock facility on this platform - recorded honestly per V2 guide section 4)
base_sha: 2dfba5aa9504feb12d9dc18c09e97a73d1f83d41 (remote review/r1.10.3-sql-design tip observed via API this tick; PR #11 open draft, head 2dfba5a, base phase/04-corrections-round191)
head_sha / tree: local work branch = 70cc73b (test commit) + PROJECT_STATUS commit on top; clean tree; the status commit records last_verified_sha=70cc73b by design (self-reference avoided per correction section 3)
last_verified_sha: 70cc73b
remote branch+SHA: review/r1.10.3-sql-design @ 2dfba5a (pre-push observation 2026-11-06T17:0xZ via API with the NEW owner PAT - repo/branch/PR/issue endpoints all HTTP 200)
pr: #11 open draft UNCHANGED; push plan: fast-forward ONLY, 2dfba5a -> 174c8d6 -> 9a72de2 -> 70cc73b -> status commit, no force, no merge, no Draft change
ci_sha_and_result: Phase 0 quality gate on 2dfba5a = completed:success (previous observation re-confirmed via API this tick); CI on the NEW pushed tip will be observed on that exact SHA after push and reported in the tick report - not pre-claimed
checks executed + exit codes + counts: npm run check exit 0 (151 files / 1946 tests = 1941 baseline + 2 reviewer race tests + 3 independent-review regressions; secret scan 0 findings; version gate 1.17.0/schema 6) + npm run test:db exit 0 (49 files / 544 tests)
open bugs and severity: issue #12 race = FIXED+fenced (verified RED/GREEN) - independent verification only, Posidon acceptance still required; zod GHSA = mitigated upstream (bounded boundaries), upgrade planned separately; OD-009 OPEN (owner decision, no purge); Cloudflare live state UNKNOWN (no Cloudflare operations allowed)
backup: PENDING this tick - ZIP (git archive + bundle + SHA256SUMS) to /home/z/pixel-work/backups AND /home/z/my-project/download/, restore-tested in a fresh dir + git fsck, SHA-256 recorded in the tick report after the test
next EXACT action: (1) commit + push this B4 docs record (FF only); (2) observe CI on the new tip; (3) fresh backup ZIP; (4) next ticks per V2 guide section 6: Phase 4.2 (input security re-verify) and 4.3 (Free-safe local harness measurement) are the next IMPLEMENTATION candidates — all live/activation gates stay owner/Posidon
updated_at_utc: 2026-11-06T17:02:11Z (set by updater)
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

## Phase B consolidated recon record (re-recorded 2026-11-06T22:55Z after TWO environment recycles; evidence originally verified at the same SHA 2dfba5a in the 19:30Z and 21:30Z ticks — their local commits 2664952/29651a1 and fca050c/22bf97f were never pushed and are unrecoverable; product code unaffected)

- **B1 (guide §4-B1) — CLOSED.** Free-plan ledger (R1.10.2 @ f7020564)
  reconciled against the current tree: ingestion commit path shape UNCHANGED
  (source-ingest-store.ts: ONE atomic batch line 245 + bounded post-commit
  per-item probes lines 255/263/274); grouped candidate exists ONLY in
  design-lab/. Official limits re-verified 2026-11-06 from current
  Cloudflare docs: D1 Free 50 queries/invocation CONFIRMED (db.batch() =
  ONE query — the ledger's counting basis; measured anchors 110/210/1001
  xAPI still exceed 50) → NOT_READY_FOR_INGESTION_ON_FREE stands; Workers
  rows CONFIRMED; Queues 24 h retention CONFIRMED (ops/day + D1 rows/day
  rows honestly marked not-re-verified-today).
- **B2 (guide §4-B2) — verified, no structural gap.** Item dedup
  STRUCTURAL (UNIQUE pairs + runtime probes, whole-batch abort on unrelated
  violations); evidence provenance STRUCTURAL (NOT NULL FKs + stored
  excerpt + stance-unique); story dedup via story_fingerprints (6 kinds),
  suite-pinned; INGESTION_LIMITS + allowlist/SSRF unchanged.
- **B3 (guide §4-B3) — pass delivered; ONE finding → OD-009.**
  Matching/ambiguity/similar-events claims (5A–5E) verified against ROADMAP
  (5E-1 honestly marked UNDER INDEPENDENT REVIEW, OFF); no false claim.
  Finding: storeRawDays=90 registry-validated but UNENFORCED — now recorded
  as **OD-009 (Open)** in docs/OPEN_DECISIONS.md with options A/B/C/D,
  schema interactions (dedup memory, evidence FK, snapshot verification),
  fail-closed implementation requirements, and recommendation A-or-C.
  Deliberately NOT implemented: data deletion is an owner decision.

## Phase B4 recon record — real-path inventory (2026-11-06, code @ pushed chain 2df..31eee34, V2 guide section 3.6)

- **Ingestion leg (gate OFF):** cron -> scheduleDueSources -> jobs engine ->
  poll-handler -> safe-http (HTTPS-only, 10 s deadline, 2 MiB streamed byte
  cap) -> 5 connectors -> atomic commit (ONE batch + bounded probes).
  Suites: source-poll-pipeline (full pipeline + gate-off), ingestion-budget,
  ingestion-gate, connector families, round17/18 budget authority.
- **Ingestion -> editorial TRIGGER LINK: ABSENT IN PRODUCTION (verified,
  deliberate).** Registered job types are exactly TWO (sources.fetch_poll,
  editorial.prepare_draft); `enqueueEditorialPrepareDraft` has NO production
  caller (tests only); the poll handler does NOT enqueue prepare_draft.
  Matches ROADMAP: Phase 5 is "PARTIAL in a bounded way" — the vertical
  slice starts FROM an existing source_item; the full engine is explicitly
  future. NOT a code defect. Wiring this link requires (a) the Free-safe
  design ACCEPTED + (b) an explicit owner activation decision — owner/
  Posidon territory, unchanged by this recon.
- **Editorial leg (gate OFF):** prepare_draft handler = item -> snapshot
  hash verify -> story (+6 fingerprint kinds) -> bounded candidate discovery
  (<=9-row probes) -> conservative assessment -> exact-content reuse ->
  aliases/mentions -> bounded event-relations -> evidence -> Persian ready
  draft. Suites: editorial-source-to-draft (7 scenarios incl. replay,
  concurrent owner, mid-commit failure, stale lease, gates, malformed AI),
  story-candidates (+demo), candidate-assessment-persistence,
  exact-content-reuse (+ R1.15.1/.2), entity-mentions, event-relations,
  evidence-guard-persistence.
- **Review/publish leg:** admin-review-* (R1.18 read-only), admin-post-media
  / role-flow-ui / send-integrity (R1.20/R1.21: capture->preview->approve->
  fingerprint re-derivation), R1.22 bridge /post_from_draft (flag OFF;
  atomicity suite incl. this round's independent-review extension).
- **Honest gaps (ROADMAP-unchecked, not new findings):** story MERGING /
  semantic matching; AI adjudication at scale beyond 5E-1. A single
  cron-driven ALL-legs live test remains IMPOSSIBLE until the trigger link
  is decided + Free gate lifts — local per-leg suites with REAL D1 are the
  deepest existing evidence.

## Hourly tick log (newest first)

- 2026-11-06T17:11:46Z — V2 tick continued (post-push): CI "Phase 0 quality gate" on 31eee34 observed completed:success via API; PR #11 head now 31eee34 (open draft, untouched). Issue #12 comment attempt = HTTP 403 (PAT lacks issue-write scope — NOT retried per discipline; evidence lives in PROJECT_STATUS + commits + chat report). B4 recheck DELIVERED (section above): per-leg real-D1 inventory complete; the ONLY missing link is the deliberate ingestion->prepare_draft auto-enqueue (ROADMAP-bounded future; needs accepted Free-safe design + owner decision). No code change this continuation (docs-only). Gates for the docs commit: see last_tests.
- V2 AUTOPILOT tick (owner message + package Pixel-Lores_AUTOPILOT_V2_PHASE4-13_9a72de2): guide set replaced (00_PROMPT_FOR_GLM_V2 + 01_CRON correction + PIXEL_CONTINUATION_AND_PHASES_04_TO_13; REFERENCE_PREVIOUS_MASTER_GUIDE read as historical only). Environment recycled (pixel-work gone) -> restored from the PACKAGE per V2 section 3 (not from guesses): SHA256SUMS 509/509 OK, bundle cloned fresh, git fsck --full clean, chain 2dfba5a->174c8d6->9a72de2 ancestor-verified, branch work at 9a72de2. Issue #12 closed INDEPENDENTLY: reviewer fence (guarded INSERT ... SELECT WHERE EXISTS + changes() gates) reviewed; RED on 174c8d6 (4 failed: both cancel-before-batch paths commit an orphan version; approvals partial-state assertions fire), GREEN on 9a72de2 9/9 after +3 GLM regression tests (approval-state == cancel-only control fixture, head untouched, success path intact; reviewer tests byte-identical). zod GHSA-mrhx-c7xc-m3w5 (high, <4.6.6, installed 3.25.76 = latest 3.x): exposure assessed - all untrusted network input byte-capped upstream (safe-http readStreamBounded fail-closed, MAX_ITEMS_PER_FEED=100, telegram 1MB, AI 1MB) -> no unbounded collection reaches zod; compatible remediation = keep boundary caps + plan zod@4 as a separate gated migration; npm audit fix --force NOT run. Gates: npm run check exit 0 (151 files / 1946 tests), npm run test:db exit 0 (49 / 544). NEW owner PAT validated cheaply via API (repo/branch/PR/issue = 200). Push/CI/cron-consolidation follow this commit per the pre-push checks.

- 2026-11-05T22:55Z — hourly cron tick (06:30 +08): environment recycled again (third consecutive); re-restored from remote @ 2dfba5a (work, clean tree, fsck --strict clean; remote tip + PR #11 + CI success on 2dfba5a observed via API first; old token cheap-tested READ-ONLY = 200, push not attempted — no new PAT). Gates re-run green (1941 + 544). Guide §4-B3 continuation DELIVERED: OD-009 (retention policy decision options for storeRawDays=90) recorded in docs/OPEN_DECISIONS.md — options only, no code change; the post-edit check run honestly FAILED (exit 1, prettier table formatting) and was FIXED and re-run to exit 0 (1941 + 544). Lost local commits of the 21:30Z tick (fca050c/22bf97f) recorded as unrecoverable; B recon re-recorded compactly above. No Cloudflare operation, no real send, no flag change, no source enabled. Backup delivered (restore-tested, fsck clean) with the honest ephemerality warning.

- (re-recorded from lost context) 2026-11-05T21:58Z — tick: B3 verification pass executed (matching/ambiguity/similar-events verified; storeRawDays=90 validated-but-unenforced found); local commits fca050c/22bf97f + backup ZIP lost to the 22:0xZ recycle.

- (re-recorded from lost context) 2026-11-05T19:52Z — tick: B1 closed (ledger reconciliation + official-docs re-verification); B2 recon (no structural gap); local commits 2664952/29651a1 + backup ZIP lost to the 21:0xZ recycle.
- 2026-11-05T18:38Z — hourly cron tick: environment had been recycled AGAIN (pixel-work, the restore dir and the prior download/ backup artifacts all gone; only upload/ survived). Re-restored from the remote branch review/r1.10.3-sql-design @ 1731528 (tip + PR #11 state + CI completed:success on that exact SHA all observed via API first), created branch work at the tip, tree clean, git fsck --strict clean. Gates re-run green on the fresh tree (1941 + 544, real exit codes 0). Phase B item 1 (master-guide Phase 4 item 1) executed: the source/connector inventory re-verified against CURRENT code — zero drift vs the v1.4.0 runbook; Free-plan NOT_READY verdict re-confirmed from the design doc. No Cloudflare operation, no real send, no source enabled, no flag changed. Backup + FF push with the owner PAT + CI observation follow this commit.
- 2026-11-05T17:50Z — R1.22 review round (master guide immediate step item 2 — compatibility of the manual R1.20-R1/R1.21/R1.22 versions): re-verified the migration chain/legacy-data/RBAC/callback/media/integrity coverage (all pinned by existing suites); the ONE uncovered gap found was concurrency fencing for the NEW editorial path — added tests/integration/admin-post-editorial-atomicity.test.ts (+4): losing conversions roll back with ZERO side effects (unique-index fence, whole-batch atomicity), the REAL bind->convert->approve interleaving answers stale, and a different-creator second conversion is the honest pointer. Environment had been RECYCLED between ticks: repo re-restored from the remote branch (a011b70, fsck clean) per the idempotent-restart rule; guides re-extracted from the owner-provided R1.21 package. Gates re-run green (1941 + 544). No Cloudflare operation, no real send.

- 2026-11-05T16:25Z — R1.22 Phase A DELIVERED: FF push 25d965d..d5a3162 to review/r1.10.3-sql-design (PR #11 head updated, Draft state untouched); CI "Phase 0 quality gate" on d5a3162 observed completed:success via API; backup ZIP Pixel-Lores_R1.22-PhaseA_d5a3162_FULL-BACKUP.zip delivered with full restore+fsck evidence (500/500, SHA-256 above). No Cloudflare operation, no real send, token never persisted.

- 2026-11-05T16:05Z — R1.22 Phase A IMPLEMENTED end-to-end (M1–M5): migration 0006 (rebuilt admin_post_versions: nullable source_update_id + editorial_draft_id/editorial_draft_version + EXACTLY-ONE-origin CHECK + partial UNIQUE per-editorial-draft-version index; legacy rows copied byte-identically; schema 5→6), pure deterministic render (unverified structural, no fabrication, typed no-truncation), /post_from_draft command (flag EDITORIAL_TO_POST_ENABLED default OFF + draft.create + private chat), service conversion with idempotent already-derived pointer and existing-draft version bump invalidating older approvals, ingress/webhook wiring, capability resolver v6. Tests: +8 render unit, +6 migration-0006 (upgrade from populated schema-5 incl. CHECK/UNIQUE negatives), +5 REAL-path bridge integration (ids/tokens only from real bot replies; live-OFF honest stop; live-ON exact single channel send). Schema-pinning suites updated coherently (d1-schema 38 indexes, chain-to-6, capability detection v5-stopped + v6). Gates re-run green (1937 + 544). Next: backup ZIP + FF push + CI observation.

- 2026-11-05T15:20Z — R1.22 recon completed (notes above); CI on final pushed SHA 1a375ed observed completed:success; PR #11 open/draft @ 1a375ed. Next tick: start M1 (RED tests).
- 2026-11-05T15:05Z — R1.21 DELIVERED: FF push 6d76503..752667f to review/r1.10.3-sql-design (PR #11 head updated, Draft state untouched); CI "Phase 0 quality gate" on 752667f observed completed:success via API; backup ZIP delivered with full restore+fsck evidence (SHA-256 above). Beginning Phase A (R1.22) recon.
- 2026-11-05T14:55Z — initial round (manual): pre-checks done (guides read, R1.21 bundle restored to /home/z/pixel-work on branch `work`, HEAD fd04f7f verified, fsck clean, clean tree, 491 tracked files). PAT validated via API (push permission confirmed on ILIV007/pixel-lort). Gates re-run green (1917 + 538). Hourly cron registered in the platform (top of each hour, Asia/Tehran). Next: FF push + CI observation + backup, then Phase A (R1.22) recon.
