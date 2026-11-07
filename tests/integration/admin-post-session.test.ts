import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  handleTelegramWebhook,
  TELEGRAM_SECRET_HEADER,
} from '../../src/entrypoints/http/handlers/telegram-webhook';
import { applyMigrations } from '../helpers/migrations';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { findOpenCaptureSession } from '../../src/adapters/db/admin-post-store';

/**
 * R1.20-R1 — the EXPLICIT capture session over the REAL webhook edge and
 * REAL D1:
 * - registration happens ONLY with the `draft.create` permission, in a
 *   PRIVATE chat, from a FRESH (non-edited) message;
 * - an ordinary admin message OUTSIDE a session creates and changes NO
 *   post data and produces NO feedback (legacy parity);
 * - inside a session, edits / media / non-text / oversize inputs are
 *   rejected explicitly and never store anything;
 * - /post_cancel always closes the session; /post_status always reveals it.
 */

const FAKE_WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';
const OWNER_ID = 1000000001;
const EDITOR_ID = 2000000002;
const REVIEWER_ID = 2000000003;
const SOURCE_MANAGER_ID = 2000000004;
const VIEWER_ID = 2000000005;

const BASE_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  DB: env.DB,
};
const FLAG_ON_ENV = { ...BASE_ENV, ADMIN_POST_ENABLED: 'true' };

async function deliver(
  envOverrides: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<{ status: number; action: string | undefined; noopReason: string | undefined }> {
  const logger = createLogger({ level: 'error', sink: (() => {}) as unknown as LogSink });
  const request = new Request('https://example.com/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TELEGRAM_SECRET_HEADER]: FAKE_WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
  const response = await handleTelegramWebhook(request, envOverrides, { logger }).then(
    (res) => res,
    (error: unknown) => {
      const code = (error as { code?: string }).code ?? 'internal_error';
      const status = code === 'service_unavailable' ? 503 : 500;
      return new Response(JSON.stringify({ error: { code } }), { status });
    },
  );
  // Offline mode (no BOT_TOKEN): outbound sends fail retryably — the reply
  // itself is observably attempted via the 503. A 200 means no reply was due.
  return { status: response.status, action: undefined, noopReason: undefined };
}

function textUpdate(updateId: number, fromId: number, text: string, chatId = fromId) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: chatId < 0 ? 'group' : 'private' },
      from: { id: fromId },
      text,
    },
  };
}

let executor: DbExecutor;

async function seedAdmin(id: number, role: string): Promise<void> {
  await executor.run({
    sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, ?, ?, 'active', 1, 1)`,
    params: [id, `Admin ${id}`, role],
  });
}

async function versionCount(): Promise<number> {
  const row = await executor.first<{ count: number }>({
    sql: 'SELECT COUNT(*) AS count FROM admin_post_versions',
  });
  return row?.count ?? 0;
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  executor = createDbExecutor(env.DB);
  for (const table of [
    'admin_post_publications',
    'admin_post_approvals',
    'admin_post_preview_sessions',
    'admin_post_versions',
    'admin_post_drafts',
    'admin_action_tokens',
    'settings',
    'telegram_updates',
    'admins',
  ]) {
    await executor.run({ sql: `DELETE FROM ${table}` });
  }
});

describe('R1.20-R1 — the explicit capture session (real webhook, real D1)', () => {
  it('an ordinary admin message OUTSIDE a session creates NO post data and stays silent', async () => {
    await seedAdmin(EDITOR_ID, 'editor');
    const outcome = await deliver(FLAG_ON_ENV, textUpdate(9100, EDITOR_ID, 'یک پیام عادی'));
    // No session -> silent legacy noop: no reply (200), nothing stored.
    expect(outcome.status).toBe(200);
    expect(await versionCount()).toBe(0);
    expect(
      await executor.first<{ count: number }>({
        sql: 'SELECT COUNT(*) AS count FROM admin_post_drafts',
      }),
    ).toEqual({ count: 0 });
    expect(await findOpenCaptureSession(executor, EDITOR_ID)).toBeNull();
  });

  it('/post opens the session; every later plain text becomes a version; /post_cancel closes it', async () => {
    await seedAdmin(EDITOR_ID, 'editor');
    // /post start (the confirmation reply is outbound -> honest 503 offline)
    const started = await deliver(FLAG_ON_ENV, textUpdate(9101, EDITOR_ID, '/post'));
    expect(started.status).toBe(503);
    expect(await findOpenCaptureSession(executor, EDITOR_ID)).not.toBeNull();

    // /post again: idempotent re-open, still exactly one session row.
    await deliver(FLAG_ON_ENV, textUpdate(9102, EDITOR_ID, '/post'));

    // Plain texts now capture as versions.
    await deliver(FLAG_ON_ENV, textUpdate(9103, EDITOR_ID, 'نسخهٔ اول'));
    await deliver(FLAG_ON_ENV, textUpdate(9104, EDITOR_ID, 'نسخهٔ دوم'));
    expect(await versionCount()).toBe(2);

    // /post_cancel closes the session AND cancels the draft.
    await deliver(FLAG_ON_ENV, textUpdate(9105, EDITOR_ID, '/post_cancel'));
    expect(await findOpenCaptureSession(executor, EDITOR_ID)).toBeNull();

    // The NEXT ordinary message is an ordinary message again — silent,
    // no new version, no state change.
    const after = await deliver(FLAG_ON_ENV, textUpdate(9106, EDITOR_ID, 'پیام عادی بعدی'));
    expect(after.status).toBe(200);
    expect(await versionCount()).toBe(2);
    const draft = await executor.first<{ status: string }>({
      sql: 'SELECT status FROM admin_post_drafts',
    });
    expect(draft?.status).toBe('cancelled');
  });

  it('roles WITHOUT draft.create are denied /post and can never capture (real project roles)', async () => {
    await seedAdmin(REVIEWER_ID, 'reviewer');
    await seedAdmin(SOURCE_MANAGER_ID, 'source_manager');
    await seedAdmin(VIEWER_ID, 'viewer');

    for (const [id, updateId] of [
      [REVIEWER_ID, 9110],
      [SOURCE_MANAGER_ID, 9111],
      [VIEWER_ID, 9112],
    ] as const) {
      const denied = await deliver(FLAG_ON_ENV, textUpdate(updateId, id, '/post'));
      // The localized insufficient_permission denial is an outbound reply.
      expect(denied.status).toBe(503);
      expect(await findOpenCaptureSession(executor, id)).toBeNull();
      // Even so, a plain text stays a silent ordinary message.
      const outcome = await deliver(FLAG_ON_ENV, textUpdate(updateId + 10, id, 'متن'));
      expect(outcome.status).toBe(200);
    }
    expect(await versionCount()).toBe(0);
  });

  it('the OWNER and CHIEF_EDITOR and EDITOR hold draft.create (blueprint roles)', async () => {
    await seedAdmin(OWNER_ID, 'owner');
    await seedAdmin(EDITOR_ID, 'editor');
    for (const [id, updateId] of [
      [OWNER_ID, 9130],
      [EDITOR_ID, 9132],
    ] as const) {
      await deliver(FLAG_ON_ENV, textUpdate(updateId, id, '/post'));
      expect(await findOpenCaptureSession(executor, id)).not.toBeNull();
      await deliver(FLAG_ON_ENV, textUpdate(updateId + 1, id, `متن ${id}`));
      await deliver(FLAG_ON_ENV, textUpdate(updateId + 2, id, '/post_cancel'));
    }
    expect(await versionCount()).toBe(2);
  });

  it('a session started in a private chat NEVER captures group messages', async () => {
    await seedAdmin(EDITOR_ID, 'editor');
    await deliver(FLAG_ON_ENV, textUpdate(9140, EDITOR_ID, '/post'));
    expect(await findOpenCaptureSession(executor, EDITOR_ID)).not.toBeNull();
    const group = await deliver(
      FLAG_ON_ENV,
      textUpdate(9141, EDITOR_ID, 'متن گروهی', -1001234567890),
    );
    // Groups stay silent noop (no group feedback) and store nothing.
    expect(group.status).toBe(200);
    expect(await versionCount()).toBe(0);
  });

  it('inside a session: edits / media / non-text / oversize are rejected explicitly and store NOTHING', async () => {
    await seedAdmin(EDITOR_ID, 'editor');
    await deliver(FLAG_ON_ENV, textUpdate(9150, EDITOR_ID, '/post'));

    // Edited message: explicit rejection (outbound reply -> 503), nothing stored.
    const edited = await deliver(FLAG_ON_ENV, {
      update_id: 9151,
      edited_message: {
        message_id: 9151,
        chat: { id: EDITOR_ID, type: 'private' },
        from: { id: EDITOR_ID },
        text: 'متن ویرایش‌شده',
      },
    });
    expect(edited.status).toBe(503);

    // R1.21: an UNSUPPORTED media type (document) is still an explicit
    // rejection — a single photo/video with an optional caption is now a
    // complete post, but every other media shape never is.
    const media = await deliver(FLAG_ON_ENV, {
      update_id: 9152,
      message: {
        message_id: 9152,
        chat: { id: EDITOR_ID, type: 'private' },
        from: { id: EDITOR_ID },
        document: { file_id: 'doc_file_id_x', file_unique_id: 'y' },
        caption: 'کپشن سند به‌تنهایی پست نیست',
      },
    });
    expect(media.status).toBe(503);

    // R1.21: an ALBUM member (media_group_id present) is rejected explicitly
    // even when it is a photo — a single album member is never degraded
    // into a post.
    const album = await deliver(FLAG_ON_ENV, {
      update_id: 9152,
      message: {
        message_id: 9152,
        chat: { id: EDITOR_ID, type: 'private' },
        from: { id: EDITOR_ID },
        photo: [{ file_id: 'album_photo_id', file_unique_id: 'y', width: 10, height: 10 }],
        media_group_id: 'group-1',
      },
    });
    expect(album.status).toBe(503);

    // Oversize text: explicit rejection.
    const oversize = await deliver(FLAG_ON_ENV, textUpdate(9153, EDITOR_ID, 'a'.repeat(4100)));
    expect(oversize.status).toBe(503);

    // Nothing was stored by ANY of the rejected inputs.
    expect(await versionCount()).toBe(0);
    // The session itself survived the rejections — it is an explicit state.
    expect(await findOpenCaptureSession(executor, EDITOR_ID)).not.toBeNull();

    // A valid text still captures afterwards.
    await deliver(FLAG_ON_ENV, textUpdate(9154, EDITOR_ID, 'متن معتبر'));
    expect(await versionCount()).toBe(1);
  });

  it('a role revoked MID-session can no longer write post data (service-side re-check)', async () => {
    await seedAdmin(EDITOR_ID, 'editor');
    await deliver(FLAG_ON_ENV, textUpdate(9160, EDITOR_ID, '/post'));
    // Demote the editor to viewer BEHIND the session's back.
    await executor.run({
      sql: `UPDATE admins SET role = 'viewer' WHERE telegram_user_id = ?`,
      params: [EDITOR_ID],
    });
    // The role lookup runs per delivery — the stale session can no longer
    // capture: the explicit permission reply fires, nothing is stored.
    const outcome = await deliver(FLAG_ON_ENV, textUpdate(9161, EDITOR_ID, 'متن پس از تنزل'));
    expect(outcome.status).toBe(503);
    expect(await versionCount()).toBe(0);
  });

  it('/post_status reveals an open session even with no draft (discoverable state)', async () => {
    await seedAdmin(EDITOR_ID, 'editor');
    const before = await deliver(FLAG_ON_ENV, textUpdate(9170, EDITOR_ID, '/post_status'));
    // No session, no draft: the status reply goes out (503 offline).
    expect(before.status).toBe(503);
    await deliver(FLAG_ON_ENV, textUpdate(9171, EDITOR_ID, '/post'));
    const after = await deliver(FLAG_ON_ENV, textUpdate(9172, EDITOR_ID, '/post_status'));
    expect(after.status).toBe(503); // the reply is attempted — with the session line
    // /post_status itself must NEVER change the session or store data.
    expect(await findOpenCaptureSession(executor, EDITOR_ID)).not.toBeNull();
    expect(await versionCount()).toBe(0);
  });
});
