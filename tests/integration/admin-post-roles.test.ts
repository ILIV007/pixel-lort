import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  handleTelegramWebhook,
  TELEGRAM_SECRET_HEADER,
} from '../../src/entrypoints/http/handlers/telegram-webhook';
import { applyMigrations } from '../helpers/migrations';
import { createLogger, type LogSink } from '../../src/observability/logger';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import {
  findPrimaryPublication,
  getApproval,
  getVersion,
} from '../../src/adapters/db/admin-post-store';
import { readPostContentDocument } from '../../src/domain/admin-post/post-content';

/**
 * R1.20-R1 — the SAFE three-role flow over the REAL webhook + REAL D1:
 *   editor (draft.create) captures -> reviewer (draft.view + draft.approve)
 *   previews THE EDITOR'S draft by id and approves the previewed version ->
 *   a publication.publish holder publishes it. The previewed, approved and
 *   sent fingerprints are proven IDENTICAL; foreign-draft access follows the
 *   existing blueprint permissions (draft.view) with no unintended
 *   disclosure; roles without the permissions get honest denials and
 *   button-free previews.
 */

const FAKE_WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';
const OWNER_ID = 1000000001; // also acts as the publisher (publication.publish)
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

const POST_TEXT = 'پست مشترک سه‌نقشی برای انتشار';
const POST_ENTITIES = [{ type: 'bold', offset: 0, length: 4 }];

interface CapturedLine {
  readonly msg: string;
  readonly [key: string]: unknown;
}

interface DeliveryResult {
  readonly status: number;
  readonly lines: CapturedLine[];
}

async function deliver(
  envOverrides: Record<string, unknown>,
  update: Record<string, unknown>,
): Promise<DeliveryResult> {
  const lines: CapturedLine[] = [];
  const sink: LogSink = (_level, line) => {
    lines.push(JSON.parse(line) as CapturedLine);
  };
  const logger = createLogger({ level: 'debug', sink });
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
  return { status: response.status, lines };
}

function textUpdate(
  updateId: number,
  fromId: number,
  text: string,
  chatId = fromId,
  entities?: unknown[],
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: chatId < 0 ? 'group' : 'private' },
      from: { id: fromId },
      text,
      ...(entities !== undefined ? { entities } : {}),
    },
  };
}

function callbackUpdate(updateId: number, fromId: number, token: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: fromId },
      data: `a:${token}`,
      message: { message_id: 9, chat: { id: fromId, type: 'private' } },
    },
  };
}

let executor: DbExecutor;
let updateSeq: number;

async function seedAdmin(id: number, role: string): Promise<void> {
  await executor.run({
    sql: `INSERT INTO admins (telegram_user_id, display_name, role, status, created_at, updated_at)
          VALUES (?, ?, ?, 'active', 1, 1)`,
    params: [id, `Admin ${id}`, role],
  });
}

/** The editor captures one version and returns the (draftId, version, fingerprint). */
async function editorCapturesPost(): Promise<{
  draftId: string;
  version: number;
  fingerprint: string;
}> {
  await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, EDITOR_ID, '/post'));
  await deliver(
    FLAG_ON_ENV,
    textUpdate(++updateSeq, EDITOR_ID, POST_TEXT, EDITOR_ID, POST_ENTITIES),
  );
  const draft = await getDraftRow(EDITOR_ID);
  if (draft === null) throw new Error('expected the editor draft to exist');
  const versionRow = await getVersion(executor, draft.id, draft.current_version);
  if (versionRow === null) throw new Error('expected the version row to exist');
  return { draftId: draft.id, version: draft.current_version, fingerprint: versionRow.fingerprint };
}

async function getDraftRow(userId: number) {
  return executor.first<{ id: string; current_version: number; status: string }>({
    sql: `SELECT id, current_version, status FROM admin_post_drafts
          WHERE created_by_user_id = ? AND status = 'open'
          ORDER BY updated_at_ms DESC LIMIT 1`,
    params: [userId],
  });
}

async function latestPreviewTokens(): Promise<{ approve: string | null; publish: string | null }> {
  const rows = await executor.query<{
    action: string;
    id: string;
  }>({
    sql: `SELECT action, id FROM admin_action_tokens
          WHERE action IN ('admin_post.approve', 'admin_post.publish')
          ORDER BY created_at DESC, rowid DESC LIMIT 2`,
  });
  let approve: string | null = null;
  let publish: string | null = null;
  for (const row of rows.rows) {
    if (row.action === 'admin_post.approve' && approve === null) approve = row.id;
    if (row.action === 'admin_post.publish' && publish === null) publish = row.id;
  }
  return { approve, publish };
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  executor = createDbExecutor(env.DB);
  updateSeq = 9400;
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
  await seedAdmin(OWNER_ID, 'owner');
  await seedAdmin(EDITOR_ID, 'editor');
  await seedAdmin(REVIEWER_ID, 'reviewer');
  await seedAdmin(SOURCE_MANAGER_ID, 'source_manager');
  await seedAdmin(VIEWER_ID, 'viewer');
});

describe('R1.20-R1 — the three-role flow (editor -> reviewer -> publisher)', () => {
  it('reviewer previews the EDITOR draft by id, approves the previewed version; the owner publishes the SAME fingerprint', async () => {
    const captured = await editorCapturesPost();

    // The REVIEWER previews the editor's draft by its id.
    const preview = await deliver(
      FLAG_ON_ENV,
      textUpdate(++updateSeq, REVIEWER_ID, `/post_preview ${captured.draftId}`),
    );
    // Offline mode: the preview content send fails retryably — but the
    // tokens were minted BEFORE the send (durable-first), so the approve
    // path is fully exercisable.
    expect(preview.status).toBe(503);
    const tokens = await latestPreviewTokens();
    expect(tokens.approve).not.toBeNull();
    // The reviewer holds NO publication.publish — no publish token exists.
    expect(tokens.publish).toBeNull();

    // Approve click — the reviewer approves THE PREVIEWED VERSION. (The
    // callback ANSWER is an outbound action -> honest 503 offline; the
    // approval itself was durably recorded BEFORE the answer.)
    const approved = await deliver(
      FLAG_ON_ENV,
      callbackUpdate(++updateSeq, REVIEWER_ID, tokens.approve!),
    );
    expect(approved.status).toBe(503);
    const approval = await getApproval(executor, captured.draftId, captured.version);
    expect(approval?.state).toBe('active');
    expect(approval?.fingerprint).toBe(captured.fingerprint);
    expect(approval?.approved_by_user_id).toBe(REVIEWER_ID);

    // The OWNER (publication.publish) previews and publishes. The LIVE
    // flag is explicitly on for this test — without BOT_TOKEN the honest
    // outcome is a claimed publication waiting under its lease.
    const liveEnv = { ...FLAG_ON_ENV, ADMIN_POST_LIVE_PUBLISH_ENABLED: 'true' };
    await deliver(liveEnv, textUpdate(++updateSeq, OWNER_ID, `/post_preview ${captured.draftId}`));
    const ownerTokens = await latestPreviewTokens();
    expect(ownerTokens.publish).not.toBeNull();
    const published = await deliver(
      liveEnv,
      callbackUpdate(++updateSeq, OWNER_ID, ownerTokens.publish!),
    );
    // The send is outbound (offline) -> retryable 503; the publication row
    // exists and is claimed/failed honestly — never silently skipped.
    expect(published.status).toBe(503);
    const publication = await findPrimaryPublication(executor, captured.draftId, captured.version);
    expect(publication).not.toBeNull();
    expect(publication?.fingerprint).toBe(captured.fingerprint);
    expect(['claimed', 'uncertain', 'failed_definitive']).toContain(publication?.state);
  });

  it('previewed == approved == sent fingerprints (the version identity contract)', async () => {
    const captured = await editorCapturesPost();

    // Reviewer preview + approve.
    await deliver(
      FLAG_ON_ENV,
      textUpdate(++updateSeq, REVIEWER_ID, `/post_preview ${captured.draftId}`),
    );
    const reviewerTokens = await latestPreviewTokens();
    await deliver(FLAG_ON_ENV, callbackUpdate(++updateSeq, REVIEWER_ID, reviewerTokens.approve!));

    // Owner preview + publish (LIVE flag on; offline transport => claimed).
    const liveEnv = { ...FLAG_ON_ENV, ADMIN_POST_LIVE_PUBLISH_ENABLED: 'true' };
    await deliver(liveEnv, textUpdate(++updateSeq, OWNER_ID, `/post_preview ${captured.draftId}`));
    const ownerTokens = await latestPreviewTokens();
    await deliver(liveEnv, callbackUpdate(++updateSeq, OWNER_ID, ownerTokens.publish!));

    // Read the STORED version bytes and re-derive the fingerprint from the
    // re-read content (R1.21: the stored document is the post-content doc).
    const versionRow = await getVersion(executor, captured.draftId, captured.version);
    const read = readPostContentDocument(versionRow!.envelope_json);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.document.media).toBe('none');
      expect(read.document.text?.text).toBe(POST_TEXT);
      expect(read.document.text?.entities).toEqual(POST_ENTITIES);
    }
    const publication = await findPrimaryPublication(executor, captured.draftId, captured.version);
    expect(versionRow!.fingerprint).toBe(captured.fingerprint);
    expect(publication!.fingerprint).toBe(captured.fingerprint);
    const approval = await getApproval(executor, captured.draftId, captured.version);
    expect(approval!.fingerprint).toBe(captured.fingerprint);
  });

  it('a preview by id WITHOUT draft.view is denied; a viewer (draft.view) gets a button-free preview', async () => {
    const captured = await editorCapturesPost();

    // source_manager has NO draft.view: honest localized denial.
    const denied = await deliver(
      FLAG_ON_ENV,
      textUpdate(++updateSeq, SOURCE_MANAGER_ID, `/post_preview ${captured.draftId}`),
    );
    expect(denied.status).toBe(503);
    const tokensAfterDenial = await latestPreviewTokens();
    expect(tokensAfterDenial.approve).toBeNull();

    // viewer HAS draft.view: the preview is delivered (content send fails
    // offline), but NO approve/publish token exists for them.
    const viewerPreview = await deliver(
      FLAG_ON_ENV,
      textUpdate(++updateSeq, VIEWER_ID, `/post_preview ${captured.draftId}`),
    );
    expect(viewerPreview.status).toBe(503);
    const viewerTokens = await executor.query<{ action: string; id: string }>({
      sql: `SELECT action, id FROM admin_action_tokens
            WHERE action IN ('admin_post.approve', 'admin_post.publish')`,
    });
    expect(viewerTokens.rows).toHaveLength(0);
  });

  it('an unknown or closed draft id gets ONE honest not-found answer (no existence disclosure)', async () => {
    await editorCapturesPost();
    const openDraft = await getDraftRow(EDITOR_ID);

    // Nonexistent id.
    const missing = await deliver(
      FLAG_ON_ENV,
      textUpdate(++updateSeq, REVIEWER_ID, '/post_preview no-such-draft-id'),
    );
    expect(missing.status).toBe(503);

    // Cancel the draft: the same answer shape, never an existence oracle.
    await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, EDITOR_ID, '/post_cancel'));
    const closed = await deliver(
      FLAG_ON_ENV,
      textUpdate(++updateSeq, REVIEWER_ID, `/post_preview ${openDraft!.id}`),
    );
    expect(closed.status).toBe(503);

    // No tokens were minted by either failed preview.
    const tokens = await executor.query<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_action_tokens',
    });
    expect(tokens.rows[0]?.count ?? 0).toBe(0);
  });

  it('a malformed /post_preview argument is rejected BEFORE any service call', async () => {
    const newline = await deliver(
      FLAG_ON_ENV,
      textUpdate(++updateSeq, REVIEWER_ID, '/post_preview\nid'),
    );
    expect(newline.status).toBe(503); // invalid usage reply
    const spaces = await deliver(
      FLAG_ON_ENV,
      textUpdate(++updateSeq, REVIEWER_ID, '/post_preview id with spaces'),
    );
    expect(spaces.status).toBe(503);
    const tokens = await executor.query<{ count: number }>({
      sql: 'SELECT COUNT(*) AS count FROM admin_action_tokens',
    });
    expect(tokens.rows[0]?.count ?? 0).toBe(0);
  });

  it('the editor still previews their OWN draft with no argument (and gets no buttons)', async () => {
    await editorCapturesPost();
    const own = await deliver(FLAG_ON_ENV, textUpdate(++updateSeq, EDITOR_ID, '/post_preview'));
    expect(own.status).toBe(503); // the content send attempted (offline)
    // The editor holds neither draft.approve nor publication.publish.
    const tokens = await executor.query<{ count: number }>({
      sql: `SELECT COUNT(*) AS count FROM admin_action_tokens
            WHERE action IN ('admin_post.approve', 'admin_post.publish')`,
    });
    expect(tokens.rows[0]?.count ?? 0).toBe(0);
  });
});
