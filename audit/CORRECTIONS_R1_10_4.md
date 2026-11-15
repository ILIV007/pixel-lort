# CORRECTIONS — R1.10.4 (LOCAL PLAN-ONLY round: docs + official-limit verification)

**Scope:** continuation of Draft PR #11 (`review/r1.10.3-sql-design`) after
Posidon's independent review **accepts the R1.10.3.1 planner/tooling
corrections**. This acceptance does NOT accept a Free-safe implementation
design; the unchanged supported RSS envelope verdict remains **NOT_READY**.
This round is **PLAN ONLY**: zero Cloudflare/account operations (including
reads), no product implementation, no resource creation, no deployment, no
real D1 writes, no migration, no activation, no billing upgrade, no merge.
Product source stays `f70205648922d0f8e60619e45e5d54e6e87b8f1b` — all 297
accepted product files remain byte-identical (re-verified after every
commit). Reviewed starting HEAD:
`761f17640133a1aec54541e5c652a1bd9e2875e3`.

## CR11040-01 — §6 stale universal-fit claim corrected (FIX 1)

- **Defect:** §6 of `free-plan/FREE_SAFE_EXECUTION_DESIGN.md` still
  carried the pre-R1.10.3.1 claim "BOTH interpretations … fit the
  ≤40/≤40 target for the FIRST profile with ≥10 headroom" — a stale
  universal-fit statement that the R1.10.3.1 envelope re-measure
  (C-15/C-16) had already made conditional-only.
- **Fix:** §6 retitled "What still gates activation (R1.10.4-corrected)"
  and the bullet replaced by an explicit UNIVERSAL-FIT CORRECTION: the
  fit held ONLY for the fixture URL shapes at the ~2 KiB canonical-URL
  assumption; after C-15/C-16, **the ≤40 execution-API-call target
  PASSES for the unchanged envelope (≈15–16 xAPI incl. residual) and
  the ≤40 SQL-statement target FAILS (≈66–67 STMT for the CJK shape)**
  → NOT_READY. The same clarification is applied where the verdict is
  stated (§9.2: "NOT_READY against the BOTH-targets requirement (the
  ≤40 xAPI target PASSES; the ≤40 STMT target FAILS)") and in the
  status header + new §10.

## CR11040-02 — §9.4 relabeled an options/measurement outline (FIX 2)

- **Defect:** §9.4 was titled "Durable continuation design (submitted
  for review)" and referenced from the status header as "a durable
  continuation design" — over-claiming implementation readiness for
  what the §5-required durable continuation spec (persisted work,
  cross-window ownership/fencing, crash windows, lossless in-window
  processing) does NOT provide: nothing in §9.4 is executable as
  written.
- **Fix:** §9.4 retitled "Continuation options and measurement OUTLINE
  (RELABELED R1.10.4 — NOT an implementation-ready durable continuation
  design)" with a relabel intro stating plainly: the R1.10.3.1
  corrections are accepted; the implementation design is NOT accepted;
  NOT_READY remains; the API target passes, the SQL-statement target
  fails; the §5-required spec still does not exist. Item 1 now records
  that the measurement-gate plan EXISTS as
  `audit/PREVIEW_RESOURCE_PROBE_PLAN.md` (PLAN ONLY, unexecuted,
  behind its own authorization checkpoints). Historical R1.10.3.1
  documents (`audit/CORRECTIONS_R1_10_3_1.md`,
  `closure/RESPONSE_LEDGER_R1_10_3_1.md`) are left byte-identical —
  they describe R1.10.3.1's own round and are not retro-edited; this
  file and design §10 record the relabel.

## CR11040-03 — preview resource probe PLAN (FIX 3 — the R1.10.4 deliverable)

NEW `audit/PREVIEW_RESOURCE_PROBE_PLAN.md` (PLAN ONLY, NOTHING
EXECUTED). Contents against this round's requirements:

- **Official limits verified with URLs, dates, exact units (§2):**
  public docs fetched 2026-10-19 (UTC/Tehran) — D1 limits ("Last
  updated Apr 21, 2026"), D1 pricing ("Apr 21, 2026"; incl. the
  verbatim footnote "Free limits reset daily at 00:00 UTC"), Workers
  limits ("Oct 12, 2026"; CPU 10 ms Free, CPU excludes network wait,
  Error 1102/`exceededCpu`, 100,000 requests/day Free, subrequests
  50/request), Workers Trace Events ("Sep 14, 2026"; `CPUTimeMs` int ms,
  `WallTimeMs` wall-clock), Workers Logs ("Oct 12, 2026"; included in
  Free at 200,000 events/day, 3-day retention, 256 KB log cap; pricing
  changes Dec 1, 2026 — re-verify before reliance), Queues pricing
  ("Apr 21, 2026"; 10,000 ops/day, per-64 KB-chunk units; reset boundary
  still UNKNOWN). Drift vs the sealed manager excerpts: none in any
  load-bearing row (recorded in §2.5). TR-01 unit ambiguity and TR-06
  reset-UNKNOWN are preserved.
- **Isolated disposable preview resources + synthetic fixtures (§4/§5):**
  a separate probe Worker (`pixel-probe-r1104` proposal) + one
  disposable D1 database bound to NOTHING product-side; no queues; Free
  headroom (10 DBs/account) owner-confirmed before creation;
  deterministic checksummed fixtures F-NORMAL / F-HETERO / F-CJK /
  F-OVERSIZE — no provider fetches, no real content.
- **Measurement definitions for quota outcomes, SQL statements, bind
  payloads, row usage, REAL Worker CPU (§6/§7):** pre-registered cases
  P-01…P-08 with fixed expectation classes (P-01 = the decisive
  documented-limits-only bind-payload ladder; P-03…P-05 = on-platform
  parity checks against LOCAL proxy numbers; P-06 = oversized-row
  plan-time rejection with zero durable effects; P-07 = CPU via
  Workers Logs invocation logs / Trace Events `CPUTimeMs`; P-08 =
  passive quota deltas from `meta` + owner analytics); BOTH
  interpretations of the Free "50 queries" row always reported; wall
  time is NEVER CPU; unobtainable CPU surfaces stay UNKNOWN.
- **Normal, heterogeneous-size, Unicode/CJK, oversized-row cases (§5/§6):**
  all four REQUIRED shapes included as F-NORMAL/P-05, F-HETERO/P-04,
  F-CJK/P-01/P-02/P-03/P-07, F-OVERSIZE/P-06.
- **Exact bounded invocation/data totals (§8):** hard caps — ≤ 12
  invocations, ≤ 600 statements, ≤ 2,500 rows written, ≤ 50,000 rows
  read, ≤ 30 MB bind payload, ≤ 5 MB storage growth, 0 queue ops,
  0 provider fetches, 0 product touches — each ≥ 40× below the
  corresponding documented daily allowance (except bind payload, which
  has NO documented row and is precisely what P-01 measures).
- **Prerequisites / abort / cleanup / evidence (§9/§10):** nine P0
  gates incl. account-headroom confirmation, baseline usage snapshot,
  at-execution-time official-limit re-verification, pinned script and
  fixture checksums, secret scan, Workers Logs capture smoke,
  rehearsed teardown; abort on any out-of-scope effect, any
  expectation-class mismatch, any quota-exceeded error; cleanup with
  Time Travel semantics; evidence set bound by SHA256SUMS with
  provenance headers.
- **Pre-committed decision rules (§12):** D1 (policy adoption needs
  ≥ 2× payload margin + correct rows + CPU pass), D2 (NOT_READY lifts
  ONLY on measured ≤ 40/≤ 40 under BOTH interpretations), D3 (CPU
  dominates: > 10 ms or `exceededCpu` ⇒ CJK shape NOT_READY on Free
  under ANY byte policy; CPU UNKNOWN ⇒ NOT_READY stands), D4 (quota
  honesty), D5 (no goal-directed re-runs), D6 (drift ⇒ re-review).
- **Internal combined-byte policy kept DISTINCT from official SQL-text
  limits (§3):** the 102,400-byte SQL-text-plus-binds policy is an
  INTERNAL CONSERVATIVE margin constraining something the docs do not
  document; the official rows are 100,000 bytes of SQL TEXT per
  statement and 100 binds per query; the policy is revisable ONLY on
  measured evidence per D1/D2.
- **Separate authorization checkpoint before ANY account operation
  (§11):** G0 (this review) → G1 (create) → G2 (execute) → G3
  (cleanup), each an explicit recorded owner "go"; read-only account
  operations included in the prohibition.

## CR11040-04 — verification matrix (this round's exact counts)

All measured on the R1.10.4 tree (node ≥22, npm ci, workerd pools):

| Gate                                           | Result                                                                     | Exit         |
| ---------------------------------------------- | -------------------------------------------------------------------------- | ------------ |
| `npm run lint` (eslint .)                      | 0 errors                                                                   | 0            |
| `npm run format:check` (prettier --check .)    | clean                                                                      | 0            |
| `npx tsc --noEmit`                             | clean                                                                      | 0            |
| Product suite (`npm run test`)                 | **1142/1142** (91 files)                                                   | 0            |
| DB suite (`npm run test:db`)                   | **301/301** (22 files)                                                     | 0            |
| Trace tooling (v3)                             | **50/50** (3 files)                                                        | 0            |
| Design lab                                     | **30/30** (2 files); 16-row ledger byte-identical                          | 0            |
| Frozen manager probes (materialized .frozen)   | **1 failed / 3 passed** (CE2 intentionally historical red)                 | 1 (EXPECTED) |
| Full CI gate (`npm run check`)                 | green                                                                      | 0            |
| `npm run scan:secrets`                         | 355 tracked files / 0 findings                                             | 0            |
| Credential-pattern grep over ALL tracked files | scanner pattern docs + self-test fixture only (no credential-shaped token) | 0            |
| 297 product files vs `f7020564…`               | byte-identical (0 modified)                                                | —            |

All numbers above were re-measured on the R1.10.4 tree in this round
(bound outputs: prettier/eslint/tsc console exits; product/DB/trace/lab
and frozen-probe runs; the `npm run check` log with the 380.09 KiB
dry-run; the secret-scan line "355 files scanned, 0 findings"). The
design-lab 16-row cost ledger regenerated from a fresh lab run is
byte-identical to the committed `design-lab/cost-ledger.json`.

## Commit identity

- Branch: `review/r1.10.3-sql-design` (same branch/PR; ordinary commits,
  no force push; reviewed commits `c72db10c…` and `761f1764…` retained
  in history).
- Parent of this round's first commit:
  `761f17640133a1aec54541e5c652a1bd9e2875e3`.
- Compliance: Cloudflare/account operations **0**; product files
  changed **0**.
