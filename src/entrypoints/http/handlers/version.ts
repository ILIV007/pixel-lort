/**
 * GET /version — safe build/schema metadata contract (Phase 1A, ADR-0012 /
 * ADR-0020).
 *
 * Response body (exactly these fields):
 *   applicationVersion — build/version marker (APP_VERSION)
 *   commit             — commit identifier (APP_COMMIT)
 *   schemaVersion      — expected D1 schema version (number, SCHEMA_VERSION)
 *   environment        — deployment environment
 *
 * Security:
 * - No secrets, no timestamps, no environment dump — the four fields above.
 * - Invalid or missing metadata fails CLOSED: 503 config_invalid with the
 *   standard safe error body (never echoes values). Local development-safe
 *   defaults are documented in .env.example and ADR-0020.
 * - Standard security headers (including cache-control: no-store) and
 *   correlation-ID behavior are applied by the shared response helpers.
 */
import { AppError } from '../../../shared/errors/app-error';
import { parseWorkerConfig } from '../../../shared/config/phase0';
import { parseDataFoundationConfig } from '../../../shared/config/phase1a';
import type { WorkerEnv } from '../../../shared/types/env';
import type { Logger } from '../../../observability/logger';
import { jsonResponse } from '../responses';

export interface VersionRouteContext {
  readonly logger: Logger;
}

export interface VersionResponseBody {
  readonly applicationVersion: string;
  readonly commit: string;
  readonly schemaVersion: number;
  readonly environment: string;
}

export function handleVersion(env: WorkerEnv, ctx: VersionRouteContext): Response {
  const { config, result } = parseWorkerConfig(env as Readonly<Record<string, unknown>>);
  const data = parseDataFoundationConfig(
    env as Readonly<Record<string, unknown>>,
    config.ENVIRONMENT,
  );

  if (!result.ok || data.config === null) {
    // Log stable field/reason codes internally; the response is the standard
    // safe config_invalid body (built by the worker's error path).
    ctx.logger.warn('version.metadata_invalid', {
      issues: [...result.issues, ...data.result.issues],
    });
    throw new AppError('config_invalid');
  }

  const body: VersionResponseBody = {
    applicationVersion: config.APP_VERSION,
    commit: data.config.APP_COMMIT,
    schemaVersion: data.config.schemaVersion,
    environment: config.ENVIRONMENT,
  };
  return jsonResponse(200, body);
}
