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
 *
 * Phase 5A editorial gate (ADR-0042 §3):
 * - `EDITORIAL_ENABLED` is validated whenever PRESENT (invalid values →
 *   `config_invalid`), is INDEPENDENT of the ingestion gate, and NEVER
 *   implies AI activation (`AI_ENABLED` stays its own fail-closed gate —
 *   with editorial ON and AI OFF, executions resolve the typed deferred
 *   `ai_disabled` retry path with zero provider calls).
 * - Editorial enabled while the jobs engine is disabled/invalid →
 *   `editorial_requires_jobs` (fail closed — the pipeline is a job type;
 *   it can never run half-wired).
 * - Editorial enabled with an INVALID AI configuration → `config_invalid`
 *   (the handler would be wired against a configuration the AI service
 *   rejects — fail safe before any execution).
 * - The handler is registered ONLY while the gate is ON; the strictly
 *   parsed flag also joins the per-invocation `policyGates` snapshot so
 *   gate-off work is LOSSLESSLY PAUSED (pre-claim `paused_by_policy`,
 *   scan exclusion IN SQL) — never unknown-type poison.
 */
import type { Logger } from '../../observability/logger';
import { createLogger } from '../../observability/logger';
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
import { parseEditorialConfig } from '../../shared/config/phase5';
import { parseAiConfig } from '../../shared/config/phase6';
import { parseEmbeddedRegistry } from '../../domain/source/source-registry';
import { createJobHandlerRegistry } from '../../domain/jobs/handler';
import { createJobsEngine, DEFAULT_ENGINE_BOUNDS, type JobsEngine } from './engine';
import { createMaintenanceHeartbeatHandler } from './handlers/maintenance-heartbeat';
import { createSourcePollHandler } from '../ingestion/poll-handler';
import { createEditorialPrepareDraftHandler } from '../editorial/prepare-draft-handler';
import { createAiDraftService } from '../ai/draft-service';
import { createEventRelationService } from '../ai/event-relation-service';
import { createWorkersAiAdapter } from '../../adapters/ai/workers-ai-adapter';
import { createConnectorRegistry } from '../../connectors/registry';

export type EngineResolution =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'config_invalid'; readonly issues: readonly string[] }
  | {
      readonly kind: 'ready';
      readonly engine: JobsEngine;
      readonly ingestionEnabled: boolean;
      readonly editorialEnabled: boolean;
    };

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
  // Phase 5A flag is validated whenever present (ADR-0042 §3).
  const editorial = parseEditorialConfig(env as Readonly<Record<string, unknown>>);
  if (!editorial.result.ok) {
    return {
      kind: 'config_invalid',
      issues: editorial.result.issues.map((issue) => `${issue.field}:${issue.reason}`),
    };
  }
  // Phase 6 AI flags are validated whenever PRESENT (ADR-0041 §3); the
  // editorial path consumes them for its handler wiring, so an invalid
  // AI configuration fails closed BEFORE the engine is built.
  const ai = parseAiConfig(env as Readonly<Record<string, unknown>>);
  if (!ai.result.ok) {
    return {
      kind: 'config_invalid',
      issues: ai.result.issues.map((issue) => `${issue.field}:${issue.reason}`),
    };
  }
  if (!config.JOBS_ENABLED) {
    const requiresJobs: string[] = [];
    if (ingestion.config.SOURCE_INGESTION_ENABLED) {
      requiresJobs.push('ingestion_requires_jobs');
    }
    if (editorial.config.EDITORIAL_ENABLED) {
      requiresJobs.push('editorial_requires_jobs');
    }
    if (requiresJobs.length > 0) {
      return { kind: 'config_invalid', issues: requiresJobs };
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
  const editorialEnabled = editorial.config.EDITORIAL_ENABLED;

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
        // R10 (Round 1.8): the RAW platform fetch only. The handler builds
        // the MANDATORY per-hop budget-authorizing ingestion transport from
        // it for every execution — this wiring can never reach an unlimited
        // transport, and no SafeFetchExecutor can be injected past the
        // budget authority.
        fetchFn: globalThis.fetch.bind(globalThis),
        idGenerator: cryptoIdGenerator,
        secrets: (name: string) => (env as Record<string, unknown>)[name] as string | undefined,
        nowMs: () => clock.now(),
        random: Math.random,
        logger,
      }) as never,
    );
  }
  if (editorialEnabled) {
    // Phase 5A (ADR-0042 §3): the editorial handler is registered ONLY
    // while EDITORIAL_ENABLED is on. It wires the EXISTING AI draft
    // service (ADR-0041) over the REAL D1 budget authority; the Workers AI
    // port is built only when the native binding is present. The Gemini
    // fallback stays UNWIRED in production: its versioned eligibility is
    // unverified (ADR-0041), so the service's own ladder skips it even if
    // its operator flag were on — no live network can be reached through
    // this wiring while the shipped flags are false.
    const workersAiBindingPresent = env.AI !== undefined;
    const ports = workersAiBindingPresent ? { 'workers-ai': createWorkersAiAdapter(env.AI) } : {};
    const aiService = createAiDraftService({
      executor,
      ports,
      clock,
      logger: logger ?? createFallbackLogger(),
      config: {
        aiEnabled: ai.config.AI_ENABLED,
        geminiEnabled: ai.config.AI_GEMINI_ENABLED,
        workersAiBindingPresent,
        geminiApiKeyPresent: env.GEMINI_API_KEY !== undefined,
      },
    });
    // R1.17 (Phase 5E-1): the SEPARATE event-relation service shares the
    // SAME ports/budget authority. R1.17.1 (G1): the effective gate is the
    // GLOBAL AI_ENABLED kill switch AND the independent
    // EVENT_RELATION_ENABLED flag — BOTH fail-closed, BOTH passed here so
    // the service's own layered defense holds in production wiring (the
    // feature flag never bypasses the global inference gate).
    const eventRelationService = createEventRelationService({
      executor,
      ports,
      clock,
      logger: logger ?? createFallbackLogger(),
      config: {
        eventRelationEnabled: ai.config.EVENT_RELATION_ENABLED,
        aiEnabled: ai.config.AI_ENABLED,
        workersAiBindingPresent,
        geminiApiKeyPresent: env.GEMINI_API_KEY !== undefined,
      },
    });
    handlers.push(
      createEditorialPrepareDraftHandler({
        executor,
        aiService,
        eventRelation: {
          // R1.17.1 (G1): the handler's relation step honors the SAME
          // effective gate (global AND feature flag) — with the global
          // gate off the step never runs at all (honest `disabled` ledger
          // if a draft were ever committed, zero calls/charges otherwise).
          enabled: ai.config.AI_ENABLED && ai.config.EVENT_RELATION_ENABLED,
          service: eventRelationService,
        },
        nowMs: () => clock.now(),
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
      // Round 1.6 (ADR-0040) + Phase 5A (ADR-0042): the strictly parsed,
      // strictly per-invocation gate snapshot — the engine never re-reads
      // an environment variable.
      policyGates: {
        ingestionGateOn: ingestionEnabled,
        editorialGateOn: editorialEnabled,
      },
    },
    DEFAULT_ENGINE_BOUNDS,
  );
  return { kind: 'ready', engine, ingestionEnabled, editorialEnabled };
}

/**
 * Minimal safe logger used when no logger is supplied (the editorial
 * handler requires one structurally; entrypoints always pass one).
 */
function createFallbackLogger(): Logger {
  return createLogger({ level: 'error', sink: () => undefined });
}
