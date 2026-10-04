/**
 * Minimal allowlist router for the Pixel HTTP surface.
 *
 * Security posture: every route must be explicitly enumerated. Anything that
 * does not match exactly (wrong path OR wrong method) produces the same safe
 * JSON 404, so the router reveals neither route existence nor method support.
 *
 * Phase 2A adds POST /telegram/webhook: the route is enumerated here, but the
 * handler itself fails closed to the same uniform 404 unless the Phase 2
 * ingress flag is enabled with a fully valid configuration.
 */
import { AppError } from '../../shared/errors/app-error';
import type { WorkerEnv } from '../../shared/types/env';
import { handleHealth, handleHealthLive, handleHealthReady } from './handlers/health';
import { handleTelegramWebhook } from './handlers/telegram-webhook';
import { handleVersion } from './handlers/version';
import type { RequestIdResolution } from './request-context';
import type { Logger } from '../../observability/logger';

export interface RouteContext {
  readonly requestId: string;
  readonly logger: Logger;
}

export async function routeRequest(
  request: Request,
  env: WorkerEnv,
  ctx: RouteContext,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const path = url.pathname;

  if (method === 'GET' && path === '/health') {
    return handleHealth(env, ctx);
  }
  if (method === 'GET' && path === '/health/live') {
    return handleHealthLive();
  }
  if (method === 'GET' && path === '/health/ready') {
    return handleHealthReady(env, ctx);
  }
  if (method === 'GET' && path === '/version') {
    return handleVersion(env, ctx);
  }
  // POST-only Telegram webhook (Phase 2A). Any other method on this path
  // falls through to the same uniform safe 404 as unknown routes — the
  // handler itself additionally treats a disabled/misconfigured ingress as
  // a nonexistent route.
  if (method === 'POST' && path === '/telegram/webhook') {
    return handleTelegramWebhook(request, env, ctx);
  }

  // Uniformly reject unknown paths and unsupported methods.
  // No user-controlled input is reflected back in the error body.
  throw new AppError('not_found');
}

export type { RequestIdResolution };
