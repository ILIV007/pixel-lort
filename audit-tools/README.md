# audit-tools/ — R1.10.3 Local Trace Suite v3 (OUTSIDE accepted source)

**This directory is NEW audit tooling. It is NOT part of the accepted source
tree** (which stays byte-identical to commit `f70205648922d0f8e60619e45e5d54e6e87b8f1b`)
and its counts have their OWN logs — never added to the accepted suite's
1142 or its subsets.

## R1.10.3 changes vs the R1.10.2 edition (v2)

- **`trace/d1-instrument.ts` v3 — R112-03 corrections:**
  - FAILED batch statements are NO LONGER counted as completed: the new
    counter `batchStatementsCompleted` increments ONLY on a completed
    batch (D1 batches are implicit all-or-nothing transactions).
    `deriveCounts().statementsCompleted = terminalCompleted +
batchStatementsCompleted`; the gap is reported as
    `statementsNotConfirmedCompleted` and is LABELED UNKNOWN-outcome
    (workerd does not expose per-statement rollback internals) — never
    "completed", never silently renamed "failed".
  - Reservoir saturation can NO LONGER rewrite a retained record
    (v2's CE3 bug): captureMeta builds the COMPLETE record first, then
    retains it (first `META_RESERVOIR_LIMIT = 4096`) or counts it in the
    explicit `metaDroppedFromReservoir` counter. Complete ALL-result
    aggregates (`metaAggregates.availableTotal/unavailableTotal` +
    per-field presence/sums) stay COMPLETE regardless of reservoir
    truncation, and `metaReservoirTruncated` flags a truncated reservoir.
    (The R1.10.2 field `metaUnavailableCount` moved to
    `metaAggregates.unavailableTotal` — C-07/C-08 updated accordingly.)
- **`trace/instrument-controls.test.ts` — 16 controls:** the accepted
  C-01…C-09 semantics (unchanged behavior, v3 field paths) PLUS new
  R112-03 controls: C-10 failed-batch completion (real D1 rollback
  proof), C-11 mixed success/failure sequence, C-12 reset, C-13 snapshot
  isolation, C-14 reservoir saturation without retained-record mutation
  (mirrors the frozen manager CE3), C-15 complete aggregates under
  truncation, C-16 the labeled UNKNOWN gap.
- **`trace/candidate-classification.ts` (NEW, design code):** the
  R112-04-CORRECTED grouped classification probes — source predicate
  PRESERVED on every probe (per-source hit sets; chunk ≤99 values + 1
  source bind = ≤100 binds), NULL keys excluded, accepted per-item
  outcome assembly in attempt order with all quirks — plus the accepted
  per-item reference loop used by the parity tests.
- **`trace/corrected-queries.test.ts` (NEW):** 6 corrected-query
  controls, SEPARATE from the frozen manager probes (which embed the
  REJECTED literal SQL and intentionally stay red):
  Q-01 the R112-01 floor (100 retained one-row inserts + 2 grouped reads
  = 3 API / 102 STMT, attempted AND completed), Q-02 foreign-source
  identity parity (the CE2 shape corrected), Q-03 chunk boundary (99+1;
  exactly 100 binds executes), Q-04 full outcome matrix parity
  (inserted/dupExternal/dupUrl/quirk/null-key/cross-key), Q-05
  new+duplicate mix at volume, Q-06 legacy mixed-source parity.
- **`trace/trace-suite.test.ts` — 28 traces: UNCHANGED from the accepted
  R1.10.2 edition** (all 37 accepted correction semantics preserved:
  TR-01 units, TR-03 ordering, TR-05 single-copy, TR-06 separate cron
  windows, recovery/stage corrections). v3's completed-count change
  affects ONLY failed batches; every trace window completes, so the
  logged numbers are identical (spot-anchors T-13 110/211, T-16
  1001/1812 verified).
- **No nested duplicates** (TR-05): exactly ONE copy of each tool file.

## Unit vocabulary (mandatory in every report)

| Term                               | Meaning                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `prepares`                         | `prepare()` construction calls — NOT executions/queries/RPC   |
| execution-API-call attempts        | terminal executions + batch calls (per window)                |
| statements attempted               | terminal executions + batch statements                        |
| statements completed               | terminal completions + completed-batch statements ONLY (v3)   |
| statements not-confirmed-completed | the gap — UNKNOWN outcome (rolled-back/unobservable), labeled |
| meta available / unavailable       | complete ALL-result totals (v3), independent of the reservoir |

These are LOCAL workerd + miniflare D1 PROXY measurements. They do NOT prove
Cloudflare-side CPU (network wait is not CPU), do NOT emulate Cloudflare
quota enforcement, and local `rows_read`/`rows_written` meta is the local
engine's estimate — NOT a cloud billable counter. The mapping to the
documented Cloudflare "50 queries per Worker invocation" Free row is a
SEPARATE documented question; BOTH interpretations are carried in
`free-plan/` documents.

## Count separation (mandatory)

Tool counts (28 traces + 16 instrument controls + 6 corrected-query
controls = 50) are NEVER added to the accepted product suite's 1142 or
its subsets (DB 301, focused rehearsals). The design-lab suites are
counted SEPARATELY again (11 parity + 14 ledger scenarios).

## EXACT bootstrap and run command (from a fresh package extraction)

The package root contains `source/` and `verification/accepted-history.bundle`
but NOT a package root `wrangler.jsonc`/`src/` — the tools must be overlaid
on a CLONE of the accepted tree. Exact steps:

```bash
# 1. Clone the real accepted history (explicit branch).
git clone --branch phase/04-corrections-round191 \
  verification/accepted-history.bundle repo

# 2. Install dependencies (no lifecycle scripts).
cd repo && npm ci --ignore-scripts

# 3. Overlay the audit tools (ONE copy, no nested duplicates).
cp -a <package-root>/audit-tools ./audit-tools

# 4. Run the UNFILTERED documented command (recursive include; no
#    narrow-file bypass, no extra path arguments).
npx vitest run --config audit-tools/vitest.config.trace.mjs --maxWorkers=1
```

Expected on the R1.10.3 final artifact: **3 files passed, 50 tests passed,
exit 0** (28 traces + 16 instrument controls + 6 corrected-query
controls). The bound run log from this round is `logs/30-trace-run-r1103.log`;
the fresh-extraction re-proof is bound as `logs/4x-…final…log`.

For the HISTORICAL input evidence (manager's independent reproduction of
the SEALED R1.10.2 input: supplied 37/37 exit 0 + frozen counterexamples
3F/1P exit 1), use the manager's own script:
`bash manager-evidence/reproduce.sh /absolute/new-logs`.

### Frozen manager probes against the v3 tooling (expected 1F/3P)

```bash
cp -a <package-root>/manager-evidence/manager-probes ./audit-tools/
mv ./audit-tools/manager-probes/design-counterexamples.test.ts.frozen \
   ./audit-tools/manager-probes/design-counterexamples.test.ts
cp <package-root>/manager-evidence/vitest.config.manager.mjs ./audit-tools/
npx vitest run --config audit-tools/vitest.config.manager.mjs --maxWorkers=1
rm -rf ./audit-tools/manager-probes ./audit-tools/vitest.config.manager.mjs
```

(The probe source is stored OPAQUE as `.frozen` — byte-preserved
historical evidence that formatters/linters never touch — and is
materialized TEMPORARILY for its standalone run; remove the copy
afterwards. `bash manager-evidence/reproduce.sh` does the same inside a
disposable scratch tree.)

Expected: **exit 1, 1 failed / 3 passed** — CE1 and CE3 turn GREEN under
the v3 instrument (the R112-03 fixes), CONTROL stays green (3 API / 102
STMT), and **CE2 stays RED intentionally**: it embeds the REJECTED
source-less literal SQL as historical proof. Do NOT edit the frozen test
to claim 4/4; the corrected candidate queries are proven separately
(Q-02…Q-06).

## Design lab (separate surface)

`design-lab/` (documented in its own README) carries the candidate SQL
parity suite and the executable cost ledger:

```bash
cp -a <package-root>/design-lab ./design-lab
npx vitest run --config design-lab/vitest.config.lab.mjs --maxWorkers=1
node design-lab/extract-ledger.mjs <raw-run-log> design-lab/cost-ledger.json
```

Expected: **2 files passed, 25 tests passed, exit 0**; 14 ledger rows.

## Trace index (v2 — unchanged; see the R1.10.2 README preserved in the sealed input)

The 28-trace index (T-01…T-28) with its exact windows and numbers is
preserved UNCHANGED in the sealed input
(`input/R1.10.2_bd7d3462_ORIGINAL.zip` → `audit-tools/README.md`) and in
the R1.10.2 delivery logs. Key anchors: T-13 = 110 xAPI / 211 STMT
(100-new single poll — exceeds the documented Free 50 under BOTH unit
readings), T-16 = 1001/1812 (active batch10), T-14 = 210/311 (100
duplicates). These are the accepted REAL-PATH baselines and remain the
reference; the design-lab candidate numbers are labeled DESIGN-LAB and
never replace them.

Honesty labels (mandatory): every number is a LOCAL proxy measurement; no
cloud CPU/quota/billing conclusion is drawn from any of it.
