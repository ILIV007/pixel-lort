/**
 * Engine construction from the Worker environment (Phase 3 — ADR-0036 §7;
 * activation gating tightened by ADR-0037; Phase 4 ingestion gate by
 * ADR-0038 §1).
 *
 * Fail-closed activation:
 * - `JOBS_ENABLED` absent or 'false' → `disabled` (the exact Telegram-only
 *   behavior is preserved; cron logs only, delivered queue messages are
 *   retried — never acknowledged — so no uncertain work is dropped).
 * - ANY present-but-invalid `JOBS_ENABLED` value → `config_invalid`
 *   (validation runs BEFORE the flag is read — an invalid flag is never
 *   silently treated as disabled).
 * - Enabled WITHOUT the D1 binding or EITHER queue binding (`JOBS`/`DLQ`)
 *   → `config_invalid`: an enabled engine must never half-run. Dispatch
 *   without `JOBS` and DLQ reconciliation without `DLQ` would silently
 *   strand durable work; readiness reports not_ready (503) until the
 *   operator runbook completes (provision queues, bind, set the flag).
 *   Tests and offline harnesses that need a producer-less engine construct
 *   `createJobsEngine` directly instead of going through the environment.
 *
 * Phase 4 ingestion gate (ADR-0038 §1; pause semantics corrected by
 * Round 1.6 ADR-0040):
 * - `SOURCE_INGESTION_ENABLED` is validated whenever PRESENT (invalid
 *   values → `config_invalid`, never silently ignored).
 * - The gate controls ONLY ingestion: with the gate OFF no poll handler is
 *   registered and no scheduling runs. The strictly parsed gate is ALSO
 *   passed to the engine as the per-invocation `policyGates` snapshot, so
 *   `sources.fetch_poll` work is LOSSLESSLY PAUSED (ADR-0040): delivered
 *   poll messages are acknowledged `paused_by_policy` pre-claim (durable
 *   row, attempts, lease and exhaustion information preserved exactly),
 *   and the dispatch/recovery scans exclude the paused type IN SQL. This
 *   is the corrective D01 behavior — the earlier "byte-identical to Phase 3
 *   v1.3.1" gate-off claim (ADR-0038 §1) is superseded on exactly this
 *   point; every other Phase 3 mechanic is unchanged.
 * - Ingestion enabled while the jobs engine is disabled/invalid →
 *   `ingestion_requires_jobs` (fail closed — ingestion can never run
 *   half-wired).
 * - Ingestion enabled with an INVALID registry catalog → `config_invalid`
 *   (fail safe, ADR-0038 §2).
 */
import type { Logger } from '../../observability/logger';
import type { WorkerEnv } from '../../shared/types/env';
import { createDbExecutor } from '../../adapters/db/db-executor';
import {
  createJobsQueueProducer,
  createDlqQueueProducer,
} from '../../adapters/queue/jobs-producer';
import { systemClock, type Clock } from '../../shared/time/clock';
import { cryptoIdGenerator } from '../../shared/ids/id';
import { parseJobsConfig } from '../../shared/config/phase3';
import { parseIngestionConfig } from '../../shared/config/phase4';
import { parseEmbeddedRegistry } from '../../domain/source/source-registry';
import { createJobHandlerRegistry } from '../../domain/jobs/handler';
import { createJobsEngine, DEFAULT_ENGINE_BOUNDS, type JobsEngine } from './engine';
import { createMaintenanceHeartbeatHandler } from './handlers/maintenance-heartbeat';
import { createSourcePollHandler } from '../ingestion/poll-handler';
import { createConnectorRegistry } from '../../connectors/registry';
import { createSafeFetch } from '../../shared/http/safe-http';

export type EngineResolution =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'config_invalid'; readonly issues: readonly string[] }
  | { readonly kind: 'ready'; readonly engine: JobsEngine; readonly ingestionEnabled: boolean };

/**
 * Resolve the jobs engine (and, when gated on, the ingestion handler set)
 * for the current environment. Registered handlers are wired HERE (exactly
 * the implemented set); later phases extend this factory together with the
 * registry.
 */
export function resolveJobsEngine(env: WorkerEnv, logger?: Logger): EngineResolution {
  const { config, result } = parseJobsConfig(env as Readonly<Record<string, unknown>>);
  // Validation runs BEFORE the flag is read (ADR-0037): a present-but-
  // invalid value is a configuration error — never silently disabled.
  if (!result.ok) {
    return {
      kind: 'config_invalid',
      issues: result.issues.map((issue) => `${issue.field}:${issue.reason}`),
    };
  }
  // Phase 4 flag is validated whenever present (ADR-0038 §1).
  const ingestion = parseIngestionConfig(env as Readonly<Record<string, unknown>>);
  if (!ingestion.result.ok) {
    return {
      kind: 'config_invalid',
      issues: ingestion.result.issues.map((issue) => `${issue.field}:${issue.reason}`),
    };
  }
  if (!config.JOBS_ENABLED) {
    if (ingestion.config.SOURCE_INGESTION_ENABLED) {
      return {
        kind: 'config_invalid',
        issues: ['ingestion_requires_jobs'],
      };
    }
    return { kind: 'disabled' };
  }
  if (env.DB === undefined) {
    return { kind: 'config_invalid', issues: ['DB:missing_binding'] };
  }
  // An ENABLED engine fails closed without BOTH queue bindings (ADR-0037):
  // dispatch needs `JOBS` and dead-letter reconciliation needs `DLQ` — a
  // missing producer would strand durable work behind a "ready" banner.
  const missingBindings: string[] = [];
  if (env.JOBS === undefined) {
    missingBindings.push('JOBS:missing_binding');
  }
  if (env.DLQ === undefined) {
    missingBindings.push('DLQ:missing_binding');
  }
  if (missingBindings.length > 0) {
    return { kind: 'config_invalid', issues: missingBindings };
  }
  const ingestionEnabled = ingestion.config.SOURCE_INGESTION_ENABLED;

  // Ingestion enabled → the registry catalog must validate (fail safe,
  // ADR-0038 §2); a broken catalog never half-runs.
  if (ingestionEnabled) {
    const registry = parseEmbeddedRegistry();
    if (!registry.ok) {
      return {
        kind: 'config_invalid',
        issues: ['SOURCE_INGESTION:registry_invalid'],
      };
    }
  }

  const clock: Clock = systemClock;
  const executor = createDbExecutor(env.DB, { logger, clock });
  const handlers = [
    createMaintenanceHeartbeatHandler({ executor, nowMs: () => clock.now() }) as never,
  ];
  if (ingestionEnabled) {
    handlers.push(
      createSourcePollHandler({
        executor,
        connectors: createConnectorRegistry(),
        safeFetch: createSafeFetch(globalThis.fetch.bind(globalThis)),
        idGenerator: cryptoIdGenerator,
        secrets: (name: string) => (env as Record<string, unknown>)[name] as string | undefined,
        nowMs: () => clock.now(),
        random: Math.random,
        logger,
      }) as never,
    );
  }
  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry(handlers),
      idGenerator: cryptoIdGenerator,
      clock,
      random: Math.random,
      logger,
      jobsProducer: createJobsQueueProducer(env.JOBS as Queue<unknown>),
      dlqProducer: createDlqQueueProducer(env.DLQ as Queue<unknown>),
      // Round 1.6 (ADR-0040): the strictly parsed, strictly per-invocation
      // gate snapshot — the engine never re-reads an environment variable.
      policyGates: { ingestionGateOn: ingestionEnabled },
    },
    DEFAULT_ENGINE_BOUNDS,
  );
  return { kind: 'ready', engine, ingestionEnabled };
}
