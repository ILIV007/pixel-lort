# design-lab/ — R1.10.3 SQL Feasibility DESIGN LAB (NOT product code)

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
  INSERT..SELECT builders (owned + legacy), the bind/byte chunker
  (100 documented binds per query INCLUDING shared guards; 100 KB
  documented statement length applied CONSERVATIVELY to SQL text + ALL
  bound values), verbatim copies of the accepted terminal state writes
  (provenance comments), and the candidate commit functions (pre-execution
  B1 rejection parity; one atomic batch; grouped source-bound
  classification from `audit-tools/trace/candidate-classification.ts`).
- `lab-suite.test.ts` — 11 semantics tests on REAL workerd D1 comparing
  the candidate against the ACCEPTED store imported UNMODIFIED
  (`src/adapters/db/source-ingest-store.ts`): L-01/L-02/L-10 full parity
  (counts + EVERY durable row + state), L-03 stale owner → zero effects,
  L-04 stale generation → zero effects, L-05 mixed-source rejection
  parity (`item_source_mismatch` BEFORE any statement, ownership not
  released), L-06 PK-collision whole-batch rollback, L-07 within
  -statement duplicate absorption (first row wins — matches the accepted
  two-statement behavior), L-08 max-volume byte audit (8 rows/94,278
  bytes ≤ 100 KB; all 100 rows land), L-09 numbered-parameter reuse
  characterization (the design does NOT depend on it; measured: works on
  workerd), L-11 legacy lost-fence semantics parity (items persist,
  stateWriteWon=false — accepted behavior, never reinterpreted).
- `cost-ledger.test.ts` — 14 executable ledger scenarios running the
  FULL accepted per-poll fixed sequence (engine claim read+CAS, source
  select, capability, acquire, authorize-per-hop, readback, terminal —
  imported product functions) + candidate commit/classification, each
  stage delta-tracked. Scenarios: zero/100-new/100-dup-ext/100-dup-url/
  50-50/max-bytes/3-hops/budget-denied/authority-failure + accepted
  BASELINE row + 4 legacy (schema-3) rows. FIRST-profile rows assert
  ≤40 execution-API calls AND ≤40 submitted statements.
- `cost-ledger.json` — the extracted ledger (exactly what the bound log
  produced; regenerate with the extractor below).
- `extract-ledger.mjs` — parses a raw run log's `LABLEDGER[…]` lines into
  the JSON.
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
  design-lab/cost-ledger.json
```

Expected: **2 files passed, 25 tests passed, exit 0**; 14 ledger rows.
Schema-3 scenarios are declared FIRST in the ledger file (the shared test
D1 cannot un-apply 0004); schema-4 scenarios apply the accepted test-only
0004 candidate plan afterwards — exactly like the trace suite does.

## Measured headline (see free-plan/FREE_SAFE_EXECUTION_DESIGN.md §4)

FIRST profile worst case (100 items, 2 redirect hops, owned candidate):
**17 xAPI / 33 STMT lab-measured**; +1 API/1 STMT queue-envelope residual
(reconciled against the accepted T-13 trace) → derived ceiling
**18 xAPI / 34 STMT** — inside the ≤40/≤40 target with ≥6 to the target
and ≥16 to the documented 50 row, under BOTH unit interpretations.
Rejected conditions: if any measured or derived total exceeded the target,
the verdict would be NOT_READY with the explicit blocker — not "fit".

## Honesty labels (mandatory)

DESIGN-LAB, not production measurement. LOCAL proxy units only. The
candidate is not wired into the product; the accepted suites (1142 + DB
301) and the accepted trace suite remain the ONLY production-path
evidence. CPU/live quotas/account headroom stay UNKNOWN.
