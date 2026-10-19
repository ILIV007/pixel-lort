# PIXEL — Free-Plan Workload Worksheet (R1.10.2 — corrected units, rebuilt)

Purpose: separate **MEASURED** data (corrected-unit local traces),
**CHOSEN** scenario assumptions (labeled, not measurements), and
**UNKNOWN** live usage — with explicit formulas. Any estimate below is an
ESTIMATE, labeled as such; nothing here is presented as a cloud measurement
or a guaranteed zero-cost claim. Formulas use the documented official limits
(provenance: `FREE_PLAN_OFFICIAL_SOURCES.md`) and the corrected trace
numbers (`FREE_PLAN_RESOURCE_LEDGER.json` → `measuredLocal`, bound to
`audit-tools/logs/trace-run-r1102.log`).

**TR-06 corrections applied here:** the 2-item fixture is no longer
presented as a worst-supported cost; row-size bounds now come from the
actual source constants (title 512 / excerpt 512 / author 256 / raw_json
≤ 8 KB) with a separate stated ASSUMPTION SET; the "years of headroom"
storage claim is WITHDRAWN; single-invocation windows are separated from
aggregates (seed and due passes are traces T-07 and T-08, not one number);
cadence staggering is NOT treated as a deterministic queue-batch bound; the
Queue reset boundary is UNKNOWN, not asserted.

## 1. MEASURED (corrected-unit local traces — the only hard numbers this round)

Unit vocabulary (TR-01): **xAPI** = execution-API-call attempts
(terminal executions + batch calls); **STMT** = statements attempted
(terminal executions + batch statements); prepares are construction only and
are never part of either count. Every available result metadata record is
captured; unavailable metadata is labeled. Counts are TOOL measurements —
never added to the accepted suite's 1142.

| Trace | Window (ONE entrypoint each)                 | Sch (exp/applied) |                          xAPI |     STMT | prepares | batches | batch stmts | meta avail/unavail | Local meta r/w (est) | Notes                                                                              |
| ----- | -------------------------------------------- | ----------------- | ----------------------------: | -------: | -------: | ------: | ----------: | ------------------ | -------------------- | ---------------------------------------------------------------------------------- |
| T-01  | webhook noop update                          | 3/3               |                             2 |        2 |        2 |       0 |           0 | 2/0                | 4/5                  | claim INSERT + terminal                                                            |
| T-02  | webhook duplicate 2nd delivery (delta)       | 3/3               |                             2 |        2 |        2 |       0 |           0 | 1/0                | —                    | already_processed path                                                             |
| T-03  | webhook foreign /start, offline              | 3/3               |                             3 |        3 |        3 |       0 |           0 | 3/0                | —                    | claim BEFORE routing; 503 tokenless                                                |
| T-04  | webhook owner /start + transport             | 3/3               |                             3 |        3 |        3 |       0 |           0 | 3/0                | —                    | +1 scripted sendMessage                                                            |
| T-05  | webhook foreign /start + transport           | 3/3               |                             3 |        3 |        3 |       0 |           0 | 3/0                | —                    | +1 denial sendMessage; claim `processed`                                           |
| T-06  | cron idle, gate OFF                          | 3/3               |                             6 |        6 |        6 |       0 |           0 | 6/0                | 12/0                 | 0 envelopes                                                                        |
| T-07  | cron SEED pass (gate ON) — separate window   | 3/3               |                             9 |       36 |       36 |       1 |          28 | 36/0               | 116/16               | seeds 14, enabled=0, 0 jobs                                                        |
| T-08  | cron DUE pass (gate ON) — separate window    | 3/3               |                            11 |       11 |       11 |       0 |           0 | 11/0               | —                    | 1 durable job after enable-1                                                       |
| T-09  | queue batch of 10, gate OFF                  | 3/3               |                            10 |       10 |       10 |       0 |           0 | 10/0               | 10/0                 | 1 lookup/job; all `paused_by_policy`; 0 writes                                     |
| T-10  | ACTIVE poll, 0 new (304 not_modified)        | 4/4               |                            10 |       11 |       11 |       2 |           3 | 11/0               | —                    | zero classification probes (no items)                                              |
| T-11  | ACTIVE poll, 0 new (empty 200 → changed)     | 4/4               |                            10 |       11 |       11 |       2 |           3 | 11/0               | —                    | NOT `not_modified` (TR-03)                                                         |
| T-12  | ACTIVE poll, 2 new, 301→200                  | 4/4               |                            13 |       17 |       17 |       3 |           7 | 17/0               | —                    | 2 hops = 2 charged (R10)                                                           |
| T-13  | ACTIVE poll, **100 new**                     | 4/4               |                       **110** |  **211** |      211 |       2 |         103 | 211/0              | 416/713              | **exceeds documented Free 50 under BOTH readings**                                 |
| T-14  | ACTIVE poll, **100 duplicates**              | 4/4               |                       **210** |  **311** |      311 |       2 |         103 | 311/0              | —                    | 2 probes/duplicate; dedup absorbed all                                             |
| T-15  | ACTIVE poll, 50 new + 50 dup                 | 4/4               |                           160 |      261 |      261 |       2 |         103 | 261/0              | —                    | mixed-shape interpolation point                                                    |
| T-16  | ACTIVE **batch10** via ONE real handleQueue  | 4/4               |                      **1001** | **1812** |     1812 |      21 |         832 | 1812/0             | 3365/5031            | 7 RSS×100 + steam/YT/GitHub; all acked                                             |
| T-17  | RSS multi-feed bound + redirect              | 4/4               |                            19 |       29 |       29 |       5 |          15 | 29/0               | —                    | 4 raw requests (3 feeds + 1 redirect hop)                                          |
| T-18  | Steam multi-app bound                        | 4/4               |                            12 |       15 |       15 |       4 |           7 | 15/0               | —                    | 3 apps → 3 raw requests                                                            |
| T-19  | YouTube multi-playlist bound                 | 4/4               |                            14 |       19 |       19 |       4 |           9 | 19/0               | —                    | 2 playlists + 1 details call                                                       |
| T-20  | GitHub multi-repo bound                      | 4/4               |                            11 |       13 |       13 |       3 |           5 | 13/0               | —                    | 2 repos → 2 raw requests                                                           |
| T-21  | Reddit token + 2 listings                    | 4/4               |                            12 |       15 |       15 |       4 |           7 | 15/0               | —                    | 3 raw requests                                                                     |
| T-22  | provider failure (ordinary grant → throw)    | 4/4               |                            10 |       11 |       11 |       2 |           3 | 11/0               | —                    | 1 attempt, 0 completed, 1 charged; NOT late-auth evidence                          |
| T-23  | budget denied (budget=0)                     | 4/4               |                            11 |       12 |       12 |       2 |           3 | 12/0               | —                    | 0 raw fetches, 0 charged                                                           |
| T-24  | budget AUTHORITY failure (storage out)       | 4/4               | 8 (7 ok + **1 failed batch**) |        9 |        9 |       1 |           2 | 7/0                | —                    | typed retry; ZERO terminal ingestion writes; 0 raw                                 |
| T-25  | poison envelope (nonexistent job)            | 4/4               |                             1 |        1 |        1 |       0 |           0 | 1/0                | —                    | safe ack, no durable row                                                           |
| T-26  | bounded retries → dead_letter (per delivery) | 4/–1              |                             6 |        6 |        6 |       0 |           0 | 6/0                | —                    | applied = −1: metadata CORRUPTED BY FIXTURE (R19-01); terminal-row transition only |
| T-27  | cron DLQ reconciliation send                 | 4/–1              |                             7 |        7 |        7 |       0 |           0 | 7/0                | 14/2                 | 1 DLQ send + guarded `dlq_delivered_at` confirmation                               |
| T-28  | cron stranded re-kick of 25h-aged queued row | 4/4               |                             9 |        9 |        9 |       0 |           0 | 9/0                | —                    | SAME durable job id re-enqueued                                                    |

Cross-validation: T-13 (110/211) and T-16 (1001/1812) reproduce the
manager's independent controls (C2-100, C3) EXACTLY with the corrected
instrument — independent confirmation that the units are now right.

**Labels:** workerd/miniflare PROXY numbers. `changes`/`rows_*` meta is the
local engine's own estimate — `changes` ≠ billable `rows_written`; returned
rows ≠ `rows_read`. R1.10.3 correction: the cloud↔local relationship is
NOT measured — index amplification MAY make cloud `rows_written` higher,
but no unconditional cloud≥local (or undercount) claim is made; local
meta is kept as raw local evidence with full coverage labels. Local
elapsed wall time is NOT cloud CPU.

## 2. CHOSEN scenario assumptions (labeled; NOT measured)

| Assumption                    | Chosen value                                                                                           | Rationale                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| Enabled sources at activation | 1 (then owner-expanded)                                                                                | S-07 discipline; §10 conservative profile |
| Source interval               | ≥ 900 s (registry values)                                                                              | reviewed registry data                    |
| Cron cadence                  | */5 → 288 fires/day                                                                                    | shipped config (CODE-FACT)                |
| Items per new poll            | 0–100 (measured at 0/2/50/100 + duplicate shapes)                                                      | T-10…T-15                                 |
| Hops per poll                 | 1–3 (redirect counted)                                                                                 | T-12/T-17 measured                        |
| Connector request caps        | RSS ≤ 4; Steam ≤ 25; YT ≤                                                                              | playlists                                 | +1; GH ≤ 25; Reddit 1+ | subs |     | T-17…T-21 + CODE-FACT bounds |
| Queue batch occupancy         | **NOT deterministic** — backlog/outage re-coalesce windows; modeled as a scenario INPUT, never assumed | TR-06                                     |

## 3. Derived ESTIMATES (formulas; every input labeled)

Inputs: S = enabled sources; I = interval seconds; P = polls/day/source =
min(86400/I, 288); N = items/new-poll (shape input); D = duplicates/poll
(shape input); H = hops/poll; C = connector requests/poll (per-connector cap
from §1); B(N,D) = xAPI per poll ≈ **10 + N + 2D** (measured anchors:
N=0→10, N=2→13, N=100→110, D=100→210, 50/50→160; linear fit is an
approximation — the anchors are the evidence); W(N) = local writes/poll ≈
state row + item rows (local engine writes only; the cloud relationship
is NOT measured — see §1 labels);
Q = queue ops per delivery (≈3) + retry reads + re-kick sends.

- **Blocking verdict formula (NOT_READY_FOR_INGESTION_ON_FREE):** the
  documented Free row is 50 queries/invocation. max(xAPI, STMT) per
  SINGLE poll must be ≤ 50 under BOTH interpretations. Measured:
  N=100 → 110 xAPI / 211 STMT → **FAIL under both**. A batch of B poll
  jobs multiplies the per-invocation totals (B×10 gate-OFF is fine; the
  ACTIVE batch10 case measured 1001/1812). Queue-batch reduction cannot
  rescue the single-job row.
- **Workers requests/day** ≈ webhook(≤ owner traffic) + cron 288 + consumer
  invocations (≈ P×S ÷ batch occupancy — occupancy is a SCENARIO INPUT).
  vs 100,000/day: margin (ESTIMATE, paper).
- **Provider raw calls/day** = P×S×C (per-connector cap; T-17…T-21) →
  per-hop units charged against the source's Tehran-day budget (CODE-FACT,
  T-12).
- **Queue operations/day** ≈ P×S×Q + retry-reads + stranded re-kick sends
  (outage/reopen component: k×P×S during recovery windows; k UNKNOWN) +
  DLQ reconcile sends. vs 10,000/day: formula-only margin (ESTIMATE,
  UNPROVEN; reset boundary UNKNOWN).
- **D1 rows written/day** ≈ Σ polls×W(N) + retry/dead-letter bookkeeping +
  re-kick marker writes (LOCAL estimate; cloud billable equality OR
  inequality is NOT measured). vs 100,000/day: formula-only margin
  (ESTIMATE, UNPROVEN).
- **D1 rows read/day** ≈ cron 288×(6…36) + polls×(xAPI×rows/probe) + scans;
  scans count EXAMINED rows (OFFICIAL). vs 5,000,000/day: formula-only
  margin (ESTIMATE; EXPLAIN QUERY PLAN index proofs exist in the accepted
  suite, CODE-FACT).
- **D1 storage (UNKNOWN — no arrival/retention measurement):** per-row byte
  caps are CODE-FACT (title 512, excerpt 512, author 256, raw_json ≤ 8 KB,
  url/id/hash bounded); row byte size is an ASSUMPTION SET, not a
  measurement: bytes/day ≈ items/day × (assumed avg row bytes) + index
  bytes. The previous "≤1–2 KB row / years of headroom" claim is
  WITHDRAWN. Storage headroom stays UNKNOWN until the owner measures
  arrival/retention on the real DB.
- **CPU:** UNKNOWN — never inferred from local elapsed time.

## 4. Clocks (record EACH independently; never translate)

| Clock                              | Boundary                                | Status                     | Applies to                             |
| ---------------------------------- | --------------------------------------- | -------------------------- | -------------------------------------- |
| Cloudflare Workers/D1 daily quotas | **midnight UTC**                        | OFFICIAL                   | Workers requests, D1 rows read/written |
| Queues daily operations allowance  | **UNKNOWN reset boundary**              | UNKNOWN (TR-06 discipline) | queue ops                              |
| Queue message retention            | rolling **24 h** per message            | OFFICIAL                   | undelivered messages expire (Free)     |
| PIXEL provider budget day          | **Asia/Tehran day** (`tehranBudgetDay`) | CODE-FACT                  | per-source `budgets` rows              |
| Time Travel window                 | rolling **7 days** (Free)               | OFFICIAL                   | bookmark/restore drills                |

## 5. UNKNOWN (blocks stronger claims)

- Account plan, entitlement, remaining allowance, other workloads sharing the
  account (owner-side only).
- Cloud-side CPU per invocation, actual D1 row counters, actual queue op
  counters, actual enforcement of the 50-query row (dashboard/analytics or
  the approved measurement plan, `FREE_PLAN_COMPATIBILITY.md` §11).
- Real provider behavior (all connectors LIVE-UNVERIFIED).
- Queues allowance reset boundary.
- Storage arrival/retention actuals.

## 6. Honesty checklist (verified this edition)

- [x] Corrected units everywhere: prepares ≠ executions; xAPI = terminal +
      batches; STMT = terminal + batch statements (TR-01).
- [x] Manager's independent measurements reproduced exactly (T-13↔C2-100,
      T-16↔C3).
- [x] 0/2/100 + duplicate-heavy + batch10 + per-connector caps all measured;
      no 2-item generalization (TR-02/TR-06).
- [x] No Paid allowance or monthly-paid example applied to Free.
- [x] No fabricated production p95 or cloud CPU number.
- [x] Local traces labeled PROXY; `changes` never relabeled as billable rows.
- [x] Per-invocation vs per-job distinguished (single-poll traces vs T-16).
- [x] Batch size 10 ≠ 1 queue operation (official semantics quoted).
- [x] UTC vs Tehran clocks separated; Queue reset boundary UNKNOWN.
- [x] External AI/media services NOT assumed free.
- [x] Estimates labeled ESTIMATE; storage headroom UNKNOWN (claim withdrawn).
- [x] Cadence staggering NOT presented as a deterministic batch bound.

## 7. R1.10.3(+R1.10.3.1) addition — FIRST-profile DESIGN-LAB rows (MEASURED, distinct from §1/§3)

The R1.10.2 §1 rows (T-01…T-28) remain the accepted REAL-PATH baselines
for the ADVERTISED profile — the NOT_READY verdict for that profile is
unchanged. The rows below are DESIGN-LAB measurements of the R1.10.3
CANDIDATE on the FIRST proposed Free preview profile (ONE single-feed RSS
source, batch 1, 100-item bound, all hops counted; other connectors OFF
in the PROPOSED profile — no config applied). Units: corrected v3 LOCAL
proxy counts (failed-batch statements NOT completed). Source:
`design-lab/cost-ledger.json`; honesty labels in `design-lab/README.md`.

| Row  | Scenario (profile, schema, items, hops)                    | xAPI | STMT   | vs §3 formula                                                                                                  |
| ---- | ---------------------------------------------------------- | ---- | ------ | -------------------------------------------------------------------------------------------------------------- |
| C-02 | owned candidate, 100 new, 1 hop                            | 15   | 29     | measured; the §3 B(N,D) formula applied ONLY to the accepted per-item path — do NOT reuse it for the candidate |
| C-04 | owned candidate, 100 dup-url (worst probes), 1 hop         | 15   | 29     | measured                                                                                                       |
| C-06 | owned candidate, 100 new MAX content bytes, 1 hop          | 15   | 29     | measured (URL shape at the ~2 KiB documented assumption)                                                       |
| C-07 | owned candidate, 100 new, 3 hops                           | 17   | 33     | measured                                                                                                       |
| C-12 | legacy candidate, 100 new, 1 hop                           | 14   | 27     | measured                                                                                                       |
| C-14 | legacy candidate, 100 new, 3 hops                          | 16   | 31     | measured                                                                                                       |
| C-15 | owned candidate, 100 new ≈45 KB CJK canonical URLs, 1 hop  | 15   | **66** | measured — **STMT target ≤40 FAILS: NOT_READY evidence (R1.10.3.1)**                                           |
| C-16 | legacy candidate, 100 new ≈45 KB CJK canonical URLs, 1 hop | 14   | **65** | measured — **STMT target ≤40 FAILS: NOT_READY evidence (R1.10.3.1)**                                           |
| C-10 | ACCEPTED baseline (per-item), 100 new, 1 hop               | 109  | 210    | reconciles to T-13 (110/211) with the 1-call queue-envelope residual documented                                |

**CONDITIONAL measured scenario (RELABELED R1.10.3.1 — not a universal
bound):** 18 xAPI / 34 STMT (candidate worst C-07 + T-13 residual) is
valid ONLY for fixture URL shapes at the ~2 KiB documented assumption.
The accepted normalizer enforces NO canonical-URL length cap: 100 items
with 5000-char CJK paths normalize to ≈45,023-byte canonical URLs INSIDE
the unchanged 2 MiB RSS envelope, and the conservative combined-byte
policy then needs 2 rows/statement → 50 INSERT statements ALONE
(C-15/C-16 measured) → for the UNCHANGED supported RSS envelope the
candidate is **NOT_READY against BOTH ≤40 targets**. Exact blocker,
platform-limit justification (the combined SQL-text-plus-binds policy is
an internal conservative margin, NOT the documented SQL-TEXT row), and
the durable continuation design:
`free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §9. CPU/live quotas/account
headroom stay UNKNOWN (§5). Free-only path; no paid features.
