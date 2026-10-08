/**
 * Engine construction from the Worker environment (Phase 3 — ADR-0036 §7).
 *
 * Fail-closed activation:
 * - `JOBS_ENABLED !== 'true'` → `disabled` (Telegram-only behavior
 *   preserved exactly; cron logs only, delivered queue messages are retried
 *   — never acknowledged — so no uncertain work is dropped).
 * - Enabled WITHOUT the D1 binding → `config_invalid` (the engine cannot
 *   run safely; nothing dispatches, nothing acks).
 * - Enabled with DB but missing queue producers → a `ready` engine whose
 *   dispatch/DLQ passes fail closed per send (stable logged codes, rows stay
 *   recoverable). This keeps local/test execution possible WITHOUT pointing
 *   at live Preview resources.
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
  if (!config.JOBS_ENABLED) {
    return { kind: 'disabled' };
  }
  if (!result.ok) {
    return {
      kind: 'config_invalid',
      issues: result.issues.map((issue) => `${issue.field}:${issue.reason}`),
    };
  }
  if (env.DB === undefined) {
    return { kind: 'config_invalid', issues: ['DB:missing_binding'] };
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
      jobsProducer:
        env.JOBS !== undefined ? createJobsQueueProducer(env.JOBS as Queue<unknown>) : undefined,
      dlqProducer:
        env.DLQ !== undefined ? createDlqQueueProducer(env.DLQ as Queue<unknown>) : undefined,
    },
    DEFAULT_ENGINE_BOUNDS,
  );
  return { kind: 'ready', engine };
}
