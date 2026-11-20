/**
 * Slice 7 — the R2/KV + MEDIA/ALBUMS integration suite (REAL workerd D1
 * for the engine half; Map-backed fakes for the R2/KV bindings — the
 * live Cloudflare surfaces are never touched by tests).
 *
 * Proven here:
 *  - R2 FAIL-CLOSED: with no MEDIA binding the resolver returns the
 *    typed `r2_binding_absent`; with a bucket present the adapter
 *    stages (put) and cleans up (delete) through the real `R2Bucket`
 *    surface shape, and rejects invalid keys/bytes typed;
 *  - KV CACHE: with no CACHE binding the resolver returns the typed
 *    `kv_binding_absent`; with a namespace present put/get/delete
 *    round-trip, a miss is `found: false`, invalid keys/values/TTLs
 *    fail typed, and a throwing namespace degrades to typed `kv_error`
 *    (fail-soft — the caller falls back to D1, never a failed request);
 *  - WIRING PIN: `wrangler.jsonc` declares the preview CACHE binding
 *    with the provisioned namespace id, and declares NO active R2
 *    binding while R2 is unprovisioned (403 code 10042 — the owner
 *    dashboard action);
 *  - EDIT MEDIA GUARD (engine, REAL D1): a correction whose caption
 *    edit smuggles a media payload refuses the WHOLE pass typed
 *    (`media_replacement_refused`) with ZERO transport calls and ZERO
 *    audit rows — media files are never replaced by edit, only the
 *    caption.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { findPublicationById } from '../../src/adapters/db/publication-outbox-store';
import {
  createEditCorrectionEngine,
  type CorrectionEditMessage,
  type PublicationEditTransport,
} from '../../src/application/publishing/edit-correction-engine';
import { createLogger } from '../../src/observability/logger';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';
import {
  createR2MediaStorage,
  resolveR2MediaStorage,
} from '../../src/adapters/r2/r2-media-storage';
import { createKvCacheStore, resolveKvCache } from '../../src/adapters/kv/cache-store';
import wranglerJsoncRaw from '../../wrangler.jsonc?raw';

const db: D1Database = env.DB;
const executor: DbExecutor = createDbExecutor(db);

const NOW = 1_700_029_800_000;
const DESTINATION = '@pixel_lores';
const KV_NAMESPACE_ID = 'b9bfaa5757044549ad41e5f1022d1d03';

let clock: MutableClock;

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

// ---------------------------------------------------------------------------
// Map-backed binding fakes (the live surfaces are never touched).
// ---------------------------------------------------------------------------

function makeFakeKv() {
  const store = new Map<string, string>();
  const namespace = {
    async get(key: string, type: string) {
      if (type !== 'text') return null;
      const found = store.get(key);
      return found === undefined ? null : found;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return { namespace: namespace as unknown as KVNamespace, store };
}

function makeThrowingKv() {
  const namespace = {
    async get(): Promise<never> {
      throw new Error('kv down');
    },
    async put(): Promise<never> {
      throw new Error('kv down');
    },
    async delete(): Promise<never> {
      throw new Error('kv down');
    },
  };
  return namespace as unknown as KVNamespace;
}

function makeFakeR2() {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const bucket = {
    async put(
      key: string,
      value: Uint8Array,
      options?: { httpMetadata?: { contentType?: string } },
    ) {
      store.set(key, {
        bytes: value,
        contentType: options?.httpMetadata?.contentType ?? '',
      });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}

// ---------------------------------------------------------------------------
// R2: fail-closed resolver + adapter.
// ---------------------------------------------------------------------------

describe('slice07: R2 fail-closed (no MEDIA binding on the account)', () => {
  it('an absent MEDIA binding resolves to typed r2_binding_absent', () => {
    expect(resolveR2MediaStorage({})).toEqual({ ok: false, reason: 'r2_binding_absent' });
    expect(resolveR2MediaStorage({ MEDIA: undefined })).toEqual({
      ok: false,
      reason: 'r2_binding_absent',
    });
  });

  it('with a bucket present the adapter stages and deletes through the R2 surface', async () => {
    const { bucket, store } = makeFakeR2();
    const resolved = resolveR2MediaStorage({ MEDIA: bucket });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const bytes = new TextEncoder().encode('fake-image-bytes');
    expect(
      await resolved.storage.put({
        objectKey: 'staging/abc.jpg',
        bytes,
        contentType: 'image/jpeg',
      }),
    ).toEqual({
      ok: true,
    });
    expect(store.get('staging/abc.jpg')?.contentType).toBe('image/jpeg');
    expect(await resolved.storage.delete('staging/abc.jpg')).toEqual({ ok: true });
    expect(store.has('staging/abc.jpg')).toBe(false);
    // Deleting a missing object is ok (idempotent cleanup).
    expect(await resolved.storage.delete('staging/abc.jpg')).toEqual({ ok: true });
  });

  it('invalid keys and bytes are rejected typed with zero bucket writes', async () => {
    const { bucket, store } = makeFakeR2();
    const storage = createR2MediaStorage(bucket);
    expect(
      await storage.put({ objectKey: '', bytes: new Uint8Array([1]), contentType: 'image/jpeg' }),
    ).toEqual({
      ok: false,
      reason: 'storage_rejected',
    });
    expect(
      await storage.put({ objectKey: 'k', bytes: new Uint8Array(0), contentType: 'image/jpeg' }),
    ).toEqual({
      ok: false,
      reason: 'storage_rejected',
    });
    expect(await storage.delete('')).toEqual({ ok: false, reason: 'storage_rejected' });
    expect(store.size).toBe(0);
  });

  it('a throwing bucket degrades to typed storage_unavailable', async () => {
    const throwing = {
      async put(): Promise<never> {
        throw new Error('r2 down');
      },
      async delete(): Promise<never> {
        throw new Error('r2 down');
      },
    } as unknown as R2Bucket;
    const storage = createR2MediaStorage(throwing);
    expect(
      await storage.put({ objectKey: 'k', bytes: new Uint8Array([1]), contentType: 'image/png' }),
    ).toEqual({
      ok: false,
      reason: 'storage_unavailable',
    });
    expect(await storage.delete('k')).toEqual({ ok: false, reason: 'storage_unavailable' });
  });
});

// ---------------------------------------------------------------------------
// KV: fail-soft cache + resolver.
// ---------------------------------------------------------------------------

describe('slice07: KV cache (namespace pixel-cache-preview)', () => {
  it('an absent CACHE binding resolves to typed kv_binding_absent', () => {
    expect(resolveKvCache({})).toEqual({ ok: false, reason: 'kv_binding_absent' });
    expect(resolveKvCache({ CACHE: undefined })).toEqual({
      ok: false,
      reason: 'kv_binding_absent',
    });
  });

  it('put/get/delete round-trip; a miss is found:false', async () => {
    const { namespace } = makeFakeKv();
    const resolved = resolveKvCache({ CACHE: namespace });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(await resolved.cache.get('missing-key')).toEqual({ ok: true, found: false });
    expect(await resolved.cache.put('greeting', 'hello', 3600)).toEqual({ ok: true });
    expect(await resolved.cache.get('greeting')).toEqual({ ok: true, found: true, value: 'hello' });
    expect(await resolved.cache.delete('greeting')).toEqual({ ok: true });
    expect(await resolved.cache.get('greeting')).toEqual({ ok: true, found: false });
  });

  it('invalid keys, values, and TTLs fail typed with zero writes', async () => {
    const { namespace, store } = makeFakeKv();
    const cache = createKvCacheStore(namespace);
    expect(await cache.put('', 'v')).toEqual({ ok: false, reason: 'invalid_input' });
    expect(await cache.put('k'.repeat(600), 'v')).toEqual({ ok: false, reason: 'invalid_input' });
    expect(await cache.put('k', 'v'.repeat(1024 * 1024 + 1))).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(await cache.put('k', 'v', 30)).toEqual({ ok: false, reason: 'invalid_input' });
    expect(await cache.get('')).toEqual({ ok: false, reason: 'invalid_input' });
    expect(await cache.delete('')).toEqual({ ok: false, reason: 'invalid_input' });
    expect(store.size).toBe(0);
  });

  it('a throwing namespace degrades to typed kv_error (fail-soft to D1)', async () => {
    const cache = createKvCacheStore(makeThrowingKv());
    expect(await cache.get('k')).toEqual({ ok: false, reason: 'kv_error' });
    expect(await cache.put('k', 'v')).toEqual({ ok: false, reason: 'kv_error' });
    expect(await cache.delete('k')).toEqual({ ok: false, reason: 'kv_error' });
  });
});

// ---------------------------------------------------------------------------
// Wiring pin: wrangler.jsonc.
// ---------------------------------------------------------------------------

describe('slice07: wrangler.jsonc wiring', () => {
  it('the preview env declares CACHE with the provisioned namespace id', () => {
    const lines = wranglerJsoncRaw.split('\n');
    const activeKv = lines.some((line) => /^\s*"kv_namespaces"\s*:/.test(line));
    expect(activeKv).toBe(true);
    expect(wranglerJsoncRaw).toContain('"binding": "CACHE"');
    expect(wranglerJsoncRaw).toContain(`"id": "${KV_NAMESPACE_ID}"`);
  });

  it('no ACTIVE r2_buckets binding is declared while R2 is unprovisioned', () => {
    const lines = wranglerJsoncRaw.split('\n');
    const activeR2 = lines.some((line) => /^\s*"r2_buckets"\s*:/.test(line));
    expect(activeR2).toBe(false);
    // The commented placeholder + the slice-7 probe note must still be there.
    expect(wranglerJsoncRaw).toContain('10042');
  });
});

// ---------------------------------------------------------------------------
// Edit media guard at the engine (REAL D1).
// ---------------------------------------------------------------------------

async function insertStory(id: string): Promise<void> {
  await executor.run({
    sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type, priority,
            confidence, working_headline, first_seen_at, last_evidence_at, version,
            created_at, updated_at)
          VALUES (?, ?, 'draftable', 'official', 'industry', 62, 80, NULL, ?, ?, 1, ?, ?)`,
    params: [id, `key-${id}`, NOW, NOW, NOW, NOW],
  });
}

async function insertDraft(id: string, storyId: string): Promise<void> {
  const document = {
    schemaVersion: 1,
    headlineFa: 'تیتر خبر گیمینگ',
    summaryFa: 'خلاصهٔ خبر برای خوانندهٔ فارسی‌زبان',
    modelClaims: [],
  };
  await executor.run({
    sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
            facts_json, warnings_json, version, created_by, created_at, updated_at)
          VALUES (?, ?, 'approved', 'fa', 'standard', ?, ?, '[]', '[]', 1, 'test', ?, ?)`,
    params: [id, storyId, 'تیتر خبر گیمینگ', JSON.stringify(document), NOW, NOW],
  });
}

async function insertPublication(id: string, storyId: string, draftId: string): Promise<void> {
  await executor.run({
    sql: `INSERT INTO publications (id, story_id, draft_id, status, priority, approval_mode,
            scheduled_at, run_after, claimed_at, lease_until, published_at, attempts,
            max_attempts, idempotency_key, last_error, created_at, updated_at)
          VALUES (?, ?, ?, 'published', 62, 'safe_auto', NULL, ?, NULL, NULL, ?, 0, 3, ?, NULL, ?, ?)`,
    params: [id, storyId, draftId, NOW, NOW - 60 * 60_000, `key-${id}`, NOW, NOW],
  });
}

async function insertRecordedMessage(
  publicationId: string,
  chatId: string,
  messageId: number,
  ordinal: number,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO publication_messages (publication_id, chat_id, message_id,
            media_group_id, ordinal, text_hash, created_at)
          VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    params: [publicationId, chatId, messageId, ordinal, `hash-${publicationId}-${ordinal}`, NOW],
  });
}

async function auditRowCount(): Promise<number> {
  const row = await executor.first<{ readonly total: number }>({
    sql: `SELECT COUNT(*) AS total FROM audit_events`,
    params: [],
  });
  return row?.total ?? 0;
}

function makeEditTransport(): PublicationEditTransport & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async editMessageTextRich() {
      calls += 1;
      return { messageId: 101 };
    },
    async editMessageCaptionRich() {
      calls += 1;
      return { messageId: 102 };
    },
  };
}

describe('slice07: the edit media guard at the engine (REAL D1)', () => {
  beforeEach(async () => {
    await applyMigrations(db, MIGRATIONS);
    await db.prepare('DELETE FROM audit_events').run();
    await db.prepare('DELETE FROM publication_messages').run();
    await db.prepare('DELETE FROM publications').run();
    await db.prepare('DELETE FROM drafts').run();
    await db.prepare('DELETE FROM stories').run();
    clock = fixedClock(NOW);
  });

  it('a caption edit smuggling a media payload refuses the whole pass with zero effects', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old');
    await insertRecordedMessage('p-old', DESTINATION, 101, 0);
    await insertRecordedMessage('p-old', DESTINATION, 102, 1);
    const transport = makeEditTransport();
    const engine = createEditCorrectionEngine({
      executor,
      editTransport: transport,
      applyGate: { enabled: true },
      clock,
      logger: silentLogger(),
    });
    const smuggled = {
      chatId: DESTINATION,
      messageId: 102,
      shape: 'caption',
      content: { kind: 'rich_text_v1', text: 'کپشن اصلاح‌شده', entities: [] },
      // A smuggled media replacement — the guard must refuse the pass.
      media: 'new-file-id-should-never-send',
    } as unknown as CorrectionEditMessage;
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-guard-1',
      correctionClass: 'rumor_denied',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: [
        {
          chatId: DESTINATION,
          messageId: 101,
          shape: 'text',
          content: { kind: 'rich_text_v1', text: 'متن اصلاح‌شده', entities: [] },
        },
        smuggled,
      ],
    });
    expect(report.applied).toBe(false);
    expect(report.refusal).toBe('media_replacement_refused');
    expect(report.edits).toHaveLength(0);
    expect(transport.calls).toBe(0);
    expect(await auditRowCount()).toBe(0);
    const row = await findPublicationById(executor, 'p-old');
    expect(row?.status).toBe('published');
  });

  it('a clean caption-only edit still applies (the guard does not block honest edits)', async () => {
    await insertStory('s1');
    await insertDraft('d-old', 's1');
    await insertPublication('p-old', 's1', 'd-old');
    await insertRecordedMessage('p-old', DESTINATION, 102, 0);
    const transport = makeEditTransport();
    const engine = createEditCorrectionEngine({
      executor,
      editTransport: transport,
      applyGate: { enabled: true },
      clock,
      logger: silentLogger(),
    });
    const report = await engine.applyCorrection({
      storyId: 's1',
      priorPublicationId: 'p-old',
      revisionId: 'rev-guard-2',
      correctionClass: 'rumor_denied',
      followUpMaterial: false,
      correctionFollowUpDesired: false,
      edits: [
        {
          chatId: DESTINATION,
          messageId: 102,
          shape: 'caption',
          content: { kind: 'rich_text_v1', text: 'کپشن اصلاح‌شده', entities: [] },
        },
      ],
    });
    expect(report.applied).toBe(true);
    expect(report.edits.map((edit) => edit.outcome)).toEqual(['applied']);
    expect(transport.calls).toBe(1);
  });
});
