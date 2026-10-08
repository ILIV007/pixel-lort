import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { createAdminUiLanguageStore } from '../../src/adapters/db/admin-ui-language-store';

/**
 * REVIEWER REGRESSION TESTS (v1.2.5 review correction -> v1.2.6).
 *
 * Attached verbatim by the independent reviewer of the Phase 2B UI-language
 * delivery and added to the suite unchanged (formatting per the repo
 * Prettier profile only). They pin the two correction contracts:
 *   1. Preference ordering is NOT the update_id number (Telegram may
 *      randomize update_id after one week without updates) — a genuinely
 *      newer private message with a LOWER update_id must be accepted.
 *   2. An unreadable stored preference never blocks the next valid save
 *      (safe atomic recovery inside the dedicated admin-UI namespace).
 */

const USER = 555000111;
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await applyMigrations(env.DB);
  await createDbExecutor(env.DB).run({ sql: 'DELETE FROM settings' });
});

it('accepts a genuinely newer selection after Telegram randomizes update_id following a week idle', async () => {
  const store = createAdminUiLanguageStore(createDbExecutor(env.DB));
  await store.savePreference({
    telegramUserId: USER,
    language: 'en',
    updateId: 9_000_000,
    changedAtMs: NOW,
  });
  // Telegram documents that the next update_id after >=1 week idle is random.
  // This distinct new update has a smaller id, but is eight days newer.
  const later = await store.savePreference({
    telegramUserId: USER,
    language: 'fa',
    updateId: 100_000,
    changedAtMs: NOW + 8 * 86400_000,
  });
  expect(later).toEqual({ kind: 'saved' });
  expect((await store.findPreference(USER))?.language).toBe('fa');
});

it('repairs an unreadable preference as promised by the storage contract', async () => {
  const executor = createDbExecutor(env.DB);
  await executor.run({
    sql: 'INSERT INTO settings (key,value_json,schema_version,updated_by,updated_at) VALUES (?, ?, 1, NULL, ?)',
    params: [`admin_ui_language:${USER}`, '{broken', NOW],
  });
  const store = createAdminUiLanguageStore(executor);
  expect(await store.findPreference(USER)).toBeNull();
  await expect(
    store.savePreference({
      telegramUserId: USER,
      language: 'fa',
      updateId: 100_001,
      changedAtMs: NOW + 1,
    }),
  ).resolves.toEqual({ kind: 'saved' });
});
