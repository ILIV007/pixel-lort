import type { SafeFetchExecutor, SafeFetchResult } from '../../src/shared/http/safe-http';

/**
 * TEST INFRASTRUCTURE — scripted SafeFetch fake for connector contract
 * tests. Records every call (url, method, headers) and returns queued
 * responses. NO live network (AGENTS.md §4).
 */

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

export interface QueuedResponse {
  /** HTTP status (required unless a transport failure is simulated). */
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly bodyText?: string;
  /** Simulate a transport failure with this stable reason. */
  readonly failReason?: string;
}

export interface FetchMock {
  readonly fetchFn: SafeFetchExecutor;
  readonly calls: readonly RecordedCall[];
  /** Change the scripted response queue between steps. */
  setResponses(responses: readonly QueuedResponse[]): void;
}

export function createFetchMock(initial: readonly QueuedResponse[] = []): FetchMock {
  const calls: RecordedCall[] = [];
  let responses = [...initial];
  const fetchFn: SafeFetchExecutor = async (input) => {
    const response = responses.shift();
    calls.push({
      url: input.url,
      method: input.method ?? 'GET',
      headers: { ...input.headers },
    });
    if (response === undefined) {
      const miss: SafeFetchResult = { ok: false, reason: 'network_error', requestCount: 1 };
      return miss;
    }
    if (response.failReason !== undefined) {
      const failure: SafeFetchResult = {
        ok: false,
        reason: response.failReason as never,
        requestCount: 1,
      };
      return failure;
    }
    const okResult: SafeFetchResult = {
      ok: true,
      status: response.status ?? 200,
      headers: new Headers(response.headers ?? {}),
      bodyText: response.bodyText ?? '',
      requestCount: 1,
      finalUrl: input.url,
    };
    return okResult;
  };
  return {
    fetchFn,
    calls,
    setResponses(next: readonly QueuedResponse[]) {
      responses = [...next];
    },
  };
}

/** Wrap a SafeFetchExecutor into the connector effects bundle. */
export function connectorEffects(
  fetchFn: SafeFetchExecutor,
  secrets: Record<string, string> = {},
): {
  safeFetch: SafeFetchExecutor;
  nowMs: () => number;
  random: () => number;
  secrets: (name: string) => string | undefined;
} {
  const NOW = 1_770_000_000_000; // 2026-02-02 — after all fixture timestamps
  return {
    safeFetch: fetchFn,
    nowMs: () => NOW,
    random: () => 0.5,
    secrets: (name: string) => secrets[name],
  };
}

/**
 * Round 1.8 (R10): scripted RAW `typeof fetch` transport for HANDLER-level
 * suites. Since Round 1.8 the poll handler builds its own budgeted
 * ingestion transport from the raw transport (the budget authority is
 * mandatory at that wiring point), so handler harnesses feed it a raw
 * scripted fetch instead of a SafeFetchExecutor fake. Same queued-response
 * shape as `createFetchMock` (status/headers/bodyText/failReason):
 * - `failReason` simulates a transport failure by THROWING (the real
 *   SafeFetch classifies it as `network_error`);
 * - bodyless terminal statuses (304) are constructed with a null body;
 * - every raw call is recorded (url, method, headers) exactly as the REAL
 *   transport issued it.
 * NO live network (AGENTS.md §4). Connector CONTRACT tests keep using the
 * SafeFetchExecutor fake above; raw-port and handler suites use THIS.
 */
export interface RawFetchMock {
  readonly fetchFn: typeof fetch;
  readonly calls: readonly RecordedCall[];
  /** Change the scripted response queue between steps. */
  setResponses(responses: readonly QueuedResponse[]): void;
}

export function createRawFetchMock(initial: readonly QueuedResponse[] = []): RawFetchMock {
  const calls: RecordedCall[] = [];
  let responses = [...initial];
  const fetchFn = (async (url: string | URL | RequestInfo, init?: RequestInit) => {
    const response = responses.shift();
    const headers =
      init?.headers instanceof Headers
        ? Object.fromEntries(init.headers.entries())
        : Array.isArray(init?.headers)
          ? Object.fromEntries(init?.headers ?? [])
          : { ...(init?.headers as Record<string, string> | undefined) };
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers });
    if (response === undefined || response.failReason !== undefined) {
      // Simulated raw transport failure — the real transport classifies
      // this as `network_error` (and the unit stays charged: a thrown
      // attempt consumes its unit, R10).
      throw new TypeError('simulated raw transport failure');
    }
    const status = response.status ?? 200;
    const bodyless = status === 204 || status === 304;
    const body = bodyless ? null : (response.bodyText ?? '');
    return new Response(body, {
      status,
      headers: response.headers ?? {},
    });
  }) as typeof fetch;
  return {
    fetchFn,
    calls,
    setResponses(next: readonly QueuedResponse[]) {
      responses = [...next];
    },
  };
}
