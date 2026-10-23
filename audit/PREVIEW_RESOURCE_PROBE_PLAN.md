# PIXEL — Preview Resource Probe Plan (R1.10.4.1 — REVISED, PLAN ONLY, NOTHING EXECUTED)

**Status: AUTHORIZATION-GATED MEASUREMENT PLAN — revised after the R1.10.4 G0
review returned CHANGES REQUIRED (R114-01…R114-05).** Round R1.10.4.1 is
**LOCAL probe-plan feasibility corrections ONLY**: zero Cloudflare/account
operations (including reads), no resource creation, no deployment, no real D1
writes, no migration, no activation, no billing upgrade, no merge, no product
implementation. The only new activity this round is the **LOCAL feasibility
validator** (`audit-tools/probe-plan/validate-probe-plan.mjs`) running against
node:sqlite and the repository tree (§16) — no network of any kind. Every
future operation below requires its own explicit owner authorization
checkpoint (§11). The unchanged supported RSS envelope verdict remains
**NOT_READY** — the ≤40 execution-API-call target PASSES and the ≤40
SQL-statement target FAILS (`free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §6/§9.2,
R1.10.4-corrected). **The machine-readable source of truth for every number in
this plan is `audit/PROBE_CASE_SCHEDULE.json`; the validator reconciles this
document against it (check V-15).**

## 0. Compliance summary (this round, verifiable)

| Item                          | R1.10.4.1 outcome                                                        |
| ----------------------------- | ------------------------------------------------------------------------ |
| Cloudflare/account operations | **0** (including reads; public docs were NOT re-fetched this round — §2) |
| Resource creation             | **0**                                                                    |
| Product files touched         | **0** (297 files stay byte-identical to `f7020564…`)                     |
| Product migrations touched    | **0** (0001–0004 are used READ-ONLY as disposable-setup inputs, §6)      |
| What this file is             | PLAN ONLY — pre-registered cases, pre-committed decision rules           |
| Local validation              | DONE — 19-check validator, 18 PASS + this document's anchors (§16)       |
| Probes executed               | **NONE** — all probe activity is future work behind §11 checkpoints      |

## 1. Purpose, scope, and the EXACT coverage claim

**Purpose.** The R1.10.3.1 retraction left the unchanged supported RSS
envelope NOT_READY with the exact blocker: the accepted normalizer uncaps
canonical-URL byte expansion, and the INTERNAL conservative combined-byte
policy caps ≈45 KB CJK rows at 2 per statement, so a 100-item CJK-shaped poll
cannot meet ≤40 submitted statements regardless of planner correctness.
Lifting that honestly requires MEASURED evidence about real platform
behavior (largest accepted bind payload; end-to-end commit cost; REAL Worker
CPU; actual daily-quota deltas). This revision exists because the R1.10.4 G0
review proved — with LOCAL counterexamples (3 failures / exit 1) — that the
original plan's payload gate was unreachable, its schema setup could not run
the owned cases, its authorization machine was circular, its budgets were not
feasible, and its conclusions were broader than its evidence.

**Scope.** Only the FIRST supported single-feed RSS profile shape and its
synthetic fixtures (§7). Only isolated disposable preview resources (§4).

**EXACT coverage claim (pre-committed; R114-05).** The fixtures cover
EXACTLY: uniform ~2 KiB canonical URLs (100-item slices of a 300-item
fixture); mixed 8 short + 92 × 45,023 B; uniform 45,023 B × 100 (slices of a
400-item fixture); one 102,500 B row (internal-budget rejection); one
1,899,995 B row (documented row-limit boundary); and the ladder's 516
distinct ~45 KB rows (slices of a 538-item fixture). Nothing else.
**Unmeasured input sizes and shapes stay NOT_READY.** The static boundary that
makes this restriction necessary (registered, computed by the validator —
V-14): a VALID RSS document of 1,800,116 bytes (< the 2,097,152-byte feed
bound) containing one item whose 600,000-CJK-character path expands — via the
accepted normalizer's percent-encoding, 9 URL bytes per 3-byte character — to
a 5,400,023-byte canonical URL, ABOVE the documented 2,000,000-byte row
limit. **Feed-bound compliance does NOT imply row-size compliance.** No
fixture in this plan claims coverage above its registered shape; no global
envelope-READY inference may be drawn from these fixtures (decision rule D7).

**Non-goals (pre-committed, unchanged).** No URL/item truncation, no lowering
of supported caps, no silent drops, no weakening of ownership fences or
conflict clauses, no paid plan, no schema/migration change, no product config
change, no product deployment, no provider fetches (all fixtures are
synthetic), and no Cloudflare operation without §11 authorization. Wall time
is never reported as CPU (§9). Unknown measurements remain UNKNOWN (§15).

## 2. Official limits — verification basis

R1.10.4 verified these rows from the PUBLIC documentation pages (fetched
2026-10-19 UTC; not account operations). **R1.10.4.1 did NOT re-fetch them**
— the independently bound copies in the R1.10.4 G0 review evidence
(`independent-review/d1-limits.md`, `workers-limits.md`, `workers-logs.md`,
re-fetched by the manager 2026-10-19/23) confirm the same rows, and the
execution round MUST re-verify every row at execution time (P0-4, D6)
before running anything. Limits are mutable; this section is a snapshot.

### 2.1 D1 — platform limits

Source: https://developers.cloudflare.com/d1/platform/limits/ — "Last updated
Apr 21, 2026" (`dateModified: 2026-04-21`). Verbatim rows this plan relies on:

| Row (verbatim)                                                                              | Exact unit           | Use in this plan                                                   |
| ------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| "Queries per Worker invocation (read subrequest limits) \| 1000 (Workers Paid) / 50 (Free)" | queries/invocation   | The Free 50-row; unit ambiguity retained (TR-01) and probed (P-QU) |
| "Maximum SQL statement length \| 100,000 bytes (100 KB)"                                    | bytes (SQL TEXT)     | Per-statement SQL-TEXT limit (§3)                                  |
| "Maximum bound parameters per query \| 100"                                                 | count/query          | THE per-statement admissibility limit (11·rows+7 ≤ 100, §8)        |
| "Maximum string, `BLOB` or table row size \| 2,000,000 bytes (2 MB)"                        | bytes/row            | The F-ROWSIZE boundary (§7) and the coverage claim (§1)            |
| "Maximum database size \| 10 GB (Workers Paid) / 500 MB (Free)"                             | bytes (Free: 500 MB) | Storage cap reconciliation (§10)                                   |
| "Maximum storage per account \| 1 TB (Workers Paid) / 5 GB (Free)"                          | bytes (Free: 5 GB)   | Account-side ceiling (§10)                                         |
| "Databases per account \| 50,000 (Workers Paid) / 10 (Free)"                                | count (Free: 10)     | Owner-confirmed headroom prerequisite (P0-2)                       |
| "Time Travel duration … \| 30 days (Workers Paid) / 7 days (Free)"                          | days (Free: 7)       | Cleanup semantics (§13)                                            |
| "Maximum SQL query duration \| 30 seconds"                                                  | seconds              | Bounds each whole `db.batch()` call (P-01b expected class)         |

Batch note (verbatim): "Limits for individual queries (listed above) apply to
each individual statement contained within a batch statement. For example,
the maximum SQL statement length of 100 KB applies to each statement inside a
`db.batch()`." — the per-statement rows bind EVERY constituent of a batch;
the docs contain **no** row for a total batch payload (that aggregate
acceptance is exactly the UNKNOWN P-01b measures).

### 2.2 D1 — pricing / daily allowances

Source: https://developers.cloudflare.com/d1/platform/pricing/ — "Last
updated Apr 21, 2026". Verbatim: "Rows read \| 5 million / day" (Free);
"Rows written \| 100,000 / day" (Free); "Storage (per GB stored) \| 5 GB
(total)" (Free); footnote 8: "Free limits reset daily at 00:00 UTC";
exhaustion returns errors to the client; per-query `meta` carries
`rows_read`/`rows_written`; footnote 6: "Indexes will add an additional
written row when writes include the indexed column" — the §10 arithmetic
accounts for the accepted schema's five source_items indexes; "An empty
database consumes approximately 12 KB of storage" (the EMPTY-DB figure — the
schema'd baseline is NOT 12 KB; locally it measured 413,696 bytes, §10).

### 2.3 Workers — platform limits (incl. the REAL CPU surfaces)

Source: https://developers.cloudflare.com/workers/platform/limits/ — "Last
updated Oct 12, 2026". Verbatim rows this plan relies on — **including the
general vs internal-service subrequest distinction (R114-05)**:

| Row (verbatim)                                                    | Exact unit          | Use in this plan                                       |
| ----------------------------------------------------------------- | ------------------- | ------------------------------------------------------ |
| "CPU time \| 10 ms (Free) / 5 min (Paid)"                         | milliseconds of CPU | The Free CPU ceiling that dominates the CJK shape (D3) |
| "Subrequests per invocation \| 50 (Free)"                         | count/request       | GENERAL subrequest row — a candidate P-QU-B boundary   |
| "Subrequests to internal services \| 1,000"                       | count/request       | INTERNAL-SERVICE row — a candidate P-QU-B non-boundary |
| "Requests \| 100,000/day (Free)" (reset midnight UTC, Error 1027) | requests/day        | Round invocation cap margin (§10)                      |

The Workers limits page defines "A subrequest is any request a Worker makes
using the Fetch API or to Cloudflare services like R2, KV, or D1" and lists
the two SEPARATE rows above. **This plan does NOT claim the general 50-row
alone defines D1 enforcement** — the D1-specific "Queries per Worker
invocation … 50 (Free)" row (§2.1) is retained as its own documented
boundary, and the P-QU discriminator (§8) treats "which row fired" as an
explicitly ambiguous, recorded outcome. CPU semantics (verbatim): "CPU time
measures how long the CPU spends executing your Worker code. Waiting on
network requests (such as `fetch()` calls, KV reads, or database queries)
does **not** count toward CPU time." Exceeding CPU returns Error 1102
(`exceededCpu` in analytics/Logpush).

### 2.4 Where real CPU is observable — and what is NOT documented (R114-05)

- The Workers limits page states: "Workers Logs — CPU time and wall time
  appear in the invocation log"
  (https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs).
- The Workers Logs page itself ("Last updated Oct 12, 2026") documents
  invocation logs (`$cloudflare.$metadata.type = "cf-worker-event"`), Free
  inclusion, **200,000 log events/day, 3-day retention, 256 KB per log**,
  the `invocation_logs` toggle — but does **NOT document the invocation-log
  CPU/wall FIELD NAMES**. `cpuFieldNamesDocumented: false`
  (schedule `documentedLimits.workersLogs`).
- The Workers Trace Events **Logpush dataset** documents `CPUTimeMs` (int,
  ms) and `WallTimeMs` (wall-clock) — but Logpush is a separate surface
  whose availability on this account is owner-side UNKNOWN and must not be
  assumed Free-available.
- Therefore: **the G2 smoke (X-SMOKE) must record the ACTUAL exportable
  CPU-labeled field (exact name + type) from the Free-available Workers Logs
  surface, or the round's CPU evidence surface is UNKNOWN** (§9, D3). The
  Logpush `CPUTimeMs`/`WallTimeMs` names are admissible ONLY if the owner
  establishes that surface, with its dataset field schema cited. Workers Logs
  pricing changes December 1, 2026 — re-verify before relying on it (P0-4).

### 2.5 Queues — carried for completeness only

Queues Free: 10,000 operations/day, 24-hour retention (page dated Apr 21,
2026); reset boundary STILL not stated on the page — UNKNOWN (TR-06). This
plan binds NO queues; the row is carried for completeness only.

## 3. Internal combined-byte policy vs official SQL-text limits (DISTINCT IN KIND)

- **Official (documented):** SQL TEXT ≤ 100,000 bytes per statement (per
  batch constituent); binds ≤ 100 per query. **No** documented row for a
  maximum bound-parameter byte size; **no** documented row for a maximum
  batch/total payload.
- **Internal (conservative margin, NOT a documented limit):** the planner's
  "SQL text + ALL bound values ≤ 102,400 bytes" policy
  (`design-lab/candidate-sql.ts`, `MAX_SQL_STATEMENT_BYTES`) — the DIRECT
  CAUSE of the NOT_READY blocker (2 rows/statement for ≈45 KB CJK rows).
- The validator proves the policy boundaries locally (V-09): a 2-row CJK
  statement audits to 91,399 bytes (fits) and a 3-row statement to 136,511
  bytes (rejected) — P-03's 50 INSERTs are exactly right. F-OVERSIZE
  (103,774-byte single-row audit) and F-ROWSIZE (1,901,273-byte audit) are
  plan-time `OversizedRowPlanError` under the CURRENT policy — zero
  statements, zero durable effects, no truncation, ever.
- The policy may be revised ONLY on measured evidence per the pre-committed
  rules (§14), never to make a target fit by assumption.

## 4. Isolated disposable preview resources (created ONLY under G1, §11)

| Resource          | Proposed name               | Properties                                                                                                    |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Probe Worker      | `pixel-probe-r1104`         | Separate Worker script; NO product bindings (no queues, no product D1, no product secrets); routes OFF        |
| Probe D1 database | `pixel-probe-db-disposable` | Brand-new empty database; schema per §6 (S3 controls, then S4 owned fixtures); probe-only latch + seed tables |
| Queues            | **NONE bound**              | Zero queue producers/consumers; queue quotas are never probed                                                 |
| Product resources | **FORBIDDEN**               | `pixel`, `pixel-preview`, `pixel-db-preview`, `pixel-jobs-preview`, `pixel-dlq-preview` are out of scope      |

- Isolation proof at execution: the probe script's binding list contains
  exactly ONE D1 binding (the disposable DB) and nothing else; the pre-flight
  `wrangler` dry-run printout is archived as evidence.
- Headroom prerequisite: Free allows 10 D1 databases per account; the current
  count is owner-side UNKNOWN; the owner confirms BEFORE creation (P0-2). If
  insufficient: abort at the checkpoint (no workaround, no paid upgrade, no
  deletion of product resources).
- The probe Worker embeds the reviewed planner/classification code copied
  from the pinned commit (P0-5); the product itself is never deployed,
  configured, or migrated.

## 5. Protected invocation and replay limits (R114-04 — "routes OFF" is NOT access control)

The probe endpoint is NOT a public unlimited surface. Five independent
controls, all specified now and all counted in the §10 caps:

1. **Routes OFF + single workers.dev URL.** No custom-domain routes; the
   probe script is reachable only at the account's workers.dev URL for the
   probe script (recorded at G1; the URL is not a secret, but nothing else
   routes to it).
2. **Probe-only bearer token (`X-Probe-Token`).** A 256-bit random token
   generated at G1, bound to the probe Worker as a probe-only SECRET (never
   in Git, config files, fixtures, logs, or this repository; never a product
   secret; transmitted to the authorized caller out-of-band). Every request
   must carry it; wrong/missing token → **404 with ZERO D1 statements
   executed** (indistinguishable from a nonexistent route; the token value is
   never logged).
3. **Durable case/run gating (the latch).** `probe_run_state`
   (`audit-tools/probe-plan/probe-ddl.sql`, applied at G1) holds ONE row per
   registered case with the case's REGISTERED invocation and statement budgets
   from `audit/PROBE_CASE_SCHEDULE.json`
   (`audit-tools/probe-plan/latch-seed.sql`, generated and byte-verified by
   the validator). The runtime gate is a single UPDATE that increments
   `invocations_used`/`statements_used` conservatively **BEFORE any probe
   work** (own tiny batch — a failed or replayed request still consumes its
   slot) and refuses when the budget is consumed, the case is `closed`, or
   the kill switch fired.
4. **Kill switch + hard-stop.** The `__global__` latch row: when `aborted`
   (set by the abort procedure or the owner), EVERY case refuses all further
   work — terminal 410 responses, zero statements, zero side effects. When
   all registered budgets are consumed the endpoint is likewise terminal.
5. **Replay/retry bounds.** Registered invocations: **20**; transport-retry
   allowance: **3** (ONLY for invocations that submitted NO D1 statement —
   pre-flight/transport failures — re-executing the SAME case under the SAME
   registered parameters, each logged); **invocations hard cap: 23.** The
   24th authenticated request that reaches the database is, by construction,
   a plan violation → abort + pre-authorized emergency teardown (§11).

## 6. Schema tiers: S3 controls and S4 owned fixtures, separately (R114-02)

The R1.10.4 plan promised migrations 0001–0003 ONLY, then ran the owned path
whose predicate writes require `source_state.poll_owner_job_id` — the
reviewer proved with the actual migrations on local SQLite that the column
does not exist under 0001–0003 (CE2). This revision specifies BOTH tiers
explicitly. **No product migration/config is changed; migrations 0001–0004
are consumed READ-ONLY as disposable-setup inputs (their tracked bytes are
never edited — append-only policy, AGENTS.md §6).**

### 6.1 S3 — the control tier (runs FIRST)

- **DDL (exact):** `migrations/0001_initial_schema.sql` (58 statements),
  `migrations/0002_telegram_update_lifecycle.sql` (8),
  `migrations/0003_job_dlq_delivery.sql` (5) — **71 statements**, applied IN
  ORDER to the disposable DB at G1 via `wrangler d1 migrations apply` (CLI).
- **Version:** after application, `SELECT value FROM schema_metadata WHERE
key = 'schema_version'` returns `'3'` — verified by X-SETUP-S3.
- **Tier boundary (verified, not assumed):** X-SETUP-S3's compile probe
  `SELECT poll_owner_job_id FROM source_state LIMIT 0` is a PREPARE-TIME
  ERROR on S3 (prepare() is construction, never a submitted statement) — the
  owned predicate CANNOT compile on S3. The validator reproduces this
  exactly (V-04a).
- **Controls that run under S3:** the legacy (schema-3 accepted path) control
  case P-C3 only, plus the verification reads. Nothing owned runs on S3.
- **Seeding (probe-only, at G1, CLI):** `sources-seed.sql` (one sources row
  per probe case that needs one — 11 rows, 1 literal-VALUES statement,
  generated from the schedule and byte-verified by the validator); P-C3's
  queued job + baseline state row are seeded inside P-C3's own registered
  statement list (probe prelude — the product's job/state pre-exist via
  scheduling; the probe registers them explicitly so every statement is
  counted).

### 6.2 S4 — the owned-fixture tier (applied mid-round, before X-SETUP-S4)

- **DDL (exact):** S3 **plus** `migrations/0004_source_poll_ownership.sql`
  (5 statements: the `ALTER TABLE source_state ADD COLUMN
poll_owner_job_id`, the partial unique index
  `idx_jobs_source_outstanding_poll`, and the three `schema_metadata`
  UPDATEs) — applied by CLI as the registered **X-SCHEMA4** step AFTER the
  S3 controls complete and BEFORE X-SETUP-S4. 0004 remains the tracked
  product migration CANDIDATE (disposable-only application; the append-only
  product files are untouched).
- **Version:** `schema_version` = `'4'`; `migration_id` =
  `'0004_source_poll_ownership'` — verified by X-SETUP-S4.
- **Ownership-fence verification (X-SETUP-S4):** (a) the compile probe now
  PREPARES cleanly; (b) a **negative probe**: seed one claimed
  `sources.fetch_poll` job, then submit a SECOND non-terminal job for the
  SAME aggregate — expected class: **typed UNIQUE rejection from
  `idx_jobs_source_outstanding_poll`** (submitted alone so nothing else
  rolls back). The validator reproduces the rejection locally (V-10 + the
  replay's negative-probe step).
- **Owner/job/generation seeding (owned cases):** each owned case's
  registered statement list carries its own prelude — `seed-job` (id
  `job-<source>-1`, type `sources.fetch_poll`, aggregate_type `'source'`,
  aggregate_id = the case's probe source, status `queued` for full-path
  cases / `claimed` for payload-scope cases, attempts = the generation) and
  `seed-source-state` (the case's `sources` row state: `next_poll_at` = the
  registered hold; `poll_owner_job_id` = NULL for full-path cases — the
  registered `ownership-acquire` statement then durably sets owner+hold —
  or = the job id for payload-scope cases). Generations are pinned per case
  in the schedule (all `1`; the fence proof uses a WRONG generation
  deliberately and inserts ZERO rows — validator check V-10f).
- **Reset and verification order (whole round, fixed):**
  G1 CLI (S3 DDL → probe DDL → latch seed → sources seed) → X-SMOKE (G2) →
  X-SETUP-S3 → P-C3 → **X-SCHEMA4 (CLI: apply 0004)** → X-SETUP-S4 →
  P-01a → P-01b-r1 → P-01b-r2 → P-01b-r3 → P-02 → P-03 → P-04 → P-05 →
  P-06 → P-06b → P-QU-A → P-QU-B → P-07a-1 → P-07a-2 → P-07a-3 →
  X-VERIFY-FINAL (G4). Cross-case interference is impossible by
  construction: every fixture-writing case uses its OWN `source_id` and its
  OWN fixture slice (§7), so the UNIQUE constraints never absorb probe rows
  and NO cross-case deletes/resets are needed; the only "reset" semantics in
  the round are the per-case prelude seeds (INSERT OR REPLACE over the
  case's own rows) — all registered and counted.

## 7. Synthetic fixtures (deterministic, checksummed, no real provider data)

All fixtures are GENERATED deterministically (the validator implements the
generator from the schedule's registered shapes and pins the exact bytes —
execution rounds regenerate + SHA-256 them BEFORE any probe, P0-6). No
provider is contacted. UTF-8 bytes via `TextEncoder`; CJK paths
percent-encode at 9 URL bytes per 3-byte character; per-fixture hosts keep
the registered byte counts EXACT.

| Fixture    | Shape                                                                                                                          | Exact bytes (validator-verified, V-07)                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| F-NORMAL   | 100-item slices (offsets 0/100/200) of a 300-item fixture; ASCII canonical URLs of exactly 2,048 B                             | URL 2,048 B; raw RSS ≈ 12,456 B per 100-item slice                                 |
| F-HETERO   | 100 items: 8 short (2,048 B) + 92 CJK (5,000-char paths → 45,023 B canonical)                                                  | URLs {2,048; 45,023} B; raw RSS 1,391,722 B < 2,097,152                            |
| F-CJK      | 100-item slices (offsets 0/100/200/300) of a 400-item fixture; uniform 45,023 B canonical URLs (the L-14 shape)                | URL 45,023 B each; raw RSS 1,511,666 B < 2,097,152                                 |
| F-CJK-L    | Ladder fixture: 538 items, distinct ~45 KB CJK URLs (filler length varies at i≥500 → 45,014 B); slices at offsets 0/22/122/330 | 538 distinct URLs; used ONLY by P-01a/P-01b (commit-scope, no RSS delivery)        |
| F-OVERSIZE | 1 item; canonical URL exactly 102,500 B (above the 102,400 B internal budget, far below the 2,000,000 B row limit)             | Plan-time `OversizedRowPlanError` under the current policy (V-09: audit 103,774 B) |
| F-ROWSIZE  | 1 item; canonical URL exactly 1,899,995 B (below the documented 2,000,000 B row limit; raw RSS 633,506 B)                      | Documented-limits-only boundary probe (P-06b); current policy: plan-time rejection |

Fixture discipline: distinct `source_id` per fixture-writing case + distinct
fixture slices ⇒ zero cross-case conflicts; every fixture's exact bytes are
re-derived at execution from the accepted normalizer and any drift is
recorded BEFORE probing. Request bodies carry the fixtures (raw RSS for
full-poll cases ≈ 0.2–1.5 MB; pre-built statement payloads for commit-only
cases ≤ ~9.7 MB JSON — all far under the documented 100 MB Free request-body
limit; cap registered at 12 MB).

## 8. Pre-registered probe cases (R114-01 — per-statement admissibility SEPARATED from aggregate batch payload)

**The R1.10.4 defect (CE1), stated plainly:** the old P-01 registered SINGLE
multi-row statements at 16/32/50 rows. Owned binds = **11·rows + 7** (11
row-value columns + 7 shared guard binds — derived from the ACTUAL repo
source by validator check V-02), so those rungs need 183/359/557 binds
against the documented 100-bind limit: **illegal — never submitted, now
removed from the plan entirely** (V-06 asserts no such rung is registered
anywhere). A single-statement ladder also cannot establish the required
AGGREGATE batch-payload margin (its best legal rung reaches only 8 × 45,023
= 360,184 canonical bytes vs the ≥ 9,004,600-byte requirement). The gate is
now SPLIT:

- **P-01a — per-statement admissibility ladder (LEGAL rungs only: 2/4/8
  rows).** Binds 29/51/95/95 (+ one repeat at rung 8) — every rung legal
  under 11·rows+7 ≤ 100; each rung submitted as its OWN `db.batch` so a
  rejection is unambiguously per-statement. Expected classes: accepted with
  `meta.changes` = rung rows, OR a typed platform rejection — either is a
  valid measured outcome; the ladder stops at the first rejection (the
  rejection itself is evidence).
- **P-01b — AGGREGATE `db.batch` payload ladder (each constituent statement
  ≤ 95 binds).** Rung 1 (P-01b-r1): the exact F-CJK commit shape — **13
  statements (12×8 + 1×4), 100 rows** in ONE `db.batch` — total bind payload
  = the required reference **P_req = 4,510,238 bytes** (validator-computed
  from the fixture bytes: all 11 row-value binds + 7 shared guard binds per
  statement). Rung 2 (P-01b-r2): **26 statements × 8 rows = 208 rows** in
  ONE `db.batch` — total bind payload **P_208 = 9,383,270 bytes =
  2.080 × P_req ≥ the pre-committed 2× margin** (V-08: the gate is
  REACHABLE — the CE1 structural unreachability is closed). Rung 3
  (P-01b-r3): an exact REPEAT of rung 2 (distinct fixture rows, identical
  registered parameters) — D1(i) requires zero payload-related rejections
  across ALL repetitions. Each rung invocation stays ≤ 27 statements — under
  the Free 50-row under BOTH unit interpretations — so a rejection can only
  be payload/duration-class, never a query-count artifact.

**The complete registered case list** (order, fixtures, statement/API counts,
expected classes, resource deltas — all in
`audit/PROBE_CASE_SCHEDULE.json`, reconciled by the validator):

| Case                | What it measures                                                                                 | Registered totals                              |
| ------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| X-SMOKE (G2)        | Evidence availability: is a CPU-labeled field exportable from Workers Logs on Free?              | 1 invocation / 2 API / 2 statements            |
| X-SETUP-S3          | S3 tier verification + tier-boundary compile probe (prepare-time error = proof)                  | 1 / 2 / 3                                      |
| P-C3                | LEGACY (schema-3 accepted path) control commit, full-poll scope — ledger parity                  | 1 / 11 / 31 (13 legacy INSERTs, 88 binds each) |
| X-SETUP-S4          | S4 verification + ownership-fence negative probe (typed UNIQUE rejection expected)               | 1 / 4 / 5                                      |
| P-01a               | Per-statement admissibility (2/4/8-row rungs)                                                    | 1 / 6 / 7 (22 rows)                            |
| P-01b-r1            | Aggregate rung 1 = the exact F-CJK batch (P_req)                                                 | 1 / 3 / 16 (100 rows)                          |
| P-01b-r2            | Aggregate rung 2 = 208 rows ≥ 2× P_req                                                           | 1 / 2 / 27                                     |
| P-01b-r3            | Aggregate rung 2 REPEAT (reproducibility)                                                        | 1 / 2 / 27                                     |
| P-02                | End-to-end CJK commit under documented-limits-only (GATED on D1's P-01b margin), full-poll scope | 1 / 12 / 32                                    |
| P-03                | CJK control under the CURRENT conservative policy — C-15 parity (50 INSERTs × 2 rows)            | 1 / 12 / 69                                    |
| P-04                | Heterogeneous control — L-12 parity (1×8 + 46×2 = 47 INSERTs)                                    | 1 / 12 / 66                                    |
| P-05                | Normal baseline control — C-02/C-06 parity (13 INSERTs)                                          | 1 / 12 / 32                                    |
| P-06                | F-OVERSIZE plan-time `OversizedRowPlanError`; zero durable effects                               | 1 / 2 / 2                                      |
| P-06b               | F-ROWSIZE row-size boundary (1 row, 18 binds, ~1.9 MB bind value) under documented-limits-only   | 1 / 4 / 5                                      |
| P-QU-A              | Quota-unit discriminator A: ONE batch of 51 one-row SELECTs (non-mutating)                       | 1 / 2 / 52                                     |
| P-QU-B              | Quota-unit discriminator B: 51 SEPARATE one-row SELECT executions (non-mutating)                 | 1 / 52 / 52                                    |
| P-07a-1/2/3         | COMMIT-ONLY CPU scopes (F-CJK doc-limits / F-CJK conservative / F-NORMAL conservative)           | 3 × 1 / 3 / {17, 54, 17}                       |
| X-VERIFY-FINAL (G4) | Final row-count/schema/latch verification (1,339 rows expected)                                  | 1 / 2 / 5                                      |

**Expected limit rejections vs safety aborts (R114-04) — separated NOW:**

- **Expected limit rejections are MEASURED OUTCOME CLASSES, never aborts:**
  P-01a/P-01b rung rejections (payload/duration class); P-06b typed
  row-size/bind-value rejection; **P-03 (69 statements), P-04 (66) and
  P-07a-2 (54) exceed the Free 50-row under the STATEMENT interpretation —
  a typed per-invocation rejection there is itself NOT_READY evidence for
  the CJK shape, pre-registered as a valid outcome**; P-QU-A/P-QU-B typed
  rejections near the 50/52 boundary (the discriminator's whole point). The
  plan no longer claims "only SQL-text/bind-count limits are approached".
- **Safety aborts (§12):** any DAILY-allowance quota-exceeded error (rows
  read/written per day, requests per day, storage), any actual total
  exceeding a §10 cap, any product-resource touch, any isolation failure,
  any doc drift, or any outcome class OUTSIDE the case's registered set.

**Quota-unit ambiguity (TR-01) — the differential discriminator (R114-05).**
P-QU-A (one API call, 51 statements) and P-QU-B (52 API calls incl. the
latch, 51 statements) are minimal, NON-MUTATING, primary-key-read controls
with distinct typed outcomes and a pre-registered 4-branch interpretation
matrix: (A✓,B✓) neither boundary at these counts — ambiguity RETAINED,
honestly recorded; (A✗,B✓) a per-statement/per-subrequest boundary counts
statements inside one batch — WHICH documented row fired stays ambiguous
(both are 50) and is recorded as such; (A✓,B✗) the boundary counts
execution-API calls; (A✗,B✗) both. A success NEVER proves absence of
enforcement above the tested count. Daily allowances are NEVER deliberately
exhausted. The general-50 vs internal-service-1,000 subrequest rows are
kept DISTINCT from the D1-specific 50-query row (§2.3) — no single row is
claimed to define D1 enforcement.

## 9. CPU scopes and measurement definitions (units discipline)

- **COMMIT-ONLY scope (P-07a-1/2/3):** the invocation receives a PRE-BUILT
  statement payload (JSON envelope with the EXACT binds) and performs:
  request-body JSON parsing of that payload (**registered inclusion**), bind
  assembly, `prepare()`/`bind()`, ONE `db.batch()`, response and log
  serialization, instrumentation. It EXCLUDES: raw XML parsing,
  normalization, URL expansion, hashing, planner/classification, fixture
  generation.
- **FULL-POLL scope (P-02, P-03, P-04, P-05, P-C3):** the invocation
  receives the raw synthetic RSS XML and performs EVERYTHING: raw XML
  parsing, normalization, URL expansion, hashing, planner/classification
  (the grouped source-bound probes), the full fixed-stage read sequence
  (engine claim read + CAS, source select, capability read, ownership
  acquire, authorization, budget readback), the commit batch, the fenced
  terminal state write, the job terminal write, response/log serialization,
  and instrumentation overhead. **D3 judges FULL-POLL values.** Commit-only
  values are reported SEPARATELY as diagnostic decomposition.
- **xAPI** — execution-API-call attempts per the corrected v3 instrument
  units (R112-03); **STMT** — submitted statements. `prepare()` is
  construction, never an execution (TR-01 anchor).
- **SQL-text bytes / bind bytes** — UTF-8 via `TextEncoder`; the audited
  per-statement total = SQL text + Σ bound-value bytes (internal-audit
  definition; NOT an official unit).
- **rows read / rows written** — official units from §2.2, recorded from
  BOTH the per-query `meta` counters and the owner-side daily analytics;
  discrepancies are recorded, never reconciled away.
- **CPU** — ONLY a CPU-labeled field from a Free-available surface whose
  EXACT name and type were recorded by the G2 smoke (§2.4), or an
  owner-established Trace Events surface with `CPUTimeMs` (int, ms) — plus
  the invocation `outcome` (`exceededCpu` on Error 1102). **Wall time
  (`WallTimeMs`, `performance.now()`, local workerd elapsed) is NEVER CPU**
  and is inadmissible for any Free-CPU conclusion. No CPU-labeled surface ⇒
  CPU = UNKNOWN (§15) — never inferred from wall time.

## 10. Exact bounded totals — RECONCILED from the machine-readable schedule (R114-04)

Every number below is DERIVED from `audit/PROBE_CASE_SCHEDULE.json` and
verified by the LOCAL validator (§16), which also MEASURED the storage
arithmetic against the actual schema in local SQLite. **The R1.10.4 5 MB
storage cap is RETIRED — the reviewer's local counterexample (CE3: one
100-row CJK fixture grew the actual-schema database by 9,125,888 bytes,
because `canonical_url` is stored in BOTH the table and the
`UNIQUE(source_id, canonical_url)` index) disproved it. The replacement cap
is justified arithmetic, not a smaller wish:**

| Budget line                        | Registered total (validator-reconciled)                                                                                                                                               | Hard cap              | Documented Free allowance / margin                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| Probe Worker invocations           | 20 (+3 transport retries)                                                                                                                                                             | **23**                | 100,000 requests/day (≈ 4,300×)                                                                       |
| Execution-API calls, round total   | 151                                                                                                                                                                                   | ≤ 55/invocation       | 50-row probed by P-QU (typed classes registered)                                                      |
| Submitted statements, round total  | 600 = 521 invocations + 79 CLI setup                                                                                                                                                  | **650**               | per-invocation ≤ 70 (max registered 69)                                                               |
| Rows written (documented counting) | 8,351 (inserts 1,339 × 6 incl. index rows + writes)                                                                                                                                   | **9,000**             | 100,000 rows/day (**12.0×**)                                                                          |
| Rows read (conservative bound)     | 15,637                                                                                                                                                                                | **25,000**            | 5,000,000 rows/day (**320×**)                                                                         |
| Bind payload, round total          | 49.0 MB measured locally                                                                                                                                                              | **55,000,000 bytes**  | no documented row (the P-01b unknown)                                                                 |
| Durable storage growth             | 101.2 MB measured locally (schema baseline 413,696 B — NOT the 12 KB empty-DB figure; 1,030 CJK rows × ≈91.3 KB incl. index amplification + 308 short rows + F-ROWSIZE + latch/seeds) | **120,000,000 bytes** | 500 MB/database (**4.9×**); 5 GB/account (2.0%)                                                       |
| Max request body                   | ≈ 9.7 MB (P-01b-r2/r3 pre-built payload JSON)                                                                                                                                         | 12,000,000 bytes      | 100 MB Free request body (≈ 8×)                                                                       |
| Workers Logs events                | ≤ ~600 (invocation + aggregated audit logs)                                                                                                                                           | **3,000**             | 200,000 events/day (≈ 67×); 256 KB/log; per-log audit summaries carry lengths, NEVER full bind values |
| Queues operations                  | 0                                                                                                                                                                                     | **0**                 | not probed                                                                                            |
| Provider fetches                   | 0 (synthetic fixtures only)                                                                                                                                                           | **0**                 | —                                                                                                     |
| Product-resource touches           | 0                                                                                                                                                                                     | **0**                 | —                                                                                                     |

The arithmetic is reconciled, not asserted: the validator replayed ALL 521
invocation-side statements against the real S4 schema in local SQLite,
executed EXACTLY the registered statement counts (V-10), measured the
resulting storage growth (101,154,816 bytes — V-11), and computed the
documented-accounting rows-written total (8,351) from per-kind multipliers
(6 per source_items insert = 1 table row + 5 index rows; the D1 footnote-6
rule) including setup, seeds, latch writes, verification calls and
repetitions. Local numbers are feasibility proxies, NOT cloud measurements;
the execution round re-measures every one of them from `meta` and
owner-side analytics (P-08's passive deltas).

## 11. Authorization state machine (R114-03 — the cycle is REMOVED)

The R1.10.4 machine was circular: P0-8 required a real smoke invocation plus
CPU-log export BEFORE G2, while G1 authorized creation only — the smoke was
never authorizable. The revised machine is finite, explicit, and acyclic;
**this round (R1.10.4.1) grants NOTHING**:

- **G0 — plan review (re-requested now):** Posidon reviews THIS revised plan
  (the R1.10.4 G0 verdict was CHANGES REQUIRED; R114-01…05 are addressed
  in place). No operation accompanies it.
- **G1 — resource creation:** owner "go" to create the §4 disposable Worker
  - D1 database, deploy the pinned probe script (token secret bound), and
    run the CLI setup: apply S3 migrations (71 statements), probe DDL (1),
    latch seed (1), sources seed (1) — 74 CLI statements, all counted in §10.
    No probe Worker invocation yet.
- **G2 — smoke/evidence-availability check:** a SEPARATE owner "go" for
  exactly ONE probe invocation (X-SMOKE) plus the owner-side Workers Logs
  export check (record the actual CPU-labeled field name+type, or CPU =
  UNKNOWN for the round — D3 then keeps NOT_READY; the owner may stop or
  continue with CPU=UNKNOWN). The smoke authorizes itself NOTHING further.
- **G3 — substantive probes:** a separate owner "go" to run the
  pre-registered cases in the registered order (per-case or whole-set). The
  future G3 grant **PRE-AUTHORIZES safe emergency teardown**: on ANY §12
  abort criterion, the SAME grant authorizes immediately stopping all
  submission (latch hard-stop), exporting available evidence within the
  3-day Workers Logs retention, and deleting the probe Worker + database —
  WITHOUT waiting for any later checkpoint. No abort is ever left dependent
  on an ungranted future permission.
- **G4 — final verification + evidence export:** X-VERIFY-FINAL invocation,
  owner-side analytics/Workers-Logs exports, final usage snapshot after the
  documented analytics lag, evidence archive + SHA256SUMS BEFORE deletion.
- **G5 — cleanup:** delete the probe Worker + disposable DB; verify zero
  remaining probe resources (owner-side listing); Time Travel note (Free 7
  days) — deletion itself is the cleanup; no restore planned.
- Standing rule: read-only/list/metrics/dashboard operations on the account
  are ALSO account operations — owner-side, never agent-performed; each
  future round's compliance record states its exact operation count.

## 12. Prerequisites and abort criteria

**Prerequisites (each verified with evidence, per phase):** P0-1 G0 passed
on THIS revised plan; P0-2 owner-confirmed account headroom (D1 databases
< 10, storage, plan still Workers Free); P0-3 owner-recorded baseline usage
snapshot BEFORE any probe; P0-4 official-limit re-verification at execution
time (drift ⇒ re-review, D6 — including the Dec 1 2026 Workers Logs pricing
change); P0-5 probe script + copied planner/instrument pinned by commit SHA
and hashed into evidence; P0-6 fixture checksums pinned and matched at run
time; P0-7 secret scan green over the probe tree; P0-8 (at G2, not before)
the smoke's CPU-field record per §2.4; P0-9 teardown commands rehearsed and
in the owner's hands BEFORE G3.

**Abort criteria (each triggers the PRE-AUTHORIZED emergency teardown of
§11/G3):** (a) any daily-allowance quota-exceeded error; (b) any actual
total exceeding a §10 cap (including the 23rd invocation); (c) any
product-resource touch or isolation failure; (d) P0-4 drift in any
load-bearing documented row; (e) any outcome outside a case's registered
expected classes; (f) any credential-shaped string appearing in probe
output. Expected limit rejections (§8) are NOT aborts.

## 13. Cleanup and evidence collection

Cleanup order: evidence archived FIRST (§13 evidence set + SHA256SUMS, never
depending on live resources), then probe Worker deleted, then the disposable
D1 database deleted (owner-authorized G5), then owner-side verification of
zero remaining probe resources, then the final usage snapshot after the
analytics lag window so P-08 deltas close to zero. Evidence collection (every
probe round): bound raw logs under `logs/` (`5x-probe-<case>-<seq>.log`
naming), byte-preserved stdout/stderr, the instrument's per-statement audits
exported to a committed JSON ledger, owner-exported dashboard/analytics/
Workers-Logs artifacts with provenance headers (round, commit SHA, UTC +
Asia/Tehran timestamps, doc page dates), SHA256SUMS over the whole evidence
set, and any deviation logged as a numbered correction — never an in-place
edit of published evidence.

## 14. Pre-committed decision rules (fixed NOW, before any measurement)

- **D1 — aggregate payload/policy adoption (REFORMULATED and registered
  BEFORE execution, per the review's requirement; the ≥2× margin itself is
  NOT weakened — only the measurement vehicle changed from illegal single
  statements to legal aggregate batches):** the documented-limits-only
  accounting may be adopted for the CJK shape IFF (i) the P-01b AGGREGATE
  ladder — each constituent statement ≤ 100 binds — demonstrates a single
  accepted `db.batch` whose total bind payload is ≥ 2× the exact F-CJK batch
  payload (P_req = 4,510,238 B; P_208 = 9,383,270 B = 2.080×; the gate is
  REACHABLE — V-08) with zero payload-related rejections across ALL
  registered repetitions (P-01b-r3 included), AND (ii) P-02 completes
  end-to-end with correct durable rows, AND (iii) P-07's FULL-POLL CPU is
  within the documented Free 10 ms. ANY failure ⇒ the conservative
  combined-byte policy STAYS, unchanged.
- **D2 — ≤40 STMT target:** the NOT_READY verdict is lifted ONLY if, under
  the adopted accounting, an on-platform F-CJK commit measures ≤ 40 submitted
  statements AND ≤ 40 execution-API calls (BOTH interpretations) AND D1(iii)
  holds — by MEASURED numbers with the full evidence chain. Otherwise
  **NOT_READY stands**.
- **D3 — CPU dominates:** if any measured FULL-POLL CPU value for a
  CJK-shaped poll exceeds 10 ms, or `exceededCpu`/Error 1102 occurs, the CJK
  shape is **NOT_READY on Free under ANY byte policy** — the CPU verdict
  dominates every other gate. CPU UNKNOWN (no CPU-labeled surface) ⇒
  NOT_READY stands; wall time never substitutes. COMMIT-ONLY CPU is reported
  separately and never substitutes for full-poll CPU.
- **D4 — quota honesty:** readiness claims rest ONLY on measured quota
  deltas (P-08) vs documented allowances; formula margins alone never produce
  READY. Missing/unevaluable measurement ⇒ that dimension is UNKNOWN ⇒
  overall NOT_READY (unchanged).
- **D5 — no goal-directed re-runs:** probes are never re-run with altered
  parameters to force an outcome; the only re-run is a repetition of the
  SAME case under the SAME registered parameters (counted, logged), and
  ladder repetitions are capped at the pre-registered counts (P-01b-r3).
- **D6 — drift:** if P0-4 re-verification shows any load-bearing documented
  row changed, execution stops until the plan is re-issued and re-reviewed.
- **D7 — coverage scope (NEW):** no fixture outcome may be promoted beyond
  its registered shape (§1); the large-single-URL region (canonical URLs
  above the measured shapes, up to and beyond the 2,000,000-byte documented
  row limit — e.g. the registered 1,800,116-byte RSS / 5,400,023-byte
  canonical counterexample) stays NOT_READY unless separately measured
  (P-06b covers exactly ONE point: 1,899,995 B); under the CURRENT policy
  those shapes are plan-time REJECTED (`OversizedRowPlanError`) — no silent
  cap, no truncation, no drop, ever. No global envelope-READY inference.
- **D8 — rejection/abort class separation (NEW):** expected limit rejections
  (§8) are recorded as measured outcomes and NEVER reinterpreted as aborts;
  safety aborts (§12) ALWAYS trigger the pre-authorized teardown. A verdict
  may cite a typed rejection as evidence, never as an excuse to rerun.

## 15. Wall-time-vs-CPU and UNKNOWN discipline (restated as commitments)

1. A CPU-labeled field from the G2-verified Free-available surface (or an
   owner-established Trace Events surface with `CPUTimeMs`) is the ONLY
   admissible CPU evidence; `WallTimeMs`/`performance.now()`/local workerd
   elapsed times are WALL and inadmissible for CPU conclusions.
2. Every measurement this plan cannot pre-commit a value for (aggregate
   bind-payload acceptance, real CPU, real quota enforcement, the "50
   queries" unit, the actual Workers Logs CPU field name) is **UNKNOWN until
   measured** — no derivation, analogy, or local proxy number is promoted.
3. Local design-lab numbers (C-01…C-16, L-01…L-14) and the validator's
   LOCAL numbers (§16) remain LOCAL PROXY UNITS: they pin feasibility and
   parity expectations but NEVER serve as cloud evidence.

## 16. The LOCAL feasibility validator (R1.10.4.1 deliverable)

`audit-tools/probe-plan/validate-probe-plan.mjs` — Node (≥ 23.4 for
`node:sqlite`; on Node 22 run with `--experimental-sqlite`), zero
dependencies, zero network, zero account operations. It consumes
`audit/PROBE_CASE_SCHEDULE.json` and the ACTUAL repository files and proves,
as 19 named checks (full current results bound in
`logs/50-plan-validator-r11041.log`):

- **V-01** schedule structural integrity (20 cases; phase invocation sums
  G2:1 / G3:18 / G4:1); **V-02** the bind formula derived from
  `design-lab/candidate-sql.ts` itself (11 values/row + 7 owned guards ⇒
  owned binds = 11·rows+7; ≤ 8 owned rows per statement); **V-03** the
  owned/legacy INSERT templates extracted from the same source with
  placeholder counts 11k+7 / 11k verified for k ∈ {1,2,4,8,9}.
- **V-04a/V-04b** the REAL migrations applied to local SQLite: S3 = 71
  statements, `schema_version` = 3, `poll_owner_job_id` ABSENT, the owned
  compile probe FAILS (tier boundary proven); +0004 ⇒ `schema_version` = 4,
  column PRESENT, probe prepares, the partial unique index exists, CLI setup
  totals reconcile (79).
- **V-05** `latch-seed.sql` AND `sources-seed.sql` regenerated from the
  schedule are byte-identical to the committed files (drift fences;
  `--write-seeds` regenerates).
- **V-06** every registered statement is legal (owned ≤ 8 rows / 95 binds;
  legacy ≤ 9 rows / 99 binds) and the illegal 16/32/50-row rungs are GONE.
- **V-07** fixture byte exactness (F-CJK 45,023 B; F-ROWSIZE 1,899,995 B;
  F-OVERSIZE 102,500 B; distinct URLs; raw RSS under the feed bound).
- **V-08** the REACHABLE gate: P_208 = 9,383,270 B ≥ 2 × P_req =
  4,510,238 B (multiple 2.080×).
- **V-09** internal-budget proofs (2-row fits at 91,399 B; 3-row rejected at
  136,511 B ⇒ P-03's 50 INSERTs; F-OVERSIZE/F-ROWSIZE plan-time rejections
  at 103,774 / 1,901,273 B).
- **V-10/V-10f** the FULL local replay against the real S4 schema: guarded
  inserts land, a WRONG generation inserts ZERO rows (the fence is live),
  the negative probe rejects, and the replay executes EXACTLY the 521
  registered invocation-side statements.
- **V-11** resource reconciliation (600/650 statements; 8,351/9,000
  documented rows written — 12.0× under 100,000/day; 49.0/55 MB bind
  payload; 101.2/120 MB MEASURED local storage growth — 4.9× under
  500 MB/db); **V-12** invocation totals (20 + 3 retries = 23; per-invocation
  maxima 69 statements / 52 API calls); **V-13** rows-read bounds
  (15,637/25,000 — 320× under 5M/day).
- **V-14** the static coverage counterexample computes exactly (1,800,116 B
  raw RSS < 2,097,152; canonical 5,400,023 B > 2,000,000).
- **V-15** THIS document cites the schedule, the validator, the ladder, the
  fixtures, the phases, the protected invocation, the CPU scopes, the
  coverage numbers and the reconciled caps (33 anchors).
- **V-16** the quota-unit discriminator structure (non-mutating; 51+51;
  4-branch matrix); **V-17** the protected-invocation artifacts (kill-switch
  DDL; 21 latch rows; every registered budget consumed exactly once).

Count separation: the validator is REVIEW-SIDE tooling — its checks are
NEVER added to the accepted product suite's 1142 or its subsets, and never
to CI's `npm run check` (product counts unchanged). Run:
`node audit-tools/probe-plan/validate-probe-plan.mjs` (from the repository
root). Local SQLite numbers are feasibility proxies, NOT cloud measurements.

## 17. What R1.10.4.1 did (closing record)

Revised this plan in place against the G0 review's five findings: split the
payload gate into legal per-statement admissibility (2/4/8) + a REACHABLE
aggregate `db.batch` ladder (13/26/26 statements; 2.080× margin) with exact
repetitions (R114-01); specified the S3 control and S4 owned schema tiers
separately with exact DDL, versions, seeding, order and verification
(R114-02); replaced the circular authorization machine with the acyclic
G0→G1→G2→G3→G4→G5 state machine including PRE-AUTHORIZED emergency teardown,
with all smoke/setup/verification calls inside the caps (R114-03);
recalculated every budget from the machine-readable schedule with a LOCAL
validator and MEASURED index-amplified storage arithmetic (the 5 MB cap
retired; 120 MB cap, 4.9× under the documented 500 MB/db) (R114-04); added
the protected invocation + replay limits (token, durable latch, kill switch),
the quota-unit discriminator with typed outcomes and retained ambiguity, the
separate expected-rejection/abort classes, the commit-only vs full-poll CPU
scopes, the honest CPU-field caveat, the 50-general/1,000-internal
subrequest distinction, and the exact coverage claim with the registered
static counterexample and decision rule D7 (R114-05). Performed ZERO
Cloudflare/account operations (including reads); changed ZERO product files;
preserved frozen historical evidence; committed ordinarily to
`review/r1.10.3-sql-design` (Draft PR #11) with no force push.
**STOP — awaiting independent review (G0) of this revised plan.**
