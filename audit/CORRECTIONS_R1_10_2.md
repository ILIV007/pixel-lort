# PIXEL R1.10.2 — TR Closure Ledger (manager findings → applied corrections)

**Round 1.10.2 — LOCAL audit-tool corrections + corrected operator reports +
Free-safe execution DESIGN ONLY. Product source UNCHANGED** (commit
`f70205648922d0f8e60619e45e5d54e6e87b8f1b`, branch `phase/04-corrections-round191`,
297 files byte-identical — re-verified this round via the real Git bundle:
clone HEAD exact, ancestors present, `git archive HEAD` == `source/` for all
297 files; product gates re-run green: 1142/1142 full suite, 301/301 DB
subset, all static gates, scan 297/0, both DRY-RUN builds 380.09 KiB).

Only documents and tooling OUTSIDE `source/` were corrected or added.
The sealed reviewed input
(`input/R1.10.1_61a01947_ORIGINAL.zip`, SHA-256
`61a01947968db2902c41b8cd419f80badfbc4adce2397e068090e2416831ca40`)
is preserved as HISTORY, never silently edited; the corrected editions live
under `audit/` and `free-plan/`, and the corrected tooling under
`audit-tools/` (no nested duplicate copies).

Manager decision (manager-review/R1101_INDEPENDENT_FINDINGS.md + OUTCOME_FA.md):
product acceptance `f7020564` STANDS; the R1.10.1 operational audit is
CHANGES REQUIRED (TR-01…TR-06); the advertised batch-10 / 100-item ingestion
profile is **NOT_READY_FOR_INGESTION_ON_FREE**; this round delivers corrected
measurement tooling, corrected reports, and a DESIGN-ONLY Free-safe path.
No paid upgrade / Cloudflare operation / real migration / deployment /
activation is authorized or performed.

Reproduction evidence (this round, logs preserved):

- Supplied UNFILTERED recursive trace command on the EXACT sealed input:
  **exit 1** (9 assertions pass; nested duplicate suite fails import) —
  reproduced byte-exactly as the manager documented
  (`logs/10-supplied-command-input-exit1.log`).
- Five manager controls UNMODIFIED: **5/5, exit 0**
  (`logs/11-manager-controls-input.log`).
- Corrected tooling on the FINAL artifact: **37/37 exit 0** (28 traces +
  9 instrument unit controls, unfiltered recursive config)
  (`audit-tools/logs/trace-run-r1102.log`).

---

## TR-01 (P1) — measurement units and batch metadata wrong → CORRECTED

**Finding:** `prepareCalls + batchCalls` is NOT an execution-API-call count.
Prepare is construction only; batch preparations were double-counted and
repeated execution of one prepared statement was mislabeled; the wrapper
captured ONLY `result[0].meta` per batch. Official API:
https://developers.cloudflare.com/d1/worker-api/d1-database/

**Applied corrections:**

1. `audit-tools/trace/d1-instrument.ts` — REWRITTEN (v2) with separated
   counters: `prepares` (construction only), terminal attempts/completed/
   failed BY METHOD (`run/all/first/raw`), `batchAttempts/batchCompleted/
batchFailed`, `batchStatements`, `batchResultRecords`, EVERY available
   result-metadata record (`metaRecords`, terminal + every batch result —
   the v1 result[0]-only omission is fixed), explicit UNAVAILABLE labeling
   (`metaUnavailableCount` + `unavailableReason`; never zero-filled),
   attempted/completed/failed separation (a throw is an attempt that
   failed, never silently dropped), and derived honest units:
   `executionApiCallAttempts = terminalAttempts + batchAttempts`,
   `statementsAttempted = terminalAttempts + batchStatements`.
   `raw()` is counted (v1 missed it). `exec()`/`withSession()` are DECLARED
   unsupported passthrough surfaces in the file header (the accepted
   DbExecutor never exercises them).
2. `audit-tools/trace/instrument-controls.test.ts` (NEW) — 9 unit controls:
   C-01 unused prepare (prepares=1, 0 execution calls), C-02 multi-statement
   batch = ONE execution-API call carrying N statements + EVERY result meta
   captured, C-03 reused statement (prepares=1, terminal=2), C-04 bind
   identity preservation (terminal + batch), C-05 failures counted and
   never dropped (terminal + batch), C-06 non-instrumented fixture probes
   invisible, C-07 unavailable metadata LABELED not zero, C-08 raw()
   counted with honest metadata labeling, C-09 declared unsupported
   surfaces. **9/9 exit 0.**
3. Cross-validation against the manager's independent numbers (their
   counters, built separately): single 100-item poll T-13 = **110 execution
   API-call attempts / 211 statements** (manager C2-100: 110/211); active
   batch10 T-16 = **1001 / 1812** (manager C3: 1001/1812). Exact match.
4. All seven operator documents + free-plan documents re-expressed in the
   corrected unit vocabulary; the old "binding calls (prepare+batch)"
   formula is gone from every current-edition document (preserved only in
   the sealed historical input). Measured API calls vs the documented
   Cloudflare quota unit is carried as a DOCUMENTED QUESTION with BOTH
   interpretations (see `free-plan/FREE_PLAN_COMPATIBILITY.md` §4) — no
   false RPC/billing label anywhere.

## TR-02 (P1) — active/worst-supported path omitted; profile NOT ready → CORRECTED

**Finding:** supplied T-06 measured only gate OFF; T-07 used default schema 3
and two items; the owned-schema-4 / high-item / active-batch path was never
measured. Manager controls: schema4 100-item poll = 110 execution API calls;
active batch10 = 1001. A single 100-item poll ALREADY blocks the documented
Free 50-query row under both unit readings; lowering queue batch size does
not fix it.

**Applied corrections:**

1. `audit-tools/trace/trace-suite.test.ts` — REBUILT (28 traces): active
   schema-4 SINGLE polls at 0/2/100 new items (T-10 304-not-modified,
   T-11 empty-200, T-12 redirect, T-13 100-new), duplicate-heavy (T-14
   100 duplicates, T-15 50/50 mix), and active BATCH10 through ONE real
   handleQueue (T-16). Every trace: explicit expected AND applied schema,
   ONE entrypoint/window, fixture writes + validation reads on the RAW
   binding OUTSIDE the measured window, counters reset immediately before
   the window.
2. `free-plan/FREE_PLAN_COMPATIBILITY.md` §1/§7 — operational status for the
   CURRENT ADVERTISED profile: **NOT_READY_FOR_INGESTION_ON_FREE** (local
   evidence; platform enforcement/CPU remain live-unverified). The "stagger
   cadences" mitigation is explicitly retired as non-deterministic
   (TR-06/§7) and as insufficient for the single-job path.
3. `free-plan/FREE_PLAN_WORKSHEET.md` — rebuilt from the corrected
   measurements: per-invocation AND per-job budgets, duplicate-heavy
   multipliers, per-connector request caps (T-17…T-21), and the
   NOT_READY verdict formula. No claim that staggering yields a
   deterministic queue-batch bound.
4. `free-plan/FREE_SAFE_EXECUTION_DESIGN.md` (NEW) — DESIGN ONLY minimal
   Free-safe path (per-item classification growth reduction, per-invocation
   AND per-job aggregate work constraints, lossless continuation, both
   quota-unit interpretations, measurable acceptance). No product patch in
   this round.

## TR-03 (P1) — operational dependency cycle remains → CORRECTED

**Finding:** Stage 7.5 required S07/S08 before Stage 8, while Stage 8
required the Phase-B fetch already validated; S07 requires gate-ON
(authorization D). Plus accounting errors: `observed` redefined as completed
responses (accepted requestCount is observed raw ATTEMPTS incl. throws);
T-08 cited as LATE-authorization evidence (it is a transport throw AFTER an
ordinary grant); empty-success treated as `not_modified` on all connectors;
global abort on infrastructure DLQ.

**Applied corrections (all operator docs consistently):**

1. `audit/PREVIEW_READINESS_CHECKLIST.md` — the cycle is REMOVED:
   Stage 7 = migration + health at 4; **Stage 8a** = explicit owner
   authorization for a BOUNDED gate-ON test window (permission BEFORE any
   network proof); **Stage 8b** = bounded S-07 then S-08 (one source,
   bounded counters); **Stage 8c** = gate OFF/cleanup + a SEPARATE
   sustained-ingestion activation decision (which now also requires the
   Free-safe design acceptance). Schema-3 Track A stays independent.
2. `audit/PREVIEW_SMOKE_TESTS.md` — S-07 counters corrected: `observed`
   NEVER redefines the accepted product counter (observed raw attempts
   including throws); operators record attempted/completed/authorized/
   charged as SEPARATE counters. T-08/T-22 relabeled: "ordinary grant,
   then transport throw" — the LATE-authorization behavior is an accepted
   UNIT-TEST property (`round18-r10-budget-authority.test.ts`) and is cited
   as such, never as a smoke outcome. Empty-success ≠ `not_modified` on all
   connectors (RSS-specific 304 semantics stated; other connectors
   explicitly listed as not-established). DLQ abort criterion split:
   bounded infrastructure retries legitimately exhaust → expected drill
   outcome vs UNEXPECTED DLQ growth (which still aborts).
3. Expected AND applied schema are now stated in every smoke scenario and
   every trace (the tooling logs `expectedSchema` and `appliedSchema`
   explicitly — T-26/T-27 show the corrupted-fixture case honestly as -1).
4. R19-01 fail-closed, D01 pre-claim pause, R10 attempt-vs-charged
   accounting, late authorization (as a unit-test property), source rights
   and at-least-once caveats: all PRESERVED unchanged.

## TR-04 (P2) — implemented recovery incorrectly declared missing → CORRECTED

**Finding:** compatibility §5/§7 said automatic D1 re-kick does not exist.
Actually `engine.ts:dispatchDueJobs` performs pending/retry_wait scans,
expired-claim recovery, and `scanStrandedQueuedJobs` with grace, then sends
and marks queued (accepted in prior rounds). Manager C4 proved a 25h-aged
queued row is re-enqueued by the REAL cron (same job id), exit 0. Also:
T-09's durable dead_letter is not DLQ send/receive proof.

**Applied corrections:**

1. `free-plan/FREE_PLAN_COMPATIBILITY.md` §5/§7/§12 — the "no automatic
   re-kick exists" claim is WITHDRAWN; the implemented application-level
   recovery is documented with file evidence
   (`src/application/jobs/engine.ts` dispatchDueJobs: reclaimExpiredClaims,
   scanDueJobs, scanStrandedQueuedJobs grace re-kick) and is NOW MEASURED:
   trace T-28 (25h-aged queued row re-enqueued by the real cron, same job
   id) and trace T-27 (actual application DLQ reconciliation SEND +
   guarded `dlq_delivered_at` confirmation through the real cron pass).
2. `audit/CAPABILITY_MATRIX.md` §7 — new IMPL+TESTED rows for the re-kick
   and DLQ reconciliation-send paths (tool traces T-27/T-28 as local
   evidence; real Queue send/receive/TTL stay LIVE-UNVERIFIED).
3. `audit/REMAINING_PRODUCT_WORK.md` — the "automatic re-kick (future
   work)" register entry is replaced by the corrected status: implemented
   locally; remaining OWNER-side items are real-Queue outage procedures and
   the full-DLQ-path cloud evidence (platform send/receive).
4. Workload model updated (worksheet §3): outage/reopen/fairness costs and
   repeated re-kick envelope amplification are now named components
   (stranded re-kicks re-send the SAME durable reference; amplification is
   bounded by the schema-4 outstanding-poll uniqueness and the grace
   window, and is quantified as UNKNOWN-with-bounds rather than assumed
   away). T-09 relabeled: terminal-row transition only; the DLQ send is
   T-27's separate measured path; real Queue receive side remains
   LIVE-UNVERIFIED.

## TR-05 (P2) — final artifact trace command broken → CORRECTED

**Finding:** the ZIP shipped BOTH `audit-tools/trace/trace-suite.test.ts`
and an identical nested `audit-tools/trace/trace/trace-suite.test.ts`; the
recursive config selected both; nested relative imports resolved to
nonexistent `audit-tools/src/...`; fresh-extraction exit1. README also
omitted the overlay-at-clone-root bootstrap.

**Applied corrections:**

1. The nested `trace/trace/` duplicate directory is REMOVED — the delivered
   `audit-tools/` contains exactly ONE copy of each tool file
   (verification: fresh-extraction UNFILTERED command `npx vitest run
--config audit-tools/vitest.config.trace.mjs --maxWorkers=1` on the
   FINAL artifact = **37/37, exit 0**, log bound to the exact package:
   `logs/20-final-fresh-extract-trace-run.log`).
2. `audit-tools/README.md` — REWRITTEN with the EXACT bootstrap: clone the
   bundle → `npm ci --ignore-scripts` → copy `audit-tools/` to the clone
   root → run the UNFILTERED documented command; no narrow-file bypass of
   the recursive include exists anywhere in the delivered artifacts.
3. The failing supplied command on the SEALED INPUT is preserved as
   historical evidence (exit 1), clearly separated from the final
   artifact's green run.

## TR-06 (P2) — worksheet bounds/provenance unsupported → CORRECTED

**Finding:** 2-item cost presented as worst-supported; row-size bound
self-contradictory (≤1–2 KB vs raw_json ≤8 KB); "years of headroom"
unmeasured; T-05/T-09 aggregates labeled as single-invocation; cadence
staggering claimed as a batch bound; title/excerpt bounds wrong
(actual constants 512/512; author 256); connector classification lost;
Queue UTC reset asserted without evidence; official-source report invented
a February fetch session against October log timestamps.

**Applied corrections:**

1. `free-plan/FREE_PLAN_WORKSHEET.md` — REBUILT: formulas take items/day,
   duplicates, index/meta samples, all configured requests (per-connector
   caps from T-17…T-21), retries, re-kicks, DLQ, retention/headroom
   scenarios as INPUTS; the 0/2/100/duplicate-heavy measured rows replace
   the 2-item generalization. The "≤1–2 KB row" bound is replaced by an
   explicit byte model with the true caps (title 512, excerpt 512,
   author 256, raw_json ≤8 KB) and a stated bytes/arrival/retention
   ASSUMPTION SET; the "years of headroom" claim is WITHDRAWN (storage
   = UNKNOWN until measured). Single-invocation vs aggregate is separated
   per row (T-07-style seed/due passes are SEPARATE traces now: T-07/T-08).
2. Cadence staggering is explicitly documented as NOT a deterministic
   queue-batch bound (backlog/outage can re-coalesce windows);
   `FREE_PLAN_COMPATIBILITY.md` §10 carries the same warning.
3. Queue reset clock: recorded as **UNKNOWN** in the ledger and worksheet
   (the official page states a daily operation allowance but does not
   establish the reset boundary for the Free plan); the operator ledger
   records Workers/D1 midnight-UTC (official) separately from the
   Asia/Tehran provider budget day (code fact) and Queue retention as a
   rolling 24 h per message (official).
4. `free-plan/FREE_PLAN_OFFICIAL_SOURCES.md` — provenance corrected: the
   citations now point to the ACTUAL retrieved excerpts shipped in
   `manager-evidence/official/` (manager web_load_page retrieval during the
   independent review; no fresh GLM web fetch was performed this round and
   none is claimed); the invented "February fetch session" date is
   removed; synthetic fixture clocks are explicitly declared NOT wall
   dates. Connector classification (current-conditional vs future-service)
   is restored in checklist §A.5 and the matrix.
5. T-05 split into T-07 (seed pass) + T-08 (due pass) as separate
   single-invocation measurements; T-09's aggregate labeling removed.

---

## Closure statement

All six findings are mapped above to exact files and evidence. The response
ledger itself is this document (`audit/CORRECTIONS_R1_10_2.md`). Source stays
`f7020564` / 297 byte-identical files; no product patch in R1.10.2. Once
Posidon accepts the corrected analysis and the Free-safe design, a narrowly
scoped implementation round can be commissioned. **STOP for Posidon review.**
