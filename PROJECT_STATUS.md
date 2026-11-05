# PROJECT_STATUS

> Durable Autopilot state file (PROJECT_GUIDE.md §3). No secrets, tokens, or
> private content here. Values not independently observed are recorded UNKNOWN.
> Maintained by the GLM agent; a file write is not a lock or a transaction.

```text
phase_id: PhaseA-R1.22 (M1–M5 implemented, gates green)
state: RUNNING (checkpoint delivery: backup + push + CI pending this tick)
base_sha: 6d76503c3e92dc7efe1454a04831bcb71779af91 (pre-push remote head of review/r1.10.3-sql-design)
head_sha: ab489d7 (R1.22 Phase A feature commit on top of 25d965d)
remote_sha: observed 6d76503 -> 752667f -> 85cbb59 -> 1a375ed (all fast-forward, no force, 2026-11-05)
pr: #11 (open, draft UNCHANGED, base phase/04-corrections-round191, head 752667f observed via API after push)
ci_sha_and_result: Phase 0 quality gate on 752667f = completed:success (observed via API 2026-11-05; CI is read-only, no deploy steps)
last_tests: npm run check exit 0 (1937/1937 tests, 150 files; prettier/eslint/tsc clean; secret scanner selftest 10/10; scan 492 files 0 findings; version gate 1.17.0/schema 6; dry-run build 786.74 KiB) + npm run test:db exit 0 (544/544, 49 files) — re-run independently on 2026-11-05 after the R1.22 Phase A implementation
active_run_id: autopilot-2026-11-05-initial (manual round, not a cron tick)
lock_owner_and_heartbeat: none (single active session in this environment; no cross-process lock facility — recorded honestly)
open_blockers_and_review_items: none blocking. Notes: origin/main (e0cf7a5) is the old Phase 3 mainline (v1.3.1) and does NOT contain this line of work; target branch for this workflow stays review/r1.10.3-sql-design per PROJECT_GUIDE §7. Cloudflare live state remains UNKNOWN (no Cloudflare operations allowed).
next_action: R1.22 implementation micro-phases in order — (M1) RED tests: conversion command contract (permission draft.create, private chat, unknown/too-large/not-ready editorial drafts rejected explicitly, NO silent truncation at post text limits); (M2) migration 0006 append-only: admin_post_versions.origin_kind TEXT NOT NULL DEFAULT 'capture', editorial_draft_id TEXT NULL, editorial_draft_version INTEGER NULL, schema 5→6, upgrade test from 0005 state + rollback path, all flags default OFF; (M3) /post_from_draft <editorialDraftId> editor command: read ready editorial draft via existing typed readers, deterministic Persian text projection, create admin post draft version 1 as text-only PostContentDocument (source_update_id = the command's own update id), provenance columns stored, then the EXISTING preview/approve/publish flow unchanged; (M4) integration test: source fixture → editorial job with artificial AI/network → draft → /post_from_draft → /post_preview → approve → fake channel request; regression suites admin-post-media/role-flow/send-integrity must stay green; (M5) docs: ADMIN_POST.md usage+limits, ADR, ROADMAP, version bump per repo convention.
backup_and_restore_check: DELIVERED /home/z/my-project/download/Pixel-Lores_R1.21-Delivered_85cbb59_FULL-BACKUP.zip (SHA-256 b9f34b06458c0b340732b0db7d7aa1b34d2e954a2e92ef9cc24706f7d27d5fcf; 494/494 checksums OK from ZIP; bundle verify OK; restored in empty dir HEAD=85cbb59; git fsck clean; tree clean). This commit's own status-line correction is bookkeeping-only relative to that artifact and is covered by the next checkpoint backup. Input R1.21 package also re-verified (494/494 OK, restore HEAD=fd04f7f, fsck clean).
updated_at_utc: 2026-11-05T16:05:00Z
```

## R1.22 recon notes (2026-11-05, verified against code @ 1a375ed)

- Two separate draft families exist: editorial drafts (`drafts` table, full document_json with Persian body, story/evidence/reports; read-only via `/drafts`, R1.18 ADR-0046) and admin post drafts (`admin_post_drafts`/`admin_post_versions` migration 0005; capture→preview→approve→publish, R1.20-R1/R1.21). No bridge exists today — that is the R1.22 Phase A gap.
- `admin_post_versions.source_update_id` is NOT NULL: for a converted version the converting COMMAND's own Telegram update id is the honest source (no schema change needed for that field). Provenance to the editorial draft (id+version) requires migration 0006 (append-only ADD COLUMNs, schema 5→6, default NULL for legacy rows, origin_kind default 'capture').
- Post content identity: PostContentDocument (text envelope | media+caption), fingerprint covers everything; conversion produces a TEXT-ONLY document; media conversion stays out of scope (editorial drafts carry no file_id). Text limits enforced by RICH_TEXT_LIMITS — over-limit editorial body = explicit typed failure, never truncation.
- Editorial draft projection must go through the EXISTING strict typed readers (`readPostContentDocument`-style discipline; draft-review-view's defensive document projection) — a malformed/too-large/unready editorial draft is an explicit honest failure, never a fabricated post.
- Publication path unchanged: approval binding, fingerprint re-derivation before every send, uncertain/failed states and human-confirmed re-send all stay exactly as R1.21 built them.

## Hourly tick log (newest first)

- 2026-11-05T16:05Z — R1.22 Phase A IMPLEMENTED end-to-end (M1–M5): migration 0006 (rebuilt admin_post_versions: nullable source_update_id + editorial_draft_id/editorial_draft_version + EXACTLY-ONE-origin CHECK + partial UNIQUE per-editorial-draft-version index; legacy rows copied byte-identically; schema 5→6), pure deterministic render (unverified structural, no fabrication, typed no-truncation), /post_from_draft command (flag EDITORIAL_TO_POST_ENABLED default OFF + draft.create + private chat), service conversion with idempotent already-derived pointer and existing-draft version bump invalidating older approvals, ingress/webhook wiring, capability resolver v6. Tests: +8 render unit, +6 migration-0006 (upgrade from populated schema-5 incl. CHECK/UNIQUE negatives), +5 REAL-path bridge integration (ids/tokens only from real bot replies; live-OFF honest stop; live-ON exact single channel send). Schema-pinning suites updated coherently (d1-schema 38 indexes, chain-to-6, capability detection v5-stopped + v6). Gates re-run green (1937 + 544). Next: backup ZIP + FF push + CI observation.

- 2026-11-05T15:20Z — R1.22 recon completed (notes above); CI on final pushed SHA 1a375ed observed completed:success; PR #11 open/draft @ 1a375ed. Next tick: start M1 (RED tests).
- 2026-11-05T15:05Z — R1.21 DELIVERED: FF push 6d76503..752667f to review/r1.10.3-sql-design (PR #11 head updated, Draft state untouched); CI "Phase 0 quality gate" on 752667f observed completed:success via API; backup ZIP delivered with full restore+fsck evidence (SHA-256 above). Beginning Phase A (R1.22) recon.
- 2026-11-05T14:55Z — initial round (manual): pre-checks done (guides read, R1.21 bundle restored to /home/z/pixel-work on branch `work`, HEAD fd04f7f verified, fsck clean, clean tree, 491 tracked files). PAT validated via API (push permission confirmed on ILIV007/pixel-lort). Gates re-run green (1917 + 538). Hourly cron registered in the platform (top of each hour, Asia/Tehran). Next: FF push + CI observation + backup, then Phase A (R1.22) recon.
