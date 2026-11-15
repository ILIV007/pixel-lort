# design-lab/ — R1.10.3(+R1.10.3.1) SQL Feasibility DESIGN LAB (NOT product code)

**DESIGN-LAB evidence. Nothing here patches, replaces, or re-implements
product code; nothing here is authorized for product use.** The accepted
real-path baselines (T-13 = 110 xAPI / 211 STMT; T-16 = 1001/1812; sealed
provenance in `input/R1.10.2_bd7d3462_ORIGINAL.zip`) are retained
separately and are NEVER replaced by lab numbers. Every lab number is a
LOCAL workerd + disposable D1 proxy measurement: no cloud quota
enforcement, no CPU evidence (network wait is not CPU), no billing
conclusion, no Free-fit declaration beyond the LOCAL ≤40/≤40 target row.

## Contents

- `candidate-sql.ts` — the candidate: parameter-bounded MULTI-ROW
  INSERT..SELECT builders (owned + legacy), the R1.10.3.1 per-chunk
  chunker (100 documented binds per query INCLUDING shared guards; the
  INTERNAL conservative budget of 100 KB applied to SQL text + ALL bound
  values — a strictly stronger assumption than the documented SQL-TEXT
  row; every chunk validated INDEPENDENTLY against its ACTUAL SQL + ACTUAL
  bind bytes, with an explicit typed rejection `OversizedRowPlanError` for
  a single oversized row), verbatim copies of the accepted terminal state
  writes (provenance comments), and the candidate commit functions
  (pre-execution B1 rejection parity; one atomic batch; per-statement
  re-audit before prepare; grouped source-bound classification from
  `audit-tools/trace/candidate-classification.ts`).
- `fixtures.ts` — R1.10.3.1 shared URL-expansion fixtures: deterministic
  percent-encoded 5000-char CJK paths whose canonical URLs are EXACTLY
  45,023 bytes (host chosen for the manager's counterexample arithmetic),
  distinct per item.
- `lab-suite.test.ts` — 14 semantics tests on REAL workerd D1 comparing
  the candidate against the ACCEPTED store imported UNMODIFIED
  (`src/adapters/db/source-ingest-store.ts`): L-01/L-02/L-10 full parity
  (counts + EVERY durable row + state), L-03 stale owner → zero effects,
  L-04 stale generation → zero effects, L-05 mixed-source rejection
  parity (`item_source_mismatch` BEFORE any statement, ownership not
  released), L-06 PK-collision whole-batch rollback, L-07 within
  -statement duplicate absorption (first row wins — matches the accepted
  two-statement behavior), L-08 max-volume byte audit (EVERY chunk
  audited ≤ 100 KB; 12×8+1×4 rows; all 100 rows land), L-09
  numbered-parameter reuse characterization (the design does NOT depend
  on it; measured: works on workerd), L-11 legacy lost-fence semantics
  parity (items persist, stateWriteWon=false — accepted behavior, never
  reinterpreted), and the R1.10.3.1 regressions: **L-12** heterogeneous
  chunking (the manager's counterexample: 8 short + 92 CJK≈45 KB → 1×8 +
  46×2 = 47 INSERT statements, every chunk ≤ budget, feed < 2 MiB, all
  rows + full URLs land), **L-13** single oversized row → typed plan-time
  rejection (`row_exceeds_statement_budget`), zero statements, zero
  durable effects, **L-14** Unicode/URL-expansion envelope (the ACCEPTED
  normalizer produces canonical URLs of EXACTLY 45,023 bytes — no URL
  length cap — and the planner yields exactly 50 chunks × 2 rows within
  budget).
- `cost-ledger.test.ts` — 16 executable ledger scenarios running the
  FULL accepted per-poll fixed sequence (engine claim read+CAS, source
  select, capability, acquire, authorize-per-hop, readback, terminal —
  imported product functions) + candidate commit/classification, each
  stage delta-tracked. Scenarios: zero/100-new/100-dup-ext/100-dup-url/
  50-50/max-bytes/3-hops/budget-denied/authority-failure + accepted
  BASELINE row + 4 legacy (schema-3) rows + the R1.10.3.1 envelope
  re-measures **C-15/C-16** (100 new ≈45 KB CJK canonical URLs: owned
  15 xAPI / 66 STMT, legacy 14 xAPI / 65 STMT — **the ≤40 STMT target
  FAILS; this is the NOT_READY evidence for a universal bound**).
  FIRST-profile normal-shape rows assert ≤40 execution-API calls AND
  ≤40 submitted statements.
- `lab-log.ts` — the single sanctioned measurement-output channel
  (workerd tests reach the host log only via `console`; the extractor
  parses those lines). One documented eslint exception, confined here.
- `cost-ledger.json` — the extracted ledger (exactly what the bound log
  produced; regenerate with the extractor below). 16 rows.
- `poll-workload.test.ts` — **Phase 4.3 STEP 2**: 7 workload scenarios
  driving the REAL end-to-end poll pipeline (scheduleDueSources -> durable
  job -> dispatchDueJobs -> engine claim -> per-hop authorization ->
  scripted network fake -> REAL RSS connector classification/normalize ->
  accepted ownership-fenced commit -> job terminal) on the applied LINEAR
  schema-6 state, instrumented by the SAME v3 D1 instrument. Scenarios:
  **W-01** 1 new item / 1 hop, **W-02** 100 new items (connector cap),
  **W-03** 304 conditional-GET second poll (validators + cursor preserved,
  zero new items), **W-04** same-origin 301 redirect (2 authorized hops),
  **W-05** HTTP 500 provider failure (adaptive ladder, zero items),
  **W-06** 100 items at the max documented shape (URL ≈2 KiB + 512-char
  caps through the REAL normalizer), **W-07** all 7 RSS sources (8 feed
  URLs) in ONE pass with an OVERLAPPING second scheduler pass absorbed
  (0 new jobs — the atomic window hold) and SEQUENTIAL envelope
  consumption (labeled: NOT cloud concurrency evidence). Emits
  `LABWORKLOAD[...]` rows (stage deltas: schedule/dispatch/consume; xAPI =
  execution-API call attempts; rows = LOCAL meta deltas when available);
  `wallMsLocal` is LOCAL WALL TIME, NOT cloud CPU. Extracted to
  `poll-workload.json` by the same extractor.
- `poll-workload.json` — the extracted workload rows (7 rows from the
  bound run; regenerate with the extractor below).
- `od009-storage.test.ts` — **Review→5 / OD-009 (OPEN decision)**:
  NON-DESTRUCTIVE storage measurement on the REAL pipeline (no deletion
  performed, proposed, or scheduled — OD-009 stays the owner's decision).
  **S-01** 100 max-shape items, per-component PAYLOAD bytes via SQLite
  BLOB byte lengths (URL 2042 B / title 512 / excerpt 512 / raw_json
  ≈713 B / hash 64 / ids+ext ≈37 B per item ⇒ ≈3 880 B payload,
  ≈3 928 B whole-row estimate incl. the labeled nominal 48 B overhead;
  raw_json share ≈18.4%); **S-02** 7 sources × 20 items, per-row
  consistency (<3% drift); **S-03** extrapolation ARITHMETIC from the
  embedded registry (min(dailyRequestBudget, polls/day × cap)):
  worst-case 2 910 items/day (budget ceiling 3 310) ⇒ ≈46 days to the
  documented 500 MB Free cap at MAX shape; 90-day steady state ≈981 MB,
  Option-A raw purge ≈803 MB (≈18.1% relief — raw_json is only ≈713 B at
  max shape, so purging it alone does NOT reach a steady state under the
  cap at worst-case arrivals). PRAGMA page info unavailable in this pool
  (recorded `available:false`, never guessed). These are LOCAL proxy
  measurements and labeled arithmetic — NOT cloud storage actuals; the
  real worst case depends on actual feed arrival rates (far below the
  registry caps) which only owner/Posidon cloud evidence can measure.
  Emits `LABSTORAGE[...]` rows; extracted to `od009-storage.json`.
- `od009-storage.json` — the extracted storage rows (3 rows from the
  bound run; regenerate with the extractor below).
- `extract-ledger.mjs` — parses a raw run log's `LABLEDGER[…]`,
  `LABWORKLOAD[…]` and `LABSTORAGE[…]` lines into the JSON files; pass
  the literal `-` as an output path to SKIP that output (byte-stable
  re-extraction of a single surface).
- `vitest.config.lab.mjs` — pool-workers config (same disposable workerd
  D1 as the audit tools; SEPARATE counts).

## EXACT bootstrap (fresh package extraction)

```bash
git clone --branch phase/04-corrections-round191 \
  verification/accepted-history.bundle repo
cd repo && npm ci --ignore-scripts
cp -a <package-root>/design-lab ./design-lab
cp -a <package-root>/audit-tools ./audit-tools   # candidate-classification is shared
npx vitest run --config design-lab/vitest.config.lab.mjs --maxWorkers=1 \
  > /absolute/raw-lab-run.log 2>&1
node design-lab/extract-ledger.mjs /absolute/raw-lab-run.log \
  design-lab/cost-ledger.json design-lab/poll-workload.json \
  design-lab/od009-storage.json
```

Expected: **4 files passed, 40 tests passed, exit 0**; 16 ledger rows,
7 workload rows and 3 storage rows. Schema-3 scenarios are declared FIRST in the ledger file
(the shared test D1 cannot un-apply 0004); schema-4 scenarios apply the
accepted test-only 0004 candidate plan afterwards — exactly like the trace
suite does. The workload suite applies the FULL linear plan (schema 6).
Each lab test file runs with per-file isolated storage, so the plans do
not interfere.

## Measured headline (see free-plan/FREE_SAFE_EXECUTION_DESIGN.md §4/§9)

CONDITIONAL measured scenario (RELABELED R1.10.3.1 — NOT a universal
bound): FIRST profile with the fixtures' ~2 KiB URL shape, 100 items, 2
redirect hops, owned candidate = **18 xAPI / 34 STMT lab-measured** (the
2026-11-06-bound extraction measures directly what the 6ad138c-era JSON
recorded as 17/33 + a "+1 queue-envelope residual" reconciliation; see the
fidelity note below) — inside the ≤40/≤40 target ONLY for that URL shape.

UNCHANGED supported RSS envelope: the accepted normalizer enforces NO
canonical-URL length cap (L-14 pins 45,023-byte canonical URLs for
5000-char CJK paths; the raw-CJK RSS XML stays < 2 MiB). Under the
conservative combined-byte policy such polls need 2 rows/statement →
**50 INSERT statements ALONE** (C-15 owned: 16 xAPI / 67 STMT; C-16
legacy: 15 xAPI / 66 STMT) → **NOT_READY against BOTH ≤40 targets for the
unchanged envelope**. Correctness is unchanged (all rows land, fences
intact, every audited statement ≤ budget). The durable continuation
design (measurement gate + pre-committed policy rule + multi-window
alternative) is in FREE_SAFE_EXECUTION_DESIGN.md §9.4. Rejected
conditions: if any measured or derived total exceeded the target, the
verdict is NOT_READY with the explicit blocker — never "fit".

## Extraction fidelity (2026-11-06 re-extraction, tree 7b12016)

The bound run log (`logs/lab-run-with-workload.log`, documented command
above) re-extracts ALL 16 ledger rows with **+1 execution-API call and
+1 statement on every row** versus the 6ad138c-era JSON: the R1.20-R1 /
R1.22 capability hardening resolves the shape with TWO metadata reads
(schema version + migration id) at applied version ≥ 4, and the previous
JSON carried pre-hardening numbers. Fidelity proof: the re-extracted
**C-10 owned BASELINE = 110 xAPI / 211 STMT — EXACTLY the accepted T-13
trace** (sealed provenance), which the earlier extraction under-counted by
that same read. All FIRST-profile ≤40/≤40 assertions still hold (C-02:
16/30); the C-15/C-16 STMT-failure NOT_READY conclusion is UNCHANGED.

## Honesty labels (mandatory)

DESIGN-LAB, not production measurement. LOCAL proxy units only. The
candidate is not wired into the product; the accepted suites (1142 + DB 301) and the accepted trace suite remain the ONLY production-path
evidence. CPU/live quotas/account headroom stay UNKNOWN.
