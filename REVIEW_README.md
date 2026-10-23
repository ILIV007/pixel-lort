# R1.10.4.1 — LOCAL probe-plan feasibility corrections (PLAN-ONLY round — NOTHING EXECUTED)

> **Status: UNREVIEWED REVISION — awaiting independent review (G0).**
> The R1.10.4 G0 review returned **CHANGES REQUIRED** (R114-01…R114-05,
> with three local counterexamples — reproduced this round before any edit:
> 3 failures / 0 passes / exit 1). This round fixes **the PLAN only**.
> Posidon independently ACCEPTS the R1.10.3.1 planner/tooling corrections;
> the Free-safe implementation design is NOT accepted; for the UNCHANGED
> supported RSS envelope the verdict remains **NOT_READY** — the ≤40
> execution-API-call target PASSES and the ≤40 SQL-statement target FAILS
> (`free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §6/§9.2). This branch continues
> from `06caee0eb9d12dd0d037dc125c7bace4db420f28` (reviewed R1.10.4 HEAD,
> retained in history — no force push) with LOCAL docs/tooling ONLY.
> **R1.10.4.1 performed ZERO Cloudflare/account operations, including
> reads** — no provisioning, deployment, real D1 writes, migrations,
> activation, billing upgrade, or merge; not even public documentation was
> re-fetched (the §2 basis is the manager's bound review evidence). The 297
> accepted product files are byte-identical to the accepted baseline commit
> `f70205648922d0f8e60619e45e5d54e6e87b8f1b` (branch
> `phase/04-corrections-round191`). `REVIEW_README.md` is publication
> metadata and is not part of the candidate itself.

## What changed in R1.10.4.1 (review-side docs + LOCAL validator ONLY)

| Area                                                                                          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit/PREVIEW_RESOURCE_PROBE_PLAN.md`                                                        | **REVISED IN PLACE** — (R114-01) the unreachable single-statement payload ladder is REPLACED by legal per-statement admissibility (P-01a: 2/4/8-row rungs, binds 29/51/95/95) + an aggregate `db.batch` payload ladder (P-01b: 13/26/26 legal statements; P_req = 4,510,238 B; P_208 = 9,383,270 B = 2.080× ≥ the 2× margin; the gate is validator-proven REACHABLE); the illegal 16/32/50-row rungs are GONE; (R114-02) S3 control and S4 owned schema tiers specified separately (exact DDL/versions, X-SCHEMA4 mid-round, owner/job/generation seeding, fixed reset/verification order, ownership-fence negative probe); (R114-03) the circular P0-8/G2 machine replaced by the acyclic G0→G1→G2→G3→G4→G5 state machine with PRE-AUTHORIZED emergency teardown and ALL smoke/setup/verification calls inside the caps; (R114-04) budgets RECONCILED from the machine-readable schedule + LOCAL validator (5 MB cap retired → 120 MB with exact measured arithmetic: 101.2 MB local growth incl. UNIQUE-index storage amplification); protected invocation + replay limits (token, durable latch, kill switch, 20+3=23 invocation hard cap); expected-rejection vs abort classes separated; (R114-05) quota-unit discriminator P-QU-A/B with a 4-branch interpretation matrix, commit-only vs full-poll CPU scopes, CPU-field honesty (Workers Logs field names undocumented), 50-general/1,000-internal/D1-50 rows kept distinct, EXACT coverage claim + static counterexample + decision rule D7 |
| `audit/PROBE_CASE_SCHEDULE.json` (NEW)                                                        | The machine-readable pre-registered case schedule — the single source of truth for every case, fixture, phase, statement, bind-payload, row and storage number in the plan; 20 cases; 151 API calls; 600 statements (521 invocations + 79 CLI); reconciled caps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `audit-tools/probe-plan/` (NEW)                                                               | The LOCAL-only feasibility validator `validate-probe-plan.mjs` (**19 checks / 0 failures / exit 0**), its README, the probe-only latch DDL, and the generated+byte-verified `latch-seed.sql` / `sources-seed.sql` drift fences. Review-side tooling — NEVER added to the product suite counts or CI's `npm run check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `audit/CORRECTIONS_R1_10_4_1.md` (NEW)                                                        | This round's corrections ledger (CR11041-01…05 mapped to R114-01…05) with the verification matrix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `free-plan/FREE_SAFE_EXECUTION_DESIGN.md`                                                     | §9.4 pointer updated: the measurement gate now exists as the R1.10.4.1-REVISED plan (G0 CHANGES REQUIRED addressed; a NEW G0 review is requested)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `REVIEW_README.md`, `VERSION.json`                                                            | Round metadata (not part of the candidate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| All 297 product files; all prior review files incl. frozen evidence, logs/, manager-evidence/ | **BYTE-IDENTICAL — untouched** (new files only; `logs/50-plan-validator-r11041.log` is a NEW bound log)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Measured results (LOCAL gates re-run this round — exact separate counts)

- Reviewer counterexamples reproduced BEFORE any edit:
  **3 failures / 0 passes / exit 1** (CE1/CE2/CE3 — exactly matches the
  independent review)
- NEW LOCAL probe-plan validator:
  **19 checks / 0 failures / exit 0** — bind formula + templates derived
  from the actual repo source; real migrations applied to local SQLite
  (S3=71 statements / S4=+5); latch/sources seeds byte-verified; every
  registered statement legal; P_208 ≥ 2× P_req (2.080×); internal-budget
  proofs; FULL replay of the 521 registered statements against the real S4
  schema (fence proof: wrong generation ⇒ 0 rows; negative probe ⇒ typed
  UNIQUE rejection); resources reconciled (600/650 statements; 8,351/9,000
  documented rows written = 12.0× under 100k/day; 49.0/55 MB binds;
  **101.2/120 MB measured local storage growth** = 4.9× under 500 MB/db;
  15,637/25,000 rows-read bound = 320× under 5M/day); the static coverage
  counterexample computes exactly (1,800,116 B RSS / 5,400,023 B canonical
  > 2,000,000 B row limit). Log: `logs/50-plan-validator-r11041.log`
- Full CI gate `npm run check` (lint + format + typecheck + product suite +
  secret scan + versions + dry-run build): **exit 0 (GREEN)**; product suite
  **1142/1142** (91 files); DB suite **301/301** (22 files); trace **50/50**;
  design lab **30/30** (ledger byte-identical); frozen manager probes
  **exit 1 = 1 failed / 3 passed** (CE2 intentionally historical red, never
  edited); secret scan **355+ tracked files / 0 findings**
- 297 product files vs `f7020564…`: **byte-identical (0 modified)**,
  re-verified after every commit
- Cloudflare/account operations this round: **0** (including reads; the only
  new activity is the LOCAL validator on node:sqlite)

## Verdict carrier (unchanged by this round)

- Unchanged supported RSS envelope: **NOT_READY** — ≤40 xAPI PASSES;
  ≤40 STMT FAILS (CJK shape); every unknown stays UNKNOWN until measured.
- The durable continuation design required by design §5 still does not
  exist; §9.4 remains an options/measurement OUTLINE only.
- The path forward is the REVISED probe PLAN behind the acyclic
  authorization machine G0→G1→G2→G3→G4→G5 (`audit/PREVIEW_RESOURCE_PROBE_PLAN.md`
  - `audit/PROBE_CASE_SCHEDULE.json`) — a NEW G0 review is requested; NO
    account operation is authorized by this round.

## Prior-round content (R1.10.4 — preserved below, unchanged in substance)

<details>
<summary>R1.10.4 summary (click to expand)</summary>

Round R1.10.4 (HEAD `06caee0eb9d12dd0d037dc125c7bace4db420f28`) was the
original PLAN-ONLY round: it re-verified the official limits from public
docs (2026-10-19), corrected the design §6 universal-fit claim (API target
passes; STMT target fails → NOT_READY), relabeled design §9.4 as an
options/measurement outline, and delivered the first
`audit/PREVIEW_RESOURCE_PROBE_PLAN.md` with cases P-01…P-08, hard caps and
checkpoints G0→G1→G2→G3. The independent G0 review of that plan returned
CHANGES REQUIRED (R114-01…R114-05) with three local counterexamples — all
three reproduced and addressed by THIS round (see
`audit/CORRECTIONS_R1_10_4_1.md`). Full details of the original round:
`audit/CORRECTIONS_R1_10_4.md`.

</details>

## Reproduction (from a fresh clone of THIS branch)

```bash
npm ci --ignore-scripts

# 0) NEW — LOCAL probe-plan validator: expect 19 checks / 0 failures / exit 0
node audit-tools/probe-plan/validate-probe-plan.mjs

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
`audit/CORRECTIONS_R1_10_4_1.md` → `audit/PREVIEW_RESOURCE_PROBE_PLAN.md`
→ `audit/PROBE_CASE_SCHEDULE.json` →
`audit-tools/probe-plan/README.md` →
`free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §6/§9/§10 →
`audit/CORRECTIONS_R1_10_4.md` (prior round).

## Explicit non-claims

No product change. No deployment. No resource creation. No real D1
writes. No migration (0004 remains a test-only candidate plan; production
schema stays 3 — the probe plan consumes migrations READ-ONLY as
disposable-setup inputs). **No Cloudflare/account operation of any kind,
including reads.** No activation. No paid upgrade. The validator's numbers
are LOCAL feasibility proxies on local SQLite — not cloud measurements.
Design-lab and probe-plan code are NOT wired into the product and are not
authorized for product use. The unchanged RSS-envelope verdict is NOT_READY;
the ≤40/≤40 result is a CONDITIONAL measured scenario, never a universal
bound; every unknown in the plan stays UNKNOWN until measured. **STOP for
Posidon review (G0) of the REVISED plan.**
