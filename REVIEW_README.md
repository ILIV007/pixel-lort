# R1.10.4 — Preview Resource Probe PLAN (PLAN-ONLY round — NOTHING EXECUTED)

> **Status: UNREVIEWED PLAN — awaiting independent review (G0).**
> Posidon independently ACCEPTS the R1.10.3.1 planner/tooling corrections.
> This does NOT accept a Free-safe implementation design; for the
> UNCHANGED supported RSS envelope the verdict remains **NOT_READY** —
> the ≤40 execution-API-call target PASSES and the ≤40 SQL-statement
> target FAILS (`free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §6/§9.2,
> R1.10.4-corrected). This branch continues from
> `761f17640133a1aec54541e5c652a1bd9e2875e3` (reviewed R1.10.3.1 HEAD,
> retained in history — no force push) with LOCAL docs ONLY.
> **R1.10.4 performed ZERO Cloudflare/account operations, including
> reads** — no resource creation, deployment, real D1 writes,
> migration, activation, billing upgrade, or merge. The 297 accepted
> product files are byte-identical to the accepted baseline commit
> `f70205648922d0f8e60619e45e5d54e6e87b8f1b` (branch
> `phase/04-corrections-round191`). `REVIEW_README.md` is publication
> metadata and is not part of the candidate itself.

## What changed in R1.10.4 (review-side docs ONLY)

| Area                                                                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `free-plan/FREE_SAFE_EXECUTION_DESIGN.md`                                                           | **FIX 1** — §6 stale universal-fit claim corrected: the ≤40/≤40 dual fit held ONLY for fixture URL shapes at the ~2 KiB assumption; stated plainly, the ≤40 API target PASSES and the ≤40 STMT target FAILS for the unchanged envelope (C-15/C-16) → NOT_READY. Status header + new §10 updated. §9.2 verdict sentence clarified (BOTH-targets requirement; API passes / STMT fails)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `free-plan/FREE_SAFE_EXECUTION_DESIGN.md`                                                           | **FIX 2** — §9.4 RELABELED "Continuation options and measurement OUTLINE — NOT an implementation-ready durable continuation design"; relabel intro + item-1 pointer to the new probe plan; the §5-required durable continuation spec still does not exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `audit/PREVIEW_RESOURCE_PROBE_PLAN.md` (NEW)                                                        | **FIX 3** — the authorization-gated preview resource probe PLAN (PLAN ONLY, NOTHING EXECUTED): official-limit re-verification with URLs/page dates/exact units (public docs fetched 2026-10-19; zero account operations); isolated disposable preview resources; synthetic checksummed fixtures (normal / heterogeneous / Unicode-CJK / oversized-row); pre-registered cases P-01…P-08 measuring quota outcomes, SQL statements, bind payloads, row usage and REAL Worker CPU (documented surfaces: Workers Logs invocation logs; Trace Events `CPUTimeMs`; wall time is NEVER CPU); exact bounded invocation/data totals ≥ 40× under every documented daily allowance; prerequisites P0-1…P0-9; abort criteria; cleanup with Time Travel semantics; evidence collection bound by SHA256SUMS; pre-committed decision rules D1…D6 (no goal-directed re-runs; CPU dominates; UNKNOWN never promoted); the internal 102,400-byte combined policy kept DISTINCT from the official 100,000-byte SQL-TEXT + 100-bind rows; separate authorization checkpoints G0→G1→G2→G3 before ANY account operation |
| `audit/CORRECTIONS_R1_10_4.md` (NEW)                                                                | This round's corrections ledger (CR11040-01…04) with the verification matrix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `REVIEW_README.md`, `VERSION.json`                                                                  | Round metadata (not part of the candidate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| All 297 product files; all R1.10.3(.1) review files incl. frozen evidence, logs/, manager-evidence/ | **BYTE-IDENTICAL — untouched**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Measured results (LOCAL gates re-run this round — exact separate counts)

- Full CI gate `npm run check` (lint + format + typecheck + product
  suite + secret scan + versions + dry-run build): **exit 0 (GREEN)**
- Product suite: **1142/1142** (91 files), exit 0; DB suite: **301/301**
  (22 files), exit 0
- Trace tooling (v3): **50/50**, exit 0; Design lab: **30/30**, exit 0;
  regenerated 16-row ledger byte-identical to
  `design-lab/cost-ledger.json`
- Frozen manager probes (materialized `.frozen` fixture): **exit 1 =
  1 failed / 3 passed** — CE1/CE3/CONTROL green under the v3
  instrument; **CE2 intentionally historical red** (never edited to
  green)
- Secret scan: **355 tracked files / 0 findings**; explicit
  credential-pattern grep over ALL tracked files hits ONLY the secret
  scanner's own pattern docs + self-test fixture (no credential-shaped
  token anywhere)
- 297 product files vs `f7020564…`: **byte-identical (0 modified)**,
  re-verified after every commit
- Cloudflare/account operations this round: **0** (the only external
  access was PUBLIC documentation fetch for §2 of the probe plan — not
  an account operation)

## Verdict carrier (unchanged by this round)

- Unchanged supported RSS envelope: **NOT_READY** — ≤40 xAPI PASSES
  (≈15–16 incl. residual); ≤40 STMT FAILS (≈66–67 for the CJK shape);
  "18 xAPI / 34 STMT" remains a CONDITIONAL measured scenario (fixture
  URL shapes at the ~2 KiB assumption), never a universal bound.
- The durable continuation design required by design §5 still does not
  exist; §9.4 is an options/measurement OUTLINE only.
- The path forward is the probe PLAN behind authorization checkpoints
  G0→G1→G2→G3 (`audit/PREVIEW_RESOURCE_PROBE_PLAN.md`) — G0 is THIS
  review.

## Prior-round content (R1.10.3.1 — preserved below, unchanged in substance)

<details>
<summary>R1.10.3.1 summary (click to expand)</summary>

Corrections after the manager verdict CHANGES REQUIRED on reviewed HEAD
`c72db10c7c631dd62c7981391d628b9c09104235`:

- **FIX 1** — `design-lab/candidate-sql.ts` per-chunk byte accounting:
  EVERY chunk built + validated independently against its ACTUAL SQL
  text + ACTUAL bind bytes (row binds + real P/B1 shared guard values)
  under BOTH the 100-bind row and the conservative 102,400-byte budget;
  explicit `OversizedRowPlanError` rejects a single oversized row at
  PLAN time (atomic, zero effects, no truncation/silent drop);
  per-statement re-audit before `prepare()`; atomicity, ownership
  predicate P, B1 binding, both targeted conflict clauses
  byte-identical. Evidence: L-08 reworked, L-12 (counterexample: 1×8 +
  46×2 = 47 INSERTs, all ≤ budget), L-13, L-14 (canonical URLs exactly
  45,023 bytes via the accepted normalizer — NO URL cap).
- **FIX 2** — "18 xAPI / 34 STMT" RETRACTED as universal → CONDITIONAL
  measured scenario; C-15 (owned: 15 xAPI / 66 STMT) / C-16 (legacy: 14
  / 65) — ≤40 STMT FAILS → NOT_READY for the unchanged envelope;
  platform-limit justification (documented SQL-TEXT row vs internal
  combined policy; payload/CPU/quota risks) in design §9.3.
- **FIX 3** — CI restored green; frozen manager probe preserved
  BYTE-IDENTICAL as `.frozen` opaque fixture, materialized temporarily
  for its standalone run (expected exit 1 = 1F/3P, CE2 intentionally
  red); no ignore lists, no disabled CI, no weakened assertions.
- Full details: `audit/CORRECTIONS_R1_10_3_1.md`,
  `closure/RESPONSE_LEDGER_R1_10_3_1.md`.

</details>

## Reproduction (from a fresh clone of THIS branch)

```bash
npm ci --ignore-scripts

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
`audit/CORRECTIONS_R1_10_4.md` → `audit/PREVIEW_RESOURCE_PROBE_PLAN.md`
→ `free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §6/§9/§10 →
`audit/CORRECTIONS_R1_10_3_1.md` (prior round).

## Explicit non-claims

No product change. No deployment. No resource creation. No real D1
writes. No migration (0004 remains a test-only candidate plan;
production schema stays 3). **No Cloudflare/account operation of any
kind, including reads.** No activation. No paid upgrade. Design-lab
code is NOT wired into the product and is not authorized for product
use. The unchanged RSS-envelope verdict is NOT_READY; the ≤40/≤40
result is a CONDITIONAL measured scenario, never a universal bound;
the probe plan is a PLAN — its measurements do not exist yet and every
unknown in it stays UNKNOWN until measured. **STOP for Posidon review
(G0).**
