/**
 * Job handler port and registry (Phase 3 — ADR-0036 §7).
 *
 * A handler is a pure application-level port: no Cloudflare types, no queue
 * types, no HTTP. It receives the ALREADY-VALIDATED payload and returns a
 * structured outcome; unexpected throws are classified by the engine as
 * transient (`job_internal_error`) and rescheduled with backoff.
 *
 * Only IMPLEMENTED handler types are registered (ADR-0036 §7). The registry
 * is deliberately explicit — no fake handlers for later phases.
 */
import type { JobErrorCode, JobType } from './job-types';

/** Outcome of one handler execution. */
export type HandlerOutcome =
  | { readonly kind: 'success' }
  | { readonly kind: 'retry'; readonly reasonCode: JobErrorCode; readonly retryAfterMs?: number }
  | { readonly kind: 'permanent'; readonly reasonCode: JobErrorCode };

/** Execution context handed to handlers (no runtime/SDK types). */
export interface JobExecutionContext<P> {
  /** Durable job id (reference only). */
  readonly jobId: string;
  /** Awarded execution generation (`attempts` after the atomic claim). */
  readonly generation: number;
  /** Validated, typed payload. */
  readonly payload: P;
}

/**
 * A registered job handler. `execute` MUST be idempotent (at-least-once
 * delivery, ADR-0032): duplicate executions may happen within the ambiguous
 * window and must not double external effects.
 */
export interface JobHandler<P = unknown> {
  readonly type: JobType;
  /** Executes the job. Must be bounded (no long-running work, no sleeps). */
  execute(context: JobExecutionContext<P>): Promise<HandlerOutcome>;
}

/** Registry contract used by the engine. */
export interface JobHandlerRegistry {
  /** Returns the handler for a type, or undefined when unregistered. */
  get(jobType: string): JobHandler<never> | undefined;
  /** All registered types (stable order; diagnostics only). */
  types(): readonly string[];
}

export function createJobHandlerRegistry(
  handlers: readonly JobHandler<never>[],
): JobHandlerRegistry {
  const byType = new Map<string, JobHandler<never>>();
  for (const handler of handlers) {
    if (byType.has(handler.type)) {
      throw new Error(`duplicate job handler registration: ${handler.type}`);
    }
    byType.set(handler.type, handler);
  }
  return {
    get: (jobType: string) => byType.get(jobType),
    types: () => [...byType.keys()],
  };
}
