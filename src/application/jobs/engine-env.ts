/**
 * Engine construction from the Worker environment (Phase 3 — ADR-0036 §7;
 * activation gating tightened by ADR-0037).
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
import { createJobHandlerRegistry } from '../../domain/jobs/handler';
import { createJobsEngine, DEFAULT_ENGINE_BOUNDS, type JobsEngine } from './engine';
import { createMaintenanceHeartbeatHandler } from './handlers/maintenance-heartbeat';

export type EngineResolution =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'config_invalid'; readonly issues: readonly string[] }
  | { readonly kind: 'ready'; readonly engine: JobsEngine };

/**
 * Resolve the jobs engine for the current environment. Registered handlers
 * are wired HERE (exactly the implemented set — the maintenance heartbeat);
 * later phases extend this factory together with the registry.
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
  if (!config.JOBS_ENABLED) {
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
  const clock: Clock = systemClock;
  const executor = createDbExecutor(env.DB, { logger, clock });
  const handlers = createJobHandlerRegistry([
    createMaintenanceHeartbeatHandler({ executor, nowMs: () => clock.now() }) as never,
  ]);
  const engine = createJobsEngine(
    {
      executor,
      handlers,
      idGenerator: cryptoIdGenerator,
      clock,
      random: Math.random,
      logger,
      jobsProducer: createJobsQueueProducer(env.JOBS as Queue<unknown>),
      dlqProducer: createDlqQueueProducer(env.DLQ as Queue<unknown>),
    },
    DEFAULT_ENGINE_BOUNDS,
  );
  return { kind: 'ready', engine };
}
