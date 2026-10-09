import { describe, expect, it } from 'vitest';
import { createSafeFetch, type SafeFetchInput } from '../../src/shared/http/safe-http';

/**
 * Safe HTTP layer (Phase 4 — ADR-0039 §2): manual redirect validation with
 * cross-origin credential stripping, deadline through body reading,
 * streamed byte caps, dishonest Content-Length, allowlist enforcement.
 */

const BASE_INPUT: SafeFetchInput = {
  url: 'https://feed.example.com/feed.xml',
  headers: { accept: 'application/xml', authorization: 'Bearer secret-token' },
  byteCap: 1024,
  timeoutMs: 5_000,
  maxRedirects: 2,
  allowedHosts: ['feed.example.com', 'cdn.example.com'],
};

function okResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

describe('createSafeFetch — happy path', () => {
  it('performs a bounded GET and reports one request', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const safeFetch = createSafeFetch(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return okResponse('<rss/>');
    });
    const result = await safeFetch(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyText).toBe('<rss/>');
      expect(result.requestCount).toBe(1);
      expect(result.status).toBe(200);
    }
    expect(calls[0]?.url).toBe('https://feed.example.com/feed.xml');
  });
});

describe('redirect handling (manual, validated, bounded)', () => {
  it('follows a same-origin redirect and counts both requests', async () => {
    let calls = 0;
    const safeFetch = createSafeFetch(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(null, { status: 302, headers: { location: '/feed-2.xml' } });
      }
      return okResponse('<rss/>');
    });
    const result = await safeFetch(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.requestCount).toBe(2);
      expect(result.finalUrl).toBe('https://feed.example.com/feed-2.xml');
    }
  });

  it('strips credential headers on a cross-origin hop', async () => {
    const captured: string[] = [];
    let calls = 0;
    const safeFetch = createSafeFetch(async (_url, init) => {
      calls += 1;
      const headers = new Headers(init?.headers);
      captured.push(headers.get('authorization') ?? 'ABSENT');
      if (calls === 1) {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://cdn.example.com/mirror.xml' },
        });
      }
      return okResponse('<rss/>');
    });
    const result = await safeFetch(BASE_INPUT);
    expect(result.ok).toBe(true);
    expect(captured[0]).toBe('Bearer secret-token'); // original origin
    expect(captured[1]).toBe('ABSENT'); // cross-origin: stripped
  });

  it('keeps credential headers on a same-origin hop', async () => {
    const captured: string[] = [];
    let calls = 0;
    const safeFetch = createSafeFetch(async (_url, init) => {
      calls += 1;
      const headers = new Headers(init?.headers);
      captured.push(headers.get('authorization') ?? 'ABSENT');
      if (calls === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: 'https://feed.example.com/b.xml' },
        });
      }
      return okResponse('<rss/>');
    });
    await safeFetch(BASE_INPUT);
    expect(captured[1]).toBe('Bearer secret-token');
  });

  it('rejects a redirect target outside the allowlist', async () => {
    const safeFetch = createSafeFetch(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.tld/steal' } }),
    );
    const result = await safeFetch(BASE_INPUT);
    expect(result).toMatchObject({ ok: false, reason: 'host_not_allowed', requestCount: 1 });
  });

  it('rejects a redirect that downgrades the scheme', async () => {
    const safeFetch = createSafeFetch(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://feed.example.com/x' } }),
    );
    const result = await safeFetch(BASE_INPUT);
    expect(result).toMatchObject({ ok: false, reason: 'scheme_not_https' });
  });

  it('enforces the redirect cap (2)', async () => {
    let hops = 0;
    const safeFetch = createSafeFetch(async () => {
      hops += 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://feed.example.com/hop${hops}` },
      });
    });
    const result = await safeFetch(BASE_INPUT);
    expect(result).toMatchObject({ ok: false, reason: 'redirect_limit' });
    // 3 requests: original + 2 hops, then the limit fires.
    expect(result.requestCount).toBe(3);
  });

  it('rejects a 3xx without a Location header', async () => {
    const safeFetch = createSafeFetch(async () => new Response(null, { status: 302 }));
    const result = await safeFetch(BASE_INPUT);
    expect(result).toMatchObject({ ok: false, reason: 'redirect_location_invalid' });
  });
});

describe('request bounds', () => {
  it('rejects targets outside the allowlist BEFORE any request', async () => {
    let calls = 0;
    const safeFetch = createSafeFetch(async () => {
      calls += 1;
      return okResponse('x');
    });
    const result = await safeFetch({ ...BASE_INPUT, url: 'https://not-allowed.tld/feed' });
    expect(result).toMatchObject({ ok: false, reason: 'host_not_allowed' });
    expect(calls).toBe(0);
  });

  it('rejects oversized streamed bodies regardless of any declared length', async () => {
    const oversized = 'a'.repeat(2048);
    const safeFetch = createSafeFetch(
      async () => new Response(oversized, { status: 200, headers: { 'content-length': '10' } }), // dishonest
    );
    const result = await safeFetch(BASE_INPUT);
    expect(result).toMatchObject({ ok: false, reason: 'body_too_large' });
  });

  it('rejects invalid Content-Length declarations', async () => {
    const safeFetch = createSafeFetch(
      async () => new Response('x', { status: 200, headers: { 'content-length': '-5' } }),
    );
    const result = await safeFetch(BASE_INPUT);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_content_length' });
  });

  it('maps network errors to a stable reason', async () => {
    const safeFetch = createSafeFetch(async () => {
      throw new Error('connection refused');
    });
    const result = await safeFetch(BASE_INPUT);
    expect(result).toMatchObject({ ok: false, reason: 'network_error' });
  });

  it('maps abort signals (timeout) to the timeout reason', async () => {
    const safeFetch = createSafeFetch(async (_url, init) => {
      return await new Promise<Response>((resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        signal.addEventListener('abort', () => {
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    const result = await safeFetch({ ...BASE_INPUT, timeoutMs: 20 });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('deadline covers body reading (slow-drip body is cut off)', async () => {
    const encoder = new TextEncoder();
    const safeFetch = createSafeFetch(async (_url, init) => {
      const signal = init?.signal as AbortSignal;
      // A drip stream that NEVER completes on its own; the abort signal
      // errors it (mirroring how a real fetch aborts the body stream).
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const drip = setInterval(() => {
            try {
              controller.enqueue(encoder.encode('chunk-'));
            } catch {
              clearInterval(drip);
            }
          }, 5);
          signal.addEventListener('abort', () => {
            clearInterval(drip);
            try {
              controller.error(new Error('aborted'));
            } catch {
              // already errored
            }
          });
        },
      });
      return new Response(stream, { status: 200 });
    });
    const startedAt = Date.now();
    const result = await safeFetch({ ...BASE_INPUT, timeoutMs: 80 });
    const elapsed = Date.now() - startedAt;
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    // NOT a 1000ms drip: the deadline cut the body read.
    expect(elapsed).toBeLessThan(500);
  });

  it('supports bounded POST bodies for token endpoints', async () => {
    const captured: Array<{ method: string; body: string | null }> = [];
    const safeFetch = createSafeFetch(async (_url, init) => {
      captured.push({
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return okResponse('{"ok":true}');
    });
    const result = await safeFetch({
      ...BASE_INPUT,
      url: 'https://feed.example.com/token',
      method: 'POST',
      body: 'grant_type=client_credentials',
    });
    expect(result.ok).toBe(true);
    expect(captured[0]?.method).toBe('POST');
    expect(captured[0]?.body).toBe('grant_type=client_credentials');
  });

  it('rejects an oversized POST body', async () => {
    const safeFetch = createSafeFetch(async () => okResponse('x'));
    const result = await safeFetch({
      ...BASE_INPUT,
      method: 'POST',
      body: 'x'.repeat(8192),
    });
    expect(result).toMatchObject({ ok: false, reason: 'network_error' });
  });

  it('degrades POST to GET on redirect hops (never re-POSTs elsewhere)', async () => {
    const captured: string[] = [];
    let calls = 0;
    const safeFetch = createSafeFetch(async (_url, init) => {
      calls += 1;
      captured.push(init?.method ?? 'GET');
      if (calls === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/after' },
        });
      }
      return okResponse('done');
    });
    await safeFetch({ ...BASE_INPUT, method: 'POST', body: 'grant_type=x' });
    expect(captured).toEqual(['POST', 'GET']);
  });
});
