import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { createTelegramIngress } from '../../src/application/telegram-ingress';
import { createAuthorizationService } from '../../src/admin/authorization';
import { createCommandRouter } from '../../src/admin/command-router';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { createAdminRoleLookup } from '../../src/adapters/telegram/admin-lookup';
import { parseTelegramUpdate } from '../../src/adapters/telegram/update-parser';
import type {
  TelegramBotApiClient,
  TelegramSentMessage,
} from '../../src/adapters/telegram/bot-api-client';
import { applyMigrations } from '../helpers/migrations';
import { createLogger, type LogSink } from '../../src/observability/logger';

/**
 * Admin UI language end-to-end behavior over the real workerd D1 binding
 * (v1.2.5, ADR-0034; write ordering corrected in v1.2.6 — ADR-0035):
 * English default, per-admin persistence, admin isolation, bootstrap-owner
 * support without an admins row, ordering by Telegram message metadata
 * (older retried messages never overwrite newer choices), honest failure
 * handling, and STRICT separation from the editorial language settings.
 *
 * The pipeline runs exactly as the webhook handler wires it; the Bot API
 * client is a stub that CAPTURES outbound messages so the rendered admin UI
 * language is observable without any live Telegram connection.
 */

const OWNER_ID = 1000000001;
const EDITOR_ID = 2000000002;
const OTHER_ADMIN_ID = 2000000004;
const DISABLED_ID = 2000000003;
const UNKNOWN_ID = 2999999999;
const NOW = 1_700_000_000_000;

interface CapturedLine {
  readonly msg: string;
  readonly [key: string]: unknown;
}

function captureLogger(): { lines: CapturedLine[]; logger: ReturnType<typeof createLogger> } {
  const lines: CapturedLine[] = [];
  const sink: LogSink = (_level, line) => {
    lines.push(JSON.parse(line) as CapturedLine);
  };
  return { lines, logger: createLogger({ level: 'debug', sink }) };
}

/** Stub Bot API client recording every sent message text. */
function stubBotApi(sent: { texts: string[] }): TelegramBotApiClient {
  return {
    async sendMessage(input: { chatId: number; text: string }): Promise<TelegramSentMessage> {
      sent.texts.push(input.text);
      return { messageId: sent.texts.length };
    },
    async answerCallbackQuery(): Promise<void> {},
  } as unknown as TelegramBotApiClient;
}

function messageUpdate(
  updateId: number,
  fromId: number,
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      // Server-assigned message time (Unix seconds): Telegram always sends
      // it; the ordering fence (ADR-0035) reads it. Derived from the update
      // id here so the classic fixtures stay chronologically monotonic.
      date: 1_700_000_000 + updateId,
      chat: { id: fromId, type: 'private' },
      from: { id: fromId },
      text,
      ...overrides,
    },
  };
}

/**
 * A private message update with EXPLICIT order metadata — used to build the
 * correction scenarios Telegram can really produce: a newer message with a
 * LOWER update_id (randomized after a week idle), a same-second pair, or an
 * older message delivered late.
 */
function orderedMessageUpdate(
  updateId: number,
  messageId: number,
  dateSeconds: number,
  fromId: number,
  text: string,
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: dateSeconds,
      chat: { id: fromId, type: 'private' },
      from: { id: fromId },
      text,
    },
  };
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  const executor = createDbExecutor(env.DB);
  await executor.run({ sql: 'DELETE FROM telegram_updates' });
  await executor.run({ sql: 'DELETE FROM admins' });
  await executor.run({ sql: 'DELETE FROM settings' });
  const seed = (userId: number, role: string, status: string) =>
    executor.run({
      sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [userId, 'Test Admin', role, status, NOW, NOW],
    });
  await seed(EDITOR_ID, 'editor', 'active');
  await seed(OTHER_ADMIN_ID, 'viewer', 'active');
  await seed(DISABLED_ID, 'reviewer', 'disabled');
});

async function process(
  update: Record<string, unknown>,
): Promise<{ status: number; sent: string[]; lines: CapturedLine[] }> {
  const parsed = parseTelegramUpdate(update);
  if (!parsed.ok) {
    throw new Error(`test update failed to parse: ${parsed.reason}`);
  }
  const sent: { texts: string[] } = { texts: [] };
  const { lines, logger } = captureLogger();
  const executor = createDbExecutor(env.DB);
  const ingress = createTelegramIngress({
    executor,
    authorization: createAuthorizationService({
      ownerTelegramId: OWNER_ID,
      lookup: createAdminRoleLookup(executor),
    }),
    commandRouter: createCommandRouter({ applicationVersion: '1.2.6' }),
    botApi: stubBotApi(sent),
    clock: { now: () => NOW },
    logger,
  });
  try {
    await ingress.processUpdate(parsed.update);
    return { status: 200, sent: sent.texts, lines };
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'internal_error';
    return { status: code === 'service_unavailable' ? 503 : 500, sent: sent.texts, lines };
  }
}

async function storedLanguage(userId: number): Promise<string | null> {
  const executor = createDbExecutor(env.DB);
  const row = await executor.first<{ value_json: string }>({
    sql: 'SELECT value_json FROM settings WHERE key = ? LIMIT 1',
    params: [`admin_ui_language:${userId}`],
  });
  if (row === null) return null;
  return (JSON.parse(row.value_json) as { language?: string }).language ?? null;
}

describe('English default (no stored preference)', () => {
  it('serves the bootstrap owner ENGLISH without any admins-table row or preference', async () => {
    const { status, sent } = await process(messageUpdate(9001, OWNER_ID, '/start'));
    expect(status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('Admin panel is active.');
    expect(sent[0]).not.toContain('پنل مدیریت');
    expect(await storedLanguage(OWNER_ID)).toBeNull();
  });

  it('serves an admin with no preference ENGLISH for /help and /version', async () => {
    const help = await process(messageUpdate(9002, EDITOR_ID, '/help'));
    expect(help.status).toBe(200);
    expect(help.sent[0]).toContain('Commands');

    const version = await process(messageUpdate(9003, EDITOR_ID, '/version'));
    expect(version.sent[0]).toBe('Application version: 1.2.6');
  });

  it('answers the bare /language with the English status and usage hint', async () => {
    const { sent } = await process(messageUpdate(9004, OWNER_ID, '/language'));
    expect(sent[0]).toContain('Admin UI language');
    expect(sent[0]).toContain('Current: English');
    expect(sent[0]).toContain('/language fa');
  });
});

describe('selection, switching back, and persistence across new requests', () => {
  it('switches to Persian, then serves every later command in Persian', async () => {
    const change = await process(messageUpdate(9010, EDITOR_ID, '/language fa'));
    expect(change.status).toBe(200);
    // Confirmation is in the language the admin switched TO.
    expect(change.sent).toEqual(['زبان رابط مدیریت به فارسی تغییر کرد.']);
    expect(await storedLanguage(EDITOR_ID)).toBe('fa');

    const start = await process(messageUpdate(9011, EDITOR_ID, '/start'));
    expect(start.sent[0]).toContain('پنل مدیریت فعال است.');

    const help = await process(messageUpdate(9012, EDITOR_ID, '/help'));
    expect(help.sent[0]).toContain('دستورها');

    const version = await process(messageUpdate(9013, EDITOR_ID, '/version'));
    expect(version.sent[0]).toBe('نسخه برنامه: 1.2.6');
  });

  it('switches back to English and confirms in English', async () => {
    await process(messageUpdate(9020, EDITOR_ID, '/language fa'));
    const back = await process(messageUpdate(9021, EDITOR_ID, '/language en'));
    expect(back.sent).toEqual(['Admin UI language set to English.']);
    expect(await storedLanguage(EDITOR_ID)).toBe('en');

    const start = await process(messageUpdate(9022, EDITOR_ID, '/start'));
    expect(start.sent[0]).toContain('Admin panel is active.');
  });

  it('persists the owner preference across new requests (bootstrap owner, no admins row)', async () => {
    const change = await process(messageUpdate(9030, OWNER_ID, '/language fa'));
    expect(change.status).toBe(200);
    expect(change.sent).toEqual(['زبان رابط مدیریت به فارسی تغییر کرد.']);

    const status = await process(messageUpdate(9031, OWNER_ID, '/status'));
    expect(status.sent[0]).toContain('وضعیت');
    expect(await storedLanguage(OWNER_ID)).toBe('fa');
  });

  it('accepts case-insensitive arguments and reports the current language on bare /language', async () => {
    await process(messageUpdate(9040, EDITOR_ID, '/language  FA '));
    expect(await storedLanguage(EDITOR_ID)).toBe('fa');

    const bare = await process(messageUpdate(9041, EDITOR_ID, '/language'));
    expect(bare.sent[0]).toContain('فارسی');
  });
});

describe('per-admin isolation', () => {
  it('never lets one admin\u2019s preference affect another admin', async () => {
    await process(messageUpdate(9050, EDITOR_ID, '/language fa'));
    // The other admin still defaults to English.
    const other = await process(messageUpdate(9051, OTHER_ADMIN_ID, '/start'));
    expect(other.sent[0]).toContain('Admin panel is active.');
    expect(await storedLanguage(OTHER_ADMIN_ID)).toBeNull();

    // Switching the other admin leaves the first admin's choice intact.
    await process(messageUpdate(9052, OTHER_ADMIN_ID, '/language en'));
    expect(await storedLanguage(EDITOR_ID)).toBe('fa');
    expect(await storedLanguage(OTHER_ADMIN_ID)).toBe('en');
  });

  it('scopes the Persian rendering strictly to the admin who selected it', async () => {
    await process(messageUpdate(9053, OWNER_ID, '/language fa'));
    const editorView = await process(messageUpdate(9054, EDITOR_ID, '/status'));
    expect(editorView.sent[0]).toContain('Application version:');
    const ownerView = await process(messageUpdate(9055, OWNER_ID, '/status'));
    expect(ownerView.sent[0]).toContain('نسخه برنامه:');
  });
});

describe('authorization and chat-scope guards', () => {
  it('denies an unknown user with no preference write', async () => {
    const { status, sent } = await process(messageUpdate(9060, UNKNOWN_ID, '/language fa'));
    // The denial is outbound; with the stub client it succeeds (200) and the
    // captured text is the minimal English denial.
    expect(status).toBe(200);
    expect(sent).toEqual(['Access denied.']);
    expect(await storedLanguage(UNKNOWN_ID)).toBeNull();
  });

  it('denies a disabled admin with no preference write', async () => {
    const { sent } = await process(messageUpdate(9061, DISABLED_ID, '/language fa'));
    expect(sent).toEqual(['Access denied.']);
    expect(await storedLanguage(DISABLED_ID)).toBeNull();
  });

  it('ignores /language in group chats — no feedback and no write', async () => {
    const update = messageUpdate(9062, OWNER_ID, '/language fa', {
      chat: { id: -100999, type: 'group' },
    });
    const { status, sent } = await process(update);
    expect(status).toBe(200);
    expect(sent).toEqual([]);
    expect(await storedLanguage(OWNER_ID)).toBeNull();
  });

  it('ignores /language in edited messages — no feedback and no write', async () => {
    const update = {
      update_id: 9063,
      edited_message: {
        message_id: 9063,
        chat: { id: OWNER_ID, type: 'private' },
        from: { id: OWNER_ID },
        text: '/language fa',
      },
    };
    const { status, sent } = await process(update);
    expect(status).toBe(200);
    expect(sent).toEqual([]);
    expect(await storedLanguage(OWNER_ID)).toBeNull();
  });

  it('ignores a /language change without ordering metadata — no feedback and no write', async () => {
    // A private /language fa whose message carries NO `date`: there is no
    // trustworthy message order, so the change fails safely (noop) — no
    // reply, no state change, no invented ordering from local arrival time.
    const noDate = messageUpdate(9067, OWNER_ID, '/language fa');
    delete (noDate['message'] as Record<string, unknown>)['date'];
    const missing = await process(noDate);
    expect(missing.status).toBe(200);
    expect(missing.sent).toEqual([]);
    const processed = missing.lines.find((l) => l.msg === 'telegram.update.processed');
    expect(processed?.['noopReason']).toBe('language_missing_ordering_metadata');
    expect(await storedLanguage(OWNER_ID)).toBeNull();

    // An INVALID date (numeric string, garbage, beyond the validated bound)
    // is treated as absent by the parser — the same fail-safe path.
    for (const [updateId, date] of [
      [9068, '1700000000'],
      [9069, 99_999_999_999],
      [9070, 1.5],
    ] as const) {
      const update = messageUpdate(updateId, OWNER_ID, '/language fa', { date });
      const result = await process(update);
      expect(result.status).toBe(200);
      expect(result.sent).toEqual([]);
      expect(await storedLanguage(OWNER_ID)).toBeNull();
    }
  });

  it('answers malformed arguments with the usage text and NO state change', async () => {
    for (const [updateId, text] of [
      [9064, '/language fr'],
      [9065, '/language fa extra'],
      [9066, '/language <script>'],
    ] as const) {
      const { sent } = await process(messageUpdate(updateId, OWNER_ID, text));
      expect(sent[0]).toContain('Admin UI language');
      expect(sent[0]).toContain('/language fa');
    }
    expect(await storedLanguage(OWNER_ID)).toBeNull();
  });
});

describe('durable fencing of older retried messages', () => {
  it('rejects an older retried language change and keeps the newer choice', async () => {
    // Newer choice first (message sent later per Telegram order).
    await process(messageUpdate(9071, EDITOR_ID, '/language fa'));
    // An OLDER message (update_id 9070) is redelivered afterwards.
    const stale = await process(messageUpdate(9070, EDITOR_ID, '/language en'));
    expect(stale.status).toBe(200);
    // Honest stale reply in the admin's CURRENT (Persian) language.
    expect(stale.sent).toEqual(['اعمال نشد: انتخاب جدیدتری برای زبان ذخیره شده است.']);
    expect(await storedLanguage(EDITOR_ID)).toBe('fa');
  });

  it('applies an older message that arrives before any newer choice', async () => {
    const first = await process(messageUpdate(9080, EDITOR_ID, '/language fa'));
    expect(first.sent).toEqual(['زبان رابط مدیریت به فارسی تغییر کرد.']);
    // A redelivery of the SAME update is a terminal duplicate, re-answered
    // without re-execution.
    const duplicate = await process(messageUpdate(9080, EDITOR_ID, '/language fa'));
    expect(duplicate.status).toBe(200);
    expect(duplicate.sent).toEqual([]);
  });
});

describe('message-order fencing, not update_id (v1.2.6, ADR-0035)', () => {
  const S0 = 1_700_000_000;

  it('accepts a genuinely newer private message with a LOWER update_id (randomized after idle)', async () => {
    // Telegram may randomize update_id after one week without updates: the
    // first message carries a HIGH update_id, the later one a LOW one.
    await process(orderedMessageUpdate(9200, 9200, S0, EDITOR_ID, '/language fa'));
    expect(await storedLanguage(EDITOR_ID)).toBe('fa');

    // Eight days NEWER by Telegram's server date, lower update_id: accepted.
    const newer = await process(
      orderedMessageUpdate(9100, 9201, S0 + 8 * 86400, EDITOR_ID, '/language en'),
    );
    expect(newer.status).toBe(200);
    expect(newer.sent).toEqual(['Admin UI language set to English.']);
    expect(await storedLanguage(EDITOR_ID)).toBe('en');
  });

  it('never lets an older message that arrives later overwrite the newer choice', async () => {
    await process(orderedMessageUpdate(9300, 9300, S0 + 200, EDITOR_ID, '/language fa'));
    expect(await storedLanguage(EDITOR_ID)).toBe('fa');

    // A genuinely OLDER message (earlier server date AND lower message_id)
    // delivered late under a FRESH update id: rejected, nothing overwritten.
    const late = await process(
      orderedMessageUpdate(9400, 9299, S0 + 50, EDITOR_ID, '/language en'),
    );
    expect(late.status).toBe(200);
    expect(late.sent).toEqual(['اعمال نشد: انتخاب جدیدتری برای زبان ذخیره شده است.']);
    expect(await storedLanguage(EDITOR_ID)).toBe('fa');
  });

  it('orders same-second messages by message_id and treats duplicates idempotently', async () => {
    const S1 = S0 + 300;
    // Two commands inside the SAME server second: the higher message_id is
    // the later message, whichever order they are DELIVERED in.
    const laterFirst = await process(
      orderedMessageUpdate(9500, 9501, S1, EDITOR_ID, '/language fa'),
    );
    expect(laterFirst.sent).toEqual(['زبان رابط مدیریت به فارسی تغییر کرد.']);
    const earlierSameSecond = await process(
      orderedMessageUpdate(9501, 9500, S1, EDITOR_ID, '/language en'),
    );
    expect(earlierSameSecond.status).toBe(200);
    expect(earlierSameSecond.sent).toEqual(['اعمال نشد: انتخاب جدیدتری برای زبان ذخیره شده است.']);
    expect(await storedLanguage(EDITOR_ID)).toBe('fa');

    // A genuine same-second LATER message (higher message_id) wins.
    const newerSameSecond = await process(
      orderedMessageUpdate(9502, 9502, S1, EDITOR_ID, '/language en'),
    );
    expect(newerSameSecond.sent).toEqual(['Admin UI language set to English.']);
    expect(await storedLanguage(EDITOR_ID)).toBe('en');

    // Duplicate delivery of the SAME update: terminal duplicate — answered
    // 200 without re-execution and without re-writing anything.
    const duplicate = await process(
      orderedMessageUpdate(9502, 9502, S1, EDITOR_ID, '/language en'),
    );
    expect(duplicate.status).toBe(200);
    expect(duplicate.sent).toEqual([]);
    expect(await storedLanguage(EDITOR_ID)).toBe('en');
  });
});

describe('strict separation from editorial language settings', () => {
  it('leaves editorial language settings untouched by UI language changes', async () => {
    const executor = createDbExecutor(env.DB);
    // An editorial-namespaced settings row (channel/editorial language lives
    // OUTSIDE the admin_ui_language: namespace).
    await executor.run({
      sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
            VALUES ('editorial.language', '"fa"', 1, NULL, ?)`,
      params: [NOW],
    });

    const change = await process(messageUpdate(9100, EDITOR_ID, '/language en'));
    expect(change.status).toBe(200);
    expect(await storedLanguage(EDITOR_ID)).toBe('en');

    // The editorial setting is byte-identical to before.
    const editorial = await executor.first<{ value_json: string }>({
      sql: 'SELECT value_json FROM settings WHERE key = ? LIMIT 1',
      params: ['editorial.language'],
    });
    expect(editorial?.value_json).toBe('"fa"');

    // Exactly ONE new settings row was created, under the dedicated namespace.
    const rows = await executor.query<{ key: string }>({
      sql: 'SELECT key FROM settings',
    });
    expect(rows.rows.map((r) => r.key).sort()).toEqual([
      'admin_ui_language:2000000002',
      'editorial.language',
    ]);
  });

  it('keeps the drafts editorial default (fa) untouched and authoritative', async () => {
    // The editorial language contract lives in the schema/blueprint: the
    // drafts table default stays Persian regardless of any admin UI choice.
    const row = await createDbExecutor(env.DB).first<{ sql: string }>({
      sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'drafts'",
    });
    expect(row?.sql).toContain("language TEXT NOT NULL DEFAULT 'fa'");
  });
});
