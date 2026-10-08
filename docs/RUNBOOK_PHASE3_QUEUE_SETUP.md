# Phase 3 queue activation — operator runbook (Preview only)

This runbook activates the reviewed Phase 3 durable job/queue engine on the
Preview Worker (`pixel-preview`). It is an OPERATOR procedure: nothing in it
was executed by the implementation pass, and every step requires explicit
owner authorization. Production (`pixel`, `*-production` resources) remains
future-only until its own release gate.

Architecture and rationale: [ADR-0036](DECISIONS/adr-0036-job-queue-engine.md).
Status and verification numbers: `handoff/PHASE_03_JOB_QUEUE_HANDOFF.md`.

## Boundaries

- Only the resources this phase needs may be provisioned: TWO Cloudflare
  Queues (`pixel-jobs-preview`, `pixel-dlq-preview`) and one incremental D1
  migration (0003). No KV, R2, Workers AI, or production provisioning.
- The engine is FAIL-CLOSED (ADR-0036 §7): `JOBS_ENABLED=false` (current
  default everywhere) keeps cron and queue behavior identical to the
  Telegram-only Phase 2 deployment; enabled-but-misconfigured paths never
  dispatch and never acknowledge uncertain work.
- The only registered handler is the harmless maintenance heartbeat
  (`jobs.maintenance_heartbeat`, D1-only idempotent effect). No Telegram,
  AI, media, or publishing handlers exist in this phase.
- Secrets are never involved: the queue path uses no new secrets. Nothing in
  this runbook handles credential material.

## Step 1 — Apply the incremental migration (Preview D1)

The engine requires schema version 3 (migration `0003_job_dlq_delivery` —
adds `jobs.dlq_delivered_at` + `idx_jobs_dlq_pending`; ADR-0036 §6).
Migration 0003 is append-only and backward compatible; the Telegram ingress
is unaffected.

```bash
# Review pending migrations first (expect exactly 0003_job_dlq_delivery).
npm run db:migrations:list:preview
# Owner-approved remote application (explicit instruction required).
npm run db:migrations:apply:preview
```

Verify `/health/ready` on the preview Worker reports `ready` afterwards
(`SCHEMA_VERSION=3` is already part of this branch's configuration).

## Step 2 — Provision the two Preview queues

Using the Cloudflare dashboard or wrangler, as the owner:

1. Create queue `pixel-jobs-preview`.
2. Create queue `pixel-dlq-preview`.
3. The consumer is declared in `wrangler.jsonc` (preview env) with
   `dead_letter_queue: pixel-dlq-preview`, `max_retries: 3`,
   `max_batch_size: 10`, `max_batch_timeout: 5` — platform-level retries
   bound poison messages that the consumer could not settle; platform-DLQ
   deliveries require NO D1 reconciliation (expired-lease reclaim + cron
   re-dispatch converge on D1; ADR-0036 §4).

Do not change producer/consumer BINDING names: `JOBS` and `DLQ` are contract
(blueprint §4; ADR-0016 resource names).

## Step 3 — Deploy the reviewed branch to Preview

Deploy the accepted Phase 3 commit with `JOBS_ENABLED` still `"false"`
(default), then verify:

- `GET /health/live`, `GET /health/ready`, `GET /version` unchanged in shape
  (application version 1.3.0, schema version 3);
- Telegram owner commands still answer (`/start`, `/help`, `/status`,
  `/version`);
- Worker logs show the `*/5` cron trigger firing as `cron.triggered` with
  `cron.jobs_disabled` — the structured no-op (flag still off).

## Step 4 — Activate the engine (flag on)

Set the preview var `JOBS_ENABLED="true"` (wrangler vars or dashboard) and
redeploy/apply. The queue consumer registers with the deployed Worker at
this point.

## Step 5 — Harmless live verification job

Create ONE durable job through an owner-authorized channel (for example a
temporary, owner-only scheduled wrapper that calls the engine factory the
same way the entrypoints do — there is deliberately NO public smoke-test
endpoint). Suggested shape:

- `type`: `jobs.maintenance_heartbeat`
- `idempotency_key`: `heartbeat-<run identifier>` (deterministic)
- `payload`: `{}`

Expected end-to-end behavior (verify in D1 + logs):

1. The job row starts `pending`; the next cron pass (≤ 5 minutes) sends the
   bounded reference and marks it `queued`.
2. The consumer claims it (attempts → 1, 2-minute lease), executes the
   handler, and persists `succeeded` BEFORE acknowledging.
3. The settings key `jobs_maintenance:heartbeat` holds the run timestamp.
4. Re-sending the same reference (or a duplicate delivery) answers
   `duplicate_completed` with NO second durable effect.
5. Create the SAME `idempotency_key` with a different payload → the engine
   reports a conflict and the original row is unchanged.

## Step 6 — Verify recovery and duplicate behavior (before Phase 4)

- **Duplicate delivery:** re-deliver the reference of the succeeded job →
  ack `duplicate_completed`, zero handler executions.
- **Crash recovery:** create a job, claim it manually
  (`UPDATE jobs SET status='claimed', attempts=1, lease_until=<now+1000> …`
  as the owner), do nothing → the next cron pass after lease expiry reclaims
  it (`claimed → queued`), and the pass after the 60-second dispatch grace
  re-dispatches it; the job then completes normally.
- **Retry ownership:** a handler-forced retryable failure lands in
  `retry_wait` with a jittered `run_after`; no queue redelivery storm (the
  delivery is acked once the D1 schedule is persisted).
- **DLQ path:** force exhaustion (3 failed attempts) → the row is
  `dead_letter` with `last_error='job_exhausted'`; the next cron
  reconciliation sends the bounded safe reference to `pixel-dlq-preview`
  and stamps `dlq_delivered_at`. Inspect the DLQ queue for the reference
  (jobId/type/attempts/errorCode/failedAtMs ONLY).

## Step 7 — Operator replay (controlled, offline-documented)

Replay of a dead-lettered job is a deliberate D1 operation performed by the
owner with explicit generation rules:

1. Read the row; confirm it is terminal (`dead_letter`) and note
   `attempts` (the consumed generation count) and `last_error`.
2. Replay = a NEW job with a FRESH deterministic
   `idempotency_key` (`<original-key>:replay-<n>`) and the SAME canonical
   payload/type — never an in-place mutation of a terminal row. The new job
   enters the normal lifecycle with `attempts = 0` and its own full
   `max_attempts` budget.
3. Bounded limits: replay one job at a time; audit via the durable rows
   themselves (original stays `dead_letter` forever; replays are separate
   rows). No replay UI, no public endpoint, no automatic retries of
   dead-lettered work. (Live replay execution is NOT authorized in this
   implementation pass; this section documents the procedure for the
   activation slice.)

## Rollback

Set `JOBS_ENABLED="false"` and redeploy: cron returns to the structured
no-op, delivered messages are retried (never acked), and durable rows stay
recoverable. The Telegram-only deployment behavior is fully restored. The
`dlq_delivered_at` column and index are inert when the engine is off.
