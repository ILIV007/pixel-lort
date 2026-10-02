import { expect, describe, it } from 'vitest';
import { SELF } from 'cloudflare:test';

/**
 * Integration tests for the Phase 0 HTTP surface, executed through the real
 * worker entrypoint inside workerd (SELF). No network access occurs; SELF
 * dispatches in-process.
 */

describe('GET /health', () => {
  it('returns a healthy JSON summary', async () => {
    const res = await SELF.fetch('https://example.com/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toMatch(/^[!-~]{8,128}$/);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['service']).toBe('pixel');
    expect(body['status']).toBe('ok');
    expect(body['version']).toBeTypeOf('string');
    expect(body['environment']).toBeTypeOf('string');
    expect(body['time']).toBeTypeOf('string');
  });

  it('does not include any secret inventory in the body', async () => {
    const res = await SELF.fetch('https://example.com/health');
    const body = (await res.json()) as Record<string, unknown>;
    const keys = Object.keys(body).map((k) => k.toLowerCase());
    for (const key of keys) {
      expect(['authorization', 'cookie', 'token', 'apikey', 'secret', 'password']).not.toContain(
        key,
      );
    }
  });
});

describe('GET /health/live', () => {
  it('returns static liveness', async () => {
    const res = await SELF.fetch('https://example.com/health/live');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, service: 'pixel', status: 'live' });
  });
});

describe('GET /health/ready', () => {
  it('returns ready with the Phase 0 config surface', async () => {
    const res = await SELF.fetch('https://example.com/health/ready');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ready');
    expect(body['service']).toBe('pixel');
  });

  it('returns only status-like fields, never configuration details', async () => {
    const res = await SELF.fetch('https://example.com/health/ready');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['ok', 'service', 'status']);
  });
});

describe('unknown routes', () => {
  it('returns a safe JSON 404 with no stack or internals', async () => {
    const res = await SELF.fetch('https://example.com/definitely/not/here');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('not_found');
    expect(body.error['message']).toBe('Not Found');
    expect(body.error['requestId']).toBeTypeOf('string');
    expect(JSON.stringify(body)).not.toContain('stack');
    expect(JSON.stringify(body)).not.toContain('cause');
  });

  it('rejects unsupported methods with the same safe 404 (allowlist semantics)', async () => {
    const res = await SELF.fetch('https://example.com/health', { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('not_found');
  });

  it('rejects a non-GET request to /health/live uniformly', async () => {
    const res = await SELF.fetch('https://example.com/health/live', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('error safety', () => {
  it('attaches a correlation id header even on error responses', async () => {
    const res = await SELF.fetch('https://example.com/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-request-id')).toMatch(/^[!-~]{8,128}$/);
  });

  it('honors a well-formed incoming x-request-id', async () => {
    const res = await SELF.fetch('https://example.com/health', {
      headers: { 'x-request-id': 'integration-test-req-0001' },
    });
    expect(res.headers.get('x-request-id')).toBe('integration-test-req-0001');
  });
});
