# PIXEL — Cloudflare Free-Plan Compatibility Addendum (R1.10.2)

**Status of this document:** evidence-based ANALYSIS ONLY, corrected edition
(TR-01 units, TR-02 readiness verdict, TR-04 recovery, TR-06
bounds/provenance). No paid upgrade, no billing change, no resource
activation, no remote operation, no config change. Official limits below are
DOCUMENTED PLAN LIMITS cited from the retrieved official-page excerpts
shipped in `manager-evidence/official/` (provenance in
`free-plan/FREE_PLAN_OFFICIAL_SOURCES.md`) — they are NOT an observation of
the owner's actual account entitlement or remaining allowance, which stays
UNKNOWN (remote checks are out of scope).

## 1. Verdict

*_Free-plan compatibility for the CURRENT SHIPPED surface (Telegram admin
bot + webhook, jobs engine ON with ingestion gate OFF, cron */5, schema 3):
plausibly trivial on paper, UNPROVEN pending owner-approved cloud
measurement.*_

**Operational status for the CURRENT ADVERTISED ingestion profile
(batch-10 consumer, ≤100-item polls, schema-4 owned path):
`NOT_READY_FOR_INGESTION_ON_FREE`** — measured local evidence, not a cloud
enforcement claim:

- ONE supported 100-item poll = **110 execution-API-call attempts /
  211 statements** (trace T-13; manager C2-100 independently: 110/211).
- The documented Free row is "**Queries per Worker invocation … 50 (Free)**"
  (`manager-evidence/official/d1-limits.json`). Under EITHER unit
  interpretation (execution-API calls OR executed statements) the
  single-job path alone exceeds it. **Lowering the queue batch size does
  NOT fix this path** — the batch is irrelevant for a one-job delivery.
- ONE active batch of 10 (7 RSS + Steam + YouTube + GitHub) through ONE
  real `handleQueue` = **1001 execution-API-call attempts / 1812
  statements** (trace T-16; manager C3 independently: 1001/1812).
- "Cloud enforcement" (whether/how Cloudflare actually enforces the row)
  and CPU remain **LIVE-UNVERIFIED**; this verdict is a local-measurement
  - documented-limit conclusion, and it does NOT assert that every
    possible Free deployment profile is impossible.

The gate-OFF surface and future ingestion are separate decisions. The
minimal next step is the DESIGN-ONLY Free-safe path
(`free-plan/FREE_SAFE_EXECUTION_DESIGN.md`), then — only after manager
acceptance — a narrowly scoped implementation round. No upgrade, no
weakened fence.

## 2. Method and evidence classes

| Class          | Meaning                                                                                         | Where                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OFFICIAL       | Cloudflare docs as retrieved in `manager-evidence/official/*.json` (URL + retrieval provenance) | `free-plan/FREE_PLAN_OFFICIAL_SOURCES.md`                                                                                                                   |
| MEASURED-LOCAL | Fresh corrected-unit traces of the REAL entrypoints on disposable workerd D1                    | `audit-tools/trace/`, `audit-tools/logs/trace-run-r1102.log`; summarized in `free-plan/FREE_PLAN_WORKSHEET.md` + `free-plan/FREE_PLAN_RESOURCE_LEDGER.json` |
| CODE-FACT      | Reviewed constants read from the accepted source (no behavior change)                           | cited inline                                                                                                                                                |
| CHOSEN         | Scenario assumption chosen for estimation (labeled, not measured)                               | `free-plan/FREE_PLAN_WORKSHEET.md`                                                                                                                          |
| UNKNOWN        | Cannot be known without owner-side/cloud access                                                 | §8                                                                                                                                                          |

**Honesty labels (mandatory):** local traces are a workerd/miniflare PROXY.
Local elapsed wall time does NOT measure Cloudflare CPU (network wait is not
CPU, and local SQLite ≠ managed D1). Local `rows_read`/`rows_written` meta,
where present, is the local engine's own estimate — it is NOT a cloud
billable counter (indexes on managed D1 can make cloud writes HIGHER).
Cloud quota enforcement is NOT emulated locally, so limit conformance for
the gate-OFF surface stays UNPROVEN, and the ingestion verdict above is a
local-measured **readiness** verdict, not a cloud-behavior observation.

## 3. Workers Free plan vs actual code paths (HTTP + Cron)

Documented (OFFICIAL): requests **100,000/day** (reset midnight UTC); CPU
**10 ms per request** and **10 ms per Cron Trigger invocation**; memory
128 MB; **50 subrequests per invocation** (redirects count); 6 simultaneous
outgoing connections; 64 env vars/Worker; 5 Cron Triggers per account.

- **HTTP Telegram path:** one webhook POST = one request. Corrected-unit
  traces (T-01…T-05): normal noop update = 2 execution-API-call attempts /
  2 statements; duplicate second delivery = +2/+2; unauthorized foreign
  `/start` offline = 3/3 (durable claim BEFORE routing); owner `/start`
  with transport = 3 D1 calls + ONE scripted Bot API `sendMessage`
  (outbound); unauthorized with transport = 3 D1 calls + ONE denial
  `sendMessage`. Bounded body read ≤ 64 KiB
  (`TELEGRAM_WEBHOOK_MAX_BODY_BYTES`), strict JSON parse — bounded payload
  work, CODE-FACT. CPU: the parse + tiny D1 round-trips are candidate CPU
  consumers; 10 ms is per-invocation CPU on Cloudflare and CANNOT be proven
  locally (UNPROVEN; no fabricated p95 is offered).
- **Cron path:** one cron fire = one invocation with its own 10 ms CPU
  budget. Idle (gate OFF): 6 execution-API-call attempts, 0 writes (T-06).
  Seed pass (gate ON): 9 attempts / 36 statements, one batch carrying the
  14-row seed (T-07). Due-scheduling pass after enabling ONE source: 11
  attempts / 11 statements (T-08) — SEPARATE single-pass measurements, no
  longer one aggregate (TR-06 fix). Cron NEVER fetches feeds (no connector
  code runs in cron, CODE-FACT).
- **Queue consumer path:** duration/CPU model is DISTINCT from HTTP (queue
  consumers are not the 10 ms-per-HTTP-request case, but Free-plan CPU still
  applies per the documented plan). Gate-OFF batch of 10 = 10 attempts (one
  lookup per job), 0 writes, all acked `paused_by_policy` (T-09). ACTIVE
  paths: see §1/§5 numbers — the batch-10 active case (T-16) is the
  blocking one.
- **Subrequests:** connectors issue raw requests per hop; redirects COUNT
  (safe-http follows ≤ `maxRedirects = 2`, CODE-FACT). Runtime per-connector
  request caps (CODE-FACT): RSS ≤ 4 feeds/poll (+≤2 redirect hops per
  request), Steam = min(appsPerBatch, |apps|) ≤ 25 requests, YouTube =
  |playlists| + 1 details call ≤ 26, GitHub = |repositories| ≤ 25, Reddit =
  1 token + |subreddits|. R1.10.3 label: T-17…T-21 measured REPRESENTATIVE
  multi-request shapes (3 apps / 2 playlists / 2 repos / 2 subreddits) —
  they are NOT supported-max proofs; max-bound budgets are measured
  separately before any broadened profile. A 10-poll active batch can therefore approach or
  exceed the 50-subrequest row for multi-request connectors — UNPROVEN,
  bounded by the per-source caps and the enabled-source set.
- **Local elapsed time is a PROXY ONLY:** no conclusion about Cloudflare
  10 ms CPU is drawn from any local duration.

## 4. D1 Free plan vs actual code paths — CORRECTED UNITS (TR-01)

Documented (OFFICIAL): **5 M rows read/day; 100 K rows written/day; 500 MB
per DB; 5 GB account storage; 50 queries per Worker invocation (Free); Time
Travel 7 days (Free); 10 restores / 10 min / DB.** Daily exhaustion makes D1
queries FAIL with explicit limit errors (OFFICIAL) — the code's existing
fail-closed paths (retryable 503, durable retry/dead-letter) align with
observable degradation, but the exact behavior under real exhaustion is
UNPROVEN.

**Unit vocabulary (TR-01 corrected; the old "prepare+batch = binding
invocation" formula is withdrawn):**

- `prepares` = `prepare()` CONSTRUCTION only (official API: "Prepares a
  query statement to be later executed"). NEVER an execution, RPC, query,
  or billable event.
- **Execution-API-call attempts** = terminal method executions
  (`run/all/first/raw`) + `batch()` calls. Each `batch()` is ONE
  execution-API call regardless of statement count.
- **Statements attempted** = terminal executions + statements submitted
  into batches.
- **Metadata coverage:** every available returned result metadata record is
  captured (terminal + EVERY batch result object); unavailable metadata is
  LABELED unavailable, never zero-filled.
- Attempted vs completed vs failed are separate counters (a throw is a
  failed attempt, never dropped).

**The documented-quotas question (kept explicit, BOTH interpretations
carried):** the official limits page cross-references "read subrequest
limits" for "Queries per Worker invocation" and does not define whether the
50 row counts execution-API calls, batch calls, or individual statements.
The official D1 throughput guidance ("use `batch()` to send multiple
statements in a single request, so the per-request overhead is paid once")
suggests a batch behaves as ONE request for throughput purposes — but the
QUOTA row's unit is a separate documented question that only Cloudflare
documentation or owner-approved cloud measurement can settle. The blocking
verdict in §1 holds under BOTH readings, which is why it does not depend on
resolving this ambiguity. Local D1 throughput notes
(`manager-evidence/official/d1-limits.json`) are quoted there.

**rows_read / rows_scanned:** scans count rows examined, not rows returned
(OFFICIAL). The accepted `DbExecutor` exposes ONLY duration/changes, so the
traces capture RAW D1 result meta via the corrected wrapper WITHOUT
relabeling: `changes` ≠ billable rows_written, returned rows ≠ rows_read.
The v1 wrapper's one-meta-sample-per-batch omission is fixed (every batch
result record is captured; R1.10.2 unit controls C-02/C-07 pin this).

**Storage:** tables AND indexes consume storage (OFFICIAL). No arrival/
retention/byte measurement exists — the "years of headroom" claim is
WITHDRAWN (TR-06); the worksheet carries an explicit ASSUMPTION SET instead
(§3 there) and storage stays UNKNOWN.

## 5. Queues Free plan vs actual code paths — recovery corrected (TR-04)

Documented (OFFICIAL): **10,000 operations/day (Free); typical delivery = 3
operations (1 write + 1 read + 1 delete) per message; each retry = 1 read;
a batch of 10 messages = 10× the operations; messages > 64 KB count as
multiple 64 KB chunks; Free retention 24 h non-configurable.** DLQ
production and consumption also consume operations. **Reset boundary for
the Queues daily allowance: UNKNOWN** (the page documents the allowance;
TR-06 bars asserting a clock that is not established).

- Envelopes are tiny references (`{version, jobId, type, attempt, traceId}`,
  CODE-FACT) — far below 64 KB, so 1 chunk per message.
- **Application-level recovery EXISTS (TR-04 correction — the R1.10.1
  "no automatic re-kick" claim is withdrawn):** the accepted
  `dispatchDueJobs` (`src/application/jobs/engine.ts`) performs, per pass:
  expired-claim reclaim (`reclaimExpiredClaims`), due `pending`/`retry_wait`
  scan, **stranded `queued` re-kick with a grace window**
  (`scanStrandedQueuedJobs`), and dead-letter DLQ reconciliation
  (`reconcileDeadLetters`). MEASURED LOCALLY (corrected tooling): trace
  T-28 — a queued row aged 25 h is re-enqueued by the REAL cron with the
  SAME durable job id; trace T-27 — one real cron pass reconciles a
  dead-letter row: the DLQ producer receives the safe reference and the row
  is confirmed `dlq_delivered_at` (guarded, at-least-once).
- **What T-27/T-28 do NOT prove (mandatory labels):** no real Queue message
  TTL expiry, no real Queue availability/retention behavior, no real
  send/receive round-trip against the platform (the consumer side of the
  DLQ queue is the platform's; a real DLQ receive path is
  LIVE-UNVERIFIED), and no claim of eventual success after attempt
  exhaustion.
- **Workload model additions (TR-04):** outage/reopen costs (backlog
  re-kicks after recovery), fairness costs (stranded scans share the
  bounded dispatch batch with due work), and repeated re-kick envelope
  amplification (the SAME durable reference can be re-sent; amplification
  is bounded by the schema-4 outstanding-poll uniqueness + grace window,
  unbounded on schema 3) are now explicit worksheet components (§3 there).
- **No hot-loop plan (unchanged):** retries are bounded (`max_retries: 3`
  consumer config, CODE-FACT) and durable retry scheduling acks the message
  (no platform redelivery storm — traces T-22/T-24/T-26 show the
  retry_wait/dead_letter ladder with the message consumed each time).

## 6. Reset clocks (explicit separation)

- Cloudflare Workers/D1 daily quotas reset at **midnight UTC** (OFFICIAL).
- The connector provider budget day is **Asia/Tehran** (`tehranBudgetDay`,
  CODE-FACT) — a DIFFERENT clock.
- **Queues daily-allowance reset boundary: UNKNOWN** (TR-06: not asserted).
- Queue message retention: rolling **24 h per message** (Free,
  OFFICIAL) — a retention bound, not a reset clock.
- Do NOT translate one clock into the other; the operator ledger records
  each independently (worksheet §4).

## 7. Named risks (evidence-based, each UNPROVEN until measured)

1. **CPU 10 ms per invocation (HTTP and cron):** parsing + bounded D1 work
   are small locally, but Cloudflare-side CPU is unmeasurable locally.
   Risk: low-to-moderate for the shipped surface; UNKNOWN for active
   ingestion; UNPROVEN. Do NOT infer cloud CPU from local elapsed time.
2. **"50 queries per Worker invocation" (Free) vs ingestion work:** the
   blocking measurement (§1). Per-invocation AND per-job aggregate work
   must both fit the documented row under BOTH unit interpretations; the
   current per-item classification growth makes that impossible for the
   advertised profile (single-job 110 attempts/211 statements; batch-10
   1001/1812; duplicate-heavy 100-item 210/311 — T-13/T-14/T-15/T-16).
   Fix path: DESIGN ONLY (`free-plan/FREE_SAFE_EXECUTION_DESIGN.md`);
   implementation is a future authorized round. **Cadence staggering is
   NOT a deterministic queue-batch bound** (backlog/outage can re-coalesce
   windows) and is retired as a mitigation (TR-06).
3. **Queues 10,000 ops/day during retries/DLQ storms:** bounded by
   `max_retries: 3` + durable backoff + durable retry scheduling (message
   consumed), but outage/reopen re-kick amplification and DLQ reconcile
   adds load; UNPROVEN. Components itemized in the worksheet.
4. **24 h Queue retention vs long outage:** D1 remains the durable truth
   and the application re-kick exists (TR-04, T-28); real-Queue expiry and
   recovery-after-real-outage remain LIVE-UNVERIFIED; operator procedure
   still required for the platform-side states the app cannot observe.
5. **Shared account usage:** the real account may host other Workers/D1/
   Queues consuming the SAME daily allowances; entitlement and remaining
   headroom are UNKNOWN to this audit.
6. **D1 storage growth:** `source_items` growth depends on the profile;
   per-row byte caps are CODE-FACT (title 512 / excerpt 512 / author 256 /
   raw_json ≤ 8 KB) but arrival rate, retention and index amplification
   are UNMEASURED — storage headroom is UNKNOWN (the "years of headroom"
   claim is withdrawn). Cleanup/rights retention is an owner decision
   (UNRESOLVED-DECISION).
7. **Time Travel 7 days (Free):** migration bookmark/restore drills must fit
   the window; restore mechanics LIVE-UNVERIFIED (see transition review).

## 8. Unknowns that block any stronger claim

- Account plan level, actual entitlement, current usage and shared workloads
  (owner-side).
- Real cron delivery cadence/jitter on Cloudflare (LIVE-UNVERIFIED).
- Real provider behavior (all connectors LIVE-UNVERIFIED — mock-only).
- Cloud-side per-invocation CPU, D1 `rows_read/rows_written` actuals, queue
  op actuals, and the actual enforcement of the 50-query row (require
  dashboard/analytics or approved measurement).
- Queues daily-allowance reset boundary (UNKNOWN by TR-06 discipline).
- Storage arrival/retention actuals (UNKNOWN).

## 9. Services NOT covered by Workers Free (explicit)

KV (`CACHE`), R2 (`MEDIA`), Workers AI (`AI`), and ALL external AI/media
providers (Gemini, Groq, YouTube API, Reddit, GitHub, IGDB, Bluesky) have
their OWN allowances/pricing. Nothing in this analysis assumes they are free
because Workers is Free. They are future-phase items with separate reviews
(`REMAINING_PRODUCT_WORK.md` caveats). Telegram Bot API calls are subject to
Telegram's own limits — not Cloudflare's.

## 10. Conservative PROPOSED Preview operating profile (values are PROPOSED)

**Nothing below is implemented or authorized; job/limit constants in code are
reviewed constants (NOT env-tunable) — the profile is chosen to live INSIDE
the shipped constants, and any change to constants is a future authorized
round.** All knobs are EITHER shipped config values (`max_retries`,
`max_batch_size` in `wrangler.jsonc`), registry source fields
(`interval_seconds`, `daily_request_budget`, item caps — data, reviewed at
seed time), OR operator vars already documented
(`SOURCE_INGESTION_ENABLED`, per-source `enabled`). No new env var is
claimed.

| Knob                                    | PROPOSED value                                                                                                        | Where it lives                       |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Enabled sources at first bounded window | **1** (the S-07 discipline: ONE low-volume RSS source)                                                                | `sources.enabled` (owner runbook)    |
| Cadence                                 | registry intervals (≥ 900 s); cron stays `*/5`                                                                        | registry seed (reviewed data)        |
| Staggering                              | registry intervals are naturally distinct; **explicitly NOT a deterministic batch bound** (§7.2)                      | registry data                        |
| Item cap                                | shipped reviewed constant (`maxItemsPerFeed = 100`)                                                                   | CODE-FACT                            |
| Consumer limits                         | unchanged: batch 10 / timeout 5 / retries 3                                                                           | `wrangler.jsonc` (shipped)           |
| Retry ceilings                          | engine backoff ladder + `max_retries: 3` + `daily_request_budget` per source                                          | CODE-FACT + registry                 |
| Provider requests                       | per-connector caps measured (T-17…T-21); counted per-hop against the source's Tehran-day budget                       | MEASURED-LOCAL caps × CHOSEN cadence |
| Expected queue ops                      | 3 ops × (polls/day) + retries + re-kicks + DLQ margin (components itemized, worksheet §3)                             | derived (worksheet)                  |
| Expected D1 daily                       | formula-driven from the corrected per-invocation measurements (worksheet §3); local estimates UNDERCOUNT cloud writes | derived (worksheet)                  |
| Account headroom                        | UNKNOWN — do not assume empty                                                                                         | §8                                   |

**This profile does NOT change the §1 verdict:** even at ONE enabled source,
a single supported 100-item poll exceeds the documented 50-query row under
both unit interpretations. The profile becomes discussable only together
with the accepted Free-safe design and its measurable acceptance criteria.

## 11. Approved-measurement plan (for the owner; nothing executed)

1. Confirm account plan + share the D1/Queues/Workers daily usage baseline
   (dashboard only; no credential sharing).
2. After Stage-5 deploy and BEFORE the Stage-8a window: run the Phase-A smoke,
   read the Workers/D1/Queues daily analytics for ONE full UTC day, and
   compare against §3/§5 expectations (worksheet formulas).
3. Stage-8a window with ONE source (§10); re-read analytics for one UTC day
   AND one Tehran budget day; record both clocks.
4. Only then re-assess §1 for the gate-OFF surface: UNPROVEN →
   PROVEN-FOR-SURFACE or NOT_READY (with the Free-safe design as the
   required path for ingestion). No paid upgrade, no fence weakening.

## 12. Fail-closed behavior under Free exhaustion (design alignment)

Documented exhaustion effects (OFFICIAL): D1 daily limits → queries FAIL with
explicit errors; storage full → inserts/DDL blocked; Queues daily ops
exhausted → deliveries stop; 24 h retention expires undelivered messages.
The accepted architecture's existing fail-closed mechanics align with
observable degradation: missing/failed D1 → retryable 503s, claims reclaimed
on recovery scans, `ingestion_capability_unresolved` stop/retry (R19-01),
bounded retries → durable retry_wait → dead_letter (T-26), gate flips are
lossless pauses (T-09), stranded-queued re-kick after outages (T-28), DLQ
reconciliation send with guarded confirmation (T-27). What remains open:
real-Queue expiry/receive evidence (LIVE-UNVERIFIED) and the Free-safe work
reduction itself (DESIGN ONLY, `free-plan/FREE_SAFE_EXECUTION_DESIGN.md`).

---

**Bottom line:** the shipped, gated-OFF preview surface is plausibly trivial
on Free resources (UNPROVEN until measured); the advertised ingestion
profile is **NOT_READY_FOR_INGESTION_ON_FREE** on measured local evidence —
a single supported 100-item poll alone issues 110 execution-API-call
attempts / 211 statements, above the documented Free 50-query row under
both unit interpretations — and the path forward is the Design-Only
Free-safe proposal, manager acceptance, then a narrowly scoped
implementation round. No paid upgrade, no quota bypass, no weakened fence,
no config change. **STOP for Posidon review.**
