# audit-tools/probe-plan/ — R1.10.4.2 LOCAL probe-plan feasibility validator

**This directory is review-side audit tooling. It is NOT part of the
accepted source tree** (which stays byte-identical to commit
`f70205648922d0f8e60619e45e5d54e6e87b8f1b`) and its checks have their OWN
run log — never added to the accepted suite's 1142 or its subsets, and never
to CI's `npm run check` (product counts unchanged).

## What it proves (and what it never does)

`validate-probe-plan.mjs` consumes the machine-readable case schedule
`audit/PROBE_CASE_SCHEDULE.json` plus the ACTUAL repository files (the real
migrations, the real `design-lab/candidate-sql.ts` source text) and proves
the probe PLAN is locally feasible before any cloud execution is requested:

| Check | Proof                                                                                                                                                                                                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-01  | Schedule structural integrity (20 cases; phase invocation sums G2:1 / G3:18 / G4:1)                                                                                                                                                                                                                                                 |
| V-02  | Bind formula derived from the repo source: 11 values/row + 7 owned guards => owned binds = 11·rows+7; ≤ 100 binds                                                                                                                                                                                                                   |
| V-03  | Owned/legacy INSERT templates extracted from the same source; '?' counts = 11k+7 / 11k for k ∈ {1,2,4,8,9}                                                                                                                                                                                                                          |
| V-04a | S3 control tier on the REAL migrations (71 statements, schema_version=3, owned column ABSENT — local compile rejection labeled LOCAL-ENGINE metadata; D1 contract pinned separately)                                                                                                                                                |
| V-04b | S4 owned tier after 0004 (schema_version=4, column PRESENT, terminal probe SUCCEEDS with 0 rows, partial unique index exists, CLI totals reconcile = 79)                                                                                                                                                                            |
| V-05  | latch-seed.sql AND sources-seed.sql regenerated from the schedule are byte-identical (drift fences)                                                                                                                                                                                                                                 |
| V-06  | Every registered statement legal (owned ≤ 8 rows / 95 binds; legacy ≤ 9 rows / 99 binds); NO 16/32/50-row rungs                                                                                                                                                                                                                     |
| V-07  | Fixture byte exactness (F-CJK 45,023 B; F-ROWSIZE 1,899,995 B; F-OVERSIZE 102,500 B; RSS < 2 MiB) + SAME-LINK round-trip: every registered delivered RSS document regenerates from the same deterministic links, serializes to exactly its registered UTF-8 bytes, and canonicalizes back to EXACTLY the registered rows (R1141-03) |
| V-08  | Reachable gate: aggregate rung-2 payload P_208 = 9,383,270 B ≥ 2 × P_req = 4,510,238 B (2.080×)                                                                                                                                                                                                                                     |
| V-09  | Internal-budget proofs (2-row fits / 3-row rejected; F-OVERSIZE + F-ROWSIZE plan-time rejections)                                                                                                                                                                                                                                   |
| V-10  | STRUCTURAL SQL/payload/storage SIMULATION (relabeled per R1141-01 — NOT a full semantic/resource replay): S3 cases before 0004, S4 after; exactly the 523 registered attempted statements; terminal-probe outcomes recorded                                                                                                         |
| V-10f | Ownership fence proof: a WRONG generation inserts ZERO rows; the correct generation inserts 2                                                                                                                                                                                                                                       |
| V-11  | Resource reconciliation incl. RESERVED refusal/emergency overhead: 602+8/650 statements; 8,351+16/9,000 rows written; 49.0/55 MB binds; 101.2/120 MB simulation storage (full-path storage UNKNOWN)                                                                                                                                 |
| V-12  | Invocation totals: 20 registered + 3 retries = 23 hard cap; per-invocation maxima within caps; round API 153+11/170                                                                                                                                                                                                                 |
| V-13  | Conservative rows-read bounds: 15,705/25,000 (318× under the documented 5M rows/day)                                                                                                                                                                                                                                                |
| V-14  | The static coverage counterexample computes exactly (1,800,116 B RSS; 5,400,023 B canonical > 2,000,000 B row limit — reviewer's frozen arithmetic preserved)                                                                                                                                                                       |
| V-15  | The plan document cites the schedule's numbers, proof-scope labels and the publication-safety hold (48 anchors)                                                                                                                                                                                                                     |
| V-16  | Quota-unit discriminator structure (non-mutating; 51+51; 4-branch interpretation matrix)                                                                                                                                                                                                                                            |
| V-17  | Protected invocation artifacts (kill-switch DDL; 21 latch rows; budgets consumed exactly once)                                                                                                                                                                                                                                      |
| V-18  | BEHAVIORAL latch controls (R1141-04): admission, duplicate delivery, kill-switch observation (1 submitted UPDATE, zero durable changes), closed case, statement-budget refusal — executed locally                                                                                                                                   |
| V-19  | Proof-scope register (R1141-01): schedule separates the structural simulation from the UNPROVEN full-poll harness; plan labels match; reviewer latch-harness bind arity (4) preserved                                                                                                                                               |

## Proof-scope honesty (R1141-01 — mandatory labels)

- The V-10 execution is a **STRUCTURAL SQL/payload/storage SIMULATION**:
  SELECT-1/simplified-SQL substitutes stand in for the accepted
  source/capability/authorization/budget-readback/classification operations.
  It is **NOT a full semantic/resource replay** and proves NO full-poll
  equivalence.
- The **full-poll-equivalent harness is UNPROVEN — NOT IMPLEMENTED** (the
  schedule's `proofScope.fullPollHarness`); full-poll cloud execution is
  BLOCKED until it exists and an authorized round runs it (decision rule D9).
- Every number the validator prints is a LOCAL feasibility proxy and
  LOCAL-ENGINE metadata (node:sqlite) — NOT a Cloudflare billable counter,
  NOT quota/CPU/billing evidence, and NOT a substitute for the
  authorization-gated probes in `audit/PREVIEW_RESOURCE_PROBE_PLAN.md`.
- node:sqlite COMPILES at prepare(); D1 does NOT (construction-only). The D1
  prepare/terminal contract is pinned by the permanent workerd control in
  `audit-tools/d1-contract/` (separate directory, own config, own log).

## Files

- `validate-probe-plan.mjs` — the validator (Node ≥ 23.4 for `node:sqlite`
  without a flag; on Node 22 run `node --experimental-sqlite`). No
  dependencies, no network, no account operations, no credentials.
- `probe-ddl.sql` — the PROBE-ONLY latch table DDL (never a product
  migration; applied to the disposable probe database at G1).
- `latch-seed.sql` — GENERATED from the schedule (1 literal-VALUES
  statement; 21 rows incl. the `__global__` kill switch). Byte-verified by
  V-05; regenerate with `--write-seeds`.
- `sources-seed.sql` — GENERATED from the schedule (1 literal-VALUES
  statement; one sources row per probe case that needs one). Byte-verified
  by V-05; regenerate with `--write-seeds`.

## Run

```bash
node audit-tools/probe-plan/validate-probe-plan.mjs
```

Expected on the R1.10.4.2 artifact: **21 checks, 0 failures, exit 0**. The
bound run log from this round is `logs/52-plan-validator-r11042.log`.

## Honesty labels (mandatory)

Every number the validator prints is a LOCAL feasibility proxy computed on
local SQLite with the real schema/SQL — it is NOT a cloud measurement, NOT
quota/CPU/billing evidence, and NOT a substitute for the authorization-gated
probes in `audit/PREVIEW_RESOURCE_PROBE_PLAN.md`. The validator exists to
prove the PLAN is executable and internally reconciled BEFORE any owner is
asked to authorize anything.
