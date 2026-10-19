# PIXEL R1.10.1 — Corrections Map (manager findings → applied corrections)

**Round 1.10.1 — LOCAL audit/runbook corrections + Free-plan constraint. Product
source UNCHANGED** (commit `f70205648922d0f8e60619e45e5d54e6e87b8f1b`,
297 files byte-identical, verified again this round via the real Git bundle).
Only documents/tooling outside `source/` were corrected or added. Originals of
every Round-1.10 document are preserved unmodified under `input-round110/` as
historical input; the corrected editions live under `audit/` (and the corrected
Persian operator summary at `audit/OPERATOR_SUMMARY_FA.md`).

Manager decision (MANAGER_REVIEW_FA.md): code acceptance `f7020564` STANDS;
the Round-1.10 operational report needed limited correction (R110-01…04) and a
new FREE-PLAN constraint addendum. This document maps each finding to exactly
where and how it was corrected. Every correction was applied consistently
across all seven documents, not only in one place.

---

## R110-01 — Schema/smoke-test ordering contradiction → CORRECTED

**Finding:** the checklist ordered Stage 7 (schema-4 migration) before Stage 8
(activation), but `PREVIEW_SMOKE_TESTS.md` S-07 claimed execution at "Stage 8"
while simultaneously erroring every schema-4 path and mandating schema 3; S-08
depended on S-07 yet was referenced from Stage 6; S-10 always expected 3.

**Applied corrections:**
1. `audit/PREVIEW_SMOKE_TESTS.md` — every scenario is now explicitly TWO-BRANCH:
   - **Phase A (pre-migration, schema 3):** Telegram/health/jobs-pause checks
     ONLY. No provider fetch, no R09-ownership experiment, no durable-ownership
     assertions. S-06 pause proof is Phase A (fixture-injected job, see R110-02).
   - **Phase B (post-AUTHORIZED-migration, schema 4):** runs ONLY after the
     separately authorized migration of Stage 7 completes AND health expects 4.
     S-07 bounded fetch, S-08 ownership observability (schema-4 fence semantics).
   - Each scenario now specifies: expected schema, flag values, resource
     assumptions, fixture preparation, allowed writes, execution stage,
     abort AND cleanup criteria.
2. S-08 CANNOT precede S-07 (dependency stated); execution notes re-listed so
   Stage-6 = {S-01…S-05, S-06, S-09, S-10(A)} and post-migration Stage 7.5 =
   {S-07, S-08, S-10(B)}.
3. S-10 expected values are stage-dependent: expectation "3" pre-migration,
   "4" only after the authorized flip — never both at once.
4. `audit/PREVIEW_READINESS_CHECKLIST.md` — Stage 6 and Stage 7/8 boundaries
   restated; no universal approval-policy change introduced (AUTO untouched).
5. `audit/PREVIEW_READINESS_REPORT.md` §4/§6 updated to the same two-branch
   structure; ordering summary now shows the smoke split explicitly.

## R110-02 — Incorrect test expectations → CORRECTED

**Finding:** S-06 "wait for cron with a due source" cannot prove consumer pause
(gate-OFF cron schedules nothing); S-07 "exactly one budget unit" is wrong
(redirects/endpoints each authorize; 304/empty feed ≠ fresh items; late
authorization may be charged without a completed raw fetch); S-04 "no state
mutation" is wrong (claim/dedup bookkeeping precedes routing —
`src/application/telegram-ingress.ts:354+`); S-03 dedup was over-claimed as
external exactly-once.

**Applied corrections (with fresh LOCAL trace evidence, `audit-tools/`):**
1. **S-06** rewritten: pause proof = deliver an ALREADY-DURABLE controlled
   job/reference through the owner-authorized queue path; fixture preparation
   is a separate step from the zero-effect observation window. Local trace
   T-04 (idle cron, gate OFF: 0 envelopes produced, 0 D1 writes) and T-06
   (real batch of 10 delivered poll jobs at the shipped preview profile:
   10 durable-state lookups, 0 writes, all 10 acked `paused_by_policy`) are
   the local evidence that gate-OFF cron schedules nothing and the consumer
   pause is zero-durable-write — the smoke test now asserts exactly these
   observable outcomes.
2. **S-07** rewritten around a bounded profile with honest counters:
   `authorized` (per-hop grants), `attempted` (raw attempts), `observed`
   (completed fetches), `charged` (durable budget units) are distinct numbers.
   Redirects count one hop each (trace T-07: 2 raw hops → exactly 2 units
   charged — R10 per-hop authority unchanged). 304/empty successful feed does
   NOT guarantee new items (`not_modified` path). A late authorization may be
   conservatively charged WITHOUT a completed raw fetch (trace T-08: transport
   failure → 1 unit durably charged, job delivery acked, backoff owned by
   `source_state` — no queue retry storm). R1.8.1 accounting documentation is
   preserved; nothing was simplified to make the test easier.
3. **S-04** corrected: for an unauthorized actor the pipeline FIRST writes the
   durable claim/dedup row (`claimTelegramUpdate` before routing), so the
   honest expectation is: allowed writes = `telegram_updates` bookkeeping
   (claim → terminal `failed`) + the denial reply attempt; FORBIDDEN =
   admin-list/config/source/publication mutations. Abort only on those.
   Trace T-03 shows exactly this bookkeeping-then-deny order (3 statements:
   claim INSERT → admin role SELECT → terminal failed UPDATE).
4. **S-03** corrected: the durable `(date, message_id)` dedup gives
   at-least-once redelivery with terminal-state dedup per the KNOWN Bot API
   side-effect contract (ADR-0030/0031); it is NOT a guarantee of external
   exactly-once across every crash/restart of the external platform.

## R110-03 — Migration/Time-Travel evidence boundary → CORRECTED

**Finding:** "Time-Travel rollback semantics all verified" exceeded the
evidence (no real Cloudflare Time Travel/bookmark/restore was exercised);
`SCHEMA3_TO_4_TRANSITION_REVIEW.md` still used the old `unknown→fail-safe OFF`
shorthand for the new `unresolved→stop/retry` model.

**Applied corrections:**
1. `audit/SCHEMA3_TO_4_TRANSITION_REVIEW.md` §4 renamed/reframed:
   - VERIFIED locally: whole-file atomicity on disposable workerd D1,
     duplicate-preflight gate, expected-version flip ordering, three-state
     model (56/56 rehearsal re-run this round — `logs/12`).
   - **LIVE-UNVERIFIED (stated as such everywhere):** real Time Travel
     bookmark creation, real point-in-time restore, the real
     `wrangler d1 migrations apply` runner, and any rollback interplay across
     D1 + Queues + Telegram.
   - Documented-not-executed consequences of a real restore: restoring the DB
     rewinds DATABASE state to the bookmark; it does NOT un-send Telegram
     messages and does NOT un-deliver/un-persist Queue effects; the operator
     must plan write quiescence, queue/DLQ drain posture, and data-loss scope
     BEFORE any real restore. Free-plan Time Travel window is **7 days**
     (official docs; see free-plan/).
2. The stale phrase "unreadable → fail-safe OFF" replaced by the accepted
   `unresolved → stop/retry` model (stops scheduling/polling BEFORE any
   effect; bounded retries → observable dead-letter; trace T-09).
3. `audit/PREVIEW_READINESS_REPORT.md` §5 wording downgraded identically
   ("verified as documented" → split verified-locally vs LIVE-UNVERIFIED).
4. `audit/OPERATOR_SUMMARY_FA.md` §مهاجرت updated identically.

## R110-04 — Cron environment claim + secrets inventory → CORRECTED

**Finding:** checklist A.7 claimed cron is "not env-overridable" — official
Cloudflare docs explicitly support per-environment Cron Triggers; A.5 lumped
current connector secrets (YOUTUBE/REDDIT/GITHUB) into "future/not implemented".

**Applied corrections:**
1. `audit/PREVIEW_READINESS_CHECKLIST.md` A.7 now distinguishes THREE layers:
   - Shipped config: the trigger `*/5 * * * *` is declared TOP-LEVEL only; no
     per-env trigger exists in the shipped tree. (The in-source comment
     asserting non-overridability is part of the ACCEPTED SOURCE and remains
     byte-unchanged; this audit note supersedes it factually.)
   - Platform capability: per-environment cron triggers ARE supported by
     Wrangler config (official docs,
     https://developers.cloudflare.com/workers/configuration/cron-triggers/,
     verified 2026-04-21+ fetch date in free-plan/FREE_PLAN_OFFICIAL_SOURCES.md).
   - Real-account state: UNKNOWN — no remote inspection was performed.
   No config change was made or proposed as done.
2. A.5 secrets reclassified (NAMES ONLY, no values/IDs):
   - **Telegram — current and required for ingress:** `BOT_TOKEN`,
     `WEBHOOK_SECRET`, `OWNER_TELEGRAM_ID`.
   - **Conditional on enabling the named current connector:** `YOUTUBE_API_KEY`
     (youtube connector), `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` (reddit
     OAuth), `GITHUB_TOKEN` (optional, github releases connector).
   - **Future services only (no code consumes today):** `GEMINI_API_KEY`,
     `GROQ_API_KEY`, `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET`,
     `BLUESKY_APP_PASSWORD`.
3. `audit/CAPABILITY_MATRIX.md` §10 wording aligned to the same classification.

---

## New this round (beyond corrections)

- `free-plan/FREE_PLAN_COMPATIBILITY.md` — the REQUIRED evidence-based
  Cloudflare Free-plan compatibility addendum (verdict: **UNPROVEN**, with a
  conservative PROPOSED preview operating profile; no paid upgrade).
- `free-plan/FREE_PLAN_RESOURCE_LEDGER.json` — machine-readable resource
  evidence (official limits + local traces + unknowns).
- `free-plan/FREE_PLAN_OFFICIAL_SOURCES.md` — official Cloudflare docs quotes
  with URLs and fetch dates (independently re-fetched this round).
- `free-plan/FREE_PLAN_WORKSHEET.md` — workload worksheet separating MEASURED
  (local traces), CHOSEN (scenario assumptions), UNKNOWN (live account).
- `audit-tools/` — local trace suite (OUTSIDE accepted source): D1
  instrumenting wrapper + 9 traces with logs (`audit-tools/logs/trace-run.log`).
- `logs/` — fresh provenance: this round's actual re-runs (full 1142, db 301,
  focused 56, all gates, both dry-run builds) plus the original Round-1.10
  logs preserved under `input-round110/logs/` for provenance.

## What did NOT change

- `source/` — 297 files byte-identical to `f7020564…` (re-verified).
- No commit, push, authentication, Cloudflare call, migration, deploy,
  activation, billing change, or delivery-app edit.
- No assertion in the accepted suite was touched; the accepted suite remains
  1142 (301/56 are subsets, never added to it).
