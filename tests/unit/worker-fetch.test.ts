import { describe, expect, it } from 'vitest';
import worker from '../../src/entrypoints/worker';

function testCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

/**
 * Direct fetch-handler tests for configuration-failure behavior that cannot
 * be exercised through SELF (which always uses wrangler.jsonc vars).
 * Confirms fail-safe fallbacks: health stays up, readiness reports not_ready,
 * and no configuration values are echoed in responses.
 */
describe('worker.fetch with invalid configuration', () => {
  it('serves /health with safe defaults and no config echo', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/health'),
      { LOG_LEVEL: 'bogus-value', APP_VERSION: 'x'.repeat(300) },
      testCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['environment']).toBe('development');
    expect(body['version']).toBe('x'.repeat(300));
    expect(JSON.stringify(body)).not.toContain('bogus-value');
  });

  it('reports /health/ready as not_ready with a 503', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/health/ready'),
      { LOG_LEVEL: 'bogus-value' },
      testCtx(),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('not_ready');
    expect(Object.keys(body).sort()).toEqual(['ok', 'service', 'status']);
  });

  it('never echoes invalid configuration values in the not_ready body', async () => {
    const res = await worker.fetch(
      new Request('https://example.com/health/ready'),
      { LOG_LEVEL: 'bogus-value' },
      testCtx(),
    );
    const serialized = JSON.stringify(await res.json());
    expect(serialized).not.toContain('bogus-value');
  });
});
