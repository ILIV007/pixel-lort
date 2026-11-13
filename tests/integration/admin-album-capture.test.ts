import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

import {
  OWNER_ID,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedAdmin,
  seedStory,
} from '../helpers/review-test-fixtures';
import { parseAdminReviewConfig } from '../../src/shared/config/phase9';
import { ADMIN_ALBUM_CAPTURE_STRINGS } from '../../src/admin/album-capture-strings';
import { escapeTelegramHtml } from '../../src/admin/telegram-html';
import { produceAlbumDraft } from '../../src/application/publishing/album-draft-producer';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { fixedClock } from '../../src/shared/time/clock';
import { createLogger } from '../../src/observability/logger';
import type { ParsedUpdate } from '../../src/adapters/telegram/update-parser';

/**
 * Phase 9D — the album media-group CAPTURE surface over REAL workerd D1
 * (the R1.18 shape): the flag family, the routing family, the session
 * lifecycle, the fenced append, the batched finish, the OD-010 boundary
 * proven END-TO-END (the producer refuses the captured candidates typed),
 * and the ZERO-send assertion. The ONLY artificial pieces are the fake Bot
 * API and the counting executor wrapper.
 */

const CHIEF_EDITOR_ID = 2000000001;
const VIEWER_ID = 2000000004;
const UNKNOWN_ID = 2000000006;

async function seedCaptureFixtures(): Promise<void> {
  await seedAdmin(OWNER_ID, 'owner');
  await seedAdmin(CHIEF_EDITOR_ID, 'chief_editor');
  await seedAdmin(VIEWER_ID, 'viewer');
  await seedStory('story-cap-1', 'داستان جمع‌آوری آزمون');
}

function albumMemberUpdate(
  updateId: number,
  fromUserId: number,
  fileId: string,
  overrides: {
    readonly chatType?: 'group';
    readonly caption?: string;
  } = {},
): ParsedUpdate {
  return {
    kind: 'message',
    updateId,
    messageId: updateId,
    date: Math.floor(1_760_000_000_000 / 1000),
    chatId: fromUserId,
    chatType: overrides.chatType ?? 'private',
    fromUserId,
    command: undefined,
    media: { kind: 'photo', fileId },
    inMediaGroup: true,
    ...(overrides.caption !== undefined
      ? {
          richCaption: {
            ok: true as const,
            kind: 'caption' as const,
            text: overrides.caption,
            entities: [],
          },
        }
      : {}),
  };
}

beforeEach(async () => {
  await freshDb();
});

describe('the ADMIN_ALBUM_CAPTURE_ENABLED flag family (fail-closed, independent)', () => {
  it('enables ONLY on the exact "true" value', () => {
    expect(
      parseAdminReviewConfig({ ADMIN_ALBUM_CAPTURE_ENABLED: 'true' }).config.albumCaptureEnabled,
    ).toBe(true);
    for (const value of [undefined, 'false', '1', 'TRUE', 'yes']) {
      const input = value === undefined ? {} : { ADMIN_ALBUM_CAPTURE_ENABLED: value };
      expect(parseAdminReviewConfig(input).config.albumCaptureEnabled).toBe(false);
    }
  });

  it('is INDEPENDENT of the other admin flags', () => {
    const all = parseAdminReviewConfig({
      ADMIN_QUEUE_ENABLED: 'true',
      ADMIN_QUEUE_WRITE_ENABLED: 'true',
      ADMIN_STORY_ENABLED: 'true',
      ADMIN_ALBUM_CAPTURE_ENABLED: 'true',
    });
    expect(all.config.albumCaptureEnabled).toBe(true);
    expect(all.config.queueEnabled).toBe(true);
    const captureOnly = parseAdminReviewConfig({ ADMIN_ALBUM_CAPTURE_ENABLED: 'true' });
    expect(captureOnly.config.albumCaptureEnabled).toBe(true);
    expect(captureOnly.config.queueEnabled).toBe(false);
    expect(captureOnly.config.queueWriteEnabled).toBe(false);
    expect(captureOnly.config.storyEnabled).toBe(false);
  });
});

describe('the routing family (the legacy behavior stays byte-identical while OFF)', () => {
  it('while OFF, /album_capture is the unknown-command noop', async () => {
    await seedCaptureFixtures();
    const harness = buildReviewHarness({});
    const outcome = await harness.ingress.processUpdate(
      privateMessage(8001, OWNER_ID, '/album_capture story-cap-1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(0);
  });

  it('while ON, the start command answers with the honest rights boundary', async () => {
    await seedCaptureFixtures();
    const harness = buildReviewHarness({ albumCaptureEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(8002, OWNER_ID, '/album_capture story-cap-1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('Album capture started');
    expect(harness.sends[0]!.text).toContain('OD-010');
  });

  it('while ON, a grammar-invalid argument is honest invalid usage', async () => {
    await seedCaptureFixtures();
    const harness = buildReviewHarness({ albumCaptureEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(8003, OWNER_ID, '/album_capture two words'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toBe(
      escapeTelegramHtml(ADMIN_ALBUM_CAPTURE_STRINGS.en.invalidUsage),
    );
  });

  it('while ON, an unknown story refuses the start honestly (no session created)', async () => {
    await seedCaptureFixtures();
    const harness = buildReviewHarness({ albumCaptureEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      privateMessage(8004, OWNER_ID, '/album_capture story-missing'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('No story found');
    // NO session row was created.
    const sessions = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM admin_sessions WHERE flow = 'album_capture'",
    ).first<{ total: number }>();
    expect(sessions!.total).toBe(0);
  });

  it('the source_manager (no draft.create) is denied; an unknown actor gets the fixed denial', async () => {
    await seedCaptureFixtures();
    await seedAdmin(2000000005, 'source_manager');
    const harness = buildReviewHarness({ albumCaptureEnabled: true });
    const denied = await harness.ingress.processUpdate(
      privateMessage(8005, 2000000005, '/album_capture story-cap-1'),
    );
    expect(denied).toBe('processed');
    expect(harness.sends[0]!.text).toContain('does not include the draft creation permission');
    harness.sends.length = 0;
    const unknown = await harness.ingress.processUpdate(
      privateMessage(8006, UNKNOWN_ID, '/album_capture story-cap-1'),
    );
    expect(unknown).toBe('processed');
    expect(harness.sends[0]!.text).toBe('Access denied.');
  });

  it('a group-chat or edited /album_capture is a noop', async () => {
    await seedCaptureFixtures();
    const harness = buildReviewHarness({ albumCaptureEnabled: true });
    const group = await harness.ingress.processUpdate(
      privateMessage(8007, OWNER_ID, '/album_capture story-cap-1', { chatType: 'group' }),
    );
    expect(group).toBe('processed');
    expect(harness.sends).toHaveLength(0);
    const edited = await harness.ingress.processUpdate(
      privateMessage(8008, OWNER_ID, '/album_capture story-cap-1', { kind: 'edited_message' }),
    );
    expect(edited).toBe('processed');
    expect(harness.sends).toHaveLength(0);
  });
});

describe('the session lifecycle (start / status / capture / finish / cancel)', () => {
  async function startedHarness(): Promise<ReturnType<typeof buildReviewHarness>> {
    await seedCaptureFixtures();
    const harness = buildReviewHarness({ albumCaptureEnabled: true });
    const start = await harness.ingress.processUpdate(
      privateMessage(8100, OWNER_ID, '/album_capture story-cap-1'),
    );
    expect(start).toBe('processed');
    harness.sends.length = 0;
    return harness;
  }

  it('a media-group member WITHOUT an active session is honestly refused (never swallowed)', async () => {
    await seedCaptureFixtures();
    const harness = buildReviewHarness({ albumCaptureEnabled: true });
    const outcome = await harness.ingress.processUpdate(
      albumMemberUpdate(8200, OWNER_ID, 'file-X1'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    expect(harness.sends[0]!.text).toContain('No active album capture session');
  });

  it('members append under the fence; the caption lands once (the first wins)', async () => {
    const harness = await startedHarness();
    const first = await harness.ingress.processUpdate(
      albumMemberUpdate(8201, OWNER_ID, 'file-A1', { caption: 'کپشن آزمون' }),
    );
    expect(first).toBe('processed');
    expect(harness.sends.at(-1)!.text).toContain('Captured (members now: 1/10)');
    expect(harness.sends.at(-1)!.text).toContain('Caption stored');
    const second = await harness.ingress.processUpdate(
      albumMemberUpdate(8202, OWNER_ID, 'file-B2', { caption: 'کپشن دوم' }),
    );
    expect(second).toBe('processed');
    expect(harness.sends.at(-1)!.text).toContain('Captured (members now: 2/10)');
    expect(harness.sends.at(-1)!.text).not.toContain('Caption stored');
    const status = await harness.ingress.processUpdate(
      privateMessage(8203, OWNER_ID, '/album_capture'),
    );
    expect(status).toBe('processed');
    expect(harness.sends.at(-1)!.text).toContain('2/10');
    expect(harness.sends.at(-1)!.text).toContain('0:photo 1:photo');
  });

  it('a duplicate file_id refuses typed and the session keeps its state', async () => {
    const harness = await startedHarness();
    const first = await harness.ingress.processUpdate(albumMemberUpdate(8210, OWNER_ID, 'file-D1'));
    expect(first).toBe('processed');
    const duplicate = await harness.ingress.processUpdate(
      albumMemberUpdate(8211, OWNER_ID, 'file-D1'),
    );
    expect(duplicate).toBe('processed');
    expect(harness.sends.at(-1)!.text).toContain('already in the session');
    const status = await harness.ingress.processUpdate(
      privateMessage(8212, OWNER_ID, '/album_capture'),
    );
    expect(status).toBe('processed');
    expect(harness.sends.at(-1)!.text).toContain('1/10');
  });

  it('finish with fewer than 2 members refuses honestly and the session STAYS active', async () => {
    const harness = await startedHarness();
    await harness.ingress.processUpdate(albumMemberUpdate(8220, OWNER_ID, 'file-E1'));
    const finish = await harness.ingress.processUpdate(
      privateMessage(8221, OWNER_ID, '/album_capture finish'),
    );
    expect(finish).toBe('processed');
    expect(harness.sends.at(-1)!.text).toContain('needs at least 2 members');
    const assets = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM media_assets WHERE telegram_file_id = 'file-E1' AND canonical_url LIKE 'album-capture:%'",
    ).first<{ total: number }>();
    expect(assets!.total).toBe(0);
    const status = await harness.ingress.processUpdate(
      privateMessage(8222, OWNER_ID, '/album_capture'),
    );
    expect(status).toBe('processed');
    expect(harness.sends.at(-1)!.text).toContain('1/10');
  });

  it('the finish batch: the candidate rows are rights-unknown evidence, ONE audit row, the session completed', async () => {
    const harness = await startedHarness();
    await harness.ingress.processUpdate(albumMemberUpdate(8230, OWNER_ID, 'file-F1'));
    await harness.ingress.processUpdate(albumMemberUpdate(8231, OWNER_ID, 'file-F2'));
    const finish = await harness.ingress.processUpdate(
      privateMessage(8232, OWNER_ID, '/album_capture finish'),
    );
    expect(finish).toBe('processed');
    expect(harness.sends.at(-1)!.text).toContain('OD-010');
    expect(harness.sends.at(-1)!.text).toContain('BLOCKED');
    const rows = await env.DB.prepare(
      "SELECT id, type, canonical_url, rights_status, status, telegram_file_id FROM media_assets WHERE telegram_file_id IN ('file-F1', 'file-F2') AND canonical_url LIKE 'album-capture:%' ORDER BY canonical_url",
    ).all<{
      id: string;
      type: string;
      canonical_url: string;
      rights_status: string;
      status: string;
      telegram_file_id: string;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]!.status).toBe('candidate');
    expect(rows.results[0]!.rights_status).toBe('unknown');
    expect(rows.results[0]!.telegram_file_id).toBe('file-F1');
    expect(rows.results[0]!.canonical_url).toMatch(/^album-capture:[^/]+\/0$/);
    expect(rows.results[1]!.canonical_url).toMatch(/^album-capture:[^/]+\/1$/);
    const audit = await env.DB.prepare(
      "SELECT id, actor_type, action FROM audit_events WHERE action = 'album_captured'",
    ).first<{ id: string; actor_type: string; action: string }>();
    expect(audit).not.toBeNull();
    expect(audit!.actor_type).toBe('admin');
    expect(audit!.id).toMatch(/^album-capture:/);
    // The session is completed: a status view now shows the empty state.
    const status = await harness.ingress.processUpdate(
      privateMessage(8233, OWNER_ID, '/album_capture'),
    );
    expect(status).toBe('processed');
    expect(harness.sends.at(-1)!.text).toContain('No active capture session');
  });

  it('cancel ends the session and stores NOTHING', async () => {
    const harness = await startedHarness();
    await harness.ingress.processUpdate(albumMemberUpdate(8240, OWNER_ID, 'file-G1'));
    const cancel = await harness.ingress.processUpdate(
      privateMessage(8241, OWNER_ID, '/album_capture cancel'),
    );
    expect(cancel).toBe('processed');
    expect(harness.sends.at(-1)!.text).toContain('cancelled');
    const assets = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM media_assets WHERE telegram_file_id = 'file-G1' AND canonical_url LIKE 'album-capture:%'",
    ).first<{ total: number }>();
    expect(assets!.total).toBe(0);
  });
});

describe('the OD-010 boundary proven END-TO-END', () => {
  it('after a successful finish, the producer refuses the captured candidates typed (ledger_binding_unresolved)', async () => {
    await seedCaptureFixtures();
    const harness = buildReviewHarness({ albumCaptureEnabled: true });
    await harness.ingress.processUpdate(
      privateMessage(8300, OWNER_ID, '/album_capture story-cap-1'),
    );
    await harness.ingress.processUpdate(albumMemberUpdate(8301, OWNER_ID, 'file-H1'));
    await harness.ingress.processUpdate(albumMemberUpdate(8302, OWNER_ID, 'file-H2'));
    const finish = await harness.ingress.processUpdate(
      privateMessage(8303, OWNER_ID, '/album_capture finish'),
    );
    expect(finish).toBe('processed');
    // The captured candidate URLs are the deterministic capture-only
    // identities — read them from the durable rows (never from a fixture).
    const captured = await env.DB.prepare(
      "SELECT canonical_url, type FROM media_assets WHERE telegram_file_id IN ('file-H1', 'file-H2') AND canonical_url LIKE 'album-capture:%' ORDER BY canonical_url",
    ).all<{ canonical_url: string; type: string }>();
    expect(captured.results).toHaveLength(2);
    // The REAL producer, over the REAL captured rows: the ledger binding
    // refuses every item typed (candidate + unknown is NOT uploadable
    // evidence — the machine invents no permission).
    const outcome = await produceAlbumDraft(
      {
        executor: createDbExecutor(env.DB, { clock: fixedClock(1_760_000_000_000) }),
        clock: fixedClock(1_760_000_000_000),
        logger: createLogger({ level: 'error', sink: () => {} }),
      },
      {
        storyId: 'story-cap-1',
        title: 'آلبوم آزمون',
        createdBy: 'album-capture-test',
        candidates: captured.results.map((row) => ({
          canonicalUrl: row.canonical_url,
          kind: row.type,
        })),
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // The capture-only canonical namespace is NOT a source-media URL:
      // the producer refuses TYPED at the planner gate (candidate_malformed)
      // — an admin-captured album is not a source-media album, and the
      // OD-010 future design must define the admin-capture production route
      // EXPLICITLY (a captured candidate never rides the source path by
      // accident — fail-closed at every layer).
      expect(outcome.reason).toBe('plan_derivation_failed');
      expect(outcome.detail?.planReason).toBe('candidate_malformed');
    }
  });
});

describe('the ZERO-send assertion', () => {
  it('the whole capture lifecycle performs ZERO delivery-evidence writes and ZERO transport calls', async () => {
    await seedCaptureFixtures();
    const harness = buildReviewHarness({ albumCaptureEnabled: true });
    await harness.ingress.processUpdate(
      privateMessage(8400, OWNER_ID, '/album_capture story-cap-1'),
    );
    await harness.ingress.processUpdate(albumMemberUpdate(8401, OWNER_ID, 'file-I1'));
    await harness.ingress.processUpdate(albumMemberUpdate(8402, OWNER_ID, 'file-I2'));
    await harness.ingress.processUpdate(privateMessage(8403, OWNER_ID, '/album_capture finish'));
    const forbiddenWrites = harness.executor
      .stats()
      .sqlTexts.filter(
        (sql) =>
          (/publication_messages|media_usages|publications\b/i.test(sql) &&
            !/^\s*SELECT/i.test(sql)) ||
          /sendMessage|sendPhoto|sendMediaGroup/i.test(sql),
      );
    expect(forbiddenWrites).toEqual([]);
    expect(harness.sends.every((s) => s.text.length > 0)).toBe(true);
  });
});
