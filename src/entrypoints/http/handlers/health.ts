/**
 * Phase 0 health handlers.
 *
 * Blueprint §5 public HTTP surface (Phase 0 subset):
 *   GET /health        — aggregate health summary (small JSON body).
 *   GET /health/live   — static process liveness; no secret inventory.
 *   GET /health/ready  — ready/degraded/not_ready only; reasons go to logs.
 *
 * Bodies are intentionally tiny and carry no configuration inventory.
 * Future phases will extend readiness checks (webhook secret, DB, queue)
 * and add `degraded` semantics per ADR-0015 (closed OD-007).
 */
import { parseWorkerConfig } from '../../../shared/config/phase0';
import type { WorkerEnv } from '../../../shared/types/env';
import type { Logger } from '../../../observability/logger';
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

export function handleHealthReady(env: WorkerEnv, ctx: HealthRouteContext): Response {
  const { result } = parseWorkerConfig(env as Readonly<Record<string, unknown>>);
  if (result.ok) {
    return jsonResponse(200, { ok: true, service: 'pixel', status: 'ready' });
  }
  ctx.logger.warn('health.ready.not_ready', { issues: result.issues });
  return jsonResponse(503, { ok: false, service: 'pixel', status: 'not_ready' });
}
