import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createLogger } from '../../src/observability/logger';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { findPublishedPostBySource } from '../../src/adapters/db/inbound-store';
import { setPublishMode } from '../../src/adapters/db/publishing-settings-store';
import {
  SOUL_CURRENT_VERSION_SETTINGS_KEY,
  getCurrentSoulVersion,
  recordSoulVersion,
  setCurrentSoulVersion,
} from '../../src/adapters/db/soul-store';
import {
  createInboundPipelineService,
  type InboundPipelineService,
  type InboundProcessInput,
  type InboundTransport,
} from '../../src/application/inbound/inbound-pipeline-service';
import type { Clock } from '../../src/shared/time/clock';

/**
 * Slice 8 — Soul v1 stamping (DESIGN §9.3) over the real workerd D1
 * binding: the inbound publish path stamps the ACTIVE Soul version on
 * every `published_posts` row; with no Soul recorded the stamp is NULL
 * (legacy). The Telegram transport is faked (no network, no real Bot API);
 * every other layer — D1, migrations, stores, domain modules — is real.
 * No AI rewriter is wired: production ships AI_ENABLED off, so the
 * pipeline runs on the cleaned text — exactly the test-post path.
 */

const db: D1Database = env.DB;

const OWNER_ID = 1000000001;
const PV_CHAT_ID = 111111;
const DESTINATION = '@pixellores';
const NOW = 1_790_000_000_000;
const SOUL_SHA = 'a'.repeat(64);

let executor: DbExecutor;
let messageSeq = 0;
let updateSeq = 0;

function nextMessageId(): number {
  messageSeq += 1;
  return 100 + messageSeq;
}

function nextUpdateId(): number {
  updateSeq += 1;
  return 90000 + updateSeq;
}

function silentLogger() {
  return createLogger({ level: 'error', sink: () => {} });
}

function createFakeTransport(): { readonly transport: InboundTransport; readonly calls: number } {
  let calls = 0;
  let nextId = 5000;
  const transport: InboundTransport = {
    async sendMessageRich() {
      nextId += 1;
      calls += 1;
      return { messageId: nextId };
    },
    async sendPhotoRich() {
      nextId += 1;
      calls += 1;
      return { messageId: nextId };
    },
    async sendVideoRich() {
      nextId += 1;
      calls += 1;
      return { messageId: nextId };
    },
    async sendMessageClassic() {
      nextId += 1;
      calls += 1;
      return { messageId: nextId };
    },
    async editMessageTextRich() {
      return true;
    },
    async editMessageCaptionRich() {
      return true;
    },
    async editMessageTextClassic() {
      return true;
    },
    async deleteMessage() {
      return true;
    },
  };
  return {
    transport,
    get calls() {
      return calls;
    },
  };
}

function buildService(transport: InboundTransport): InboundPipelineService {
  const clock: Clock = { now: () => NOW };
  return createInboundPipelineService({
    executor,
    clock,
    logger: silentLogger(),
    config: { livePublishEnabled: true, destination: DESTINATION },
    transport,
  });
}

function inboundInput(
  overrides: Partial<InboundProcessInput> & { text: string },
): InboundProcessInput {
  return {
    chatId: PV_CHAT_ID,
    telegramUserId: OWNER_ID,
    role: 'owner',
    uiLanguage: 'en',
    updateId: nextUpdateId(),
    sourceMessageId: nextMessageId(),
    kind: 'message',
    hasText: true,
    richText: undefined,
    media: undefined,
    richCaption: undefined,
    inMediaGroup: false,
    hasMediaAttachment: false,
    ...overrides,
  };
}

async function seedSoul(version: number, pointer: boolean): Promise<void> {
  await recordSoulVersion(executor, {
    version,
    text: `Soul v${version}`,
    sha256: SOUL_SHA,
    createdBy: OWNER_ID,
    nowMs: NOW,
  });
  if (pointer) {
    await setCurrentSoulVersion(executor, { version, actorId: OWNER_ID, nowMs: NOW });
  }
}

beforeEach(async () => {
  executor = createDbExecutor(db);
  await applyMigrations(db);
  await executor.run({
    sql: `INSERT OR IGNORE INTO admins
            (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, ?, 'owner', 'active', ?, ?)`,
    params: [OWNER_ID, `admin-${OWNER_ID}`, NOW, NOW],
  });
  await setPublishMode(executor, { mode: 'auto', actorId: OWNER_ID, nowMs: NOW });
  // Soul state persists across tests in this file: reset it so each test
  // starts from the same (empty) Soul state.
  await executor.run({ sql: `DELETE FROM souls` });
  await executor.run({
    sql: `DELETE FROM settings WHERE key = ?`,
    params: [SOUL_CURRENT_VERSION_SETTINGS_KEY],
  });
});

describe('slice 8 — Soul v1 stamping (real D1, fake transport)', () => {
  it('resolves the active Soul version from the settings pointer', async () => {
    expect(await getCurrentSoulVersion(executor)).toBe(null);
    await seedSoul(1, false);
    expect(await getCurrentSoulVersion(executor)).toBe(1);
    await seedSoul(2, false);
    // No pointer: the highest recorded version wins.
    expect(await getCurrentSoulVersion(executor)).toBe(2);
    // A pointer wins over the highest version.
    await setCurrentSoulVersion(executor, { version: 1, actorId: OWNER_ID, nowMs: NOW });
    expect(await getCurrentSoulVersion(executor)).toBe(1);
    // A corrupt pointer falls back to the highest version, never throws.
    await executor.run({
      sql: `UPDATE settings SET value_json = ? WHERE key = ?`,
      params: ['{"version": "one"}', SOUL_CURRENT_VERSION_SETTINGS_KEY],
    });
    expect(await getCurrentSoulVersion(executor)).toBe(2);
  });

  it('refuses a duplicate Soul version (append-only)', async () => {
    await seedSoul(1, false);
    await expect(
      recordSoulVersion(executor, {
        version: 1,
        text: 'Soul v1 again',
        sha256: SOUL_SHA,
        createdBy: OWNER_ID,
        nowMs: NOW,
      }),
    ).rejects.toThrow();
    await expect(
      recordSoulVersion(executor, {
        version: 2,
        text: 'Soul v2',
        sha256: 'short',
        createdBy: OWNER_ID,
        nowMs: NOW,
      }),
    ).rejects.toThrow();
  });

  it('stamps soul_version 1 on a directly published inbound post', async () => {
    await seedSoul(1, true);
    const fake = createFakeTransport();
    const service = buildService(fake.transport);
    const sourceMessageId = nextMessageId();
    const result = await service.processInbound(
      inboundInput({
        sourceMessageId,
        text: '🔵 بازی «Hounded» برای PS5 در ۲۰۲۷ معرفی شد #تأییدشده\n\nبازی ماجراجویی سگ‌محور Hounded برای PS5 معرفی شد؛ نقش اصلی یک سگ Border Collie به نام Duke است.',
      }),
    );
    expect(result.kind).toBe('reply');
    const row = await findPublishedPostBySource(executor, {
      sourceChatId: PV_CHAT_ID,
      sourceMessageId,
    });
    expect(row).not.toBe(null);
    expect(row?.soulVersion).toBe(1);
    expect(row?.category).toBe('news');
  });

  it('stamps NULL when no Soul is recorded (legacy)', async () => {
    const fake = createFakeTransport();
    const service = buildService(fake.transport);
    const sourceMessageId = nextMessageId();
    const result = await service.processInbound(
      inboundInput({
        sourceMessageId,
        text: '🔵 بازی «Hounded» برای PS5 در ۲۰۲۷ معرفی شد #تأییدشده\n\nبازی ماجراجویی سگ‌محور Hounded برای PS5 معرفی شد.',
      }),
    );
    expect(result.kind).toBe('reply');
    const row = await findPublishedPostBySource(executor, {
      sourceChatId: PV_CHAT_ID,
      sourceMessageId,
    });
    expect(row).not.toBe(null);
    expect(row?.soulVersion).toBe(null);
  });
});
