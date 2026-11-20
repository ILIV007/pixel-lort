/**
 * Slice 7 — the REAL R2 media-storage adapter + the fail-closed binding
 * resolver (DESIGN §12.3, CHECKUP 2026-11-15: R2 is NOT enabled on the
 * Pixel account — the API returns 403 code 10042 until the owner enables
 * it in the dashboard under Workers & Pages → R2).
 *
 * `resolveR2MediaStorage(env)` is the ONLY construction path: when the
 * `MEDIA` binding is absent it returns the typed
 * `r2_binding_absent` — the upload path refuses with zero writes and
 * zero Telegram calls instead of inventing storage. When the binding IS
 * present, the adapter implements the `MediaStoragePort` contract (put /
 * delete) over the real `R2Bucket`: staged bytes are temporary
 * (72-hour retention, rtp1) and deleted after the file_id is saved.
 *
 * The adapter NEVER logs keys, bytes, or content — only stable reason
 * codes. A missing object on delete is ok (idempotent cleanup).
 *
 * BOUNDARY: the binding is the only live surface here; everything else
 * is the already-reviewed `MediaStoragePort` contract. No other module
 * may touch `env.MEDIA` directly.
 */

import type { MediaStoragePort, MediaStorageResultV1 } from '../../domain/media/media-ports';
import type { WorkerEnv } from '../../shared/types/env';

/** The R2 object-key bound (R2 keys are at most 1024 UTF-8 bytes). */
const MAX_R2_KEY_BYTES = 1024;
/** The application byte cap for one staged object (the mrp1 transport cap). */
const MAX_STAGED_BYTES = 50 * 1024 * 1024;

export type R2ResolverOutcome =
  | { readonly ok: true; readonly storage: MediaStoragePort }
  | { readonly ok: false; readonly reason: 'r2_binding_absent' };

function isValidKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length >= 1 &&
    new TextEncoder().encode(key).byteLength <= MAX_R2_KEY_BYTES
  );
}

/**
 * The real R2-backed `MediaStoragePort`. Construct ONLY through
 * `resolveR2MediaStorage` — direct construction bypasses the
 * fail-closed binding check.
 */
export function createR2MediaStorage(bucket: R2Bucket): MediaStoragePort {
  return {
    async put(input): Promise<MediaStorageResultV1> {
      if (
        typeof input !== 'object' ||
        input === null ||
        !isValidKey(input.objectKey) ||
        !(input.bytes instanceof Uint8Array) ||
        input.bytes.byteLength === 0 ||
        input.bytes.byteLength > MAX_STAGED_BYTES ||
        typeof input.contentType !== 'string' ||
        input.contentType.length === 0
      ) {
        return { ok: false, reason: 'storage_rejected' };
      }
      try {
        await bucket.put(input.objectKey, input.bytes, {
          httpMetadata: { contentType: input.contentType },
        });
        return { ok: true };
      } catch {
        return { ok: false, reason: 'storage_unavailable' };
      }
    },
    async delete(objectKey: string): Promise<MediaStorageResultV1> {
      if (!isValidKey(objectKey)) return { ok: false, reason: 'storage_rejected' };
      try {
        await bucket.delete(objectKey);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'storage_unavailable' };
      }
    },
  };
}

/**
 * Resolve the R2 media storage from the worker environment. Absent
 * binding → typed `r2_binding_absent`: the caller refuses the media
 * path (fail-closed), never a partial upload.
 */
export function resolveR2MediaStorage(env: Pick<WorkerEnv, 'MEDIA'>): R2ResolverOutcome {
  if (env === null || typeof env !== 'object' || env.MEDIA === undefined || env.MEDIA === null) {
    return { ok: false, reason: 'r2_binding_absent' };
  }
  return { ok: true, storage: createR2MediaStorage(env.MEDIA) };
}
