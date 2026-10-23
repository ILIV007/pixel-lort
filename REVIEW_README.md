# R1.10.4.2 — LOCAL proof-scope, fixture, and accounting corrections (PLAN-ONLY round — NOTHING EXECUTED, PUBLICATION HELD)

> **Status: UNREVIEWED REVISION — awaiting independent review (G0).
> PUBLICATION HELD: nothing is pushed; the commits on this branch are LOCAL
> and unpushed (R1141-05).**
> The R1.10.4.1 G0 review returned **PARTIALLY ACCEPTED / CHANGES REQUIRED**
> (R1141-01…R1141-05, with the validator 19/19, the D1 counterexample 1F/2P,
> the fixture counterexample 1F/2P, and the latch control 1P — all
> reproduced this round BEFORE any edit, bound at
> `logs/51-reviewer-evidence-repro-r11042.log`). This round fixes **the PLAN
> and its LOCAL tooling only**. Posidon independently accepts the R1.10.3.1
> planner/tooling corrections and the R1.10.4.1 feasibility fixes; the
> Free-safe implementation design is NOT accepted; for the UNCHANGED
> supported RSS envelope the verdict remains **NOT_READY** — the ≤40
> execution-API-call target PASSES and the ≤40 SQL-statement target FAILS
> (`free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §6/§9.2). This branch continues
> from `fc679f1f051f6d223356515160068980727f768b` (reviewed R1.10.4.1 HEAD,
> retained in history — no force push) with LOCAL docs/tooling ONLY.
> **R1.10.4.2 performed ZERO Cloudflare/account operations, including reads,
> and ZERO GitHub remote writes.** The 297 accepted product files are
> byte-identical to the accepted baseline commit
> `f70205648922d0f8e60619e45e5d54e6e87b8f1b` (branch
> `phase/04-corrections-round191`). `REVIEW_README.md` is publication
> metadata and is not part of the candidate itself.

## What changed in R1.10.4.2 (review-side docs + LOCAL tooling ONLY)

| Area                                                                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit/PREVIEW_RESOURCE_PROBE_PLAN.md`                                                      | **REVISED IN PLACE** — (R1141-01) every "full replay" claim RETRACTED: the validator execution is the **STRUCTURAL SQL/payload/storage SIMULATION** with declared SELECT-1/simplified substitutes (§16); the full-poll-equivalent harness is **UNPROVEN — NOT IMPLEMENTED** with full-poll cloud execution BLOCKED (schedule `proofScope`, decision rule **D9**); the S3 control cases now simulate BEFORE 0004; local engine metadata ≠ Cloudflare billable counters (§9/§10); full-path storage = UNKNOWN; (R1141-02) the D1 prepare/terminal contract is CORRECTED (§6): the tier-boundary probe is a registered ATTEMPTED QUERY (terminal rejection on S3 / terminal success with 0 rows on S4), counts reconciled (**153 API calls; 523 attempted statements; 602 round total**), and a PERMANENT positive workerd control is added (`audit-tools/d1-contract/`, 4 tests passing) while the historical counterexample stays byte-identical and historically red; (R1141-03) ONE deterministic generator now produces complete raw RSS documents AND canonical rows from the SAME links — actual UTF-8 serialized bytes, same-link round-trip identity for every delivered slice (F-NORMAL 207,582 B/slice; F-HETERO 1,401,282 B; F-CJK 1,505,082 B/slice; F-OVERSIZE 102,609 B — the defective `short-<i>` helper and double-counted wrapper are REMOVED; no URL cap, no truncation, no dropped rows; P_req/P_208 unchanged); (R1141-04) honest reject-path accounting (§5): the token path is the only zero-D1 path; every latch observation costs ONE submitted UPDATE with zero durable changes (behavioral proof V-18); RESERVED overhead (8 attempts / 8 API calls / ≤16 rows written / ≤64 rows read) reconciled; enforcement classes registered (durably enforced / operator submission limits / NOT enforced — no global hard request ceiling claimed); the latch now also enforces the statement budget at invocation granularity; conservative before-work admission and the no-retry-storm rule preserved; (R1141-05) NEW §19 publication-safety note: Workers Builds build attempts are KNOWN (public check-run evidence on 761f176/06caee0/fc679f1), deployment outcome/side effects/charges UNKNOWN, **publication HELD** |
| `audit/PROBE_CASE_SCHEDULE.json` (schemaVersion 2)                                          | Terminal-probe registrations with reconciled counts; per-fixture raw-RSS deliveries (byte-verified); `proofScope` (structural simulation vs UNPROVEN harness); `publicationSafety`; `accessControlClasses`; `reservedRefusalAndEmergencyOverhead`; `attemptedQueryDefinition` + `engineMetadataDistinction`; X-SMOKE tier corrected to S3 (runs at schema version 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `audit-tools/probe-plan/validate-probe-plan.mjs`                                            | **21 checks / 0 failures / exit 0** — adds the same-link fixture round-trip (V-07), the tier-aware STRUCTURAL SIMULATION (V-10, exactly 523 attempted statements), BEHAVIORAL latch controls (V-18: admission/duplicate/kill-switch/closed/statement-budget — executed, not inspected), the proof-scope register (V-19), the reserved overhead in all reconciliations (V-11/V-12/V-13), and D1-contract labeling (V-04a/V-04b); latch SQL gains the `statements_used` guard WITHOUT changing the reviewer-harness bind arity (4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `audit-tools/d1-contract/` (NEW)                                                            | PERMANENT workerd control for the D1 prepare/terminal contract (R1141-02): 4 tests, all passing — prepare() is construction-only on S3; the missing-column rejection happens at TERMINAL execution; schema_version = 3; the SAME statement prepares and terminally succeeds with 0 rows on S4 after the 0004 candidate. Own vitest config; NEVER added to the product suite counts or CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `audit/CORRECTIONS_R1_10_4_2.md` (NEW)                                                      | This round's corrections ledger (CR11042-01…05 mapped to R1141-01…05) with the verification matrix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `audit-tools/probe-plan/latch-seed.sql`                                                     | Regenerated from the schedule (statement budgets 4/6 for the setup cases); byte-verified by V-05                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `REVIEW_README.md`, `VERSION.json`                                                          | Round metadata (not part of the candidate) — **publication HELD, unpushed**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| All 297 product files; all prior review files incl. frozen evidence, logs/, posidon-review/ | **BYTE-IDENTICAL — untouched** (new files only; `logs/51…/52…/53…` are NEW bound logs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Measured results (LOCAL gates re-run this round — exact separate counts)

- Reviewer probes reproduced BEFORE any edit (at fc679f1):
  **validator 19/19 exit 0; D1 counterexample 1F/2P; fixture counterexample
  1F/2P; latch control 1P** — exit pattern 0/1/0/1, exactly matching the
  review (`logs/51-reviewer-evidence-repro-r11042.log`)
- Revised LOCAL probe-plan validator: **21 checks / 0 failures / exit 0** —
  same-link round-trip (6 delivered slices, identity=true, byte-exact);
  tier-aware structural simulation (S3 cases before 0004; exactly 523
  attempted statements = registered; fence proof; negative-probe rejection);
  behavioral latch controls; proof-scope register; reconciled resources
  (602+8/650 statements; 8,351+16/9,000 documented rows written = 12.0×
  under 100k/day; 49.0/55 MB binds; 101.2/120 MB SIMULATION storage growth =
  4.9× under 500 MB/db; 15,705/25,000 rows-read bound = 318× under 5M/day).
  Log: `logs/52-plan-validator-r11042.log`
- Permanent workerd D1-contract control: **4 tests / 4 passed / exit 0**
  (`logs/53-d1-terminal-contract-r11042.log`)
- Full CI gate `npm run check` (lint + format + typecheck + product suite +
  secret scan + versions + dry-run build): **exit 0 (GREEN)**; product suite
  **1142/1142** (91 files, unchanged); DB suite **301/301**; trace **50/50**;
  design lab **30/30** (ledger byte-identical); frozen manager probes
  **exit 1 = 1 failed / 3 passed** (CE2 intentionally historical red, never
  edited)
- 297 product files vs `f7020564…`: **byte-identical (0 modified)**,
  re-verified after the commit
- Cloudflare/account operations this round: **0** (including reads)
- GitHub remote writes this round: **0** — **publication HELD (R1141-05)**

## Verdict carrier (unchanged by this round)

- Unchanged supported RSS envelope: **NOT_READY** — ≤40 xAPI PASSES;
  ≤40 STMT FAILS (CJK shape); every unknown stays UNKNOWN until measured.
- No full-poll-equivalent claim is made: the structural simulation proves
  feasibility only; the full-poll harness is UNPROVEN and cloud execution is
  BLOCKED (D9). Structural calibration is never promoted into full-poll
  readiness.
- The durable continuation design required by design §5 still does not
  exist; §9.4 remains an options/measurement OUTLINE only.
- The path forward is the REVISED probe PLAN behind the acyclic
  authorization machine G0→G1→G2→G3→G4→G5 (`audit/PREVIEW_RESOURCE_PROBE_PLAN.md`
  - `audit/PROBE_CASE_SCHEDULE.json`) — a NEW G0 review is requested; NO
    account operation is authorized by this round. Additionally, NO push or
    PR update happens until the §19 publication-safety hold is resolved by a
    SEPARATE owner authorization.

## Prior-round content (R1.10.4.1 — preserved below, unchanged in substance)

<details>
<summary>R1.10.4.1 summary (click to expand)</summary>

Round R1.10.4.1 (HEAD `fc679f1f051f6d223356515160068980727f768b`) split the
payload gate into legal per-statement admissibility (2/4/8 rows) plus a
reachable aggregate `db.batch` ladder (13/26/26 statements; P_208 =
9,383,270 B = 2.080× P_req = 4,510,238 B), specified the disposable S3
control and S4 owned schema tiers separately, removed the authorization
cycle (acyclic G0→…→G5 with pre-authorized emergency teardown), reconciled
every budget from the machine-readable schedule with a 19-check LOCAL
validator (5 MB cap retired → 120 MB with measured 101.2 MB simulation
storage), and defined protected invocation/replay limits. The independent
G0 review of that revision returned PARTIALLY ACCEPTED / CHANGES REQUIRED
(R1141-01…05) — proof-scope, fixture, and accounting defects — all addressed
by THIS round (see `audit/CORRECTIONS_R1_10_4_2.md`). Full details of the
prior round: `audit/CORRECTIONS_R1_10_4_1.md`.

</details>

## Reproduction (from a fresh clone of THIS branch)

```bash
npm ci --ignore-scripts

# 0) NEW — LOCAL probe-plan validator: expect 21 checks / 0 failures / exit 0
node audit-tools/probe-plan/validate-probe-plan.mjs

# 0b) NEW — permanent workerd D1-contract control: expect 4/4, exit 0
npx vitest run --config audit-tools/d1-contract/vitest.config.d1.mjs

# 1) Trace tooling — expect 50/50, exit 0
npx vitest run --config audit-tools/vitest.config.trace.mjs --maxWorkers=1

# 2) Frozen manager probes — expect exit 1, 1 failed / 3 passed (CE2 intentionally red)
cp -a manager-evidence/manager-probes ./audit-tools/
mv ./audit-tools/manager-probes/design-counterexamples.test.ts.frozen \
   ./audit-tools/manager-probes/design-counterexamples.test.ts
cp manager-evidence/vitest.config.manager.mjs ./audit-tools/
npx vitest run --config audit-tools/vitest.config.manager.mjs --maxWorkers=1
rm -rf audit-tools/manager-probes audit-tools/vitest.config.manager.mjs

# 3) Design lab — expect 30/30, exit 0; ledger regeneration identical
npx vitest run --config design-lab/vitest.config.lab.mjs --maxWorkers=1 \
  > /tmp/raw-lab-run.log 2>&1
node design-lab/extract-ledger.mjs /tmp/raw-lab-run.log /tmp/cost-ledger.json
diff /tmp/cost-ledger.json design-lab/cost-ledger.json && echo "LEDGER IDENTICAL"

# 4) Full CI gate (lint, format, typecheck, product tests, secret scan, build)
npm run check
```

Suggested reading order for review:
`audit/CORRECTIONS_R1_10_4_2.md` → `audit/PREVIEW_RESOURCE_PROBE_PLAN.md`
(§5/§6/§16/§18/§19) → `audit/PROBE_CASE_SCHEDULE.json` (`proofScope`,
`publicationSafety`, `caps.accessControlClasses`) →
`audit-tools/probe-plan/README.md` → `audit-tools/d1-contract/` →
`free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §6/§9/§10 →
`audit/CORRECTIONS_R1_10_4_1.md` (prior round).

## Explicit non-claims

No product change. No deployment. No resource creation. No real D1
writes. No migration (0004 remains a test-only candidate plan; production
schema stays 3 — the probe plan consumes migrations READ-ONLY as
disposable-setup inputs). **No Cloudflare/account operation of any kind,
including reads.** **No push, no PR update, no remote write of any kind —
publication HELD (R1141-05); the round's commits are LOCAL and unpushed.**
No activation. No paid upgrade. No full-poll-equivalent claim: the
validator's execution is a STRUCTURAL SIMULATION and the full-poll harness
is UNPROVEN (D9). The validator's numbers are LOCAL feasibility proxies and
LOCAL-ENGINE metadata on local SQLite — not cloud measurements and not
Cloudflare billable counters. Design-lab, probe-plan, and d1-contract code
are NOT wired into the product and are not authorized for product use. The
unchanged RSS-envelope verdict is NOT_READY; the ≤40/≤40 result is a
CONDITIONAL measured scenario, never a universal bound; every unknown in
the plan stays UNKNOWN until measured. **STOP for Posidon review (G0) of
the REVISED plan — no G0/G1 cloud authorization is claimed and no READY
verdict is asserted.**
