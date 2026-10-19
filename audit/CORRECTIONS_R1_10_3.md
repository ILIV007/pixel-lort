# CORRECTIONS — R1.10.3 (Free-Safe SQL Design Proofs)

Round: R1.10.3 — LOCAL design-lab/tooling/docs ONLY. Product source
`f70205648922d0f8e60619e45e5d54e6e87b8f1b` (297 files) byte-identical;
no product change, no Cloudflare operation, no migration, no deployment,
no activation, no paid upgrade. Accepted R1.10.2 progress (corrected trace
vocabulary, 37-test executable package, recovery/stage corrections) is
PRESERVED unchanged.

## R112-01 (P1 BLOCKER — retracted estimate) → CORRECTED

- The R1.10.2 "15–16 total STMT / ≥3× headroom" grouped-reads-only claim
  is RETRACTED in `free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §2 with the
  explicit retained-INSERT arithmetic (100 unchanged INSERT statements
  counted explicitly; derived 12 API / 113 STMT for the T-13 composition).
- The manager's minimal control is REPRODUCED as corrected-query control
  Q-01 (100 one-row inserts + 2 grouped reads = 3 API / 102 STMT,
  attempted AND completed under v3 units) and preserved in the ledger as
  row C-10 (accepted baseline: 109/210 lab-scope, reconciled to T-13's
  110/211 with the 1-call queue-envelope residual documented).
- The "2-job ≈32/32" estimate is withdrawn.
- Replacement design proven, not merely named: parameter-bounded MULTI-ROW
  INSERT + grouped source-bound probes, measured in `design-lab/`
  (14 ledger rows; FIRST-profile worst case 17 xAPI / 33 STMT lab-measured,
  18/34 derived ceiling with the envelope residual; ≤40/≤40 target met).

## R112-02 (P1 — per-connector capacity and losslessness) → ADDRESSED IN SCOPE

- The FIRST deterministic Free preview profile is designed exactly as
  directed: ONE single-feed RSS source, batch 1, current 100-item bound,
  ALL redirect/authorization hops counted, other connectors explicitly
  OFF in the PROPOSED profile (no config applied; no feature removal).
- T-17…T-21 are relabeled REPRESENTATIVE (not max-bound) in the affected
  documents; their supported-max budgets stay explicitly excluded until
  separately measured.
- D3 continuation wording is corrected: RSS/YouTube = whole-feed refetch +
  dedup with NO per-item cursor; provider finite-feed history is NOT
  guaranteed by refetch — the actual evidence window is stated (§5 of the
  design). AT-LEAST-ONCE fetch and the precise supported-window contract
  stand unchanged; no universal-losslessness claim.

## R112-03 (P2 — failure/overflow counters) → FIXED (tooling v3)

- `audit-tools/trace/d1-instrument.ts` v3: failed-batch statements are no
  longer counted completed (`batchStatementsCompleted` only on completed
  batches; gap labeled `statementsNotConfirmedCompleted` = UNKNOWN
  outcome); reset/snapshot/mixed-success-failure controls added
  (C-10…C-16); the metadata reservoir no longer rewrites a retained
  record (complete record built first; explicit
  `metaDroppedFromReservoir`; complete ALL-result aggregates with
  per-field presence/sums; `metaReservoirTruncated` flag).
- Frozen-suite state after the fix: manager probes = **1F/3P** (CE1 and
  CE3 GREEN, CONTROL green, CE2 intentionally red) — exactly the manager's
  predicted composition. CE2 was NOT edited; the corrected candidate
  queries have their OWN tests (Q-02…Q-06).

## R112-04 (P2 — grouped lookup must preserve source identity) → CORRECTED

- The candidate probes keep the EXACT per-item pairs: probe A
  `WHERE source_id = ? AND id IN (…)`, probes B/C with the same source
  binding; per-source hit sets (a cross-source value leak found during
  development was fixed and is pinned by test Q-06); NULL keys excluded
  (accepted `= NULL` probes never matched); legacy mixed-source batches
  group PER SOURCE (Q-06 parity).
- Parity matrix proven on real workerd D1: chunk-boundary/100-bind
  (Q-03), foreign-source identity (Q-02, the CE2 shape corrected),
  new+duplicate+cross-key (Q-04/Q-05), legacy-mixed-source (Q-06), and
  in the lab: PK-collision (L-06), stale-owner/generation (L-03/L-04),
  whole-batch rollback and lost-fence semantics (L-06/L-11) — none
  weakened.

## Operator nits → CORRECTED IN PLACE

- "Automatic reversion to false" (Stage 8a) reworded to an EXPLICIT timed
  operator shutdown/check — no automatic mechanism exists or is
  authorized (`audit/PREVIEW_READINESS_CHECKLIST.md`).
- Unconditional "cloud ≥ local" row-count assertions and "index
  amplification automatically undercounts" wording removed/corrected in
  `free-plan/FREE_PLAN_WORKSHEET.md` — raw local metadata and full
  coverage labels kept; cloud billable equality OR inequality is NOT
  measured.
- Small connector fixtures labeled REPRESENTATIVE, not max-bound proofs
  (`audit/PREVIEW_SMOKE_TESTS.md`, `audit/CAPABILITY_MATRIX.md`,
  `audit/REMAINING_PRODUCT_WORK.md`).

## Verification summary (exact logs in logs/)

- INSTRUCTIONS package: manifest 313/313 OK; verify_package.py PASS
  (sealed original bd7d3462 + bundle HEAD f7020564 + source 297/297
  byte-identical). logs/01, logs/02.
- Manager reproduction on the SEALED input: supplied 37/37 exit 0;
  counterexamples 3F/1P exit 1; accepted tracked diff 0. logs/03–logs/07.
- v3 tooling unfiltered command: 50/50 exit 0 (28 traces + 16 controls +
  6 corrected queries). logs/30.
- Frozen manager probes on v3: 1F/3P exit 1 (CE2 historical red). logs/31.
- Design lab: 25/25 exit 0; ledger 14 rows; FIRST-profile targets met.
  logs/32, logs/33.
- Accepted source tracked diff after ALL local runs: empty. logs/40.
- Full product 1142 suite: NOT freshly rerun this round; the accepted
  R1.10.2 logs (sealed input logs/01-full-suite.log) are reused WITH
  provenance — the source tree is byte-identical (proven above), and no
  fresh-execution claim is made.

Status: **DESIGN REVIEW — not accepted, not product-implemented, not
cloud-ready.** STOP for Posidon review.
