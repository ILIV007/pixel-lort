# CORRECTIONS — R1.10.3.1 (LOCAL design/tooling corrections ONLY)

**Scope:** corrections to the R1.10.3 review-side candidate after the
manager verdict **CHANGES REQUIRED** on Draft PR #11
(reviewed HEAD `c72db10c7c631dd62c7981391d628b9c09104235`). Product
source stays `f70205648922d0f8e60619e45e5d54e6e87b8f1b` — all 297
accepted product files remain byte-identical (re-verified after every
commit). No product implementation, no merge, no migration/config
change, no Cloudflare operation, no deployment, no activation, no paid
upgrade. Design remains **UNREVIEWED / NOT accepted**; the unchanged
envelope verdict is **NOT_READY** (§9.2 of
`free-plan/FREE_SAFE_EXECUTION_DESIGN.md`).

## CR11031-01 — per-chunk byte accounting (FIX 1)

- **Defect:** `design-lab/candidate-sql.ts` `planInsertChunks` derived
  ONE rows-per-statement from the input prefix and applied it blindly to
  later chunks. Manager counterexample: 8 short-URL items then 92 items
  with 5000-char CJK HTTPS paths (RSS XML < 2 MiB) → rowsPerStatement 8,
  later statements reached **375,637** audited SQL-plus-bind bytes vs the
  declared 102,400 budget.
- **Fix:** every chunk is now built and validated INDEPENDENTLY against
  its ACTUAL SQL text + ACTUAL bind bytes (own row binds + the REAL
  shared guard bind values of P + B1), under BOTH the 100-bind-count row
  and the conservative combined-byte budget. Chunk sizes vary and each
  carries a `statementAudit`. A single oversized row now raises
  `OversizedRowPlanError` (`row_exceeds_statement_budget`) at PLAN time —
  whole commit rejected atomically, zero statements, zero durable
  effects, no truncation, no silent drop. Every fully built statement is
  re-audited before `prepare()` (`assertStatementWithinBudget`).
  Atomicity, ownership predicate P, B1 source binding, and both targeted
  conflict clauses are byte-identical to R1.10.3.
- **Evidence:** lab L-08 (reworked: EVERY chunk audited), L-12 (the
  counterexample reproduced and fixed: 1×8 + 46×2 = 47 INSERT
  statements, all audits ≤ budget, all rows + full ≈45 KB URLs land,
  feed < 2 MiB), L-13 (oversized row rejected pre-execution), L-14
  (uniform CJK: exactly 50 chunks × 2 rows). 30/30 lab tests exit 0.

## CR11031-02 — worst-case claim retracted as universal; NOT_READY (FIX 2)

- **Fact:** the accepted normalizer (`src/connectors/normalize.ts`,
  unmodified) enforces NO canonical-URL length cap; 5000-char CJK paths
  normalize to canonical URLs of **exactly 45,023 bytes** (pinned via the
  real `normalizeRawItem` in L-12/L-14) while the raw-CJK RSS XML stays
  ≈1.4 MB < the 2 MiB feed limit — inside the unchanged envelope.
- **Consequence:** under the unchanged conservative combined-byte policy
  the planner selects 2 rows/statement → **50 INSERT statements ALONE**;
  measured end-to-end as ledger rows **C-15 (owned: 15 xAPI / 66 STMT)**
  and **C-16 (legacy: 14 xAPI / 65 STMT)** — the ≤40 STMT target FAILS
  (≤40 xAPI still holds).
- **Resolution:** the "18 xAPI / 34 STMT" figure is RETRACTED as a
  universal bound and RELABELED a **conditional measured scenario**
  (fixture URL shapes at the ~2 KiB assumption). Verdict for the
  UNCHANGED supported RSS envelope: **NOT_READY against BOTH ≤40
  targets**. Platform-limit justification (documented SQL-TEXT row vs
  the internal combined policy; no documented bound-parameter size or
  batch-payload row; payload/CPU/quota risks) and the **durable
  continuation design** (authorized preview-DB measurement gate,
  pre-committed policy decision rule, durable multi-window alternative)
  are in `free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §9.3/§9.4.
- **Prohibited moves (none done, none proposed):** URL/item truncation,
  lowering supported caps, discarding work, weakening fences, assuming a
  paid plan.

## CR11031-03 — CI restored green (FIX 3)

Measured before this round (publication log): eslint exit 1 with 45
errors (44 no-console + 1 unused-var) and prettier --check exit 1 on 28
files — ALL confined to the added review-side files. Mechanical fixes:

- `console.log` in the measurement suites is channeled through ONE
  documented helper per tree — `design-lab/lab-log.ts` and
  `audit-tools/trace/trace-log.ts` — each carrying the SINGLE
  `eslint-disable-next-line no-console` with its justification: the
  workerd test pool forwards host-visible output ONLY via console and
  `design-lab/extract-ledger.mjs` PARSES those lines
  (`LABLEDGER[…]`/`LAB[…]`/`TRACE[…]`/`POSIDON[…]` channels). No blanket
  ignores; no eslint config change (the product `eslint.config.js` is
  byte-identical).
- `design-lab/extract-ledger.mjs` (Node CLI) carries three per-line
  disable comments for the same reason (its output IS the extraction
  log).
- `design-lab/cost-ledger.test.ts`: the genuinely unused
  `capability` binding renamed `_capability` (config-allowed pattern);
  the ledger row schema gained honest per-chunk fields
  (`chunkRows` run-length, `maxStatementTotalBytes`).
- Prettier applied to the 28 flagged review-side files
  (markdown/JSON/TS formatting only). Content-preservation proof: an
  ordered word-stream comparison (letters/digits in order) of every
  reformatted .md/.json against the reviewed HEAD is IDENTICAL — zero
  words added, removed, or reordered; table dashes/padding and emphasis
  markers are the only changes.
- **Frozen evidence:** the manager probe source is preserved
  BYTE-IDENTICAL as an opaque fixture
  `manager-evidence/manager-probes/design-counterexamples.test.ts.frozen`
  (git rename, bytes untouched) and is materialized TEMPORARILY for its
  standalone run by `manager-evidence/reproduce.sh` and the documented
  commands; the materialized copy is removed after the run. The frozen
  run keeps its expected outcome **exit 1 = 1 failed / 3 passed**
  (CE1/CE3/CONTROL green under the v3 instrument, CE2 intentionally
  historical red). No ignore lists, no disabled CI, no weakened
  assertions; `logs/` and `manager-evidence/OBSERVATIONS.json`,
  `manager-evidence/README.md` are byte-untouched.

## CR11031-04 — verification matrix (re-run, exact counts)

All measured on the corrected tree (node ≥22, npm ci, workerd pools):

| Gate                                              | Result                                   | Exit               |
| ------------------------------------------------- | ---------------------------------------- | ------------------ |
| `npm run lint` (eslint .)                         | 0 errors                                 | 0                  |
| `npm run format:check` (prettier --check .)       | clean                                    | 0                  |
| `npx tsc --noEmit`                                | clean                                    | 0                  |
| Product suite (`npm run test`)                    | **1142/1142** (91 files)                 | 0                  |
| DB suite (`npm run test:db`)                      | **301/301** (22 files)                   | 0                  |
| Trace tooling (v3, 28 traces + 16 controls + 6 Q) | **50/50** (3 files)                      | 0                  |
| Design lab (14 parity/regression + 16 ledger)     | **30/30** (2 files)                      | 0                  |
| Frozen manager probes (materialized .frozen)      | **1 failed / 3 passed**                  | 1 (EXPECTED — CE2) |
| `npm run test:secrets` (self-test)                | pass                                     | 0                  |
| `npm run test:telegram-setup`                     | pass                                     | 0                  |
| `npm run check:versions`                          | pass                                     | 0                  |
| `npm run scan:secrets`                            | 353 tracked files / 0 findings           | 0                  |
| Credential-pattern grep over ALL tracked files    | only the scanner's own self-test fixture | 0                  |
| `npm run build` (wrangler dry-run)                | 380.09 KiB                               | 0                  |
| `npm run check` (the CI gate, all of the above)   | green                                    | 0                  |

Cost ledger: regenerated from the bound raw run log via
`node design-lab/extract-ledger.mjs` — **16 rows**, committed at
`design-lab/cost-ledger.json`; the committed file is byte-identical to a
fresh extraction of the committed tree's run.

## Commit identity

- Branch: `review/r1.10.3-sql-design` (same branch/PR; ordinary commits,
  no force push; reviewed commit `c72db10c…` retained in history).
- Parent of this round's first commit: `c72db10c7c631dd62c7981391d628b9c09104235`.
- See `closure/RESPONSE_LEDGER_R1_10_3_1.md` for the verdict-item →
  evidence map.
