# ADR-0036: Durable job/queue engine — lifecycle, fencing, dispatch, retry, DLQ

- **Status:** Accepted
- **Phase:** 3 (job/queue framework and idempotency, blueprint §26 step 3)
- **Date:** 2026-10-08
- **Decided by:** Alexios

## Context

Phase 3 replaces the Phase-0 no-op cron/queue skeleton (ADR-0007/0011) with
the durable execution engine the blueprint defines (§1, §2, §7): D1 is the
source of truth for job state; Cloudflare Queues carry ONLY durable job
references; delivery is at-least-once (ADR-0032's honest semantics extend to
all job side effects). The existing `jobs` table (migration 0001) already
carries `id, type, aggregate_type, aggregate_id, status, priority, run_after,
attempts, max_attempts, lease_until, idempotency_key (UNIQUE), payload_json,
last_error, created_at, updated_at` with statuses `pending | queued |
claimed | succeeded | retry_wait | failed | dead_letter | cancelled`.

## Decision

### 1. Lifecycle and valid transitions (clock unit: epoch MILLISECONDS everywhere)

```
pending ──────────► queued ──────────► claimed ──────► succeeded   (terminal)
   ▲                   ▲                   │───────────► retry_wait ──► (due again: queued via dispatch)
   │                   │                   │───────────► dead_letter (terminal)
   │                   │                   │
cancelled (terminal)   └── stranded-queued recovery (grace expiry)
dead_letter (terminal)
failed  — RESERVED: never written by the Phase 3 engine (blueprint-valid
          status kept for forward compatibility; consumers treat an
          encountered `failed` row as non-executable and reconciliation
          ignores it; a future phase owning that status must document it)
```

- `pending → queued`: dispatch producer accepted the reference. Marker ONLY —
  never authoritative (window 2 below).
- `queued/retry_wait/pending → claimed`: ONE atomic claim; the claim awards
  execution generation `attempts + 1` and sets `lease_until = now + lease`.
  A `claimed` row whose lease has EXPIRED is ALSO atomically claimable by the
  next delivery (stale-owner recovery, mirroring ADR-0030) — recovery never
  depends on cron alone; the guarded reclaim admits exactly one winner and
  the stale owner's later mutations are rejected by the generation fence.
- `claimed → succeeded | retry_wait | dead_letter`: fenced terminal
  transitions (guard `status='claimed' AND attempts=<owned generation>`).
- `retry_wait → (dispatchable again when run_after <= now)`; `succeeded`,
  `dead_letter`, `cancelled` are NOT executable; an UNEXPIRED claimed lease is
  never stolen (claim precondition `lease_until IS NULL OR lease_until < now`).
- **Lease bounds:** `JOB_CLAIM_LEASE_MS = 2 minutes` — far above the bounded
  Phase 3 handler execution (pure D1 work, no external calls), far below any
  recovery horizon. **Lease renewal: NOT supported** — Phase 3 handlers are
  bounded D1-only operations; renewal would widen stale-owner windows for zero
  benefit. A future phase with genuinely long handlers must add fenced renewal
  in its own ADR. Boundary semantics tested at lease − 1 ms (active), exact
  expiry (stale), after expiry (stale), mirroring ADR-0030.
- **`attempts` is the fencing generation.** Claim = exactly one
  `attempts + 1` award; every owner-dependent mutation (complete, fail,
  retry, dead-letter) is guarded by the owned generation; a stale owner can
  never succeed, fail, extend or release a newer owner's job.

### 2. Idempotent creation

`createJob` INSERTs with a caller-supplied deterministic `idempotency_key`
(`src/shared/ids/idempotency-key.ts` primitives). On unique-constraint loss
the existing row is read and COMPARED (type + canonical payload):
compatible → `{kind:'existing'}` (idempotent); incompatible
(same key, different type or payload) → `{kind:'conflict'}` — the existing
job is NEVER silently overwritten. Payloads are stored canonically
(recursively key-sorted JSON) so comparison is byte-stable and bounded
(`JOB_PAYLOAD_MAX_BYTES = 16384`, enforced at create and re-checked before
execution).

### 3. Dispatch reconciliation — both uncertainty windows (blueprint §6 order)

D1 and Queues do not share a transaction; the durable job row is created
FIRST (status `pending`), then the reference `{version, jobId, type, attempt,
traceId}` is sent:

- **Persist ok, enqueue failed/unknown:** the row remains `pending`/`retry_wait`
  (never marked `queued`); the bounded cron scan re-dispatches due work. The
  failure is logged with a stable code only.
- **Enqueue ok, queued-marker write failed / process died:** the row stays
  `pending`/`retry_wait`; the delivered message still processes normally
  (duplicate suppression is the claim's job), and cron re-dispatch produces
  only harmless duplicate REFERENCES.
- **A `queued` marker alone cannot strand work:** rows marked `queued` whose
  `updated_at` has not transitioned within `JOB_DISPATCH_GRACE_MS = 60s`
  become dispatchable again (bounded re-kick). Duplicate deliveries that this
  creates are absorbed by claim fencing.
- **Overlapping cron / duplicate sends cannot create duplicate durable
  effects:** sending twice is at-least-once duplication of a REFERENCE; the
  atomic claim admits exactly one executing owner per generation.
- **Cron performs a bounded, indexed, deterministic scan only:** due
  `pending/retry_wait` rows (`run_after <= now`) via
  `idx_jobs_due(status, run_after, priority DESC)` ordered
  `run_after ASC, priority DESC, id ASC LIMIT JOB_DISPATCH_BATCH (25)`, plus a
  separate bounded scan for stranded `queued` rows. Cron NEVER executes
  handlers, never fetches sources, never calls AI, never publishes.

### 4. Consumer, retry ownership, ack/retry table (WP4)

D1 `run_after` is the SINGLE durable retry schedule authority; Queue
redelivery (`message.retry()`) is only delivery pressure, never a schedule.
One delivery = at most one claim attempt.

| Delivery situation                                                                  | Action                                                         | Rationale                                                                                                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Envelope fails Zod (shape/version≠1/bounds)                                         | **ack** (`jobs.msg.poison_envelope`)                           | No durable state can be located; retry can never succeed. The job row (if any) stays recoverable via cron re-dispatch with a FRESH envelope      |
| Job row missing                                                                     | **ack** (`jobs.msg.job_missing`)                               | Nothing to execute                                                                                                                               |
| Row `succeeded`                                                                     | **ack** (`jobs.msg.duplicate_completed`)                       | Terminal; duplicate suppression                                                                                                                  |
| Row `dead_letter` / `cancelled`                                                     | **ack** (`jobs.msg.dead_lettered` / `jobs.msg.cancelled`)      | Terminal; never executable                                                                                                                       |
| Row not yet due (`run_after > now`)                                                 | **retry** with bounded `delaySeconds` hint                     | D1 owns the schedule; cron re-kicks when due; ack would drop the last reference                                                                  |
| Unregistered `type`                                                                 | fenced `→ dead_letter` (`job_type_unregistered`), then **ack** | Poison JOB (not message): retrying forever would amplify; fail safe without fake handlers                                                        |
| Persisted payload corrupt/invalid                                                   | fenced `→ dead_letter` (`job_payload_invalid`), then **ack**   | Semantic permanent error — never blindly retried                                                                                                 |
| Active lease held elsewhere                                                         | **retry**                                                      | NOT a successful duplicate (ADR-0030 analogy); keeps pressure until the lease resolves                                                           |
| Claim won; handler success; fenced complete `true`                                  | **ack**                                                        | Durable success first (persist-before-ack)                                                                                                       |
| Handler returned retryable failure; fenced `retry_wait` write `true`                | **ack**                                                        | Schedule durably persisted in D1 (`run_after = now + backoff`); provider retries would only amplify                                              |
| Handler returned permanent failure; fenced `dead_letter` write `true`               | **ack** (+ bounded DLQ reference enqueued by reconciliation)   | Terminal state durable                                                                                                                           |
| Terminal/retry persistence returns `false` (lost fence) or THROWS (storage failure) | **retry**                                                      | NEVER acknowledge uncertain completion as success; never ack a schedule that was not persisted. Recoverable: redelivery or expired-lease reclaim |

- **Retry backoff:** bounded exponential with FULL jitter,
  `delay = randint(0, min(cap, base × 2^(attempt−1)))` then
  `max(delay, retry_after_floor)` when a provider floor applies;
  `base = 2s`, `cap = 1h`, clock and random injected (deterministic tests).
  Defaults: `max_attempts = 3`; the 5-attempt P0 publication policy is
  DOCUMENTED, not implemented (no publishing exists). Workers never sleep.
- **Exhaustion → dead_letter + DLQ:** the fenced exhaustion transition resets
  `dlq_delivered_at = NULL`; a bounded reconciliation scan sends a SAFE
  reference (`jobId, type, attempts, errorCode, failedAtMs` — no payload, no
  provider text, no credentials) to the DLQ producer and marks
  `dlq_delivered_at` guarded (`status='dead_letter' AND dlq_delivered_at IS
NULL`). Crash between send and mark → one duplicate DLQ reference later
  (at-least-once, safe); the record is never silently lost.
- **Platform DLQ (Cloudflare `max_retries`) vs application DLQ:** messages the
  CONSUMER could not settle (e.g. repeated storage failures) exhaust the
  platform retry budget and land in `pixel-dlq` via the platform path. That
  path performs NO D1 mutation — the row stays `claimed`/`retry_wait` and is
  recovered by expired-lease reclaim + cron re-dispatch (the queue message is
  only a reference; losing it can never lose the job). Application-level
  dead-letter rows are delivered to the SAME queue by the reconciliation
  scan. Both paths converge on D1 as the source of truth.

### 5. Envelope attempt semantics (WP2)

`envelope.attempt` is INFORMATIONAL: the execution generation the delivery is
EXPECTED to award (`row.attempts + 1` at send time, minimum 1 — the
blueprint counter starts at 1). The awarded execution generation is
EXCLUSIVELY the row's `attempts` after the atomic claim. A stale or forged
envelope can never override row values or bypass `run_after` (the claim
precondition enforces due-ness; the fenced mutations enforce generation).
Mismatching attempts are logged as a stable anomaly event and change
nothing.

### 6. Schema delta (migration 0003 — schema version 3)

The existing `jobs` table is sufficient for the lifecycle itself. ONE field
is genuinely missing: DLQ-delivery tracking. `dead_letter` rows must be
reconcilable ("did the DLQ reference get sent?") without re-sending every
dead-letter row forever. Migration 0003 (append-only; 0001/0002 untouched):

- `ALTER TABLE jobs ADD COLUMN dlq_delivered_at INTEGER;` — NULL = the bounded
  DLQ reference has not been confirmed enqueued; timestamp = confirmed.
- `CREATE INDEX idx_jobs_dlq_pending ON jobs(status, dlq_delivered_at);` —
  serves the bounded reconciliation scan (`status='dead_letter' AND
dlq_delivered_at IS NULL`). Reclaim/dispatch scans reuse `idx_jobs_due`;
  `claimed`/`queued` populations are bounded by lease/grace mechanics, so no
  additional lifecycle index is added. No hypothetical future tables.
- `schema_metadata.schema_version → 3`, `migration_id →
'0003_job_dlq_delivery'` inside the same atomic batch.

### 7. Handlers, contracts, activation (WP2/WP5)

- **Zod (ADR-0010)** validates the envelope (`src/domain/jobs/envelope.ts`)
  and every persisted payload before execution. Only IMPLEMENTED handler
  types are registered (`jobs.maintenance_heartbeat`); unknown types fail
  safe per §4. No fake handlers for later phases.
- **One harmless registered handler** proves the engine end-to-end:
  `jobs.maintenance_heartbeat` — payload `{ note?: string ≤ 200 }`; effect is
  an idempotent D1-only upsert of the `jobs_maintenance:heartbeat` settings
  key (last successful run timestamp). No Telegram, no AI, no public smoke
  endpoint.
- **Activation is fail-closed:** non-secret flag `JOBS_ENABLED` ('true' |
  'false', default 'false'). Disabled: cron logs only (Telegram-only behavior
  preserved exactly). Enabled-but-misconfigured (missing `JOBS`/`DLQ` binding
  or DB): no dispatch, no ack-all — the consumer answers `retry()` so no
  uncertain work is dropped, cron logs a stable config error. Production
  wrangler config is UNCHANGED (no queue bindings, no cron trigger change
  beyond the blueprint's */5 schedule); Preview declares producer `JOBS` →
  `pixel-jobs-preview`, consumer (same queue, `dead_letter_queue:
pixel-dlq-preview`, `max_retries: 3`, bounded batch 10/5s) and DLQ producer
  `DLQ` → `pixel-dlq-preview` — resources are provisioned by the operator
  runbook ONLY after review (offline pass creates nothing).

## Consequences

- At-least-once with duplicate suppression before execution; external side
  effects are NOT exactly-once (ADR-0032 wording applies to future
  publishing-side reconciliation — unchanged).
- Working Telegram commands remain synchronous; the framework is exercised
  ONLY by the harmless maintenance job (invariant: no refactoring for
  exercise).
- Duplicated DLQ references and duplicate job REFERENCES are bounded, safe,
  and documented; the durable effect is always single-owner.
- `failed` status stays reserved; future owners must ADR it.

## Verification highlights (Phase 3 suite)

- idempotent create / conflicting key / concurrent creation; claim races
  (one winner), strict due/lease boundaries (−1 ms, exact, +1 ms);
- crash-after-claim reclaim; stale-owner success/failure rejected without
  mutating the newer row; old-envelope delivery after a newer claim;
- durable-create-with-failed-enqueue and enqueue-with-failed-marker recovery;
  stranded-queued re-kick after grace; overlapping dispatch without duplicate
  durable effects; bounded cron batches; no handler execution in cron;
- backoff cap/jitter determinism, `retry_after` floor, exhaustion,
  permanent errors; complete/retry/dead-letter persistence false/throw never
  acked; DLQ send failure reconciliation; malformed envelope / unknown type /
  missing row / corrupt payload without hot loops;
- end-to-end create → dispatch → consume → durable success with duplicate
  delivery producing exactly one durable effect; feature-disabled and
  enabled-but-misconfigured paths preserve existing Telegram/health behavior;
  log assertions prove no payload/secret/provider leakage.
