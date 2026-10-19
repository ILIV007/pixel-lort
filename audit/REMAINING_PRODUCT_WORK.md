# PIXEL — Remaining Product Work Register — R1.10.2 corrected edition

**Round 1.10.2 — inventory only (corrected edition; the R1.10.1 edition is
preserved inside the sealed input `input/R1.10.1_61a01947_ORIGINAL.zip`).**
Every item is derived from the accepted tree's own documents and code
(`docs/ROADMAP.md`, `docs/blueprint/v1/*`, `src/editorial/README.md`,
`src/domain/README.md`, `migrations/0001_initial_schema.sql`). Items marked
**UNRESOLVED-DECISION** require owner policy before anyone implements them;
they are proposals here and are NOT silently implemented or decided in this
round. Phase 5 implementation is explicitly NOT started in Rounds 1.10,
1.10.1 or 1.10.2.
**R1.10.2 corrections carried (TR-04):** application-level recovery is
IMPLEMENTED and locally measured (expired-claim reclaim, stranded-queued
re-kick, DLQ reconciliation send — see capability matrix §7 and tool traces
T-27/T-28); the register below lists only what genuinely remains. Free-plan
caveats are attached where a future phase touches a service whose Free
allowance is separate from Workers Free (owner constraint: Free-plan-first,
no paid activation; the advertised ingestion profile is
NOT_READY_FOR_INGESTION_ON_FREE pending the accepted Free-safe design).

## 1. Roadmap phases not started (docs/ROADMAP.md)

| Phase | Scope (from ROADMAP) | Status | Notes / owner decisions |
|---|---|---|---|
| 5 — Story/claim/evidence engine | Fingerprints, entity aliases, deterministic matching + thresholds; AI adjudication path (compact claim sets) and decision persistence | ⬜ NOT IMPLEMENTED (`src/domain/README.md`: "Domain code must not be added before its phase") | Schema already ported in 0001 (stories/claims/evidence/fingerprints) — dormant |
| 6 — AI adapters, prompt contracts, Persian editorial | Provider routing with fallbacks; Zod-validated semantic outputs; immutable prompt versions; Persian editorial drafts; fact guard | ⬜ NOT IMPLEMENTED (`src/editorial/README.md`: "No code exists") | Secret NAMES reserved (`GEMINI_API_KEY`, `GROQ_API_KEY`); binding `AI` commented. **Free-plan caveat:** external AI providers and Workers AI have their OWN pricing/allowances — Workers Free does NOT make them free; separate review required before this phase |
| 7 — Media engine & album publisher | Media candidates, rights policy, R2 temporary storage, album planning; Telegram upload with `file_id` reuse + R2 retention cleanup | ⬜ NOT IMPLEMENTED | Binding `MEDIA` (R2) commented; UNRESOLVED-DECISION: rights policy defaults. **Free-plan caveat:** R2 has its own free tier/limits — separate review required |
| 8 — Publication scheduler, edit & correction | Tehran-window scheduling, anti-robot rules, priority classes; edit/correction workflows; failed-publication idempotency | ⬜ NOT IMPLEMENTED | **GATE (ADR-0032):** publishing-side duplicate mitigation MUST be designed/implemented/tested BEFORE autonomous publishing — exactly-once DB ownership ≠ exactly-once Telegram delivery |
| 9 — Admin Telegram screens | Command map, screens, opaque action tokens, multi-step sessions | ⬜ NOT IMPLEMENTED (callback routing deliberately noop; token primitives already tested) | UNRESOLVED-DECISION: which of the 17 blueprint commands ship first |
| 10 — Security hardening & budget controls | Security test suite (webhook spoofing, replay, SSRF, injection); budget counters & soft-limit enforcement | ⬜ partial primitives exist (SSRF/XML/webhook suites); hardening phase itself ⬜ | — |
| 11 — Shadow mode | 7–14 day shadow run instrumentation; blueprint §25 metrics gates | ⬜ NOT IMPLEMENTED | UNRESOLVED-DECISION: metrics gate thresholds confirmation |
| 12 — Private test channel | Test-channel publication verification on real clients | ⬜ NOT IMPLEMENTED | UNRESOLVED-DECISION: test channel identity is owner-owned |
| 13 — Production rollout | `safe_auto` → `auto` staged rollout; final default `AUTO` | ⬜ NOT IMPLEMENTED | UNRESOLVED-DECISION: rollout ladder acceptance metrics |

## 2. Implemented-but-dormant code (wired later by the phases above)

| Item | Evidence | Activated by |
|---|---|---|
| `getMe` client method (bot username verification) | `src/adapters/telegram/bot-api-client.ts` | Phase 9 router hardening (`expectedBotUsername` wiring) |
| `editMessageText` client method | same | Phase 8 edit/correction workflows |
| `answerCallbackQuery` + action-token/callback contract | `bot-api-client.ts`; `src/adapters/telegram/action-tokens.ts` | Phase 9 screens |
| Approval schema columns (`publications.approval_mode`, `drafts.status` approval states, `sources.approval_policy`, thresholds) | `migrations/0001_initial_schema.sql`; blueprint spec | Phases 5/8/13; AUTO default preserved until then |
| `TARGET_CHANNEL` config (validated, unconsumed) | `src/shared/config/phase2.ts` | Phase 8 publishing |
| Catalog-only connectors `bluesky-public`, `igdb` | `src/domain/source/types.ts` | Later ingestion extension (owner decision to enable sources) |

## 3. Infrastructure / operational gaps (owner-runbook territory)

| Item | Evidence | Status |
|---|---|---|
| Preview queue provisioning (`pixel-jobs-preview`, `pixel-dlq-preview`) | `wrangler.jsonc`; `docs/RUNBOOK_PHASE3_QUEUE_SETUP.md` | Declared; provisioning owner-runbook-only; LIVE-UNVERIFIED. **Free-plan caveat:** Queues Free = 10,000 operations/day, 24 h retention — see `free-plan/FREE_PLAN_COMPATIBILITY.md` §5 |
| Application-level recovery (expired-claim reclaim; stranded-queued re-kick with grace; DLQ reconciliation send) | `src/application/jobs/engine.ts` (`dispatchDueJobs`, `reconcileDeadLetters`); **tool traces T-27/T-28** | **IMPLEMENTED + locally measured (TR-04 correction — not future work).** Remaining OWNER-side items: real-Queue outage/expiry procedure, and real DLQ send/receive cloud evidence (LIVE-UNVERIFIED) |
| Free-safe ingestion work reduction (grouped classification probes D1; invocation batch bound D4) | `free-plan/FREE_SAFE_EXECUTION_DESIGN.md` | **DESIGN ONLY (R1.10.2)** — implementation requires manager design acceptance + a future authorized round; no migration required |
| Real-migration 0004 execution + `SCHEMA_VERSION` flip | `docs/reviews/PIXEL_ROUND1_9_MIGRATION_0004_TRANSITION.md` §4 | Owner decision; see transition review. Free-plan note: Time Travel window 7 days on Free |
| Ingestion activation on preview (`SOURCE_INGESTION_ENABLED` → true) | ADR-0038; checklist Stage 8a/8b/8c | Owner decision via the bounded-window path; the ADVERTISED batch-10/100-item profile is **NOT_READY_FOR_INGESTION_ON_FREE** until the Free-safe design is accepted and implemented |
| Production infra (worker, D1, queues beyond preview) | `docs/ROADMAP.md` Phase 1B note | Intentionally unprovisioned until release gate |
| Live-verification of all five connector families | capability matrix §6 | Requires owner-authorized Stage-8a window |
| D1 Time Travel bookmark/restore drill | transition doc §5 | Owner capability; never exercised by GLM; LIVE-UNVERIFIED |
| **Cloudflare Free-plan conformance measurement** | `free-plan/FREE_PLAN_COMPATIBILITY.md` §11 | Owner-approved cloud measurement required before any real Preview load; gate-OFF surface UNPROVEN; enforcement/CPU LIVE-UNVERIFIED |

## 4. Tooling backlog (recorded in the tree)

- ESLint major evaluation (pinned 9.x prints end-of-support warning during
  `npm ci`) — dedicated tooling-maintenance slice, NOT inside a feature phase
  (`docs/ROADMAP.md` "Tooling maintenance backlog").

## 5. Explicitly out of scope for Rounds 1.10/1.10.1/1.10.2 (and not started)

- Any Phase 5+ implementation; any editorial/publishing code; any schema or
  migration change; any gate default change; any owner-policy decision made
  silently; any paid-plan upgrade or quota-bypass mechanism; any
  implementation of the Free-safe design (D1/D4) before manager acceptance.
  All of the above remain proposals for future authorized rounds.

> R1.10.3 note: the connector multi-request fixtures (RSS multi-feed, Steam 3 apps,
> YouTube 2 playlists + details, GitHub 2 repos, Reddit 2 subreddits) are
> REPRESENTATIVE shapes, NOT supported-max proofs; per-connector max-bound
> budgets are excluded from the FIRST Free preview profile until separately
> measured (free-plan/FREE_SAFE_EXECUTION_DESIGN.md §6).
