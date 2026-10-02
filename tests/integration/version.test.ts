import { beforeEach, describe, expect, it } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createLogger } from '../../src/observability/logger';
import { handleVersion } from '../../src/entrypoints/http/handlers/version';
import worker from '../../src/entrypoints/worker';

/**
 * Phase 1A /version contract tests (ADR-0020).
 *
 * Via SELF (real wrangler.jsonc vars): the full happy-path contract.
 * Via direct handler / worker invocation: fail-closed behavior for invalid
 * or production-invalid metadata that SELF cannot reproduce (vars are fixed).
 */

function testCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

describe('GET /version via SELF', () => {
  it('returns exactly the four documented fields with correct types', async () => {
    const res = await SELF.fetch('https://example.com/version');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toMatch(/^[!-~]{8,128}$/);

    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'applicationVersion',
      'commit',
      'environment',
      'schemaVersion',
    ]);
    expect(body['applicationVersion']).toBe('1.1.0');
    expect(body['commit']).toBe('local-dev');
    expect(body['schemaVersion']).toBe(1);
    expect(body['environment']).toBe('development');
  });

  it('contains no timestamps, secrets, or environment dump', async () => {
    const res = await SELF.fetch('https://example.com/version');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain('time');
    expect(JSON.stringify(body).toLowerCase()).not.toContain('token');
    expect(JSON.stringify(body).toLowerCase()).not.toContain('secret');
  });

  it('rejects unsupported methods with the uniform safe 404', async () => {
    const res = await SELF.fetch('https://example.com/version', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('GET /version — fail-closed metadata handling', () => {
  it('throws a stable config_invalid AppError for an invalid SCHEMA_VERSION', () => {
    expect(() =>
      handleVersion({ SCHEMA_VERSION: 'not-an-integer' }, { logger: silentLogger() }),
    ).toThrowError(expect.objectContaining({ code: 'config_invalid', status: 503 }));
  });

  it('throws config_invalid when the production placeholder guard triggers', () => {
    expect(() =>
      handleVersion(
        { ENVIRONMENT: 'production', APP_COMMIT: 'local-dev' },
        { logger: silentLogger() },
      ),
    ).toThrowError(expect.objectContaining({ code: 'config_invalid' }));
  });

  it('throws config_invalid when the preview placeholder guard triggers', () => {
    expect(() =>
      handleVersion(
        { ENVIRONMENT: 'preview', APP_COMMIT: 'local-dev' },
        { logger: silentLogger() },
      ),
    ).toThrowError(expect.objectContaining({ code: 'config_invalid' }));
  });

  it('throws config_invalid for an uncontrolled commit string outside development', () => {
    expect(() =>
      handleVersion(
        { ENVIRONMENT: 'preview', APP_COMMIT: 'not-a-commit' },
        { logger: silentLogger() },
      ),
    ).toThrowError(expect.objectContaining({ code: 'config_invalid', status: 503 }));
  });

  it('serves the version contract with local defaults when fields are absent', () => {
    const res = handleVersion({}, { logger: silentLogger() });
    expect(res.status).toBe(200);
  });

  it('maps invalid metadata through the worker error path to a safe 503', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/version'),
      { SCHEMA_VERSION: 'bogus' },
      testCtx(),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('x-request-id')).toMatch(/^[!-~]{8,128}$/);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('config_invalid');
    expect(JSON.stringify(body)).not.toContain('bogus');
  });
});

describe('GET /health/ready — Phase 1A schema health (DB binding present)', () => {
  beforeEach(async () => {
    await applyMigrations(env.DB);
  });

  it('reports ready when the applied schema matches SCHEMA_VERSION', async () => {
    const res = await SELF.fetch('https://example.com/health/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ready');
    expect(Object.keys(body).sort()).toEqual(['ok', 'service', 'status']);
  });

  it('reports not_ready when the application schema metadata is missing', async () => {
    await env.DB.prepare(`DELETE FROM schema_metadata`).run();

    const res = await SELF.fetch('https://example.com/health/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('not_ready');
    expect(Object.keys(body).sort()).toEqual(['ok', 'service', 'status']);
  });

  it('reports not_ready when the schema version mismatches the configuration', async () => {
    await env.DB.prepare(
      `UPDATE schema_metadata SET value = '2' WHERE key = 'schema_version'`,
    ).run();

    const res = await SELF.fetch('https://example.com/health/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('not_ready');
  });
});
