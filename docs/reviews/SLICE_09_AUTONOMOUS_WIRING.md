# Slice 9 — autonomous wiring (source → draft → publish)

Date: 2026-11-21. App 1.47.0, schema 11 (migration 0011). Branch
`slice/09-autonomous-wiring`. Implements the five missing links proven
blocked in `SLICE_08B_AUTONOMOUS_BLOCKED.md`. The blueprint
(`docs/blueprint/v1/`) is untouched; the registry additions live in code
(the dead-source precedent).

## What was wired

- **Link 0 — registry:** VGC / Gematsu / GameSpot RSS added as code-level
  additions (`src/domain/source/additional-sources.ts`, merged through the
  SAME `RegistrySchema` as the embedded catalog; 14 + 3 = 17 sources).
  The scheduler seeds them through the merged registry; the seed creates
  rows with `enabled=0` (the runbook enables the ones needed for a test).
- **Link 1 — ingestion:** unchanged (already worked); sources are enabled
  in D1 per the Phase 4 runbook at test time.
- **Link 2 — ingestion → editorial:** `enqueueFreshSourceItems`
  (`src/application/editorial/enqueue-fresh-items.ts`) scans
  `processing_status='new'` oldest-first, bounded 10/tick, enqueues the
  existing `editorial.prepare_draft` job per item and marks the item
  `queued` (fenced predicate — a second pass sees nothing fresh). Cron
  runs it after the DLQ reconcile, only while `EDITORIAL_ENABLED`.
- **Link 4 — draft → publication:** `bridgeReadyDrafts`
  (`src/application/publishing/auto-publish-bridge.ts`) runs only in
  `auto`/`safe-auto` mode (else it skips with zero writes); it requires a
  resolvable Soul version (else the whole pass skips with zero writes);
  per ready draft (limit 5/tick, oldest first) it runs the ag1 auto-gate
  — eligible only → fenced `auto_approved` → idempotent
  `enqueuePublication` with `publicationId = pub:auto:<draftId>`,
  priority 80 (P1 — required: the test window runs in quiet hours and
  P2/P3 are quiet-gated to 09:30), `approvalMode` auto/safe_auto, and the
  Soul version stamped. Non-eligible drafts stay `ready` for the human
  path; nothing is ever force-approved.
- **Link 5 — publication scheduler:** cron calls
  `scanDuePublications` with the REAL Bot API transport
  (`createBotApiClient`) and the send gate resolved from the SAME D1
  mode read once per tick. The mode read is STRICT
  (`readExplicitPublishMode`): a missing or corrupt mode row reads as
  `paused`, never the panel default `auto`. If `TARGET_CHANNEL` is
  missing, bridge AND scan both skip. The transport adapter casts the
  scheduler content to `RichTextEnvelope`; the client validates it.
- **Migration 0011** (`migrations/0011_autonomous_soul_stamp.sql`):
  `publications.soul_version` (nullable, CHECK ≥ 1) + schema metadata
  11 / `0011_autonomous_soul_stamp`. The autonomous outbox had NO soul
  column at all — the slice-8 contract (every published row carries the
  Soul version) could not be met without it. `enqueuePublication`
  accepts the stamp and refuses a non-positive one.
- **Ownership capability lag (fix, not silent):** the `ownershipEnabled`
  lists in the ingestion scheduler and the poll handler ended at v8 —
  schema v9/v10 never added, although schema-health comments say every
  newer linear state takes the ownership path. Extended to v9, v10, v11.

## The P1 latency defect (found by the slice-9 e2e test, fixed here)

`scanDuePublications` recomputed the policy decision on EVERY scan and
`planPublicationTime` anchored the P1 latency to the decision instant
(`dueAtMs = nowMs + jitterMs`, jitter 5–20 min). A P1 row therefore
deferred to `now + jitter` on every scan, forever — while the
`scheduled_at` the release had just stored was never read anywhere in
the scan path. P0/P2/P3 were unaffected (their due resolves to `now` or
to a fixed past send). The existing suite only ever asserted P1's FIRST
deferral, so the defect was untested.

Fix (backward-compatible, no behavior change for callers that do not
pass it): `PublicationScheduleInputV1` gains the OPTIONAL
`latencyAnchorMs` — the fixed instant the P1 latency runs from; absent
it behaves exactly as before. The scheduler passes
`row.created_at` (the enqueue instant): the due time is then STABLE
across scans (`anchor + jitter`) and the row sends once it passes.
A future anchor is `invalid_input`. Regression tests: unit
(`tests/unit/publication-schedule.test.ts`, anchor stability + legacy

- future-anchor refusal) and the slice-9 full-chain e2e (advance the
  clock past the latency → both P1 publications send, with the 8-minute
  P1 gap between them).

## Test-window flags (NOT in the repo)

Repo vars stay FALSE (fail-closed default). The controlled test window
activates ONLY via deploy-time `--var` overrides
(`SOURCE_INGESTION_ENABLED=true EDITORIAL_ENABLED=true
EDITORIAL_FACT_GUARD_ENABLED=true AI_ENABLED=true`); after the test the
worker is redeployed WITHOUT overrides (flags back to false) and the
mode back to `paused`. `AI_GEMINI_ENABLED` stays false; the
matching/adjudication gates stay false. `EDITORIAL_FACT_GUARD_ENABLED`
must be on: the ag1 auto-gate refuses with `report_absent` when the
fact-guard payload is missing.

## What is NOT built (follow-up, recorded in the PR body)

The **no-AI draft path** (DESIGN §6 requires one to exist) is still
missing: with `AI_ENABLED=false` a prepare-draft job fails `ai_disabled`
and retries to exhaustion. Slice 9 deliberately does NOT build it; it
is tracked as a follow-up, not silently skipped. The test window runs
with AI on for that reason only.

## Tests

- `tests/unit/additional-sources.test.ts` (5): the three additions,
  live-verified endpoints, merged catalog 17 + schema-valid, no
  mutation of the input, collision fails safe.
- `tests/integration/migration-0011.test.ts` (2): v10 baseline → only
  0011 pending → version 11 + migration id; the CHECK on
  `publications.soul_version` (NULL ok, ≥1 ok, 0/negative refused);
  double-apply no-op.
- `tests/integration/slice09-autonomous-wiring.test.ts` (6): drain
  (bounded, oldest-first, claimed once); the FULL chain over real
  workerd D1 (drain → drafts → bridge with `soul_version=1`, priority
  80, `approval_mode=auto` → scheduler scan → both published, ledger
  rows recorded); bridge paused (zero writes, drafts stay ready; scan
  gate-off is decision-only); bridge `requires_review` (ungrounded
  draft never reaches the outbox); bridge soul-unknown (whole pass
  skips); registry seeding (VGC / Gematsu / GameSpot seeded disabled).
- `tests/unit/publication-schedule.test.ts` (+3): the P1 latency anchor.
- `tests/integration/migration-0005.test.ts` updated: the linear chain
  now ends at 11 (rebuild drops the 0011 column; v10 via a stopped
  plan; v11 as the linear final state; recovery paths to 11).

## Live state at write time

Code only — nothing deployed, merged, or written to live D1 yet.
Preview is still v1.46.0 / schema 10, mode `paused`, flags off,
`published_posts=0`. The live sequence (backup → migrate preview →
deploy with overrides → enable sources → mode auto → monitor →
mode paused + redeploy without overrides → verify paused blocks) runs
after merge + CI green, and its message_ids + preview verifications
are reported separately.
