# CORRECTIONS — R1.10.4.1 (LOCAL probe-plan feasibility corrections ONLY)

**Scope:** continuation of Draft PR #11 (`review/r1.10.3-sql-design`) after
the R1.10.4 G0 review returned **CHANGES REQUIRED** (verdict
`CHANGES_REQUIRED_G0_NOT_APPROVED`; findings R114-01…R114-05 with three
local counterexamples — 3 failures / 0 passes / exit 1 — reproduced this
round before any edit: CE1 the unreachable single-statement payload ladder,
CE2 the schema-3-only setup that cannot run the owned predicate, CE3 the
9,125,888-byte local storage growth of one 100-row CJK fixture against the
plan's 5 MB cap). This round fixes **the PLAN only** — not the product, not
Cloudflare resources, not any account state. ZERO Cloudflare/account
operations (including reads) were performed: no provisioning, deployment,
real D1 writes, migrations, activation, or billing changes; no merge; no
product implementation. Product source stays
`f70205648922d0f8e60619e45e5d54e6e87b8f1b` — all 297 accepted product files
remain byte-identical (re-verified after every commit). Reviewed starting
HEAD: `06caee0eb9d12dd0d037dc125c7bace4db420f28` (ordinary commits only; no
force push).

## CR11041-01 — the unreachable payload gate is closed (R114-01)

- **Defect:** the R1.10.4 P-01 registered SINGLE multi-row statements at
  2/4/8/16/32/50 rows. Owned binds = **11·rows + 7** (11 row-value columns +
  7 shared guard binds — the review's own arithmetic), so 16/32/50-row rungs
  need 183/359/557 binds against the documented 100-bind limit: illegal
  under the plan's own rule. Worse, the best LEGAL single rung (8 rows)
  carries only 360,184 canonical bytes — a single-statement ladder can never
  establish the required aggregate-batch margin (CE1: required lower bound
  2 × 100 × 45,023 = 9,004,600 bytes).
- **Fix:** the gate is SPLIT into two separately-specified measurements.
  **P-01a** (per-statement admissibility): legal rungs 2/4/8 rows only
  (binds 29/51/95/95 incl. one repeat at rung 8), each rung submitted as its
  own `db.batch` so a rejection is unambiguously per-statement. **P-01b**
  (aggregate `db.batch` payload ladder, each constituent ≤ 95 binds): rung 1
  = the exact F-CJK commit shape (13 statements: 12×8 + 1×4, 100 rows —
  total bind payload **P_req = 4,510,238 B**); rung 2 = 26 statements × 8
  rows = 208 rows in ONE batch (**P_208 = 9,383,270 B = 2.080 × P_req ≥ the
  pre-committed 2× margin**); rung 3 = an exact repeat of rung 2
  (reproducibility; D1(i) requires zero payload-related rejections across
  all repetitions). Each ladder invocation registers ≤ 27 statements — under
  the Free 50-row under BOTH unit interpretations — so payload attribution
  can never be confounded with a query-count artifact. The illegal
  16/32/50-row rungs are removed from the plan entirely (validator V-06
  asserts none is registered anywhere). The D1 margin rule is REFORMULATED
  and registered BEFORE execution (plan §14): the ≥ 2× margin itself is NOT
  weakened — only the measurement vehicle changed from illegal single
  statements to legal aggregate batches (justification recorded in the plan
  §8/§14 and in the schedule's `decisionRuleInputs`). The reachable gate is
  PROVEN locally (V-08).

## CR11041-02 — disposable schema3 controls and schema4 owned fixtures, specified separately (R114-02)

- **Defect:** the R1.10.4 plan promised migrations 0001–0003 ONLY, then ran
  P-02 on the owned path whose predicate/state write requires
  `source_state.poll_owner_job_id` — reproduced with the actual accepted
  migrations on local SQLite: no such column (CE2).
- **Fix:** plan §6 now specifies BOTH tiers exactly. **S3 (control tier):**
  migrations 0001 (58 statements) + 0002 (8) + 0003 (5) = **71 statements**,
  applied in order at G1 via wrangler CLI; `schema_version` = 3 verified;
  the tier boundary is PROVEN by X-SETUP-S3's compile probe
  (`SELECT poll_owner_job_id FROM source_state LIMIT 0` — a prepare-time
  error on S3); only the legacy control case P-C3 runs under S3.
  **S4 (owned tier):** the tracked migration candidate
  `migrations/0004_source_poll_ownership.sql` (5 statements) applied to the
  SAME disposable DB mid-round as the registered X-SCHEMA4 CLI step (after
  the S3 controls, before X-SETUP-S4); `schema_version` = 4 verified; the
  owned compile probe prepares; the ownership fence is verified by a
  NEGATIVE probe (a second non-terminal job for the same aggregate ⇒ typed
  UNIQUE rejection from `idx_jobs_source_outstanding_poll`). Owner/job/
  generation seeding is pinned per case (job id `job-<source>-1`, type
  `sources.fetch_poll`, aggregate = the case's probe source, status
  queued/claimed per scope, attempts = the generation; state rows seeded
  with the registered hold; full-path cases acquire ownership durably via
  the registered `ownership-acquire` statement). The whole-round
  reset/verification ORDER is fixed (plan §6.2); cross-case interference is
  impossible by construction (per-case `source_id` + per-case fixture
  slices ⇒ no conflicts, no cross-case deletes). **No product migration or
  config is changed** — migrations are consumed read-only as
  disposable-setup inputs; account setup/writes remain future explicitly
  authorized operations (§11); existing app databases are untouched. The
  validator proves both tiers on the real migrations (V-04a/V-04b) and the
  fence (V-10f: a WRONG generation inserts ZERO rows).

## CR11041-03 — the authorization cycle is removed (R114-03)

- **Defect:** R1.10.4's P0-8 required one real invocation plus CPU-log
  export BEFORE G2, while G1 authorized CREATION ONLY — the smoke invocation
  was never authorizable (a circular precondition).
- **Fix:** plan §11 registers a finite, explicit, ACYCLIC state machine:
  **G0** (plan review — re-requested now) → **G1** (resource creation +
  CLI setup only; 74 CLI statements, all counted; no probe invocation) →
  **G2** (a SEPARATE owner authorization for exactly ONE smoke invocation
  X-SMOKE + the owner-side CPU-field availability check; if no CPU-labeled
  surface is obtainable, CPU = UNKNOWN for the round and D3 keeps
  NOT_READY — the owner may stop or continue) → **G3** (substantive probes;
  per-case or whole-set) → **G4** (final verification + evidence export) →
  **G5** (cleanup). **The future G3 grant PRE-AUTHORIZES safe emergency
  teardown**: on ANY abort criterion, stop submitting (latch hard-stop),
  export available evidence within the 3-day retention, delete the probe
  Worker + database — never dependent on a later ungranted permission. All
  smoke/setup/verification calls are inside the §10 caps (X-SMOKE,
  X-SETUP-S3, X-SETUP-S4, X-VERIFY-FINAL are registered cases with
  budgets). This round grants NONE of those permissions.

## CR11041-04 — budgets recalculated from a machine-readable schedule + LOCAL validator (R114-04)

- **Defect:** the R1.10.4 caps were declared, not reconciled: the actual
  schema stores `canonical_url` in BOTH the table and the
  `UNIQUE(source_id, canonical_url)` index, so one 100-row CJK fixture
  grew a local actual-schema database by **9,125,888 bytes** — above the
  plan's 5 MB growth cap (CE3; reproduced this round and now embedded in the
  validator's measured arithmetic); the "empty DB ≈ 12 KB" figure was
  misused as the schema baseline (local complete schema = 413,696 bytes);
  and "routes OFF" was offered as access control.
- **Fix:** plan §10 is now DERIVED from `audit/PROBE_CASE_SCHEDULE.json`
  (the machine-readable case schedule) and reconciled by the LOCAL
  validator (`audit-tools/probe-plan/validate-probe-plan.mjs`, 19 checks,
  all PASS this round, exit 0; run log bound at
  `logs/50-plan-validator-r11041.log`). The validator replays ALL 521
  invocation-side statements against the real S4 schema in local SQLite
  (executing EXACTLY the registered counts — V-10), MEASURES the storage
  growth (**101,154,816 bytes** for the full round including 1,030 CJK rows
  with index amplification, 308 short rows, F-ROWSIZE, and the latch/seeds —
  V-11), and computes the documented-accounting rows-written total
  (**8,351**, inserts × 6 incl. the five source_items indexes, plus setup,
  seeds, latch writes, verification calls and repetitions). The 5 MB cap is
  RETIRED and replaced by exact justified arithmetic: **120,000,000 bytes**
  (the measured 101.2 MB + headroom; **4.9× under** the documented 500
  MB/database Free limit; 2.0% of the 5 GB account storage) while staying
  Free with preserved headroom on every other axis (rows written 8,351 ≤
  9,000 cap = **12.0× under** 100,000/day; rows read 15,637 ≤ 25,000 =
  **320× under** 5M/day; bind payload 49.0 MB ≤ 55 MB cap; statements 600 ≤
  650; invocations 20 + 3 transport retries = hard cap 23; request bodies
  ≤ ~9.7 MB vs the documented 100 MB Free limit). Protected invocation and
  replay limits are specified (plan §5): probe-only `X-Probe-Token` bearer
  authentication (wrong/missing ⇒ 404 with zero D1 statements), a DURABLE
  per-case latch (`probe_run_state`) that consumes budgets conservatively
  BEFORE probe work, a `__global__` kill switch with terminal hard-stop
  behavior, and bounded retries — **no publicly unlimited probe endpoint,
  no product bindings, no provider/Telegram calls, no credentials in
  Git/logs/fixtures**. Expected per-invocation limit rejections are
  registered as measured outcome classes SEPARATE from safety aborts
  (P-03/P-04/P-07a-2 deliberately exceed the Free 50-row under the
  statement interpretation — a typed rejection there is itself NOT_READY
  evidence, never an abort; plan §8/§14 D8).

## CR11041-05 — conclusions constrained to the evidence actually measurable (R114-05)

- **Defect:** no registered differential quota-unit test existed; commit-only
  CPU was conflated with full-poll CPU; Logpush field names were treated as
  Workers Logs field names; the general 50-subrequest row was not kept
  distinct from the D1-specific 50-query row; and four fixture shapes could
  have implied a universal input-envelope conclusion — refuted by the
  review's static counterexample (a 1,800,116-byte RSS document — under the
  2,097,152-byte feed bound — containing one URL that expands to a
  5,400,023-byte canonical value, ABOVE the documented 2,000,000-byte row
  limit).
- **Fix:** the plan now (a) registers the **quota-unit discriminator**
  P-QU-A (ONE batch of 51 one-row SELECTs — 1 API call, 51 statements) and
  P-QU-B (51 separate one-row SELECT executions — 52 API calls), minimal,
  NON-MUTATING, with distinct typed outcomes and a pre-registered
  4-branch interpretation matrix; wherever the matrix leaves the unit
  unresolved the ambiguity is RETAINED (a success never proves absence of
  enforcement above the tested count; daily allowances are never
  deliberately exhausted); the D1-specific 50-query row, the general
  50-subrequest row and the 1,000 internal-service row are kept DISTINCT
  (§2.3); (b) specifies **commit-only vs full-poll CPU scopes explicitly**
  (§9: full-poll includes raw synthetic XML parsing, normalization, URL
  expansion, hashing, planner/classification, the fixed-stage reads, DB
  calls, response/log serialization and instrumentation; commit-only
  includes request-body JSON parsing of the pre-built payload, bind
  assembly, the batch, and serialization — reported SEPARATELY, and D3
  judges full-poll values only); (c) states the CPU-field honesty rule: the
  Workers Logs pages do NOT document invocation-log CPU field names — the
  G2 smoke must record the ACTUAL exportable field (name + type) or CPU
  stays UNKNOWN; the Trace Events `CPUTimeMs`/`WallTimeMs` names are
  Logpush-dataset fields admissible only if the owner establishes that
  surface; (d) fixes the **exact coverage claim** (§1) with the registered
  static counterexample (computed exactly by V-14) and the NEW decision
  rule **D7**: no promotion of any fixture outcome beyond its registered
  shape; the large-single-URL region stays NOT_READY unless separately
  measured (P-06b covers exactly ONE point — a 1,899,995-byte canonical
  URL); under the CURRENT policy those shapes are plan-time REJECTED with
  zero durable effects — no silent caps, truncation, drops or weakened
  fences anywhere.

## Verification matrix (this round, all LOCAL)

| Gate                                                           | Result                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Reviewer counterexamples reproduced BEFORE edits               | 3 failures / 0 passes / exit 1 (CE1/CE2/CE3 — matches the review)                               |
| LOCAL probe-plan validator                                     | **19 checks / 0 failures / exit 0** (`logs/50-plan-validator-r11041.log`)                       |
| Latch/sources seed drift fences                                | Regenerated == committed, byte-identical (V-05)                                                 |
| Product files vs `f7020564…`                                   | 297/297 byte-identical, 0 modified/deleted (re-verified post-commit)                            |
| Frozen historical evidence (incl. CE2 intentionally-red probe) | Untouched                                                                                       |
| Cloudflare/account operations                                  | **0** (including reads; no public doc fetch this round — §2 basis is the bound review evidence) |

## Deliverables

- `audit/PREVIEW_RESOURCE_PROBE_PLAN.md` — revised in place (R1.10.4.1).
- `audit/PROBE_CASE_SCHEDULE.json` — NEW machine-readable case schedule.
- `audit-tools/probe-plan/validate-probe-plan.mjs` — NEW LOCAL-only
  feasibility validator (19 checks).
- `audit-tools/probe-plan/README.md`, `probe-ddl.sql`, `latch-seed.sql`,
  `sources-seed.sql` — NEW probe-plan tooling (latch DDL + generated seeds).
- `logs/50-plan-validator-r11041.log` — the bound validator run log.
- `REVIEW_README.md`, `VERSION.json`,
  `free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §9.4 pointer — round metadata.

**STOP — awaiting independent review (G0) of the revised plan.**
