/**
 * Slice 7 — the KV CACHE store + the fail-closed binding resolver
 * (blueprint §4 binding name CACHE; namespace `pixel-cache-preview`,
 * created 2026-11-21 via the Cloudflare API).
 *
 * KV is cache ONLY — never the source of truth (D1 owns durable state;
 * AGENTS.md §2). Every method is fail-SOFT: a KV error returns a typed
 * failure and the caller falls back to D1 — a cache miss or a KV outage
 * can never fail a request or lose a write. Nothing here is a lock:
 * advisory locks stay D1 claims (ADR-0025), because KV has no
 * compare-and-swap and a KV "lock" could never be a correctness
 * boundary.
 *
 * Bounds (application caps, inside the KV limits): keys at most 512
 * UTF-8 bytes, values at most 1 MiB, TTL 60s..30d when given. Keys and
 * values are never logged.
 *
 * BOUNDARY: the binding is the only live surface here. No other module
 * may touch `env.CACHE` directly — construction goes through
 * `resolveKvCache`, which returns the typed `kv_binding_absent` when
 * the binding is missing.
 */

import type { WorkerEnv } from '../../shared/types/env';

export const KV_CACHE_LIMITS = {
  /** KV key bound (512 bytes). */
  maxKeyBytes: 512,
  /** Application value cap (1 MiB — inside the KV 25 MiB limit). */
  maxValueBytes: 1024 * 1024,
  /** Minimum TTL (60s). */
  minTtlSeconds: 60,
  /** Maximum TTL (30 days). */
  maxTtlSeconds: 30 * 24 * 60 * 60,
} as const;

export type KvCacheFailureReason = 'invalid_input' | 'kv_error';

export type KvGetOutcome =
  | { readonly ok: true; readonly found: true; readonly value: string }
  | { readonly ok: true; readonly found: false }
  | { readonly ok: false; readonly reason: KvCacheFailureReason };

export type KvWriteOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: KvCacheFailureReason };

export interface KvCacheStore {
  get(key: string): Promise<KvGetOutcome>;
  put(key: string, value: string, ttlSeconds?: number): Promise<KvWriteOutcome>;
  delete(key: string): Promise<KvWriteOutcome>;
}

export type KvResolverOutcome =
  | { readonly ok: true; readonly cache: KvCacheStore }
  | { readonly ok: false; readonly reason: 'kv_binding_absent' };

function isValidKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length >= 1 &&
    new TextEncoder().encode(key).byteLength <= KV_CACHE_LIMITS.maxKeyBytes
  );
}

function isValidValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    new TextEncoder().encode(value).byteLength <= KV_CACHE_LIMITS.maxValueBytes
  );
}

function isValidTtl(ttlSeconds: unknown): ttlSeconds is number {
  return (
    typeof ttlSeconds === 'number' &&
    Number.isInteger(ttlSeconds) &&
    ttlSeconds >= KV_CACHE_LIMITS.minTtlSeconds &&
    ttlSeconds <= KV_CACHE_LIMITS.maxTtlSeconds
  );
}

/**
 * The KV-backed cache store. Construct ONLY through `resolveKvCache` —
 * direct construction bypasses the fail-closed binding check.
 */
export function createKvCacheStore(namespace: KVNamespace): KvCacheStore {
  return {
    async get(key: string): Promise<KvGetOutcome> {
      if (!isValidKey(key)) return { ok: false, reason: 'invalid_input' };
      try {
        const value = await namespace.get(key, 'text');
        if (value === null) return { ok: true, found: false };
        return { ok: true, found: true, value };
      } catch {
        return { ok: false, reason: 'kv_error' };
      }
    },
    async put(key: string, value: string, ttlSeconds?: number): Promise<KvWriteOutcome> {
      if (!isValidKey(key) || !isValidValue(value)) {
        return { ok: false, reason: 'invalid_input' };
      }
      if (ttlSeconds !== undefined && !isValidTtl(ttlSeconds)) {
        return { ok: false, reason: 'invalid_input' };
      }
      try {
        if (ttlSeconds !== undefined) {
          await namespace.put(key, value, { expirationTtl: ttlSeconds });
        } else {
          await namespace.put(key, value);
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: 'kv_error' };
      }
    },
    async delete(key: string): Promise<KvWriteOutcome> {
      if (!isValidKey(key)) return { ok: false, reason: 'invalid_input' };
      try {
        await namespace.delete(key);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'kv_error' };
      }
    },
  };
}

/**
 * Resolve the KV cache from the worker environment. Absent binding →
 * typed `kv_binding_absent`: the caller falls back to D1 (fail-soft),
 * never a failed request.
 */
export function resolveKvCache(env: Pick<WorkerEnv, 'CACHE'>): KvResolverOutcome {
  if (env === null || typeof env !== 'object' || env.CACHE === undefined || env.CACHE === null) {
    return { ok: false, reason: 'kv_binding_absent' };
  }
  return { ok: true, cache: createKvCacheStore(env.CACHE) };
}
