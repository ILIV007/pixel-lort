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
 * Bodies are intentionally tiny and carry no configuration inventory;
 * reasons are logged as stable codes only.
 */
import { parseWorkerConfig } from '../../../shared/config/phase0';
import { parseDataFoundationConfig } from '../../../shared/config/phase1a';
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
