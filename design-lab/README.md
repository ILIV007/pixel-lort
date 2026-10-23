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

Expected: **2 files passed, 30 tests passed, exit 0**; 16 ledger rows.
Schema-3 scenarios are declared FIRST in the ledger file (the shared test
D1 cannot un-apply 0004); schema-4 scenarios apply the accepted test-only
0004 candidate plan afterwards — exactly like the trace suite does.

## Measured headline (see free-plan/FREE_SAFE_EXECUTION_DESIGN.md §4/§9)

CONDITIONAL measured scenario (RELABELED R1.10.3.1 — NOT a universal
bound): FIRST profile with the fixtures' ~2 KiB URL shape, 100 items, 2
redirect hops, owned candidate = **17 xAPI / 33 STMT lab-measured**;
+1 API/1 STMT queue-envelope residual (reconciled against the accepted
T-13 trace) → 18 xAPI / 34 STMT — inside the ≤40/≤40 target ONLY for that
URL shape.

UNCHANGED supported RSS envelope: the accepted normalizer enforces NO
canonical-URL length cap (L-14 pins 45,023-byte canonical URLs for
5000-char CJK paths; the raw-CJK RSS XML stays < 2 MiB). Under the
conservative combined-byte policy such polls need 2 rows/statement →
**50 INSERT statements ALONE** (C-15 owned: 15 xAPI / 66 STMT; C-16
legacy: 14 xAPI / 65 STMT) → **NOT_READY against BOTH ≤40 targets for the
unchanged envelope**. Correctness is unchanged (all rows land, fences
intact, every audited statement ≤ budget). The durable continuation
design (measurement gate + pre-committed policy rule + multi-window
alternative) is in FREE_SAFE_EXECUTION_DESIGN.md §9.4. Rejected
conditions: if any measured or derived total exceeded the target, the
verdict is NOT_READY with the explicit blocker — never "fit".

## Honesty labels (mandatory)

DESIGN-LAB, not production measurement. LOCAL proxy units only. The
candidate is not wired into the product; the accepted suites (1142 + DB 301) and the accepted trace suite remain the ONLY production-path
evidence. CPU/live quotas/account headroom stay UNKNOWN.
