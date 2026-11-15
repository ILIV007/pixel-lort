/**
 * ROUND 1.5 DESIGN LAB — executable design pipeline (PROPOSED DESIGN, NOT
 * product code). Nothing under `src/` imports this module.
 *
 * This module mirrors the DESIGN's specified insertion points 1:1 while
 * delegating every UNCHANGED mechanic to the accepted production stores:
 *   - dispatch pass: accepted `reclaimExpiredClaims` + design-filtered
 *     scans + accepted `markJobQueued`/`markJobDeadLetter`;
 *   - consume path: accepted `parseQueueEnvelope`/`parseJobPayload`/
 *     `claimJob`/`completeJob`/`markJobRetryWait`/`decideRetry` with the
 *     §B policy decision inserted BEFORE the atomic claim (the D01 fix);
 *   - poll execution: the ownership design (acquisition A1, ownership-
 *     fenced commit) over accepted budget stores.
 *
 * The product wiring (one insertion point each in engine.ts / scheduler.ts
 * / poll-handler.ts + the typePolicy port) is the SEPARATE later authorized
 * implementation round. This harness exists ONLY so the design's
 * end-to-end behavior is provable on real workerd D1 today.
 */
import type { DbExecutor } from '../../src/adapters/db/db-executor';
import type { IdGenerator } from '../../src/shared/ids/id';
import type { QueueEnvelope } from '../../src/domain/jobs/envelope';
import { parseQueueEnvelope } from '../../src/domain/jobs/envelope';
import { parseJobPayload, PAYLOAD_SCHEMAS } from '../../src/domain/jobs/payloads';
import type { JobHandlerRegistry, HandlerOutcome } from '../../src/domain/jobs/handler';
import type { JobErrorCode } from '../../src/domain/jobs/job-types';
import {
  claimJob,
  completeJob,
  markJobDeadLetter,
  markJobQueued,
  markJobRetryWait,
  type JobRow,
} from '../../src/adapters/db/job-store';
import {
  reconcileIngestionBudget,
  reserveIngestionBudget,
  readIngestionBudget,
} from '../../src/adapters/db/ingestion-budget-store';
import {
  decideRetry,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  type BackoffParams,
} from '../../src/domain/jobs/lifecycle';
import type { ConnectorFetchOutput, SourceConnector } from '../../src/connectors/contract';
import type { SourcesPollPayload } from '../../src/domain/jobs/payloads';
import { tehranBudgetDay } from '../../src/shared/time/tehran-day';
import type { Logger } from '../../src/observability/logger';
import {
  acquirePollOwnership,
  commitOwnedPollResults,
  readPollOwnership,
  type OwnedIngestItemRow,
} from './round15-ownership';
import {
  countPolicyPausedDue,
  isHandlerMisconfigured,
  isPausedByPolicy,
  policyExcludedTypes,
  reclaimExpiredClaimsPolicyAware,
  scanDueJobsPolicyFiltered,
  scanStrandedQueuedJobsPolicyFiltered,
  type PolicyGateState,
} from './round15-pause';

/** Lease duration mirror of the accepted engine bound. */
export const LAB_LEASE_MS = 2 * 60 * 1000;

/** Design dispatch summary — extends the accepted shape with pause counters. */
export interface DesignDispatchSummary {
  readonly dueScanned: number;
  readonly strandedScanned: number;
  readonly dispatched: number;
  readonly markedQueued: number;
  readonly sendFailures: number;
  readonly poisonedUnregistered: number;
  /** Misconfiguration poisons (distinct class — never a silent pause). */
  readonly misconfiguredPoisoned: number;
  /** Rows seen due but excluded by policy (no send, no write). */
  readonly policyPaused: number;
  readonly reclaimedLeases: number;
  readonly reclaimedExhausted: number;
  /**
   * ROUND 1.5.1 (B2): expired claimed rows of PAUSED types seen by the
   * recovery pass — observed, never selected, never mutated, never counted
   * against the active recovery page.
   */
  readonly pausedExpiredObserved: number;
}

/** What the queue entrypoint must do with one delivered message (accepted shape). */
export type DesignDeliveryAction =
  | { readonly action: 'ack'; readonly outcome: string }
  | { readonly action: 'retry'; readonly outcome: string; readonly delaySeconds?: number };

export interface DesignDispatchDeps {
  readonly executor: DbExecutor;
  readonly handlers: JobHandlerRegistry;
  /** JOBS producer port; `undefined` = binding missing (fail closed). */
  readonly producer?: { send(envelope: QueueEnvelope): Promise<void> };
  readonly idGenerator: IdGenerator;
  readonly nowMs: number;
  readonly gates: PolicyGateState;
  readonly dispatchBatch?: number;
  readonly reclaimBatch?: number;
  readonly dispatchGraceMs?: number;
  readonly logger?: Logger;
}

/** Deterministic merge of due + stranded candidates (accepted ordering). */
function mergeCandidates(
  due: readonly { id: string }[],
  stranded: readonly { id: string }[],
  full: ReadonlyMap<string, JobRow>,
  cap: number,
): JobRow[] {
  const byId = new Map<string, JobRow>();
  for (const row of due) {
    const fullRow = full.get(row.id);
    if (fullRow !== undefined) byId.set(row.id, fullRow);
  }
  for (const row of stranded) {
    if (!byId.has(row.id)) {
      const fullRow = full.get(row.id);
      if (fullRow !== undefined) byId.set(row.id, fullRow);
    }
  }
  return [...byId.values()]
    .sort((a, b) => {
      if (a.run_after !== b.run_after) return a.run_after - b.run_after;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, cap);
}

async function loadJobRows(
  executor: DbExecutor,
  ids: readonly string[],
): Promise<Map<string, JobRow>> {
  const map = new Map<string, JobRow>();
  for (const id of ids) {
    const row = await executor.first<JobRow>({
      sql: `SELECT id, type, aggregate_type, aggregate_id, status, priority, run_after,
                   attempts, max_attempts, lease_until, idempotency_key, payload_json,
                   last_error, created_at, updated_at, dlq_delivered_at
              FROM jobs WHERE id = ?`,
      params: [id],
    });
    if (row !== null) map.set(id, row);
  }
  return map;
}

/**
 * One design dispatch pass: policy-aware recovery + policy-filtered scans +
 * per-row decision (poison / misconfigured-poison / send). Paused rows NEVER
 * enter the candidate list (SQL exclusion) and NEVER consume recovery or
 * dispatch scan slots — they are counted separately (observability only).
 *
 * ROUND 1.5.1 (B2): the recovery pass is now POLICY-AWARE
 * (`reclaimExpiredClaimsPolicyAware`) — the pause policy is resolved BEFORE
 * any recovery candidate is selected or mutated. During OFF, paused-type
 * expired claims are neither requeued nor dead-lettered (the policy precedes
 * exhaustion handling in the recovery path) and never occupy the active
 * recovery page; enabled expired work is reached in the first page.
 */
export async function dispatchPassWithPolicy(
  deps: DesignDispatchDeps,
): Promise<DesignDispatchSummary> {
  const batch = deps.dispatchBatch ?? 25;
  const reclaimBatch = deps.reclaimBatch ?? 25;
  const graceMs = deps.dispatchGraceMs ?? 60_000;
  const excluded = policyExcludedTypes(deps.gates);

  const reclaim = await reclaimExpiredClaimsPolicyAware(
    deps.executor,
    deps.nowMs,
    reclaimBatch,
    excluded,
  );
  const due = await scanDueJobsPolicyFiltered(deps.executor, deps.nowMs, batch, excluded);
  const stranded = await scanStrandedQueuedJobsPolicyFiltered(
    deps.executor,
    deps.nowMs - graceMs,
    batch,
    excluded,
  );
  const policyPaused = await countPolicyPausedDue(deps.executor, deps.nowMs, excluded);

  const rows = await loadJobRows(deps.executor, [
    ...due.map((r) => r.id),
    ...stranded.map((r) => r.id),
  ]);
  const selected = mergeCandidates(due, stranded, rows, batch);

  let dispatched = 0;
  let markedQueued = 0;
  let sendFailures = 0;
  let poisonedUnregistered = 0;
  let misconfiguredPoisoned = 0;

  for (const row of selected) {
    // Unknown type: poison (accepted shipped behavior, unchanged).
    if (!PAYLOAD_SCHEMAS.has(row.type)) {
      const poisoned = await markJobDeadLetter(
        deps.executor,
        row.id,
        null,
        'job_type_unregistered',
        deps.nowMs,
      );
      if (poisoned) poisonedUnregistered += 1;
      continue;
    }
    // Defense in depth: the SQL filter already excluded paused types.
    if (isPausedByPolicy(row.type, deps.gates)) {
      continue;
    }
    // Misconfiguration: schema-known, no handler in THIS deployment, not
    // paused — a visible wiring bug, poisoned pre-claim with a DISTINCT code.
    if (isHandlerMisconfigured(row.type, deps.handlers, deps.gates)) {
      const poisoned = await markJobDeadLetter(
        deps.executor,
        row.id,
        null,
        'handler_misconfigured',
        deps.nowMs,
      );
      if (poisoned) misconfiguredPoisoned += 1;
      continue;
    }
    if (deps.producer === undefined) {
      // Fail closed: rows stay dispatchable (accepted semantics).
      sendFailures += 1;
      continue;
    }
    const envelope: QueueEnvelope = {
      version: 1,
      jobId: row.id,
      type: row.type,
      attempt: row.attempts + 1,
      traceId: deps.idGenerator.newId(),
    };
    try {
      await deps.producer.send(envelope);
    } catch {
      // Queue outage: the row REMAINS dispatchable; a later pass retries.
      sendFailures += 1;
      continue;
    }
    dispatched += 1;
    const marked = await markJobQueued(deps.executor, row.id, deps.nowMs);
    if (marked) markedQueued += 1;
  }

  return {
    dueScanned: due.length,
    strandedScanned: stranded.length,
    dispatched,
    markedQueued,
    sendFailures,
    poisonedUnregistered,
    misconfiguredPoisoned,
    policyPaused,
    reclaimedLeases: reclaim.reclaimed,
    reclaimedExhausted: reclaim.exhaustedToDeadLetter,
    pausedExpiredObserved: reclaim.pausedExpiredObserved,
  };
}

export interface DesignConsumeDeps {
  readonly executor: DbExecutor;
  readonly handlers: JobHandlerRegistry;
  readonly idGenerator: IdGenerator;
  readonly gates: PolicyGateState;
  readonly leaseMs?: number;
  readonly backoff?: BackoffParams;
  readonly retryHintMaxSeconds?: number;
  readonly random?: () => number;
  readonly logger?: Logger;
}

/**
 * One delivered-message resolution with the §B policy decision inserted
 * BEFORE the atomic claim (the D01 fix). Mirrors the accepted
 * `consumeMessage` decision table; every unchanged mechanic delegates to
 * the accepted production store functions.
 */
export async function consumeWithPolicy(
  deps: DesignConsumeDeps,
  messageId: string,
  body: unknown,
  nowMsInput?: number,
): Promise<DesignDeliveryAction> {
  const nowMs = nowMsInput ?? Date.now();
  const leaseMs = deps.leaseMs ?? LAB_LEASE_MS;
  const backoff = deps.backoff ?? {
    baseMs: DEFAULT_BACKOFF_BASE_MS,
    capMs: DEFAULT_BACKOFF_CAP_MS,
  };
  const retryHintMaxSeconds = deps.retryHintMaxSeconds ?? 3_600;
  const random = deps.random ?? (() => 0.5);
  try {
    // 1. Envelope validation (accepted).
    const parsed = parseQueueEnvelope(body);
    if (!parsed.ok) {
      return { action: 'ack', outcome: `poison_${parsed.reason}` };
    }
    const envelope = parsed.envelope;

    // 2. Durable row lookup (accepted).
    const row = await deps.executor.first<JobRow>({
      sql: `SELECT id, type, aggregate_type, aggregate_id, status, priority, run_after,
                   attempts, max_attempts, lease_until, idempotency_key, payload_json,
                   last_error, created_at, updated_at, dlq_delivered_at
              FROM jobs WHERE id = ?`,
      params: [envelope.jobId],
    });
    if (row === null) {
      return { action: 'ack', outcome: 'job_missing' };
    }

    // 3. Terminal / reserved rows (accepted).
    if (row.status === 'succeeded') return { action: 'ack', outcome: 'duplicate_completed' };
    if (row.status === 'dead_letter') return { action: 'ack', outcome: 'dead_lettered' };
    if (row.status === 'cancelled') return { action: 'ack', outcome: 'cancelled' };
    if (row.status === 'failed') return { action: 'ack', outcome: 'reserved_failed' };

    // 4. Payload validation BEFORE claiming (accepted).
    const payload = parseJobPayload(row.type, row.payload_json);
    if (!payload.ok) {
      const errorCode: JobErrorCode =
        payload.reason === 'unregistered_type' ? 'job_type_unregistered' : 'job_payload_invalid';
      const poisoned = await markJobDeadLetter(deps.executor, row.id, null, errorCode, nowMs);
      if (poisoned) {
        return { action: 'ack', outcome: `poisoned_${errorCode}` };
      }
      return { action: 'retry', outcome: 'poison_transition_lost' };
    }

    // 4.5 ★ DESIGN POLICY DECISION — BEFORE the claim, BEFORE any attempt
    //     burn, BEFORE any poison. Disabled-by-policy: acknowledge the
    //     delivery; the durable row stays exactly as it is (pending) and is
    //     resumed by the next dispatch pass once the gate is back ON.
    if (isPausedByPolicy(row.type, deps.gates)) {
      return { action: 'ack', outcome: 'paused_by_policy' };
    }
    // 4.6 Misconfiguration (distinct class — never a silent pause): the
    //     payload schema is known, the gate is NOT holding the type back,
    //     and THIS deployment has no handler. Pre-claim poison, visible.
    if (isHandlerMisconfigured(row.type, deps.handlers, deps.gates)) {
      const poisoned = await markJobDeadLetter(
        deps.executor,
        row.id,
        null,
        'handler_misconfigured',
        nowMs,
      );
      return poisoned
        ? { action: 'ack', outcome: 'poisoned_handler_misconfigured' }
        : { action: 'retry', outcome: 'poison_transition_lost' };
    }

    // 5. Atomic claim (accepted).
    const claim = await claimJob(deps.executor, envelope.jobId, nowMs, leaseMs);
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
        const remainingSeconds = Math.ceil((claim.runAfterMs - nowMs) / 1000);
        return {
          action: 'retry',
          outcome: 'not_due',
          delaySeconds: Math.min(retryHintMaxSeconds, Math.max(1, remainingSeconds)),
        };
      }
      case 'active_elsewhere':
        return { action: 'retry', outcome: 'active_elsewhere' };
      case 'budget_exhausted':
        return { action: 'ack', outcome: 'job_dead_lettered' };
      case 'claimed':
        return await executeClaimed(
          deps,
          row,
          claim.generation,
          payload.payload,
          messageId,
          nowMs,
          random,
          backoff,
        );
    }
  } catch {
    return { action: 'retry', outcome: 'consumer_error' };
  }
}

/** Execute a WON claim and persist the fenced terminal transition. */
async function executeClaimed(
  deps: DesignConsumeDeps,
  row: JobRow,
  generation: number,
  parsedPayload: unknown,
  messageId: string,
  nowMs: number,
  random: () => number,
  backoff: BackoffParams,
): Promise<DesignDeliveryAction> {
  const handler = deps.handlers.get(row.type);
  if (handler === undefined) {
    // Unreachable through the policy layer above (misconfiguration is
    // poisoned pre-claim); fail safe with the DISTINCT design code.
    const poisoned = await markJobDeadLetter(
      deps.executor,
      row.id,
      generation,
      'handler_misconfigured',
      nowMs,
    );
    return poisoned
      ? { action: 'ack', outcome: 'poisoned_handler_misconfigured' }
      : { action: 'retry', outcome: 'poison_transition_lost' };
  }

  let outcome: HandlerOutcome;
  try {
    outcome = await handler.execute({
      jobId: row.id,
      generation,
      payload: parsedPayload as never,
    });
  } catch {
    outcome = { kind: 'retry', reasonCode: 'job_internal_error' };
  }

  if (outcome.kind === 'success') {
    const completed = await completeJob(deps.executor, row.id, generation, nowMs);
    return completed
      ? { action: 'ack', outcome: 'job_completed' }
      : { action: 'retry', outcome: 'completion_fence_lost' };
  }
  if (outcome.kind === 'permanent') {
    const dead = await markJobDeadLetter(
      deps.executor,
      row.id,
      generation,
      outcome.reasonCode,
      nowMs,
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
      ? { ...backoff, retryAfterFloorMs: outcome.retryAfterMs }
      : backoff,
    random,
  );
  if (decision.kind === 'exhausted') {
    const dead = await markJobDeadLetter(deps.executor, row.id, generation, 'job_exhausted', nowMs);
    return dead
      ? { action: 'ack', outcome: 'job_dead_lettered' }
      : { action: 'retry', outcome: 'deadletter_fence_lost' };
  }
  const scheduled = await markJobRetryWait(
    deps.executor,
    row.id,
    generation,
    nowMs + decision.delayMs,
    outcome.reasonCode,
    nowMs,
  );
  return scheduled
    ? { action: 'ack', outcome: 'retry_scheduled' }
    : { action: 'retry', outcome: 'retry_schedule_not_persisted' };
}

/** Stub connector the lab injects (design-level; pacing functions differ). */
export type LabConnector = Pick<SourceConnector, 'preflight' | 'plannedRequestCount'> & {
  fetch(input: {
    sourceId: string;
    config: Record<string, unknown>;
    state: { etag: string | null; lastModified: string | null; cursor: string | null };
  }): Promise<ConnectorFetchOutput>;
};

export interface DesignPollHandlerDeps {
  readonly executor: DbExecutor;
  readonly connector: LabConnector;
  readonly idGenerator: IdGenerator;
  readonly nowMs: () => number;
  readonly secrets: (name: string) => string | undefined;
  readonly logger?: Logger;
}

/**
 * The DESIGN `sources.fetch_poll` handler: the accepted handler shape with
 * the ownership design inserted — acquisition + verification BEFORE any
 * network activity, and the ownership-fenced commit for every terminal
 * state write (items + state in ONE batch).
 */
export function createDesignPollHandler(deps: DesignPollHandlerDeps) {
  return {
    type: 'sources.fetch_poll' as const,
    async execute(context: {
      jobId: string;
      generation: number;
      payload: SourcesPollPayload;
    }): Promise<HandlerOutcome> {
      const { sourceId, scheduledForMs } = context.payload;
      const jobId = context.jobId;
      const generation = context.generation;

      const source = await deps.executor.first<{
        id: string;
        connector: string;
        enabled: number;
        interval_seconds: number;
        config_json: string;
        cursor: string | null;
        etag: string | null;
        last_modified: string | null;
        consecutive_failures: number;
      }>({
        sql: `SELECT s.id, s.connector, s.enabled, s.interval_seconds, s.config_json,
                     st.cursor, st.etag, st.last_modified, st.consecutive_failures
                FROM sources s JOIN source_state st ON st.source_id = s.id
               WHERE s.id = ?`,
        params: [sourceId],
      });
      if (source === null) {
        return { kind: 'permanent', reasonCode: 'ingestion_source_missing' };
      }
      if (source.enabled !== 1) {
        // Disabled between scheduling and execution: skip (accepted rule;
        // the hold self-heals the schedule on a later pass).
        return { kind: 'success' };
      }

      // ★ OWNERSHIP DESIGN (A1): acquire + verify BEFORE any network call.
      const acquisition = await acquirePollOwnership(deps.executor, {
        sourceId,
        jobId,
        scheduledForMs,
        generation,
        nowMs: deps.nowMs(),
      });
      if (acquisition.kind !== 'owned') {
        // The window was superseded, the owner is foreign, or the job lost
        // its claim between the claim and here (e.g. cancellation): the
        // handler performs NO network activity and no writes.
        return { kind: 'success' };
      }
      const ownership = await readPollOwnership(deps.executor, sourceId);
      if (ownership === null || ownership.ownerJobId !== jobId) {
        return { kind: 'success' };
      }
      const observedHoldUntilMs = ownership.nextPollAtMs;

      // Pre-flight (accepted shape, stub connector).
      let config: Record<string, unknown> = {};
      try {
        const parsedConfig: unknown = JSON.parse(source.config_json);
        if (
          parsedConfig !== null &&
          typeof parsedConfig === 'object' &&
          !Array.isArray(parsedConfig)
        ) {
          config = parsedConfig as Record<string, unknown>;
        }
      } catch {
        config = {};
      }
      const preflight = deps.connector.preflight(config, deps.secrets);
      if (!preflight.ok) {
        await commitOwned(deps, source, jobId, generation, observedHoldUntilMs, {
          status: 'failed',
          items: [],
          cursor: source.cursor,
          etag: source.etag,
          lastModified: source.last_modified,
          retryAfterSeconds: null,
          requestCount: 0,
          malformedCount: 0,
          failureReason: preflight.reason,
        });
        return { kind: 'success' };
      }

      // Atomic budget reservation BEFORE any network call (accepted store).
      const planned = Math.max(1, deps.connector.plannedRequestCount(config));
      const budget = await reserveIngestionBudget(deps.executor, {
        sourceId,
        count: planned,
        nowMs: deps.nowMs(),
      });
      if (budget.kind === 'source_missing') {
        return { kind: 'permanent', reasonCode: 'ingestion_source_missing' };
      }
      if (budget.kind === 'exhausted') {
        await commitOwned(deps, source, jobId, generation, observedHoldUntilMs, {
          status: 'failed',
          items: [],
          cursor: source.cursor,
          etag: source.etag,
          lastModified: source.last_modified,
          retryAfterSeconds: null,
          requestCount: 0,
          malformedCount: 0,
          failureReason: 'budget_exhausted',
        });
        return { kind: 'success' };
      }

      // ONE bounded connector fetch sequence (stub; failures surface here).
      let fetched: ConnectorFetchOutput;
      try {
        fetched = await deps.connector.fetch({
          sourceId,
          config,
          state: { etag: source.etag, lastModified: source.last_modified, cursor: source.cursor },
        });
      } catch {
        await commitOwned(deps, source, jobId, generation, observedHoldUntilMs, {
          status: 'failed',
          items: [],
          cursor: source.cursor,
          etag: source.etag,
          lastModified: source.last_modified,
          retryAfterSeconds: null,
          requestCount: 0,
          malformedCount: 0,
          failureReason: 'connector_unavailable',
        });
        return { kind: 'success' };
      }

      // Reconcile OBSERVED extra requests (accepted store).
      const extra = Math.max(0, fetched.requestCount - planned);
      if (extra > 0) {
        await reconcileIngestionBudget(deps.executor, {
          sourceId,
          extraCount: extra,
          nowMs: deps.nowMs(),
        });
      }

      await commitOwned(deps, source, jobId, generation, observedHoldUntilMs, fetched);
      return { kind: 'success' };
    },
  };
}

/** Design-level terminal mapping (simplified pacing; NOT the product ladder). */
async function commitOwned(
  deps: DesignPollHandlerDeps,
  source: {
    id: string;
    interval_seconds: number;
    cursor: string | null;
    etag: string | null;
    last_modified: string | null;
    consecutive_failures: number;
  },
  jobId: string,
  generation: number,
  observedHoldUntilMs: number,
  fetched: ConnectorFetchOutput,
): Promise<void> {
  const nowMs = deps.nowMs();
  const intervalMs = source.interval_seconds * 1000;
  const success = fetched.status === 'changed' || fetched.status === 'not_modified';
  const failures = success
    ? 0
    : fetched.failureReason !== null &&
        (fetched.failureReason === 'http_status_error' ||
          fetched.failureReason === 'http_timeout' ||
          fetched.failureReason === 'response_malformed' ||
          fetched.failureReason === 'unexpected_content_type')
      ? source.consecutive_failures + 1
      : source.consecutive_failures;

  let nextPollAtMs: number;
  if (fetched.retryAfterSeconds !== null) {
    nextPollAtMs = nowMs + Math.max(fetched.retryAfterSeconds * 1000, intervalMs);
  } else if (fetched.failureReason === 'budget_exhausted') {
    nextPollAtMs = nowMs + 10 * 60 * 1000;
  } else if (fetched.status === 'failed') {
    nextPollAtMs =
      nowMs + Math.min(30 * 60 * 1000, intervalMs * Math.pow(2, Math.min(failures, 4)));
  } else {
    nextPollAtMs = nowMs + intervalMs;
  }

  const lastError = success ? null : (fetched.failureReason ?? 'http_status_error');
  const requestsToday = await readIngestionBudget(deps.executor, { sourceId: source.id, nowMs });

  const itemRows: OwnedIngestItemRow[] = fetched.items.map((item) => ({
    id: deps.idGenerator.newId(),
    sourceId: source.id,
    externalId: item.externalId,
    canonicalUrl: item.canonicalUrl,
    title: item.title,
    excerpt: item.excerpt,
    author: item.author,
    publishedAtMs: item.publishedAtMs,
    fetchedAtMs: nowMs,
    contentHash: item.contentHash,
    rawJson: JSON.stringify(item.rawJson),
  }));

  await commitOwnedPollResults(deps.executor, {
    sourceId: source.id,
    jobId,
    generation,
    observedHoldUntilMs,
    items: itemRows,
    state: {
      cursor: fetched.cursor,
      etag: fetched.status === 'not_modified' ? source.etag : fetched.etag,
      lastModified: fetched.status === 'not_modified' ? source.last_modified : fetched.lastModified,
      nextPollAtMs,
      success,
      lastChangedAtMs: fetched.status === 'changed' ? nowMs : null,
      lastError,
      consecutiveFailures: failures,
      circuitOpenUntilMs:
        fetched.failureReason === 'credentials_rejected' ? nowMs + 30 * 60 * 1000 : null,
      requestsToday,
      budgetDate: tehranBudgetDay(nowMs),
    },
    nowMs,
  });
}
