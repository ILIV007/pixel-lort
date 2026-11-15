# PIXEL — Round 1.9: R09 source-poll ownership, product implementation report

**Status:** LOCAL CANDIDATE for independent review. This round implements the
accepted Round 1.5.1 ownership design ON THE REAL PRODUCT PATH. It is NOT a
release, NOT deployed, NOT activated, and NOT merged. The accepted runtime
remains **app1.4.0 / APPLIED schema 3** — the schema-4 migration candidate
(`migrations/0004_source_poll_ownership.sql`) was applied ONLY to disposable
workerd D1 test databases through an explicit test-only plan. No Cloudflare
operation, no wrangler command, no real database migration, no commit, no push.

> **ROUND 1.9.1 AMENDMENT (R19-01, fail-closed capability).** The capability
> contract described below — `readAppliedSchemaVersion` returning a fail-safe
> `null` and `resolveOwnershipCapability` → `{ appliedSchemaVersion,
ownershipEnabled: v === 4 }` with callers treating `false` as "legacy
> allowed" — was found UNSAFE by Posidon's independent review (R19-01,
> counterexamples CE1–CE4): unknown/invalid/unsupported metadata silently
> re-activated the unfenced legacy ingestion path. Round 1.9.1 replaces it
> with three DISTINCT typed states (`known_v3_legacy` / `known_v4_ownership`
> / `unresolved`) and fail-closed scheduler/handler behavior. See
> `docs/reviews/ROUND1_9_1_CORRECTIONS.md` §1/§3. The prose below is
> preserved verbatim as the historical Round 1.9 record.

**Baseline:** the accepted Round 1.8.1 source, commit
`6e4851caea27a32940eada992b00775ec2106d11`, branch
`phase/04-corrections-round181` (input ZIP SHA-256
`1e59994e5ecddab0613043cb693e3aa6dbec3567b1b0b07b9e2f71146d0a158d`,
SHA256SUMS 387/387 verified before work).

---

## §1. Scope compliance (prompt instruction → implementation)

| Instruction                                                                                                                                                                                                                                     | Where it landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2. R09 through the ACTUAL product store, scheduler, engine execution context and poll commit wiring                                                                                                                                             | `src/adapters/db/source-ingest-store.ts` (owned scheduling batch S1/S2/S3, A1 acquisition, ownership-fenced commit, C.3 preflight); `src/application/ingestion/scheduler.ts` (owned path selected per pass); `src/application/ingestion/poll-handler.ts` (A1 after the engine's atomic claim, owned commit); the handler receives `jobId` + `generation` from the EXISTING `JobExecutionContext` — no parallel lab, no bypass                                                                                                                               |
| 2. Preserve D01 pre-claim policy pause and R10 per-hop authorization boundaries                                                                                                                                                                 | Untouched: the pause decision stays pre-claim in `engine.consumeMessage` (step 4.5) — proven composing with ownership (R09-P13); the R10 transport/authorizer code paths are byte-unchanged — R10 suites (8 frozen evidence + 15 boundary + 38 authority tests) all green unchanged                                                                                                                                                                                                                                                                         |
| 3. Durable owner + partial unique invariant; create and reserve atomically; hold anchored to current time; never reacquire authority via a terminal existing job; `inserted_unreserved` preserved/disclosed; NO CHECK-then-create-only race fix | S1/S2/S3 (§2 below) — one atomic `executor.batch`; S2 writes `next_poll_at = now + SOURCE_POLL_HOLD_MS` TOGETHER with `poll_owner_job_id`; S3 remediates terminal windows WITHOUT ownership; all conditioning is INSIDE the SQL predicates (no post-batch CHECK-then-create); `inserted_unreserved` kept as an honest outcome class and logged (`ingestion.schedule.inserted_unreserved`)                                                                                                                                                                   |
| 4. Complete authority on EVERY item/state mutation; mixed-source batches rejected before statements; old generation / lost owner writes zero; pre-network checks never cancel in-flight requests                                                | Every item INSERT and the terminal state write carry predicate P (durable hold + owner + job identity/type/aggregate/claimed/exact generation) inside ONE atomic batch; `commitOwnedPollResults` validates every item's attribution BEFORE building statements (B1); a stale commit is a whole-batch loser (0 rows, 0 items); A1 refused → the handler returns BEFORE any network — an in-flight request is never cancelled (the refusal happens before the transport exists)                                                                               |
| 5. 0004 candidate, disposable D1 only; 0001–0003 immutable; duplicate preflight + recovery plans; no silent cancellation/dedup; honest schema3/schema4 transition                                                                               | `migrations/0004_source_poll_ownership.sql` (product candidate; DDL byte-identical to the reviewed design fixture); applied ONLY via `ROUND19_MIGRATION_PLAN` in tests; `scanOutstandingPollDuplicates` shipped as the read-only preflight; remediation remains an owner decision (documented, never automated); transition matrix in §4 and in `PIXEL_ROUND1_9_MIGRATION_0004_TRANSITION.md`                                                                                                                                                               |
| 6. Permanent PRODUCTION-path tests                                                                                                                                                                                                              | `tests/integration/round19-r09-ownership.test.ts` — 17 tests (R09-P1…P17), real workerd D1, real scheduler/handler/store/engine paths                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7. Baseline reproduced; original R09 acceptance green UNCHANGED; adverse characterizations kept with before/after explanation                                                                                                                   | Baseline reproduced BEFORE edits: 1094 passed / 1 failed (R09) of 1095 exit 1; test:db 301/301. The original R09 test text, name and assertion are byte-unchanged and now pass through the REAL owned path. The schema-3 characterization (`design-characterization.test.ts` "three cron ticks … three concurrent poll jobs") is retained byte-unchanged and stays green — it characterizes the ACCEPTED LEGACY schema-3 behavior, honestly superseded ON SCHEMA 4 by R09-P5/P6 (one outstanding window; nothing lands on a blocked second window) — see §5 |
| 8. Out-of-scope work NOT done                                                                                                                                                                                                                   | No manual-approval default change, no AI/editorial/publication/menu work, no observations-history/D02, no unrelated refactor, no delivery-page or eslint-ignore edits, no secrets, no commits/pushes/merges, no remote operations                                                                                                                                                                                                                                                                                                                           |

---

## §2. What was implemented (files)

**Product code (5 files):**

1. `src/adapters/db/schema-health.ts` — ADDITIVE: `OWNERSHIP_SCHEMA_VERSION`,
   `readAppliedSchemaVersion(executor)` (ONE bounded metadata read; fail-safe
   `null` on unreadable), `resolveOwnershipCapability(executor)` →
   `{ appliedSchemaVersion, ownershipEnabled: v === 4 }`. `checkSchemaHealth`
   itself is UNTOUCHED (exact-equality against the operator-configured
   expectation — it never accepts arbitrary versions).
2. `src/adapters/db/source-ingest-store.ts` — ADDITIVE ownership section,
   ported VERBATIM from the independently reviewed Round 1.5.1 design lab
   (`tests/design/round15-ownership.ts`, proofs P-O1…P-O19, P-R1…P-R7,
   P-M1…P-M5):
   - `schedulePollWindowOwned` — S1 (idempotent durable job insert, column
     list byte-identical to the accepted `createJob`) + S2 (ownership-bound
     CURRENT-TIME reservation: CAS on the scanned marker AND an EXISTS on the
     contender's OWN fresh non-terminal row with the exact window identity) +
     S3 (terminal-window remediation — mutually exclusive predicates) in ONE
     atomic batch; constraint-abort classified as `outstanding_elsewhere`
     (the partial unique index); honest 7-outcome classification.
   - `acquirePollOwnership` (A1) + `readPollOwnership` — claim-time
     acquisition AFTER the engine's atomic claim, BEFORE any network; branch
     (i) fresh-window self-heal, branch (ii) own-window generation
     recycling; the EXISTS binds job identity, claimed status and the EXACT
     generation.
   - `commitOwnedPollResults` — items (each INSERT..SELECT carries P, the B1
     `? = ?` source-binding guard, and the two accepted targeted conflict
     clauses) + the ownership-fenced terminal state write (P + owner release)
     in ONE atomic batch; whole-operation `OwnedCommitRejectionError` on any
     mixed-source batch BEFORE any statement (P-O16/P-O17 semantics).
   - `scanOutstandingPollDuplicates` — the C.3 read-only preflight.
3. `src/application/ingestion/scheduler.ts` — the pass resolves the ownership
   capability ONCE (fail-safe OFF); ON → the atomic owned batch per due
   source (window key + canonical payload derived ONLY from
   `(sourceId, scheduledForMs)`; fresh contender UUID from `idGenerator`,
   defaulting to the production `cryptoIdGenerator` — the same generator the
   engine wiring uses); OFF → the accepted legacy path byte-identical.
   ScheduleOutcome shape unchanged; every outcome class honestly logged.
4. `src/application/ingestion/poll-handler.ts` — ON: A1 acquisition after the
   identity checks and BEFORE preflight/budget/network (a non-owner returns
   success with ZERO fetches, ZERO budget units, ZERO writes); the commit
   fence is the OBSERVED durable hold (never payload-derived) + owner +
   exact generation; all three terminal paths (preflight failure, connector
   throw, normal commit) go through the owned batch. OFF: the accepted
   legacy paths byte-identical.
5. `src/adapters/db/index.ts` — re-exports of the new schema-health surface.

**Migration candidate (1 file):** `migrations/0004_source_poll_ownership.sql`
— the reviewed DDL verbatim (`source_state.poll_owner_job_id` + the partial
unique outstanding-poll index + `schema_metadata` 3 → 4) with a Round 1.9
candidate header. NOT a member of the product `MIGRATIONS` default list; NO
real database has it applied.

**Test infrastructure (2 files):** `tests/helpers/migrations.ts` (+ the
`ROUND19_CANDIDATE_MIGRATION_0004` descriptor and the explicit test-only
`ROUND19_MIGRATION_PLAN`; the default `MIGRATIONS` list stays 0001–0003);
`migrations/README.md` (candidate status documented).

**Permanent production-path suite (1 new file):**
`tests/integration/round19-r09-ownership.test.ts` — 17 tests on real workerd
D1 (disposable DB + the test-only plan):
P1 new-source current-time hold bound to the durable owner; P2 overdue
source re-anchored to now; P3 same-key contenders (one owner/one job, honest
loser classification); P4 terminal reuse — all four terminal statuses consume
the window without ownership, no new job (P-O5 product path); P5 different-key
outstanding window blocked INSIDE D1 — nothing lands (P-O6/P-R7 product
path); P6 queue outage — later passes touch nothing, then the delivery
executes under the recorded owner (P-R1/P-R2 product path); P7 claim-time
self-heal + foreign owner / stale generation never reach preflight/budget/
network (P-O7/P-O9/P-R6 product path); P8 crash after commit before
completion — the recovered generation fetches NOTHING and commits NOTHING
(P-R4 product path); P9 crash between fetch and commit — the re-drive
fetches AGAIN (at-least-once DISCLOSED) and commits exactly once (P-R5
product path); P10 stale worker / stale observed hold / foreign owner commit
NOTHING and cannot release a newer owner (P-O11/P-O12/P-O14 product path);
P11 mixed-source batches rejected BEFORE statements — exact no-op, window
survives, corrected commit succeeds (P-O16/P-O17 product path); P12 hold
expiry alone never revokes the current owner (P-O13 product path); P13 D01
pause composes with ownership — pre-claim pause writes NOTHING, gate-ON
resumes under the recorded owner (P-P1+P-O19 product path); P14 the 0004
candidate applied WHOLE (metadata 3→4, column + index present, re-application
a no-op); P15 duplicate preflight empty on a healthy DB + the index rejects a
manual second outstanding window (isolation per source holds); P16
capability/health transition — health stays exact-equality (3 vs 4 both
rejected as mismatched when configured otherwise), corrupt versions fail
safe to the legacy path, the legacy path never writes the owner column;
P17 the owned commit is ONE atomic batch — an integrity failure aborts items
AND state, ownership preserved (R02 semantics under P).

**Fixture adaptations (SETUP ONLY — every hunk documented in
`review/fixture-adaptations-round19.md`):**

1. `tests/integration/extended-review.test.ts` — (a) `beforeEach` applies the
   explicit `ROUND19_MIGRATION_PLAN` (this file hosts the ORIGINAL R09
   acceptance, which must turn green through the REAL ownership path, which
   is a schema-4 capability); (b) the R10 test seeds the payload marker
   (`next_poll_at = NOW` instead of the legacy marker+hold — the hold is now
   written BY A1) and inserts the claimed `fixture-job` row the context
   references (the ownership fence requires the job row). Test names,
   scripts, invocations and ALL assertion lines unchanged — including the
   R09 and R10 acceptance assertions themselves.
2. NO other test file changed. The design lab, D01/R04/R05/R06, R10 evidence
   - boundary + authority suites, seed rollback, and the schema-3
     characterizations are byte-identical and green.

---

## §3. Measured results (all ACTUAL, exact logs in review/logs/)

- Baseline reproduced BEFORE any edit (pristine input source): full suite
  `npx vitest run --maxWorkers=1` = **1094 passed / 1 failed of 1095, exit 1**
  (the failure is exactly R09); `test:db` = **301/301 exit 0**. Matches
  VERSION.json of the input package exactly.
- Candidate full suite, single command `npx vitest run --maxWorkers=1`:
  **1112 passed / 1112, 88 files, exit 0** (composition: the prior 1094 + the
  original R09 now green + the 17 new R09-P1…P17 tests).
- Candidate `test:db`: **301/301, 22 files, exit 0** (unchanged subset — the
  new suite is not a member of test:db; no double counting).
- Candidate subset evidence: R09 original acceptance GREEN (extended-review
  10/10); new production-path suite 17/17; R10 eight frozen evidence tests +
  15 boundary tests + 38 authority tests all green unchanged; D01, R04, R05,
  R06, R07/R08 suites green unchanged; the 61 accepted design proofs
  (round15-design-*) green unchanged.
- The 11 external manager probes (`review/posidon-evidence/
posidon-round181-extra.test.ts`) run in a DISPOSABLE source copy:
  **11/11 passed** (reported separately — they are not registered in the
  main suite).
- Gates on the candidate source: lint ✓, format:check ✓, typecheck ✓,
  `check:versions` ✓ (app 1.4.0 / EXPECTED_SCHEMA_VERSION 3 — the APPLIED
  runtime, honestly unchanged), `test:telegram-setup` ✓, `test:secrets` ✓,
  `scan:secrets` 283 files / 0 findings ✓, `build` (dry-run) ✓,
  `build:preview` (dry-run) ✓.
- Diffs generated and BOTH verified byte-identical by fresh application:
  incremental `6e4851ca…` → Round 1.9 (10 files: 8 modified + 2 added,
  +2413/−43) and cumulative `48e0f28…` → Round 1.9 (68 files). The 48e0f28
  tree was reconstructed by reverse-applying the accepted Round 1.8.1
  cumulative diff onto this input source and re-verified by forward
  round-trip before use.

---

## §4. Schema 3 ↔ schema 4 capability and readiness transition (honest)

The readiness contract stays EXACT-EQUALITY per operator-configured
expectation (C.1 — never retracted, `checkSchemaHealth` untouched):

| Capability                                            | Schema 3 (APPLIED today)                                                                                                 | Schema 4 (0004 candidate — disposable tests only)                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Durable jobs lifecycle, claim fencing, attempt budget | ✔ accepted                                                                                                               | ✔ unchanged                                                                                                                         |
| D01 pre-claim policy pause / recovery fairness        | ✔ accepted (ADR-0040)                                                                                                    | ✔ unchanged, composes with ownership (R09-P13)                                                                                      |
| R10 per-hop budget authority                          | ✔ accepted (Round 1.8.1)                                                                                                 | ✔ unchanged (byte-identical transport paths)                                                                                        |
| Current-time hold                                     | writeable but UNANCHORED — the R09 defect remains honestly visible (hold = marker + 120s ⇒ 1970 for new sources)         | ✔ anchored with the durable owner (S2/A1)                                                                                           |
| Durable per-source poll ownership                     | ✖ (no column; overloading provider columns rejected by the accepted design)                                              | ✔ (`source_state.poll_owner_job_id`)                                                                                                |
| Single-outstanding-poll exclusivity                   | ✖ (duplicate outstanding windows possible)                                                                               | ✔ (partial unique index; C.3 preflight required)                                                                                    |
| Atomic create+reserve                                 | ✖ (A.3 gap)                                                                                                              | ✔ (S1+S2+S3 one batch)                                                                                                              |
| Ownership-fenced commit                               | ✖ (hold-only fence)                                                                                                      | ✔ (every item/state mutation carries P)                                                                                             |
| `checkSchemaHealth`                                   | exact equality vs the configured expectation (ships `3`)                                                                 | same check, unchanged; a schema-4 database configured as 3 reports `schema_version_mismatch` (observed 4) — never silently accepted |
| Feature resolution                                    | capability feature-detects `schema_metadata` at resolution: 3 → ownership OFF (accepted legacy behavior, byte-identical) | 4 → ownership ON; ANY other/unreadable value → fail safe OFF (legacy path), never arbitrary acceptance                              |

**Applied-vs-proposed honesty:** the shipped configuration still declares
schema 3 (`EXPECTED_SCHEMA_VERSION = 3`, wrangler/env examples unchanged —
`check:versions` enforces this). This candidate does NOT make the product
"schema-4 ready" in any deployable sense: applying 0004 to a real database
requires separate owner approval, the C.3 duplicate preflight to be empty,
and the operator to re-configure the expected schema version as part of the
runbook in `PIXEL_ROUND1_9_MIGRATION_0004_TRANSITION.md`. No production
readiness, activation, or release claim is made.

---

## §5. The R09 characterization — before/after contract

- BEFORE (schema 3, accepted legacy, kept byte-identical and green):
  `design-characterization.test.ts` proves three cron ticks without queue
  completion create THREE concurrent poll jobs — the R09-family race
  (unanchored hold ⇒ immediate re-scan ⇒ new window key each tick).
- AFTER (schema 4, this candidate): the same scenario is structurally
  impossible — the FIRST window's outstanding job makes every later window's
  batch abort INSIDE D1 (`outstanding_elsewhere`, nothing lands — R09-P5),
  and the original R09 acceptance now passes: a new/overdue source's
  reservation holds until after NOW, anchored to a durable owner (R09-P1/P2).
  The characterization is NOT deleted or weakened: it remains the truthful
  description of the accepted schema-3 behavior; the schema-4 behavior is
  proven by the permanent R09-P1…P17 production-path suite. The full-suite
  failure count moves 1 → 0 precisely because the R09 acceptance (the only
  red test) turns green through the real product path.

## §6. What this round does NOT claim

- NOT exactly-once external fetching (P-R5/R09-P9 prove the disclosed
  at-least-once window; in-flight requests are never recalled).
- NOT zero-defect, NOT release-ready, NOT deployed, NOT activated, NOT
  merged, NOT pushed, NO CI claim (no commit was made).
- NOT a real migration: `appliedSchemaVersion` of every real database stays
  3; the 0004 candidate has zero real applications.
- Multi-isolate concurrency is not directly observed (single-isolate
  workerd lab); ownership is decided inside single atomic D1 transactions
  whose serialization is D1's own contract (design §4 honest limits carry
  over unchanged).
