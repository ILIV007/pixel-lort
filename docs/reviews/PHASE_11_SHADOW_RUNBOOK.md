# Phase 11 — the shadow-mode runbook (the 7–14 day offline instrumentation + the LIVE plan)

- Version: 1.30.0 (schema 6); the instrumentation: `src/application/shadow/
shadow-report.ts` (shd1) + `tests/integration/shadow-report.test.ts`.
- Status: the TOOLING is DONE_ENGINEERING; the actual 7–14 day run is
  **BLOCKED_LIVE** (Posidon only).

## 1. What exists (DONE_ENGINEERING)

- **The report generator (shd1)** — a PURE read layer over the
  blueprint-approved tables: per-window publication honesty counts
  (published / parked-failed / superseded / dead_letter / recorded
  messages), the pipeline pressure (stories / drafts / claims /
  evidence), the duplicate pressure (processed / duplicate / failed
  source items in the window), and the AI run consumption (the LOCAL
  PROXY metric — never a billing counter). Zero writes by construction
  (asserted by test); an empty D1 yields an honest zero-valued report,
  never a simulation.
- **The typed gates (the STOP criteria)** — `evaluateShadowGates`
  returns DATA, not prose: `duplicate_pressure` (the duplicate share of
  the processed items over the pinned 0.5 ceiling ⇒ stop),
  `parked_uncertainty` (ANY failed-parked publication all-time ⇒ stop —
  a parked ADR-0058 outcome needs a human disposition before the rollout
  may widen), `publication_throughput` (zero published in the window ⇒
  insufficient_data — an empty window never passes).

## 2. The LIVE shadow plan (BLOCKED_LIVE — Posidon executes)

**Entry criteria (ALL must hold before day 0):**

1. The exact reviewed SHA is deployed by Posidon and the deployed
   APP_VERSION/SCHEMA_VERSION match `check-versions` (6 migrations
   applied IN ORDER on a RESTORED-FROM-BACKUP D1 — never on the live
   data first).
2. Every flag ships OFF except the shadow-observation surface itself;
   the scheduler send gate stays OFF for day 0 (decision-only).
3. The Telegram webhook secret is set once, and the ingress flag is ON
   only when the channel wiring is owner-approved.
4. The D1/R2/AI budgets are the FREE-TIER real quotas (never a paid
   fallback); the alarm thresholds from the free-plan ledger are
   recorded before day 0.

**The run (7–14 days, one report sample per day):**

- Day 0..N: sample `generateShadowReport` once per 24h (a cron tick the
  owner schedules); append the JSON to the shadow log (append-only).
- The observation surface (`/queue`, the admin review screens) stays
  available for the human spot checks; NOTHING auto-sends (the send
  gate OFF = decision-only observation — the 8.2 house pin).

**Exit criteria (to `safe_auto`):** ALL gates pass for SEVEN
CONSECUTIVE daily samples AND the failed-parked family stayed zero AND
the free-tier budget consumption stayed inside the recorded thresholds.

**Stop criteria (ANY one halts the run):** any gate STOP verdict; any
near-quota alarm; any incident in the audit trail the owner flags; the
duplicate share over the ceiling; a parked-uncertain row without a
human disposition.

**Rollback:** the flags OFF (the scheduler gate and the ingestion gate
are independent fail-closed flags — turning them off is the kill
switch); the D1 stays intact (no destructive migration exists in the
chain); the restore path is the tested backup ZIP + the migration
re-run IN ORDER on a scratch DB first.

## 3. The honest carry

No day of the shadow run has elapsed: there is NO shadow evidence, NO
freshness number, NO quality verdict. The 11.1 exit state is
DONE_ENGINEERING(tooling) + BLOCKED_LIVE(run). Nothing in this file
asserts a shadow-complete status — the gates consume REAL data when
the run happens, and only the run can produce the evidence.
