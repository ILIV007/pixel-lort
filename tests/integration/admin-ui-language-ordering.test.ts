import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { createAdminUiLanguageStore } from '../../src/adapters/db/admin-ui-language-store';

/**
 * Store-level ordering + recovery contracts (v1.2.6, ADR-0035) over the real
 * workerd D1 binding:
 *
 * - Preference ordering is the VALIDATED TELEGRAM MESSAGE-ORDER pair
 *   `(changedAtMs, messageId)` — the changing message's server-assigned
 *   `date` plus the per-chat `message_id` same-second tiebreak. update_id is
 *   only the durable dedup boundary (ADR-0025) and audit value.
 * - Older retried writes (older date/message_id, no matter when they arrive)
 *   resolve `stale` without writing; equal-ordering writes are duplicate
 *   deliveries and re-apply idempotently.
 * - Unreadable stored rows (malformed JSON, or valid JSON with invalid field
 *   types/values) never block the next valid save: they are repaired
 *   atomically inside the dedicated `admin_ui_language:` namespace, without
 *   weakening the fence for fully valid rows.
 * - Missing/invalid ordering metadata fails safely (deterministic throw, no
 *   write, no partial state).
 */

const USER = 555_000_111;
const OTHER_USER = 555_000_112;
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await applyMigrations(env.DB);
  await createDbExecutor(env.DB).run({ sql: 'DELETE FROM settings' });
});

function store(): ReturnType<typeof createAdminUiLanguageStore> {
  return createAdminUiLanguageStore(createDbExecutor(env.DB));
}

async function rawValueJson(telegramUserId: number): Promise<string | null> {
  const row = await createDbExecutor(env.DB).first<{ value_json: string }>({
    sql: 'SELECT value_json FROM settings WHERE key = ? LIMIT 1',
    params: [`admin_ui_language:${telegramUserId}`],
  });
  return row?.value_json ?? null;
}

describe('message-order fencing (ADR-0035)', () => {
  it('rejects an older retried message even when it arrives later (lower date wins nothing)', async () => {
    const s = store();
    await s.savePreference({
      telegramUserId: USER,
      language: 'fa',
      updateId: 9_000_001,
      changedAtMs: NOW,
      messageId: 101,
    });
    // An older message (earlier server date AND lower message_id) delivered
    // afterwards — e.g. an old retry that finally lands — must not overwrite.
    const stale = await s.savePreference({
      telegramUserId: USER,
      language: 'en',
      updateId: 9_000_002,
      changedAtMs: NOW - 5_000,
      messageId: 100,
    });
    expect(stale).toEqual({ kind: 'stale' });
    expect((await s.findPreference(USER))?.language).toBe('fa');
  });

  it('breaks same-second ties by the per-chat message_id (higher id is newer)', async () => {
    const s = store();
    await s.savePreference({
      telegramUserId: USER,
      language: 'en',
      updateId: 1,
      changedAtMs: NOW,
      messageId: 500,
    });
    // Same server second, higher message_id: the genuinely later message.
    const newer = await s.savePreference({
      telegramUserId: USER,
      language: 'fa',
      updateId: 2,
      changedAtMs: NOW,
      messageId: 501,
    });
    expect(newer).toEqual({ kind: 'saved' });
    expect((await s.findPreference(USER))?.language).toBe('fa');

    // Same second, LOWER message_id: an out-of-order same-second delivery
    // must never overwrite the newer choice.
    const outOfOrder = await s.savePreference({
      telegramUserId: USER,
      language: 'en',
      updateId: 3,
      changedAtMs: NOW,
      messageId: 499,
    });
    expect(outOfOrder).toEqual({ kind: 'stale' });
    expect((await s.findPreference(USER))?.language).toBe('fa');
  });

  it('re-applies a duplicate delivery idempotently (equal ordering pair)', async () => {
    const s = store();
    const first = await s.savePreference({
      telegramUserId: USER,
      language: 'fa',
      updateId: 77_000,
      changedAtMs: NOW,
      messageId: 900,
    });
    expect(first).toEqual({ kind: 'saved' });
    const before = await rawValueJson(USER);
    // Telegram redelivers the SAME message: identical ordering metadata and
    // identical language. The write re-applies (idempotent) and the stored
    // value is unchanged.
    const duplicate = await s.savePreference({
      telegramUserId: USER,
      language: 'fa',
      updateId: 77_000,
      changedAtMs: NOW,
      messageId: 900,
    });
    expect(duplicate).toEqual({ kind: 'saved' });
    expect(await rawValueJson(USER)).toBe(before);
    expect((await s.findPreference(USER))?.language).toBe('fa');
  });

  it('never lets a message without message_id beat a same-second write that carries one', async () => {
    const s = store();
    await s.savePreference({
      telegramUserId: USER,
      language: 'en',
      updateId: 11,
      changedAtMs: NOW,
      messageId: 42,
    });
    // Same second, no message_id provided: order is not provably newer —
    // the fail-safe direction is "does not apply".
    const unordered = await s.savePreference({
      telegramUserId: USER,
      language: 'fa',
      updateId: 12,
      changedAtMs: NOW,
    });
    expect(unordered).toEqual({ kind: 'stale' });
    expect((await s.findPreference(USER))?.language).toBe('en');
  });

  it('keeps per-admin isolation under ordering (one admin never fences another)', async () => {
    const s = store();
    await s.savePreference({
      telegramUserId: USER,
      language: 'fa',
      updateId: 21,
      changedAtMs: NOW - 1_000_000,
      messageId: 1,
    });
    const other = await s.savePreference({
      telegramUserId: OTHER_USER,
      language: 'en',
      updateId: 22,
      changedAtMs: NOW - 2_000_000,
      messageId: 1,
    });
    expect(other).toEqual({ kind: 'saved' });
    expect((await s.findPreference(USER))?.language).toBe('fa');
    expect((await s.findPreference(OTHER_USER))?.language).toBe('en');
  });
});

describe('missing/invalid ordering metadata fails safely', () => {
  it('rejects invalid store input with a deterministic error and writes NOTHING', async () => {
    const s = store();
    // Prime a valid preference; invalid calls must never disturb it.
    await s.savePreference({
      telegramUserId: USER,
      language: 'fa',
      updateId: 31,
      changedAtMs: NOW,
      messageId: 7,
    });
    const before = await rawValueJson(USER);

    for (const bad of [
      { language: 'en' as const, changedAtMs: Number.NaN, messageId: 8 }, // NaN date
      { language: 'en' as const, changedAtMs: NOW + 1, messageId: 0 }, // invalid message_id
      { language: 'en' as const, changedAtMs: NOW + 1, messageId: 1.5 }, // non-integer message_id
    ]) {
      await expect(
        s.savePreference({ telegramUserId: USER, updateId: 32, ...bad }),
      ).rejects.toMatchObject({ code: 'internal_error' });
    }
    expect(await rawValueJson(USER)).toBe(before);
    expect((await s.findPreference(USER))?.language).toBe('fa');
  });
});

describe('safe corrupt-row recovery (ADR-0035)', () => {
  it('repairs valid JSON with invalid FIELD TYPES and keeps the write in the admin-UI namespace', async () => {
    const executor = createDbExecutor(env.DB);
    // Unrelated row in another namespace must stay byte-identical.
    await executor.run({
      sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
            VALUES ('editorial.language', '"fa"', 1, NULL, ?)`,
      params: [NOW],
    });
    const stuckRows = [
      // changed_at_ms as TEXT: a naive numeric fence would compare across
      // types and block every future write (permanently stuck row).
      `{"language":"en","changed_at_ms":"${NOW}","last_update_id":5}`,
      // language as a number / outside the en-fa domain.
      `{"language":7,"changed_at_ms":${NOW},"last_update_id":5}`,
      `{"language":"de","changed_at_ms":${NOW},"last_update_id":5}`,
      // ordering fields as strings / out of the safe range.
      `{"language":"en","changed_at_ms":${NOW},"last_update_id":"5"}`,
      `{"language":"en","changed_at_ms":${NOW + 1},"last_update_id":${Number.MAX_SAFE_INTEGER + 1}}`,
      // last_message_id present but invalid (string, zero, null).
      `{"language":"en","changed_at_ms":${NOW},"last_update_id":5,"last_message_id":"42"}`,
      `{"language":"en","changed_at_ms":${NOW},"last_update_id":5,"last_message_id":0}`,
      `{"language":"en","changed_at_ms":${NOW},"last_update_id":5,"last_message_id":null}`,
      // wrong top-level JSON types.
      `[1,2,3]`,
      `"just a string"`,
    ];
    for (const [index, valueJson] of stuckRows.entries()) {
      const key = `admin_ui_language:${USER + index}`;
      await executor.run({
        sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
              VALUES (?, ?, 1, NULL, ?)`,
        params: [key, valueJson, NOW],
      });
      const s = store();
      // Reads fail safe: unreadable -> treated as "no preference".
      expect(await s.findPreference(USER + index)).toBeNull();
      // The next valid save REPAIRS the row instead of failing.
      await expect(
        s.savePreference({
          telegramUserId: USER + index,
          language: 'fa',
          updateId: 100_001,
          changedAtMs: NOW + 1,
          messageId: 55,
        }),
      ).resolves.toEqual({ kind: 'saved' });
      const repaired = await s.findPreference(USER + index);
      expect(repaired?.language).toBe('fa');
      expect(repaired?.lastMessageId).toBe(55);
      expect(await rawValueJson(USER + index)).toBe(
        JSON.stringify({
          language: 'fa',
          changed_at_ms: NOW + 1,
          last_update_id: 100_001,
          last_message_id: 55,
        }),
      );
    }
    // The unrelated editorial row is untouched.
    const editorial = await executor.first<{ value_json: string }>({
      sql: 'SELECT value_json FROM settings WHERE key = ? LIMIT 1',
      params: ['editorial.language'],
    });
    expect(editorial?.value_json).toBe('"fa"');
  });

  it('keeps the fence STRONG for fully valid rows (recovery never weakens valid data)', async () => {
    const s = store();
    await s.savePreference({
      telegramUserId: USER,
      language: 'en',
      updateId: 41,
      changedAtMs: NOW + 10_000,
      messageId: 77,
    });
    const before = await rawValueJson(USER);
    // An older, perfectly shaped save still loses the fence.
    await expect(
      s.savePreference({
        telegramUserId: USER,
        language: 'fa',
        updateId: 42,
        changedAtMs: NOW,
        messageId: 78,
      }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(await rawValueJson(USER)).toBe(before);
    expect((await s.findPreference(USER))?.language).toBe('en');
  });
});
