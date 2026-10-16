# ADR-0040: Lossless policy pause for gated job types (the D01 contract)

- **Status:** Accepted after independent Round 1.6 review (local D01 implementation only; not deployment approval)
- **Phase:** 4 (Round 1.6; implements the independently accepted Round 1.5.1
  design `docs/reviews/PIXEL_ROUND1_5_1_OWNERSHIP_PAUSE_DESIGN.md` §5/§10.2)
- **Date:** 2026-10-16
- **Reviewed by:** Posidon, acting for Zeus (design independently accepted in Round 1.5.1; D01 product implementation independently verified in Round 1.6). No new owner approval, release, deployment or migration authorization is asserted.

## Context

`SOURCE_INGESTION_ENABLED` (ADR-0038 §1) gates ingestion: with the gate off,
the scheduler never runs and the `sources.fetch_poll` handler is never
registered. The shipped engine therefore treated a delivered poll message as
a schema-known type with NO handler and dead-lettered the durable job
(`job_type_unregistered` after one burned claim) — permanently poisoning
work that was merely policy-disabled (review finding D01). The Round 1.5
design and its Round 1.5.1 corrections (B2 — policy-aware recovery,
counterexamples CE2/CE3) specify the reviewed contract, which this round
transfers into the real engine/factory/database boundary on schema 3:

- Pause is an EXPLICIT policy: a type is disabled-by-policy only if it is
  listed in a code-defined enablement registry AND its gate is off.
  `PAYLOAD_SCHEMAS` membership or handler absence alone confers nothing.
- The pause must be LOSSLESS (no attempt burn, no poison, no DLQ, no
  rewrite, no reset, no terminal resurrection) and FAIR (paused rows never
  consume dispatch or recovery scan slots ahead of enabled work).
- Failure classes stay DISTINCT: unknown type → poison
  (`job_type_unregistered`, unchanged); schema-known + missing handler with
  the gate NOT holding the type → visible `handler_misconfigured` wiring-bug
  poison, never a silent pause; policy-mapped + gate off → pause, ALWAYS
  taking precedence over the misconfiguration probe.
- Scope guard: R09 ownership, R04, R10, observation history and migrations
  remain out of scope; applied migrations stay 0001–0003 (schema 3); app
  stays 1.4.0.

## Decision

### 1. Explicit enablement policy (`src/domain/jobs/policy.ts`)

`JOB_ENABLEMENT_POLICY` maps exactly one type today:
`sources.fetch_poll → gate 'ingestion_gate'`. A per-invocation gate
snapshot `JobsPolicyGates { ingestionGateOn }` is built by
`resolveJobsEngine` from the strictly parsed `SOURCE_INGESTION_ENABLED`
value and passed to `createJobsEngine` as `ports.policyGates`; the engine
never re-reads an environment variable. An engine constructed WITHOUT the
snapshot (offline harnesses and every accepted Phase 3/4 suite) behaves as
if every gate is ON, so no policy pause or scan exclusion is applied. This is NOT a claim of whole-engine byte-equivalence: the distinct handler_misconfigured behavior is intentionally new.

### 2. Consumer pause BEFORE the claim (the D01 fix)

In `consumeMessage`, after durable-row resolution, terminal/reserved
resolution and pre-claim payload validation, and BEFORE the atomic claim:

- 4.5 **paused** (`isPausedByPolicy(row.type, gates)`) → acknowledge
  `paused_by_policy` with ZERO durable writes: status, attempts, lease,
  schedule, payload and error/exhaustion information are byte-preserved.
  The decision uses the DURABLE row type — never the untrusted queue
  envelope type.
- 4.6 **misconfigured** (schema-known, handler missing, NOT paused) →
  pre-claim poison `dead_letter` / `handler_misconfigured` (new
  `JOB_ERROR_CODES` entry), guarded by the claimable statuses; ack
  `poisoned_handler_misconfigured` only after the durable write. The
  execute-claimed handler-missing backstop now carries the same distinct
  code (it is unreachable through the policy layer; kept as defense in
  depth).

### 3. Dispatch and recovery exclude paused types IN SQL

`scanDueJobs`, `scanStrandedQueuedJobs` and `reclaimExpiredClaims` accept an
`excludedTypes` list (default empty = byte-identical accepted SQL) and
filter `type NOT IN (…)` INSIDE the existing bounded, indexed, deterministically
ordered pages. Consequences, proven by tests:

- paused rows consume ZERO scan slots in the due page, the stranded page and
  the active recovery page — a page full of paused rows can never starve
  other types (dispatch fairness; recovery fairness — enabled expired claims
  are reached in the FIRST page);
- recovery is POLICY-FIRST: `countPolicyPausedExpiredClaims` (one COUNT
  aggregate, observability only; physical rows scanned are not bounded by its one-row result) runs before the recovery page, so the pause
  policy precedes every exhaustion/requeue decision; paused expired claims
  are neither requeued nor dead-lettered while the gate is off (dormant —
  claimed with an expired lease, attempts and `last_error` preserved);
- paused due work is counted by `countPolicyPausedDue` (observability only —
  a COUNT aggregate returns one row but does not bound rows scanned; the
  active pages stay LIMIT-bounded and exclude paused types).

### 4. Attempt economics (unchanged mechanics, now pause-safe)

Pauses happen pre-claim, so `attempts` never moves while a gate is off; a
row at `attempts = max_attempts − 1` can never be dead-lettered by pauses.
Recovery still NEVER writes `attempts`; guarded transitions are
byte-identical in shape to ADR-0037 (budget spent → `dead_letter` /
`job_exhausted` at the boundary; budget intact → `queued`). With the gate
back ON: eligible pending/retry work resumes through the bounded pages;
recovered claims first become `queued` and may wait the stranded-queue grace
(resume timing is state- and backlog-dependent — there is no unconditional
promise that every paused job dispatches on the first ON pass); genuinely
exhausted claims dead-letter through ordinary exhaustion exactly once;
already-terminal rows stay terminal. Unknown/misconfigured types are never
policy-excluded — they keep their ordinary visible paths.

### 5. Global disablement unchanged

`JOBS_ENABLED=false` / invalid configuration keep the exact fail-closed
semantics (cron structured no-op; delivered queue messages RETRIED, never
acknowledged). The ingestion gate OFF is this specific D01 pause policy — it
changes no other global engine or publishing behavior.

## Corrective note on ADR-0038 §1

The ADR-0038 §1 sentence "With the gate off, cron/queue behavior is
byte-identical to Phase 3 v1.3.1" is superseded on exactly ONE point: with
the gate off, delivered `sources.fetch_poll` messages are now acknowledged
`paused_by_policy` (and the paused type is excluded from dispatch/recovery
scans) instead of being dead-lettered. Every other gate-off mechanic
(scheduling skipped, poll handler unregistered, all Phase 3 lifecycle
semantics) is unchanged. The stale "in-flight poll jobs are poisoned safely"
rollback guidance in `docs/RUNBOOK_PHASE4_SOURCES.md` §2.9 is corrected
accordingly: rollback no longer poisons in-flight poll work; it is paused
losslessly and resumes when the gate returns.

## Consequences

- D01 is closed at product level on schema 3 with NO migration and NO new
  durable state: dormancy is the pre-existing `claimed`-with-expired-lease
  state; pausing performs no writes.
- `JOB_ERROR_CODES` gains exactly one authored constant
  (`handler_misconfigured`), safe to persist, log, and deliver in DLQ
  references.
- `DispatchSummary` gains honest counters (`misconfiguredPoisoned`,
  `policyPaused`, `pausedExpiredObserved`); the cron log reports them.
  `ReclaimExpiredResult` is shape-unchanged.
- Bounded-resumption honesty replaces the informal "gate off is
  byte-identical" claim; operators resume work by turning the gate on and
  letting the bounded pages drain.
- Out of scope and untouched: R09 ownership (no `source_state.poll_owner_job_id`,
  no partial unique index), R04, R10, observation history/D02, cancellation
  remediation (`job_cancelled_superseded` remains design material only),
  migrations, deployment, activation.
