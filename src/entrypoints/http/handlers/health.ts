/**
 * Phase 0/1A health handlers.
 *
 * Blueprint §5 public HTTP surface (Phase 0 subset + Phase 1A extension):
 *   GET /health        — aggregate health summary (small JSON body).
 *   GET /health/live   — static process liveness; no secret inventory.
 *   GET /health/ready  — ready/degraded/not_ready only; reasons go to logs.
 *
 * Phase 1A readiness extension (ADR-0021):
 * - Invalid build/schema metadata (APP_COMMIT / SCHEMA_VERSION) => not_ready.
 * - When a D1 binding IS present, schema health is verified against the
 *   configured SCHEMA_VERSION; a missing/mismatched schema => not_ready.
 * - Without a D1 binding (ordinary offline development — no real remote
 *   resource exists in Phase 1A), the endpoint stays READY: absence of a
 *   not-yet-provisioned resource is not a failure (ADR-0019).
 *
 * Phase 2 readiness extension (fail-closed, ADR-0008 phase-scoped):
 * - Any present-but-invalid Phase 2 value => not_ready (never silently
 *   ignored).
 * - While TELEGRAM_INGRESS_ENABLED is 'true', the required Phase 2 secrets
 *   must be present and valid, and a D1 binding must exist for durable
 *   update idempotency; otherwise => not_ready.
 *
 * Phase 3 readiness extension (fail-closed, ADR-0036 §7 tightened by
 * ADR-0037):
 * - Any present-but-invalid JOBS_ENABLED value => not_ready (never silently
 *   treated as disabled).
 * - While the jobs engine is ENABLED, the D1 binding and BOTH queue
 *   bindings (JOBS/DLQ) must be present; a missing binding => not_ready —
 *   an enabled engine must never half-run behind a ready banner. A DISABLED
 *   engine is the ordinary Telegram-only ready state.
 *
 * Bodies are intentionally tiny and carry no configuration inventory;
 * reasons are logged as stable codes only.
 */
import { parseWorkerConfig } from '../../../shared/config/phase0';
import { parseDataFoundationConfig } from '../../../shared/config/phase1a';
import { parseTelegramPhase2Config } from '../../../shared/config/phase2';
import { resolveJobsEngine } from '../../../application/jobs/engine-env';
import type { WorkerEnv } from '../../../shared/types/env';
import type { Logger } from '../../../observability/logger';
import { createDbExecutor, checkSchemaHealth } from '../../../adapters/db';
import { jsonResponse } from '../responses';

export interface HealthRouteContext {
  readonly logger: Logger;
}

export function handleHealth(env: WorkerEnv, ctx: HealthRouteContext): Response {
  const { config, result } = parseWorkerConfig(env as Readonly<Record<string, unknown>>);
  if (!result.ok) {
    // Log internally only; the response body stays minimal.
    ctx.logger.warn('health.config_invalid_fallback', { issues: result.issues });
  }
  return jsonResponse(200, {
    ok: true,
    service: 'pixel',
    status: 'ok',
    version: config.APP_VERSION,
    environment: config.ENVIRONMENT,
    time: new Date().toISOString(),
  });
}

export function handleHealthLive(): Response {
  return jsonResponse(200, {
    ok: true,
    service: 'pixel',
    status: 'live',
  });
}

export async function handleHealthReady(
  env: WorkerEnv,
  ctx: HealthRouteContext,
): Promise<Response> {
  const { config, result } = parseWorkerConfig(env as Readonly<Record<string, unknown>>);
  const data = parseDataFoundationConfig(
    env as Readonly<Record<string, unknown>>,
    config.ENVIRONMENT,
  );

  const reasons: string[] = [];
  if (!result.ok) {
    reasons.push('config_invalid');
  }
  if (data.config === null) {
    reasons.push('metadata_config_invalid');
  }

  // Phase 2 (fail-closed, ADR-0008): any present-but-invalid Phase 2 value
  // fails readiness in every environment. While the Telegram ingress flag is
  // ENABLED, the three Phase 2 secrets are REQUIRED (missing or invalid =>
  // not_ready) and a D1 binding must exist for durable update idempotency.
  const phase2 = parseTelegramPhase2Config(env as Readonly<Record<string, unknown>>);
  if (!phase2.result.ok) {
    reasons.push('telegram_config_invalid');
  }
  if (phase2.config?.ingressEnabled === true && env.DB === undefined) {
    reasons.push('telegram_db_unavailable');
  }

  // Phase 3 (fail-closed, ADR-0036 §7 tightened by ADR-0037): the jobs
  // engine shares ONE validation with the runtime entrypoints — a
  // present-but-invalid flag or an ENABLED engine missing the DB/JOBS/DLQ
  // bindings is `config_invalid` and must fail readiness (503), never run
  // half-configured. A disabled engine is the ordinary ready state.
  const jobs = resolveJobsEngine(env, ctx.logger);
  if (jobs.kind === 'config_invalid') {
    reasons.push('jobs_config_invalid');
  }

  if (data.config !== null && env.DB !== undefined) {
    const executor = createDbExecutor(env.DB, { logger: ctx.logger });
    const health = await checkSchemaHealth(executor, data.config.schemaVersion);
    if (!health.ok) {
      reasons.push(health.reason ?? 'schema_query_failed');
    }
  }

  if (reasons.length === 0) {
    return jsonResponse(200, { ok: true, service: 'pixel', status: 'ready' });
  }

  ctx.logger.warn('health.ready.not_ready', { reasons });
  return jsonResponse(503, { ok: false, service: 'pixel', status: 'not_ready' });
}
