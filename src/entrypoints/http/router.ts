/**
 * Minimal allowlist router for the Phase 0 HTTP surface.
 *
 * Security posture: every route must be explicitly enumerated. Anything that
 * does not match exactly (wrong path OR wrong method) produces the same safe
 * JSON 404, so the router reveals neither route existence nor method support.
 */
import { AppError } from '../../shared/errors/app-error';
import type { WorkerEnv } from '../../shared/types/env';
import { handleHealth, handleHealthLive, handleHealthReady } from './handlers/health';
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

  // Uniformly reject unknown paths and unsupported methods.
  // No user-controlled input is reflected back in the error body.
  throw new AppError('not_found');
}

export type { RequestIdResolution };
