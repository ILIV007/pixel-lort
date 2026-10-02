/**
 * Pixel Worker entrypoint.
 *
 * Phase 0 scope (docs/ROADMAP.md phase 0):
 * - GET /health, /health/live, /health/ready via a strict allowlist router.
 * - Safe JSON 404 for everything else.
 * - Typed no-op scheduled and queue handlers with structured logs.
 *
 * Hard rules:
 * - No business workflow, source adapter, AI call, or Telegram publishing.
 * - Never log authorization headers, cookies, tokens, request bodies, or
 *   future Telegram update payloads. Only method + path are logged, and the
 *   path never includes the query string.
 */
import { parseWorkerConfig } from '../shared/config/phase0';
import { toAppError } from '../shared/errors/app-error';
import type { WorkerEnv } from '../shared/types/env';
import { createLogger, type Logger } from '../observability/logger';
import { handleQueue } from './queue';
import { handleScheduled } from './cron';
import { resolveRequestId, REQUEST_ID_HEADER } from './http/request-context';
import { routeRequest } from './http/router';
import { errorResponse } from './http/responses';

async function handleFetch(request: Request, env: WorkerEnv): Promise<Response> {
  const startedAtMs = Date.now();
  const { requestId } = resolveRequestId(request);

  // Configuration is validated per request; on invalid config the logger
  // falls back to safe defaults and the issue is logged internally only.
  const { config, result } = parseWorkerConfig(env as Readonly<Record<string, unknown>>);
  const logger: Logger = createLogger({
    level: config.LOG_LEVEL,
    base: { requestId },
  });
  if (!result.ok) {
    logger.warn('http.config_invalid_fallback', { issues: result.issues });
  }

  let response: Response;
  try {
    logger.info('http.request.received', {
      http: { method: request.method, path: new URL(request.url).pathname },
    });
    response = await routeRequest(request, env, { requestId, logger });
  } catch (error) {
    const appError = toAppError(error);
    logger.error('http.request.failed', {
      code: appError.code,
      error,
    });
    response = errorResponse(error, requestId);
  }

  response.headers.set(REQUEST_ID_HEADER, requestId);
  logger.info('http.request.completed', {
    status: response.status,
    durationMs: Date.now() - startedAtMs,
  });
  return response;
}

export default {
  fetch(request: Request, env: WorkerEnv, _ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env);
  },
  scheduled: handleScheduled,
  queue: handleQueue,
} satisfies ExportedHandler<WorkerEnv>;
