# PIXEL — Preview Resource Probe Plan (R1.10.4 — PLAN ONLY, NOTHING EXECUTED)

**Status: AUTHORIZATION-GATED MEASUREMENT PLAN — submitted for independent
review. NOTHING in this document has been executed.** Round R1.10.4
performed **ZERO Cloudflare/account operations, including reads**: no
resource creation, no deployment, no real D1 writes, no migration, no
activation, no billing upgrade, no merge, and no account read of any
kind. This document only (a) re-verifies the CURRENT official limits
from public documentation (public docs are not account operations), and
(b) pre-registers how FUTURE authorized probes would measure real quota
outcomes, SQL statements, bind payloads, row usage and real Worker CPU
on isolated disposable preview resources. Every future operation below
requires its own separate owner authorization checkpoint (§11). The
unchanged supported RSS envelope verdict remains **NOT_READY**; the ≤40
execution-API-call target PASSES and the ≤40 SQL-statement target FAILS
(`free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §6/§9.2 — R1.10.4-corrected).

## 0. Compliance summary (this round, verifiable)

| Item                          | R1.10.4 outcome                                                         |
| ----------------------------- | ----------------------------------------------------------------------- |
| Cloudflare/account operations | **0** (including reads; nothing was probed, listed, or logged remotely) |
| Resource creation             | **0**                                                                   |
| Product files touched         | **0** (297 files stay byte-identical to `f7020564…`)                    |
| What this file is             | PLAN ONLY — pre-registered probes, pre-committed decision rules         |
| Official-limit verification   | DONE against public docs (§2) — the only external access this round     |
| Probes executed               | **NONE** — all probe activity is future work behind §11 checkpoints     |

## 1. Purpose, scope and non-goals

**Purpose.** The R1.10.3.1 retraction (design §9.2) left the unchanged
supported RSS envelope NOT_READY with the exact blocker: the accepted
normalizer uncaps canonical-URL byte expansion, and the INTERNAL
conservative combined-byte policy then caps ≈45 KB CJK rows at 2 per
statement, so a 100-item CJK-shaped poll cannot meet ≤40 submitted
statements regardless of planner correctness. Lifting that honestly
requires MEASURED evidence about real platform behavior that local
workerd proxies cannot provide:

- (a) the largest bind payload the platform actually ACCEPTS under the
  documented-limits-only accounting;
- (b) end-to-end commit cost (execution-API calls, submitted statements,
  rows written) for the CJK shape under that accounting on REAL preview
  D1;
- (c) REAL Worker CPU for the same poll (Workers Free CPU limit: 10 ms —
  a shape that cannot fit 10 ms is NOT_READY on Free under ANY byte
  policy);
- (d) actual daily-quota deltas (rows read/written) as observed by the
  platform, vs formula margins.

**Scope.** Only the FIRST supported single-feed RSS profile shape and
its synthetic fixtures (§5). Only isolated disposable preview resources
(§4). Nothing binds to, reads, or writes any product resource.

**Non-goals (pre-committed, unchanged).** No URL/item truncation, no
lowering of supported caps, no silent drops, no weakening of ownership
fences or conflict clauses, no paid plan, no schema/migration change, no
product config change, no product deployment, no provider fetches (all
fixtures are synthetic), and no Cloudflare operation without §11
authorization. Wall time is never reported as CPU (§7). Unknown
measurements remain UNKNOWN (§7) — never "fit by assumption".

## 2. Official limits — current verification (retrieved 2026-10-19)

Method: this round fetched the PUBLIC documentation pages below (public
web access only; not an account operation; no credentials, no API, no
dashboard). Retrieval timestamp: **2026-10-19 (UTC); 2026-10-19
Asia/Tehran**. Each page carries its own "Last updated" date, quoted
below; limits are mutable — the future probe round MUST re-verify all
rows at execution time and record any drift before running anything.

### 2.1 D1 — platform limits

Source: https://developers.cloudflare.com/d1/platform/limits/ — page
states "Last updated Apr 21, 2026" (page metadata `dateModified:
2026-04-21`). Verbatim rows relevant to this plan:

| Row (verbatim)                                                                              | Exact unit           | Relevance                                                              |
| ------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| "Queries per Worker invocation (read subrequest limits) \| 1000 (Workers Paid) / 50 (Free)" | queries/invocation   | The Free-plan 50-row (unit ambiguity carried, TR-01 — still undefined) |
| "Maximum SQL statement length \| 100,000 bytes (100 KB)"                                    | bytes (SQL TEXT)     | Official SQL-TEXT limit (see §3 — distinct from the internal policy)   |
| "Maximum bound parameters per query \| 100"                                                 | count/query          | Bind-COUNT limit                                                       |
| "Maximum string, `BLOB` or table row size \| 2,000,000 bytes (2 MB)"                        | bytes/row            | ≈45 KB canonical URLs are far below                                    |
| "Maximum database size \| 10 GB (Workers Paid) / 500 MB (Free)"                             | bytes (Free: 500 MB) | Disposable DB sizing ceiling (§8)                                      |
| "Maximum storage per account \| 1 TB (Workers Paid) / 5 GB (Free)"                          | bytes (Free: 5 GB)   | Account-side storage ceiling                                           |
| "Databases per account \| 50,000 (Workers Paid) / 10 (Free)"                                | count (Free: 10)     | Headroom for one disposable DB must be owner-confirmed (§4, §9)        |
| "Time Travel duration … \| 30 days (Workers Paid) / 7 days (Free)"                          | days (Free: 7)       | Cleanup semantics (§10)                                                |
| "Maximum SQL query duration \| 30 seconds"                                                  | seconds              | Also bounds the entire batch call (footnote 4)                         |
| "Maximum bindings per Workers script \| Approximately 5,000"                                | count (approx.)      | Not load-bearing for this plan                                         |

Batch note (verbatim, same page): "Limits for individual queries (listed
above) apply to each individual statement contained within a batch
statement. For example, the maximum SQL statement length of 100 KB
applies to each statement inside a `db.batch()`."

Throughput note (verbatim): "To get more throughput from a single
database, reduce the number of requests rather than only the duration of
each query. For example, use `batch()` to send multiple statements in a
single request, so that the per-request overhead is paid once for the
whole batch."

Also same page: up to **six** simultaneous connections to D1 per Worker
invocation; D1 operations run within Workers platform CPU/memory limits.

**Unit ambiguity preserved (TR-01, unchanged):** the docs still do NOT
define whether the "50 queries per Worker invocation" row counts
execution-API calls, `batch()` calls, or individual SQL statements
inside batches. Both interpretations remain carried
(`free-plan/FREE_PLAN_COMPATIBILITY.md` §1/§4); probes measure BOTH
(§7).

**Cross-check row (Workers limits, §2.3):** D1 queries are subrequests
("A subrequest is any request a Worker makes using the Fetch API or to
Cloudflare services like R2, KV, or D1"), and Workers Free allows 50
subrequests/request — a second documented ceiling any probe must respect
and record.

### 2.2 D1 — pricing / daily allowances

Source: https://developers.cloudflare.com/d1/platform/pricing/ — page
states "Last updated Apr 21, 2026" (`dateModified: 2026-04-21`). Verbatim:

- "Rows read \| 5 million / day" (Workers Free) — unit: rows/day.
- "Rows written \| 100,000 / day" (Workers Free) — unit: rows/day.
- "Storage (per GB stored) \| 5 GB (total)" (Workers Free).
- Footnote 8 (verbatim): "Free limits reset daily at 00:00 UTC." — this
  CONFIRMS the UTC reset boundary for D1 daily allowances on the current
  page (previously carried from R1.10.1 citations; now re-verified on
  the page itself).
- Exhaustion behavior (verbatim): "When your account hits the daily read
  and/or write limits, you will not be able to run queries against D1.
  D1 API will return errors to your client indicating that your daily
  limits have been exceeded." Storage-exhaust behavior (verbatim):
  "Once you have reached your included storage limit, you will need to
  delete unused databases or clean up stale data before you can insert
  new data, create or alter tables or create indexes and triggers."
- Per-query counters (verbatim): "Every query returns a `meta` object
  that contains a total count of the rows read (`rows_read`) and rows
  written (`rows_written`) by that query."
- Index note (verbatim, footnote 6): "Indexes will add an additional
  written row when writes include the indexed column" — the fixtures'
  expected rows-written counts below account for the accepted schema's
  indexes (§6).
- Empty DB note (verbatim): "An empty database consumes approximately 12
  KB of storage."

### 2.3 Workers — platform limits (incl. the real CPU surfaces)

Source: https://developers.cloudflare.com/workers/platform/limits/ —
page states "Last updated Oct 12, 2026" (`dateModified: 2026-10-12`).
Verbatim rows relevant to this plan:

| Row (verbatim)                                                          | Exact unit          | Relevance                                         |
| ----------------------------------------------------------------------- | ------------------- | ------------------------------------------------- |
| "Requests \| 100,000/day (Free)" (row: "Requests … 100,000/day")        | requests/day        | Probe totals stay ≪ this (§8)                     |
| "CPU time \| 10 ms (Free) / 5 min (Paid)"; per Cron Trigger Free: 10 ms | milliseconds of CPU | The Free CPU ceiling that dominates the CJK shape |
| "Subrequests \| 50/request (Free) / 10,000/request (Paid)"              | count/request       | Cross-check on the D1 "50 queries" row (§2.1)     |
| "Simultaneous outgoing connections/request \| 6"                        | count               | Matches the D1 page                               |

CPU semantics (verbatim): "CPU time measures how long the CPU spends
executing your Worker code. Waiting on network requests (such as
`fetch()` calls, KV reads, or database queries) does **not** count
toward CPU time." Exceeding CPU returns Error 1102 ("Worker exceeded
resource limits"); in analytics and Logpush the invocation outcome is
`exceededCpu`.

**Where real CPU is OBSERVABLE (verbatim pointers from the same page):**

- "Workers Logs — CPU time and wall time appear in the invocation log"
  (https://developers.cloudflare.com/workers/observability/logs/workers-logs/#invocation-logs).
- "Tail Workers / Logpush — CPU time and wall time appear at the top
  level of the Workers Trace Events object"
  (https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/).

Workers Trace Events dataset
(https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/
— page states "Last updated Sep 14, 2026"): field **`CPUTimeMs`** —
Type: `int` — "The amount of CPU time used by the Worker script, in
milliseconds." Field **`WallTimeMs`** — "The elapsed time in
milliseconds between the start of a Worker invocation, and when the
Workers Runtime determines that no more JavaScript needs to run" —
explicitly WALL-clock; `waitUntil()` work extends WallTime. These two
fields are the plan's canonical CPU/WALL distinction (§7).

Daily requests (verbatim): "Accounts on the Workers Free plan have a
daily request limit of 100,000 requests, resetting at midnight UTC.
When a Worker exceeds this limit, Cloudflare returns **Error 1027**."

Workers Logs availability (https://developers.cloudflare.com/workers/observability/logs/workers-logs/
— page states "Last updated Oct 12, 2026"): "Workers Logs is included in
both the Free and Paid Workers plans" — Workers Free: **200,000 log
events per day**, 3-day retention; a single log is capped at 256 KB and
truncation sets `$cloudflare.truncated = true`. **Pricing-change note
(verbatim): "Beginning December 1, 2026, Workers Logs will use
Cloudflare Observability pricing"** — the execution round MUST re-verify
Workers Logs terms on/after that date before relying on it for evidence.

### 2.4 Queues — pricing / Free allowance

Source: https://developers.cloudflare.com/queues/platform/pricing/ —
page states "Last updated Apr 21, 2026" (`dateModified: 2026-04-21`).
Verbatim: "Standard operations \| 10,000 operations/day included"
(Workers Free); "Message retention \| 24 hours (non-configurable)";
"An operation is counted for each 64 KB of data that is written, read,
or deleted."; "Operations are per message, not per batch."; "In most
cases, it takes 3 operations to deliver a message". **Reset boundary
for the Queues daily allowance is STILL not stated on the page —
remains UNKNOWN (TR-06 discipline, worksheet §4).** This plan binds NO
queues (§4), so queue quotas are not probed; the row is carried for
completeness only.

### 2.5 Drift vs the sealed R1.10.2/R1.10.3 manager excerpts

Compared against `manager-evidence/official/d1-limits.json`,
`d1-api.json` and the carried R1.10.1 citations
(`free-plan/FREE_PLAN_OFFICIAL_SOURCES.md`): **no observed change** in
any row this plan relies on (D1 limits/pricing rows, Workers CPU 10 ms
Free, 100,000 requests/day Free, Queues 10,000 ops/day Free, 24 h
retention). The only NEW page facts this round adds: D1 pricing footnote
8 (UTC reset, now re-verified verbatim), Workers limits page dates
(Oct 12, 2026), the Workers Logs pricing-change notice (Dec 1, 2026),
and the named `CPUTimeMs`/`WallTimeMs` Trace Events fields. The account
plan/entitlement remains owner-side UNKNOWN (no account read, ever).

## 3. Internal combined-byte policy vs official SQL-text limits (DISTINCT IN KIND)

Kept explicit because conflating them is the historical error this plan
must never repeat:

- **Official (documented):** "Maximum SQL statement length | 100,000
  bytes (100 KB)" — a limit on the SQL **TEXT**, applied to each
  statement inside a batch; and "Maximum bound parameters per query |
  100" — a COUNT limit on binds. The docs contain **NO** documented row
  for a maximum bound-parameter BYTE size and **NO** documented row for
  a maximum batch/total payload.
- **Internal (conservative margin, NOT the documented limit):** the
  planner's policy "SQL text + ALL bound values ≤ 102,400 bytes
  (100 × 1024)" (`design-lab/candidate-sql.ts`,
  `MAX_SQL_STATEMENT_BYTES`) is an INTERNAL POLICY that constrains
  something the docs do not document (combined bytes). It is strictly
  STRONGER than the documented rows for the shapes measured so far, and
  it is the DIRECT CAUSE of the NOT_READY blocker (2 rows/statement for
  ≈45 KB CJK rows).
- Consequence: adopting "documented-limits-only" accounting would NOT
  contradict any documented row — but the real platform's enforcement
  of large bind payloads on the D1 Worker binding is UNDOCUMENTED and
  UNKNOWN, which is exactly what probe P-01 (§6) is designed to measure
  before any policy revision. The policy may be revised ONLY on measured
  evidence per the pre-committed rules (§12, D1/D2), never to make a
  target fit by assumption.

## 4. Isolated disposable preview resources (to be created ONLY under §11 authorization)

All probe resources are DISPOSABLE and share NOTHING with product
resources. Names below are proposals; the owner approves/renames at the
§11 checkpoint.

| Resource          | Proposed name               | Properties                                                                                               |
| ----------------- | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| Probe Worker      | `pixel-probe-r1104`         | A separate Worker script; NO product bindings (no queues, no product D1, no secrets); routes OFF         |
| Probe D1 database | `pixel-probe-db-disposable` | Brand-new empty database (≈12 KB initial storage); schema = the accepted migrations 0001–0003 ONLY       |
| Queues            | **NONE bound**              | Zero queue producers/consumers; the probe never touches queue quotas                                     |
| Product resources | **FORBIDDEN**               | `pixel`, `pixel-preview`, `pixel-db-preview`, `pixel-jobs-preview`, `pixel-dlq-preview` are out of scope |

- Isolation proof required at execution: the probe script's binding list
  contains exactly ONE D1 binding (the disposable DB) and nothing else;
  a pre-flight `wrangler` dry-run printout is archived as evidence.
- Account headroom prerequisite: Free allows **10 D1 databases per
  account**; the current account count is owner-side UNKNOWN. The owner
  confirms headroom BEFORE creation (§9, P0-2); if headroom is
  insufficient, the plan aborts at the checkpoint (no workaround, no
  paid upgrade, no deletion of product resources).
- The probe Worker uses the SAME product SQL code paths ONLY as copied
  into the probe script (the reviewed planner/classification from the
  design lab, pinned by commit SHA — §9, P0-5); the product itself is
  never deployed, configured, or migrated.
- Workers Logs `observability.enabled = true` in the probe config so
  invocation logs (CPU/wall) are captured (§2.3); retention 3 days on
  Free — evidence must be exported within that window (§10).

## 5. Synthetic fixtures (deterministic, checksummed, no real provider data)

All fixtures are GENERATED deterministically by a committed generator
script (design-lab pattern, reused verbatim); no provider is contacted
and no real content is used. Each fixture's exact bytes are pinned by
SHA-256 recorded in the execution round's evidence BEFORE any probe runs
(§9, P0-6). The four required shapes:

| Fixture        | Shape                                                                                                                                            | Derived expectations (from the reviewed planner, LOCAL numbers — to be re-measured on-platform)          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **F-NORMAL**   | 100 items, fixture URL shape at the ~2 KiB canonical-URL assumption (the cost-ledger fixture shape)                                              | 8 rows/statement → 13 INSERTs; ≈15 xAPI / 29 STMT (ledger C-02/C-06) — the conditional scenario          |
| **F-HETERO**   | 100 items: first 8 short URLs, remaining 92 with 5000-char CJK HTTPS paths (L-12 counterexample shape; RSS < 2 MiB)                              | 1×8 + 46×2 = 47 INSERTs under the conservative policy; every chunk audit ≤ 102,400 bytes                 |
| **F-CJK**      | 100 items, uniform 5000-char CJK paths → canonical URLs of EXACTLY 45,023 bytes each via the accepted normalizer (L-14; raw RSS ≈1.4 MB < 2 MiB) | 2 rows/statement → 50 INSERTs alone; ≈15 xAPI / 66 STMT owned (C-15) — the NOT_READY shape               |
| **F-OVERSIZE** | 1 item whose canonical URL alone exceeds the internal budget → planner must raise `OversizedRowPlanError` at PLAN time                           | ZERO statements submitted, ZERO durable effects (L-13 parity); the invocation still burns CPU — recorded |

Fixture discipline: UTF-8 byte counts are computed with `TextEncoder`
(the audited definition); "45,023 bytes" is a LOCAL pinned value — the
execution round re-derives it from the accepted normalizer and records
any drift as evidence BEFORE probing. Fixtures include the heterogeneous
and Unicode/CJK cases REQUIRED by this round's scope, plus the normal
baseline and the oversized-row negative case.

## 6. Pre-registered probe cases (expectations fixed BEFORE execution)

Each case: fixture, accountings, expected outcome CLASS, and what is
recorded. If an observed outcome does not match its pre-registered class,
the round ABORTS (§9) — outcomes are never reinterpreted post-hoc.

| Case | Fixture(s)         | Accounting under test                                                                                                                        | Pre-registered expectation (class)                                                                                                                                                                                                                                                                               | Primary recorded evidence                                                                      |
| ---- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| P-01 | F-CJK-derived rows | **Documented-limits-only** (SQL TEXT ≤ 100,000 B per statement; ≤ 100 binds; NO internal combined cap)                                       | Bind-payload ACCEPTANCE LADDER: increasing rows/statement (2 → 4 → 8 → 16 → 32 → 50), one repetition each + final repeat at the max accepted rung; expectation: acceptance OR a typed platform rejection — EITHER is a valid measured outcome; the max accepted total bind payload is **UNKNOWN until measured** | Per-statement audit bytes; per-rung accept/reject verbatim; total payload at max accepted rung |
| P-02 | F-CJK              | Documented-limits-only **IFF P-01 reached the required payload** (≥ the full 100-row CJK batch total with ≥ 2× margin); else P-02 is NOT RUN | End-to-end CJK commit replica (owned path): statements + xAPI + rows written on real preview D1; UNKNOWN until measured                                                                                                                                                                                          | Instrument counters (v3 units); `meta.rows_read`/`rows_written` per statement; invocation logs |
| P-03 | F-CJK              | CURRENT conservative policy (control)                                                                                                        | ≈50 INSERT statements, ≈15 xAPI / 66 STMT, every audit ≤ 102,400 bytes, ALL rows land — LOCAL parity check on-platform                                                                                                                                                                                           | Same as P-02                                                                                   |
| P-04 | F-HETERO           | CURRENT conservative policy                                                                                                                  | ≈47 INSERT statements (1×8 + 46×2), all chunks ≤ budget, all rows land — L-12 parity on-platform                                                                                                                                                                                                                 | Same as P-02                                                                                   |
| P-05 | F-NORMAL           | CURRENT conservative policy                                                                                                                  | ≈13 INSERT statements, ≈15 xAPI / 29 STMT — C-02/C-06 parity on-platform                                                                                                                                                                                                                                         | Same as P-02                                                                                   |
| P-06 | F-OVERSIZE         | CURRENT conservative policy (negative)                                                                                                       | Plan-time `OversizedRowPlanError`; ZERO statements executed; ZERO durable rows; invocation completes                                                                                                                                                                                                             | Rejection record; post-probe row-count check (must equal pre-probe)                            |
| P-07 | F-CJK, F-NORMAL    | CPU measurement (runs WITH P-02/P-03/P-05 invocations)                                                                                       | Real CPU per invocation from Workers Logs invocation logs / Trace Events `CPUTimeMs`; UNKNOWN until measured; wall time recorded as WALL ONLY                                                                                                                                                                    | `CPUTimeMs`/`WallTimeMs` per invocation; any `exceededCpu`/1102 outcome                        |
| P-08 | all                | Quota deltas (passive)                                                                                                                       | Daily rows read/written deltas on the OWNER dashboard/analytics for the probe DB only; deltas must match `meta` sums within documented counting rules (indexes add written rows); NO exhaustion is ever deliberately triggered                                                                                   | Dashboard/analytics exports (owner-side); `meta` sums from the instrument                      |

P-01 details (the decisive probe): the ladder submits single
multi-row-INSERT statements (placeholder-heavy SQL TEXT, ≈45 KB CJK
binds per row) with steps 2/4/8/16/32/50 rows — total bind payloads
≈0.09/0.18/0.36/0.72/1.44/2.25 MB — under documented-limits-only
accounting (each statement's SQL TEXT stays ≤ 100,000 bytes; binds ≤
100/query is satisfied by the ≤ 99-row-binds + shared guards bound
per the reviewed planner ONLY IF the bind-count row still permits the
rung; a rung that would exceed 100 binds is NOT SUBMITTED and recorded
as bind-COUNT-blocked). A rung is "accepted" iff the platform returns
success with `meta.changes` matching the rung's row count. The ladder
STOPS at the first rejection (the rejection itself is evidence);
"required payload" = the total binds of one full 100-item F-CJK commit
under documented-limits-only accounting (≈ 4.5 MB — recorded exactly by
the instrument), plus the pre-committed ≥ 2× margin rule (§12, D1).

## 7. Measurement definitions (units discipline)

- **xAPI** — execution-API-call attempts, per the corrected v3
  instrument units (R112-03: failed-batch statements are NOT completed;
  reservoir truncation counted; `prepare()` is construction, never an
  execution — TR-01 anchor). STMT — submitted statements.
- **SQL-text bytes / bind bytes** — UTF-8 bytes via `TextEncoder`; the
  audited per-statement total = SQL text bytes + Σ bound-value bytes
  (the internal-audit definition; NOT an official unit).
- **rows read / rows written** — official units from §2.2, recorded
  from BOTH the per-query `meta` counters (self-reported) and the
  owner-side daily analytics (authoritative); discrepancies are
  recorded, never reconciled away.
- **CPU** — ONLY `CPUTimeMs` (int, milliseconds) from Workers Logs
  invocation logs or the Workers Trace Events object (§2.3), and the
  invocation `outcome` (`exceededCpu` on Error 1102). **Wall time is
  NEVER CPU**: `performance.now()`, `WallTimeMs`, and any local workerd
  elapsed time are recorded as WALL and are inadmissible for any
  Free-CPU conclusion. If no CPU-labeled surface is obtainable for an
  invocation, that invocation's CPU is **UNKNOWN** — never inferred
  from wall time.
- **Both unit interpretations of the Free "50 queries" row are always
  computed and reported** (execution-API calls; submitted statements) —
  the ambiguity is documented, not resolved by assumption (TR-01).
- Every number in evidence carries: unit, measurement surface, and the
  doc version (page "Last updated" date) it is judged against.

## 8. Exact bounded invocation/data totals (hard caps; exceeding ANY cap aborts)

| Budget line                                  | Hard cap (whole probe round)                          | Documented Free allowance                                                 | Margin                  |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------- |
| Probe Worker invocations (HTTP-triggered)    | **≤ 12**                                              | 100,000 requests/day                                                      | ≈ 4 orders of magnitude |
| Statements per invocation                    | ≤ 120 (P-03 worst case ≈ 50 INSERTs + fixed overhead) | — (per-invocation "50 queries" row judged under BOTH interpretations, §7) | recorded, not assumed   |
| Submitted statements, round total            | **≤ 600**                                             | —                                                                         | —                       |
| Rows written (incl. index rows), round total | **≤ 2,500**                                           | 100,000 rows/day                                                          | ≥ 40×                   |
| Rows read, round total                       | **≤ 50,000**                                          | 5,000,000 rows/day                                                        | ≥ 100×                  |
| Bind payload, round total (all statements)   | **≤ 30 MB**                                           | no documented row (UNKNOWN — the point of P-01)                           | measured per-statement  |
| Durable storage growth                       | ≤ 5 MB + ≈12 KB empty-DB baseline                     | 500 MB/database; 5 GB/account                                             | ≥ 100×                  |
| Queues operations                            | **0** (no queues bound)                               | 10,000 ops/day                                                            | infinite                |
| Workers Logs events                          | ≤ 2,000 (≤ 12 invocations + custom logs)              | 200,000 events/day (Free)                                                 | ≥ 100×                  |
| Provider fetches                             | **0** (synthetic fixtures only)                       | —                                                                         | —                       |
| Product-resource touches                     | **0**                                                 | —                                                                         | —                       |

No probe deliberately drives ANY daily allowance toward exhaustion; a
quota-exceeded error anywhere is an immediate abort with the state
recorded (§9). The only limit deliberately approached is the
per-statement SQL-TEXT/bind-COUNT pair — on the disposable database
only.

## 9. Prerequisites (ALL must hold before any probe; each verified with evidence)

- **P0-1 — §11 checkpoints G1 (create) and G2 (execute) BOTH passed** by
  explicit owner authorization, in that order, G2 AFTER resources exist
  and are verified isolated.
- **P0-2 — Account headroom confirmed by the owner**: D1 databases < 10
  on the Free account, storage headroom, plan is (still) Workers Free.
  Owner-side dashboard reads are the owner's own operations; agents
  perform none.
- **P0-3 — Baseline usage snapshot recorded** (owner): D1 rows
  read/written today, storage, Workers requests, BEFORE any probe — so
  P-08 deltas are attributable.
- **P0-4 — Official-limit re-verification at execution time**: §2 rows
  re-fetched from the live pages, dates recorded, drift (if any)
  documented; if any load-bearing row changed, the plan is RE-REVIEWED
  before execution (limits are mutable — this plan is a snapshot).
- **P0-5 — Probe script pinned**: the script, the copied
  planner/classification code, and the instrument carry the reviewed
  commit SHA in their provenance headers; the executed bytes are hashed
  into the evidence set.
- **P0-6 — Fixture checksums pinned**: every F-\* fixture SHA-256
  recorded and matched at run time; a mismatch aborts.
- **P0-7 — Secret scan green** on the probe tree (`npm run scan:secrets`
  - credential-pattern grep); NO credentials of any kind in the probe
    Worker, its config, or evidence.
- **P0-8 — Workers Logs enabled** in the probe config and a 1-invocation
  smoke confirms invocation logs (with `CPUTimeMs`) are being captured
  and exportable within the 3-day Free retention.
- **P0-9 — Abort/cleanup paths rehearsed**: the teardown commands (§10)
  exist and are syntax-checked BEFORE G2; the owner has them.

## 10. Cleanup (owner-authorized; part of the plan, not an afterthought)

1. Probe Worker deleted (`wrangler delete` or dashboard by the owner).
2. Disposable D1 database deleted by the owner. **Time Travel note:**
   Free retention is 7 days; deletion itself is the cleanup — no restore
   is planned or needed, and no probe data persists beyond deletion.
3. Verification of zero remaining probe resources (owner-side listing;
   agents perform none) — recorded in evidence.
4. Final usage snapshot AFTER the documented analytics lag window
   (owner records it when stable) so P-08 deltas close to zero.
5. Evidence archived (§10 evidence set + SHA256SUMS) BEFORE deletion so
   the archive does not depend on the deleted resources.

**Evidence collection (for every probe round):** bound raw logs under
`logs/` (naming `4x-probe-<case>-<seq>.log`), byte-preserved stdout/
stderr; the instrument's per-statement audits exported to a committed
JSON ledger (design-lab extraction pattern, parser committed BEFORE
execution); owner-exported dashboard/analytics/Workers-Logs artifacts
stored with provenance headers (round, commit SHA, UTC + Asia/Tehran
timestamps, doc page dates); `SHA256SUMS.txt` over the whole evidence
set; any deviation logged as a numbered correction, never an in-place
edit of an already-published evidence file.

## 11. Authorization checkpoints (the ONLY entry points — separate, explicit, recorded)

- **G0 (this round, R1.10.4):** review of THIS PLAN by Posidon. No
  operation of any kind precedes or accompanies it. ✅ requested — this
  document is the G0 artifact.
- **G1 — resource creation checkpoint:** explicit owner "go" to create
  the §4 disposable Worker + D1 database (and NOTHING else), after
  P0-2/P0-3. Creation is the ONLY operation G1 authorizes.
- **G2 — execution checkpoint:** a SEPARATE explicit owner "go" to run
  the pre-registered cases P-01…P-08 exactly as tabled, after P0-4…P0-9.
  Any change to cases/limits/totals requires a REISSUED plan and a NEW
  G2. G2 may authorize a SUBSET of cases (partial runs are valid).
- **G3 — cleanup checkpoint:** explicit owner "go" for §10 teardown and
  evidence finalization.
- Standing rule: read-only, list, metrics, and dashboard operations on
  the account are ALSO account operations — they are owner-side, never
  agent-performed, and each future round's compliance record must state
  its exact operation count (this round: **0**).

## 12. Pre-committed decision rules (fixed NOW, before any measurement)

- **D1 — bind-payload / policy adoption:** the documented-limits-only
  accounting may be adopted for the CJK shape IFF (i) the P-01 ladder
  reaches the full F-CJK batch payload with **≥ 2× margin** with zero
  payload-related rejections across all repetitions, AND (ii) P-02
  completes end-to-end with correct durable rows, AND (iii) P-07 shows
  CPU within the documented Free 10 ms for the same shape. ANY failure
  → the conservative combined-byte policy STAYS, unchanged.
- **D2 — ≤40 STMT target:** the unchanged-envelope NOT_READY verdict is
  lifted ONLY if, under the adopted accounting, an on-platform F-CJK
  commit measures ≤ 40 submitted statements AND ≤ 40 execution-API calls
  (BOTH interpretations) AND D1(iii) holds. Otherwise **NOT_READY
  stands** — and if the verdict is lifted, it is lifted by MEASURED
  numbers only, with the full evidence chain.
- **D3 — CPU dominates:** if any measured `CPUTimeMs` for a CJK-shaped
  poll exceeds 10 ms, or `exceededCpu`/Error 1102 occurs, the CJK shape
  is **NOT_READY on Free under ANY byte policy** — the CPU verdict
  dominates every other gate. CPU UNKNOWN (no CPU-labeled surface) →
  NOT_READY stands; wall time never substitutes.
- **D4 — quota honesty:** readiness claims may rest ONLY on measured
  quota deltas (P-08) vs documented allowances; formula margins alone
  can never produce a READY claim. Missing/unevaluable measurement →
  that dimension is UNKNOWN → overall verdict NOT_READY (unchanged).
- **D5 — no goal-directed re-runs:** probes are never re-run with
  altered parameters to force a desired outcome; the only re-run is a
  repetition of the SAME case under the SAME registered parameters
  (counted, logged), and ladder re-runs are capped at the pre-registered
  counts in §6.
- **D6 — drift:** if P0-4 re-verification shows any load-bearing
  documented row changed, execution stops until the plan is re-issued
  and re-reviewed (a changed platform invalidates pre-commitments).

## 13. Wall-time-vs-CPU and UNKNOWN discipline (restated as commitments)

1. `CPUTimeMs` (or an equivalent CPU-labeled surface re-verified at
   execution time per P0-4) is the ONLY admissible CPU evidence;
   `WallTimeMs`/`performance.now()`/local workerd elapsed times are
   WALL and inadmissible for CPU conclusions.
2. Every measurement this plan cannot pre-commit a value for (bind
   payload acceptance, real CPU, real quota enforcement, the "50
   queries" unit) is recorded as **UNKNOWN until measured** — no
   derivation, analogy, or local proxy number is promoted into its
   place.
3. Local design-lab numbers (C-01…C-16, L-01…L-14) remain LOCAL PROXY
   UNITS: they pin parity expectations (P-03…P-05) but NEVER serve as
   cloud evidence.

## 14. What R1.10.4 did (closing record)

Wrote this plan; re-verified the official limits from public docs (§2);
corrected the §6 universal-fit claim and relabeled §9.4 in
`free-plan/FREE_SAFE_EXECUTION_DESIGN.md`; performed **zero**
Cloudflare/account operations; changed **zero** product files;
preserved frozen historical evidence; committed ordinarily to
`review/r1.10.3-sql-design` (Draft PR #11) with no force push.
**STOP — awaiting independent review (G0) before any future
checkpoint.**
