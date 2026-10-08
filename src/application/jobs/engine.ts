/**
 * Durable jobs engine (Phase 3 — ADR-0036): application-layer orchestration
 * over the typed D1 boundary and queue PRODUCER ports.
 *
 * Ports are injected (executor, queue producers, handlers, clock, random,
 * logger) so every decision path is testable offline with controlled fakes.
 * The engine NEVER executes work in dispatch paths (cron only sends bounded
 * references) and NEVER acknowledges uncertain completion as success
 * (ADR-0036 §4 decision table).
 *
 * Crash-window design (ADR-0036 §3):
 * - Durable row FIRST (`pending`), reference second — an enqueue
 *   failure/uncertainty leaves a recoverable `pending`/`retry_wait` row for
 *   the bounded cron scan.
 * - The `queued` marker is written only AFTER the queue accepted the send
 *   and is guarded by dispatchable statuses; a marker alone can never strand
 *   work (grace-window re-kick).
 * - DLQ delivery is reconciled from durable state (`dlq_delivered_at IS
 *   NULL`), never from in-memory knowledge.
 *
 * Logging: stable event names, counts, and authored codes only — never
 * payloads, envelope bodies, SQL text, or error strings (AGENTS.md §3,
 * ADR-0017/0022).
 */
import type { Clock } from '../../shared/time/clock';
import type { IdGenerator } from '../../shared/ids/id';
import type { Logger } from '../../observability/logger';
import type { DbExecutor } from '../../adapters/db/db-executor';
import type { DlqProducerPort, JobsQueueProducerPort } from '../../adapters/queue/jobs-producer';
import {
  claimJob,
  completeJob,
  createJob,
  findJobById,
  markDlqDelivered,
  markJobDeadLetter,
  markJobQueued,
  markJobRetryWait,
  reclaimExpiredClaims,
  scanDueJobs,
  scanPendingDlqDeliveries,
  scanStrandedQueuedJobs,
  type JobRow,
} from '../../adapters/db/job-store';
import { isAppError } from '../../shared/errors/app-error';
import { parseQueueEnvelope, type QueueEnvelope } from '../../domain/jobs/envelope';
import {
  canonicalizeJson,
  CreateJobInputSchema,
  parseJobPayload,
  PAYLOAD_SCHEMAS,
  type CreateJobInput,
} from '../../domain/jobs/payloads';
import {
  decideRetry,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  type BackoffParams,
} from '../../domain/jobs/lifecycle';
import type { JobHandlerRegistry } from '../../domain/jobs/handler';
import type { JobErrorCode } from '../../domain/jobs/job-types';

/** Producer ports + infrastructure dependencies. */
export interface JobsEnginePorts {
  readonly executor: DbExecutor;
  readonly handlers: JobHandlerRegistry;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  /** Deterministic randomness for full-jitter backoff (tests inject fixed). */
  readonly random: () => number;
  readonly logger?: Logger;
  /** JOBS queue producer. Dispatch fails closed (recoverable) when absent. */
  readonly jobsProducer?: JobsQueueProducerPort;
  /** DLQ producer. Reconciliation skips sends (rows stay reconcilable) when absent. */
  readonly dlqProducer?: DlqProducerPort;
}

/** Engine bounds (ADR-0036 §1/§3/§4 — reviewed constants). */
export interface JobsEngineBounds {
  readonly leaseMs: number;
  readonly dispatchBatch: number;
  readonly dlqReconcileBatch: number;
  readonly reclaimBatch: number;
  readonly dispatchGraceMs: number;
  readonly backoff: BackoffParams;
  readonly retryHintMaxSeconds: number;
}

export const DEFAULT_ENGINE_BOUNDS: JobsEngineBounds = {
  leaseMs: 2 * 60 * 1000,
  dispatchBatch: 25,
  dlqReconcileBatch: 25,
  reclaimBatch: 25,
  dispatchGraceMs: 60 * 1000,
  backoff: { baseMs: DEFAULT_BACKOFF_BASE_MS, capMs: DEFAULT_BACKOFF_CAP_MS },
  retryHintMaxSeconds: 3_600,
};

/** What the queue entrypoint must do with one delivered message. */
export type DeliveryAction =
  | { readonly action: 'ack'; readonly outcome: string }
  | { readonly action: 'retry'; readonly outcome: string; readonly delaySeconds?: number };

export interface DispatchSummary {
  readonly dueScanned: number;
  readonly strandedScanned: number;
  readonly dispatched: number;
  readonly markedQueued: number;
  readonly sendFailures: number;
  readonly poisonedUnregistered: number;
  readonly reclaimedLeases: number;
}

export interface DlqReconcileSummary {
  readonly scanned: number;
  readonly delivered: number;
  readonly sendFailures: number;
  readonly producerMissing: boolean;
}

export type CreateDurableJobResult =
  | { readonly kind: 'created'; readonly jobId: string }
  | { readonly kind: 'existing'; readonly jobId: string }
  | { readonly kind: 'conflict'; readonly jobId: string }
  | {
      readonly kind: 'rejected';
      readonly reason:
        'invalid_input' | 'unregistered_type' | 'payload_too_large' | 'payload_invalid';
    };

export interface JobsEngine {
  /**
   * Idempotently create a durable job (durable-create-FIRST discipline).
   * The type must be REGISTERED (implemented handler + payload schema);
   * anything else is rejected at the door — unknown types must never enter
   * the durable pipeline (ADR-0036 §7). The payload is canonicalized and
   * size-bounded before insert.
   */
  createDurableJob(input: CreateJobInput): Promise<CreateDurableJobResult>;
  /** Bounded cron dispatch pass (recover + dispatch; no execution). */
  dispatchDueJobs(nowMs?: number): Promise<DispatchSummary>;
  /** Bounded dead-letter → DLQ reconciliation pass. */
  reconcileDeadLetters(nowMs?: number): Promise<DlqReconcileSummary>;
  /** Resolve one delivered queue message into an ack/retry action. */
  consumeMessage(messageId: string, body: unknown, nowMs?: number): Promise<DeliveryAction>;
}

export function createJobsEngine(
  ports: JobsEnginePorts,
  bounds: JobsEngineBounds = DEFAULT_ENGINE_BOUNDS,
): JobsEngine {
  const { executor, handlers, idGenerator, clock, random, logger } = ports;

  function logDebug(event: string, fields?: Record<string, unknown>): void {
    logger?.debug(event, fields);
  }

  function logWarn(event: string, fields?: Record<string, unknown>): void {
    logger?.warn(event, fields);
  }

  async function createDurableJob(input: CreateJobInput): Promise<CreateDurableJobResult> {
    const parsedInput = CreateJobInputSchema.safeParse(input);
    if (!parsedInput.success) {
      return { kind: 'rejected', reason: 'invalid_input' };
    }
    if (!PAYLOAD_SCHEMAS.has(parsedInput.data.type)) {
      return { kind: 'rejected', reason: 'unregistered_type' };
    }
    const payloadCheck = parseJobPayload(
      parsedInput.data.type,
      JSON.stringify(parsedInput.data.payload ?? {}),
    );
    if (!payloadCheck.ok) {
      return {
        kind: 'rejected',
        reason: payloadCheck.reason === 'payload_invalid' ? 'payload_invalid' : 'payload_too_large',
      };
    }
    let canonical: string;
    try {
      canonical = canonicalizeJson(parsedInput.data.payload ?? {});
    } catch {
      return { kind: 'rejected', reason: 'payload_invalid' };
    }
    if (canonical.length > 16_384) {
      return { kind: 'rejected', reason: 'payload_too_large' };
    }
    const result = await createJob(
      executor,
      {
        id: idGenerator.newId(),
        type: parsedInput.data.type,
        idempotencyKey: parsedInput.data.idempotencyKey,
        canonicalPayloadJson: canonical,
        priority: parsedInput.data.priority ?? 50,
        runAfterMs: parsedInput.data.runAfterMs ?? clock.now(),
        maxAttempts: parsedInput.data.maxAttempts ?? 3,
        aggregateType: parsedInput.data.aggregateType,
        aggregateId: parsedInput.data.aggregateId,
      },
      clock.now(),
    );
    if (result.kind === 'created') {
      logDebug('jobs.create.created');
    } else if (result.kind === 'existing') {
      logDebug('jobs.create.existing_idempotent');
    } else {
      logWarn('jobs.create.idempotency_conflict');
    }
    return result;
  }

  async function dispatchDueJobs(nowMsInput?: number): Promise<DispatchSummary> {
    const nowMs = nowMsInput ?? clock.now();

    // 1. Recover expired claims first (bounded) so stranded executions
    //    re-enter the dispatchable pool.
    const reclaimedLeases = await reclaimExpiredClaims(executor, nowMs, bounds.reclaimBatch);
    if (reclaimedLeases > 0) {
      logDebug('jobs.recover.leases_reclaimed', { count: reclaimedLeases });
    }

    // 2. Bounded, deterministic, indexed scans.
    const due = await scanDueJobs(executor, nowMs, bounds.dispatchBatch);
    const stranded = await scanStrandedQueuedJobs(
      executor,
      nowMs - bounds.dispatchGraceMs,
      bounds.dispatchBatch,
    );
    const selected = mergeDispatchCandidates(due, stranded, bounds.dispatchBatch);

    let dispatched = 0;
    let markedQueued = 0;
    let sendFailures = 0;
    let poisonedUnregistered = 0;
    let producerMissingReported = false;

    for (const row of selected) {
      // Fail-safe poison: an unregistered type can never execute in this
      // deployment — dead-letter it at the scan (no queue round trip, no
      // hot loop; DLQ reconciliation delivers the safe reference).
      if (!PAYLOAD_SCHEMAS.has(row.type)) {
        const poisoned = await markJobDeadLetter(
          executor,
          row.id,
          null,
          'job_type_unregistered',
          nowMs,
        );
        if (poisoned) {
          poisonedUnregistered += 1;
        }
        continue;
      }
      if (ports.jobsProducer === undefined) {
        // Fail closed: no dispatch, rows stay recoverable (pending/retry_wait).
        if (!producerMissingReported) {
          logWarn('jobs.dispatch.producer_missing');
          producerMissingReported = true;
        }
        sendFailures += 1;
        continue;
      }
      const envelope: QueueEnvelope = {
        version: 1,
        jobId: row.id,
        type: row.type,
        attempt: row.attempts + 1,
        traceId: idGenerator.newId(),
      };
      try {
        await ports.jobsProducer.send(envelope);
      } catch (error) {
        // Enqueue failed/unknown: the row REMAINS dispatchable (never marked
        // queued) and is re-dispatched by a later bounded scan (ADR-0036 §3).
        sendFailures += 1;
        logWarn('jobs.dispatch.enqueue_failed', {
          errorCode: isAppError(error) ? error.code : 'internal_error',
        });
        continue;
      }
      dispatched += 1;
      const marked = await markJobQueued(executor, row.id, nowMs);
      if (marked) {
        markedQueued += 1;
      }
      // A failed/absent marker is deliberately not an error: the row is
      // recoverable via the grace-window re-kick (window 2, ADR-0036 §3).
    }

    const summary: DispatchSummary = {
      dueScanned: due.length,
      strandedScanned: stranded.length,
      dispatched,
      markedQueued,
      sendFailures,
      poisonedUnregistered,
      reclaimedLeases,
    };
    logDebug('jobs.dispatch.pass', {
      dueScanned: summary.dueScanned,
      strandedScanned: summary.strandedScanned,
      dispatched: summary.dispatched,
      sendFailures: summary.sendFailures,
    });
    return summary;
  }

  async function reconcileDeadLetters(nowMsInput?: number): Promise<DlqReconcileSummary> {
    const nowMs = nowMsInput ?? clock.now();
    const pending = await scanPendingDlqDeliveries(executor, bounds.dlqReconcileBatch);
    let delivered = 0;
    let sendFailures = 0;
    let producerMissingReported = false;
    for (const row of pending) {
      if (ports.dlqProducer === undefined) {
        if (!producerMissingReported) {
          logWarn('jobs.dlq.producer_missing');
          producerMissingReported = true;
        }
        sendFailures += 1;
        continue;
      }
      try {
        await ports.dlqProducer.send({
          jobId: row.id,
          type: row.type,
          attempts: row.attempts,
          errorCode: row.last_error ?? 'job_exhausted',
          failedAtMs: row.updated_at,
        });
      } catch (error) {
        sendFailures += 1;
        logWarn('jobs.dlq.send_failed', {
          errorCode: isAppError(error) ? error.code : 'internal_error',
        });
        continue;
      }
      // Guarded confirmation: a crash between the send and this mark
      // produces ONE duplicate reference later — never a lost record.
      const confirmed = await markDlqDelivered(executor, row.id, nowMs);
      if (confirmed) {
        delivered += 1;
      }
    }
    return {
      scanned: pending.length,
      delivered,
      sendFailures,
      producerMissing: ports.dlqProducer === undefined,
    };
  }

  async function consumeMessage(
    messageId: string,
    body: unknown,
    nowMsInput?: number,
  ): Promise<DeliveryAction> {
    const nowMs = nowMsInput ?? clock.now();
    try {
      // 1. Envelope validation — poison MESSAGES are acked (retrying a
      //    message that can never parse only creates hot loops). The
      //    durable job (if any) remains recoverable: dispatch always sends
      //    FRESH envelopes.
      const parsed = parseQueueEnvelope(body);
      if (!parsed.ok) {
        return { action: 'ack', outcome: `poison_${parsed.reason}` };
      }
      const envelope = parsed.envelope;

      // 2. Durable row lookup — D1 owns type, lifecycle, attempts, schedule.
      const row = await findJobById(executor, envelope.jobId);
      if (row === null) {
        return { action: 'ack', outcome: 'job_missing' };
      }
      if (envelope.attempt !== row.attempts + 1) {
        // Informational anomaly only (ADR-0036 §5): a stale/forged envelope
        // can never override row values or bypass run_after.
        logDebug('jobs.msg.attempt_mismatch', { messageId });
      }

      // 3. Terminal / reserved rows: never executable, safe to acknowledge.
      if (row.status === 'succeeded') {
        return { action: 'ack', outcome: 'duplicate_completed' };
      }
      if (row.status === 'dead_letter') {
        return { action: 'ack', outcome: 'dead_lettered' };
      }
      if (row.status === 'cancelled') {
        return { action: 'ack', outcome: 'cancelled' };
      }
      if (row.status === 'failed') {
        return { action: 'ack', outcome: 'reserved_failed' };
      }

      // 4. Payload validation BEFORE claiming (poison jobs fail safe here;
      //    payload_json is immutable so the pre-claim parse is authoritative).
      const payload = parseJobPayload(row.type, row.payload_json);
      if (!payload.ok) {
        const errorCode: JobErrorCode =
          payload.reason === 'unregistered_type' ? 'job_type_unregistered' : 'job_payload_invalid';
        const poisoned = await markJobDeadLetter(executor, row.id, null, errorCode, nowMs);
        if (poisoned) {
          logWarn('jobs.msg.poisoned_job', { messageId });
          return { action: 'ack', outcome: `poisoned_${errorCode}` };
        }
        // Lost the guarded transition (a concurrent claim won): resolve as
        // transient pressure — the new owner or a later pass settles it.
        return { action: 'retry', outcome: 'poison_transition_lost' };
      }

      // 5. Atomic claim — one winner, one generation award.
      const claim = await claimJob(executor, envelope.jobId, nowMs, bounds.leaseMs);
      switch (claim.kind) {
        case 'job_missing':
          return { action: 'ack', outcome: 'job_missing' };
        case 'duplicate_completed':
          return { action: 'ack', outcome: 'duplicate_completed' };
        case 'dead_lettered':
          return { action: 'ack', outcome: 'dead_lettered' };
        case 'cancelled':
          return { action: 'ack', outcome: 'cancelled' };
        case 'reserved_failed':
          return { action: 'ack', outcome: 'reserved_failed' };
        case 'not_due': {
          // D1 owns the schedule; cron re-kicks when due. Retry keeps
          // delivery pressure without false success.
          const remainingSeconds = Math.ceil((claim.runAfterMs - nowMs) / 1000);
          return {
            action: 'retry',
            outcome: 'not_due',
            delaySeconds: Math.min(bounds.retryHintMaxSeconds, Math.max(1, remainingSeconds)),
          };
        }
        case 'active_elsewhere':
          return { action: 'retry', outcome: 'active_elsewhere' };
        case 'claimed':
          return executeClaimed(row, payload.payload, claim.generation, messageId, nowMs);
      }
    } catch (error) {
      // Storage failure or unexpected engine error: NEVER acknowledge —
      // preserve a recoverable delivery (redelivery or lease-expiry
      // reclaim settles it).
      logWarn('jobs.msg.consumer_error', {
        messageId,
        errorCode: isAppError(error) ? error.code : 'internal_error',
      });
      return { action: 'retry', outcome: 'consumer_error' };
    }
  }

  /** Execute a WON claim and persist the fenced terminal transition. */
  async function executeClaimed(
    row: JobRow,
    payload: unknown,
    generation: number,
    messageId: string,
    nowMs: number,
  ): Promise<DeliveryAction> {
    const handler = handlers.get(row.type);
    if (handler === undefined) {
      // Unreachable through createDurableJob (registration-checked) but
      // reachable for replayed/legacy rows: fail safe, no execution.
      const poisoned = await markJobDeadLetter(
        executor,
        row.id,
        generation,
        'job_type_unregistered',
        nowMs,
      );
      return poisoned
        ? { action: 'ack', outcome: 'poisoned_job_type_unregistered' }
        : { action: 'retry', outcome: 'poison_transition_lost' };
    }

    let outcome;
    try {
      outcome = await handler.execute({ jobId: row.id, generation, payload: payload as never });
    } catch {
      // Unexpected handler failure: transient internal error — reschedule
      // with backoff (never sleep, never blind-retry a permanent class).
      logWarn('jobs.msg.handler_threw', { messageId });
      outcome = { kind: 'retry', reasonCode: 'job_internal_error' } as const;
    }

    if (outcome.kind === 'success') {
      // Persist-before-ack: success is acknowledged ONLY after the fenced
      // terminal write durably landed.
      const completed = await completeJob(executor, row.id, generation, clock.now());
      return completed
        ? { action: 'ack', outcome: 'job_completed' }
        : { action: 'retry', outcome: 'completion_fence_lost' };
    }

    if (outcome.kind === 'permanent') {
      const dead = await markJobDeadLetter(
        executor,
        row.id,
        generation,
        outcome.reasonCode,
        clock.now(),
      );
      return dead
        ? { action: 'ack', outcome: 'job_dead_lettered' }
        : { action: 'retry', outcome: 'deadletter_fence_lost' };
    }

    const decision = decideRetry(
      'retryable',
      outcome.reasonCode,
      generation,
      row.max_attempts,
      outcome.retryAfterMs !== undefined
        ? { ...bounds.backoff, retryAfterFloorMs: outcome.retryAfterMs }
        : bounds.backoff,
      random,
    );
    if (decision.kind === 'exhausted') {
      const dead = await markJobDeadLetter(
        executor,
        row.id,
        generation,
        'job_exhausted',
        clock.now(),
      );
      return dead
        ? { action: 'ack', outcome: 'job_dead_lettered' }
        : { action: 'retry', outcome: 'deadletter_fence_lost' };
    }
    const scheduled = await markJobRetryWait(
      executor,
      row.id,
      generation,
      clock.now() + decision.delayMs,
      outcome.reasonCode,
      clock.now(),
    );
    return scheduled
      ? { action: 'ack', outcome: 'retry_scheduled' }
      : { action: 'retry', outcome: 'retry_schedule_not_persisted' };
  }

  return { createDurableJob, dispatchDueJobs, reconcileDeadLetters, consumeMessage };
}

/**
 * Merge due + stranded candidates deterministically:
 * `run_after ASC, priority DESC, id ASC`, deduplicated by id, capped.
 */
function mergeDispatchCandidates(
  due: readonly JobRow[],
  stranded: readonly JobRow[],
  cap: number,
): JobRow[] {
  const byId = new Map<string, JobRow>();
  for (const row of due) {
    byId.set(row.id, row);
  }
  for (const row of stranded) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()]
    .sort((a, b) => {
      if (a.run_after !== b.run_after) {
        return a.run_after - b.run_after;
      }
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, cap);
}
