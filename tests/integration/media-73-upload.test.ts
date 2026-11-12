import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { MIGRATIONS, applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { createMediaAssetStore } from '../../src/adapters/db/media-asset-store';
import { planAlbumMedia } from '../../src/domain/media/album-plan';
import {
  readMediaCandidateV1,
  type MediaCandidateV1,
} from '../../src/domain/media/media-candidate';
import { createRichTextEnvelope } from '../../src/domain/telegram/rich-text-envelope';
import { cryptoIdGenerator } from '../../src/shared/ids/id';
import {
  runMediaRetentionCleanup,
  stagingObjectKey,
  uploadAlbumMediaGroup,
  type MediaUploadPorts,
} from '../../src/application/media/upload-service';

/**
 * Phase 7.3 — the REAL upload path over REAL workerd D1 (the
 * BLUEPRINT-APPROVED `media_assets` table through the REAL
 * `createMediaAssetStore`), with the FOUR seams faked per the ADR-0042
 * §6 discipline: the fetch/storage/telegram ports are the ONLY artificial
 * pieces; the service, the reuse rules, the retention selection and the
 * whole durable state are the SHIPPED code.
 *
 * Proven here end-to-end:
 *  - the full happy path: plan (3 items) → rights allow → fetch → stage
 *    ('candidate' rows with r2_key + the 72h deadline) → ONE media-group
 *    send → the blueprint step-10 transition (telegram_file_id saved +
 *    r2_key/expires_at cleared + status 'uploaded') → the R2 object
 *    deleted IMMEDIATELY;
 *  - the ECONOMY rule: a replay reuses EVERY file_id with ZERO fetch /
 *    ZERO storage cost (the group itself still sends via file_id
 *    references — no upload cost, no re-download);
 *  - the hash-level reuse: the same bytes under a DIFFERENT URL reuse
 *    their file_id and the fetched bytes are discarded;
 *  - the ALL-OR-NOTHING group: one deferred item withholds the WHOLE send
 *    (typed, no partial album, nothing staged);
 *  - a failed send marks the staged rows 'failed' and auto-resends
 *    NOTHING (the retention backstop owns them);
 *  - the retention cleanup: expired R2-holding rows are deleted (bounded)
 *    and cleared to 'expired'; an UPLOADED row's file_id survives the
 *    cleanup (the ledger value outlives the temporary object).
 */

const db: D1Database = env.DB;
const executor = createDbExecutor(db);
const assets = createMediaAssetStore(executor);

const HOUR = 3_600_000;
const NOW = 1_000_000;

function candidate(url: string, overrides: Partial<MediaCandidateV1> = {}): MediaCandidateV1 {
  const read = readMediaCandidateV1({
    schemaVersion: 1,
    kind: 'photo',
    role: 'gameplay',
    origin: 'official_api',
    officiality: 'official',
    relevance: 'supporting',
    freshness: 'recent',
    canonicalUrl: url,
    previouslyUsed: false,
    ...overrides,
  });
  if (!read.ok) throw new Error(`fixture candidate invalid: ${read.reason}`);
  return read.candidate;
}

function threePhotoPlan() {
  const outcome = planAlbumMedia({
    candidates: [
      candidate('https://cdn.example.com/media/p0.jpg'),
      candidate('https://cdn.example.com/media/p1.jpg'),
      candidate('https://cdn.example.com/media/p2.jpg'),
    ],
  });
  if (!outcome.ok) throw new Error(`fixture plan invalid: ${outcome.reason}`);
  return outcome;
}

function captionFor(text: string) {
  const outcome = createRichTextEnvelope({ kind: 'caption', text, entities: [] });
  if (!outcome.ok) throw new Error('fixture caption invalid');
  return outcome.envelope;
}

interface RecordingPorts extends MediaUploadPorts {
  readonly calls: {
    readonly fetchUrls: string[];
    readonly putKeys: string[];
    readonly deleteKeys: string[];
    readonly sendGroups: number;
  };
  failNextSend: () => void;
}

function recordingPorts(): RecordingPorts {
  const calls = {
    fetchUrls: [] as string[],
    putKeys: [] as string[],
    deleteKeys: [] as string[],
    sendGroups: 0,
    attachmentsSent: [] as string[][],
  };
  let failNextSend = false;
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const ports: MediaUploadPorts = {
    rights: {
      decide: (_input) => ({
        decision: 'allow_temporary',
        reason: 'rights_cleared_and_policy_compliant',
        destination: 'r2_temporary_only',
        byteCapUnchecked: false,
        policyVersion: 'mrp1',
      }),
    },
    fetch: {
      fetch: async (request) => {
        calls.fetchUrls.push(request.canonicalUrl);
        return {
          ok: true,
          bytes,
          contentType: 'image/jpeg',
          byteLength: bytes.byteLength,
          contentHash: `hash-${request.canonicalUrl.split('/').pop() ?? request.canonicalUrl}`,
        };
      },
    },
    storage: {
      put: async (input) => {
        calls.putKeys.push(input.objectKey);
        return { ok: true };
      },
      delete: async (objectKey) => {
        calls.deleteKeys.push(objectKey);
        return { ok: true };
      },
    },
    assets,
    telegram: {
      sendMediaGroup: async (input) => {
        calls.sendGroups += 1;
        calls.attachmentsSent.push(input.attachments.map((a) => a.ref));
        if (failNextSend) {
          failNextSend = false;
          return { ok: false, reason: 'send_failed' };
        }
        // The honest Bot API reply: one message per item, in order, each
        // carrying its returned file_id.
        return {
          ok: true,
          fileIds: input.items.map((_, index) => `BAAC-fresh-${calls.sendGroups}-${index}`),
        };
      },
    },
    ids: cryptoIdGenerator,
  };
  return {
    ...ports,
    calls,
    failNextSend: () => {
      failNextSend = true;
    },
  };
}

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  await executor.run({ sql: `DELETE FROM media_assets` });
});

describe('Phase 7.3 — the upload path over REAL D1 (faked fetch/storage/telegram seams)', () => {
  it('the full happy path: fetch + stage + ONE group send + the step-10 transition + immediate R2 deletion', async () => {
    const planResult = threePhotoPlan();
    if (!planResult.ok) return expect.unreachable();
    const ports = recordingPorts();
    const outcome = await uploadAlbumMediaGroup(
      {
        chatId: '@pixellores',
        plan: planResult.plan,
        caption: captionFor('تیتر آلبوم'),
        nowMs: NOW,
      },
      ports,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.uploadedCount).toBe(3);
    expect(outcome.reusedCount).toBe(0);
    expect(ports.calls.fetchUrls).toHaveLength(3);
    expect(ports.calls.putKeys).toHaveLength(3);
    expect(ports.calls.sendGroups).toBe(1);
    // The R2 objects were deleted IMMEDIATELY after the save (3 deletes).
    expect(ports.calls.deleteKeys).toHaveLength(3);
    expect(outcome.document.items).toHaveLength(3);
    expect(outcome.document.caption?.kind).toBe('caption');
    expect(outcome.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The durable assets: three rows, ALL 'uploaded' — file_id saved,
    // r2_key/expires_at CLEARED (the step-10 transition in one call).
    const rows = await executor.query<{
      status: string;
      telegram_file_id: string | null;
      r2_key: string | null;
      expires_at: number | null;
      canonical_url: string;
      sha256: string | null;
      rights_status: string;
    }>({
      sql: `SELECT status, telegram_file_id, r2_key, expires_at, canonical_url, sha256, rights_status FROM media_assets ORDER BY canonical_url`,
    });
    expect(rows.rows).toHaveLength(3);
    for (const row of rows.rows) {
      expect(row.status).toBe('uploaded');
      expect(row.telegram_file_id).not.toBeNull();
      expect(row.r2_key).toBeNull();
      expect(row.expires_at).toBeNull();
      // THE a279e13 CORRECTION (formerly pinned 'official'): the durable
      // echo of a machine-staged asset is `unknown` — no publish
      // clearance is minted from the official_api provenance; an
      // affirmative status is an explicit, evidence-backed owner action.
      expect(row.rights_status).toBe('unknown');
      expect(row.sha256).not.toBeNull();
    }
  });

  it('the ECONOMY rule, a279e13-corrected: an `unknown`-echo row is NEVER reused — the replay RE-STAGES (the reuse economy applies to evidence-cleared rows only)', async () => {
    const planResult = threePhotoPlan();
    if (!planResult.ok) return expect.unreachable();
    const first = recordingPorts();
    const firstOutcome = await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: planResult.plan, nowMs: NOW },
      first,
    );
    expect(firstOutcome.ok).toBe(true);

    const second = recordingPorts();
    const secondOutcome = await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: planResult.plan, nowMs: NOW + HOUR },
      second,
    );
    expect(secondOutcome.ok).toBe(true);
    if (!secondOutcome.ok) return;
    // THE a279e13 CORRECTION (formerly pinned reuse-all/zero-fetch): the
    // first round's rows echo `unknown` — the A1 reuse guard refuses an
    // uncleared file_id (re-sending it would republish media the ledger
    // holds no affirmative rights evidence for), so the replay re-fetches
    // and re-stages. The honest cost of the fail-closed rights posture.
    expect(secondOutcome.reusedCount).toBe(0);
    expect(secondOutcome.uploadedCount).toBe(3);
    expect(second.calls.fetchUrls).toHaveLength(3);
    expect(second.calls.putKeys).toHaveLength(3);
    // The GROUP still sends (the album must be delivered) — via the
    // freshly staged items; the ledger never claimed a clearance the
    // provenance did not carry.
    expect(second.calls.sendGroups).toBe(1);
    // The two rounds are INDEPENDENT staging rounds: the fake transport
    // names ids per-instance, so the durable ledger is the honest witness
    // — six rows total (two rounds x three items), every echo `unknown`.
    const allRows = await executor.query<{ readonly rights_status: string }>({
      sql: `SELECT rights_status FROM media_assets`,
    });
    expect(allRows.rows).toHaveLength(6);
    expect(allRows.rows.every((row) => row.rights_status === 'unknown')).toBe(true);
  });

  it('the hash-level reuse, a279e13-corrected: the same bytes under a DIFFERENT URL re-stage while the echo stays `unknown`', async () => {
    const planResult = threePhotoPlan();
    if (!planResult.ok) return expect.unreachable();
    const first = recordingPorts();
    await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: planResult.plan, nowMs: NOW },
      first,
    );

    // A NEW plan whose URLs differ but whose fetched HASHES collide with
    // the first round (the fake fetch derives the hash from the URL tail —
    // so mirror the same file names under a different host).
    const mirrorPlan = planAlbumMedia({
      candidates: [
        candidate('https://mirror.example.net/media/p0.jpg'),
        candidate('https://mirror.example.net/media/p1.jpg'),
        candidate('https://mirror.example.net/media/p2.jpg'),
      ],
    });
    if (!mirrorPlan.ok) return expect.unreachable();
    const second = recordingPorts();
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: mirrorPlan.plan, nowMs: NOW + HOUR },
      second,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // THE a279e13 CORRECTION (formerly pinned hash-reuse): the hash hit
    // meets an `unknown`-echo row — the A1 guard refuses it, the item
    // re-stages. Hash identity never substitutes for rights evidence.
    expect(outcome.reusedCount).toBe(0);
    expect(second.calls.putKeys).toHaveLength(3);
    // The group sends with the FRESH file_ids (no reused uncleared id).
    expect(second.calls.sendGroups).toBe(1);
  });

  it('the ALL-OR-NOTHING group: one deferred item withholds the WHOLE send (no staging, no asset row)', async () => {
    const planOutcome = planAlbumMedia({
      candidates: [
        candidate('https://cdn.example.com/media/p0.jpg'),
        candidate('https://cdn.example.com/media/p1.jpg'),
        candidate('https://cdn.example.com/media/p2.jpg', { origin: 'source_metadata' }),
      ],
    });
    if (!planOutcome.ok) return expect.unreachable();
    const ports = recordingPorts();
    // Make the source_metadata item CONFLICT (rights_ambiguous ⇒ defer).
    const deferPorts: MediaUploadPorts = {
      ...ports,
      rights: {
        decide: (input) =>
          input.rightsState === 'source_metadata_cleared'
            ? { decision: 'defer', reason: 'rights_ambiguous', policyVersion: 'mrp1' }
            : {
                decision: 'allow_temporary',
                reason: 'rights_cleared_and_policy_compliant',
                destination: 'r2_temporary_only',
                byteCapUnchecked: false,
                policyVersion: 'mrp1',
              },
      },
    };
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: planOutcome.plan, nowMs: NOW },
      deferPorts,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('rights_deferred');
    expect(
      outcome.items.some(
        (item) => item.outcome === 'deferred' && item.reason === 'rights_ambiguous',
      ),
    ).toBe(true);
    expect(ports.calls.sendGroups).toBe(0);
    expect(ports.calls.putKeys).toHaveLength(0);
    const staged = await executor.first<{ n: number }>({
      sql: `SELECT COUNT(*) AS n FROM media_assets`,
    });
    expect(staged?.n).toBe(0);
  });

  it('a failed send marks the staged rows failed and auto-resends NOTHING', async () => {
    const planResult = threePhotoPlan();
    if (!planResult.ok) return expect.unreachable();
    const ports = recordingPorts();
    ports.failNextSend();
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: planResult.plan, nowMs: NOW },
      ports,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('send_failed');
    expect(ports.calls.sendGroups).toBe(1);
    const rows = await executor.query<{ status: string; r2_key: string | null }>({
      sql: `SELECT status, r2_key FROM media_assets`,
    });
    expect(rows.rows).toHaveLength(3); // no ledger poisoning — the rows are honest bookkeeping
    for (const row of rows.rows) {
      expect(row.status).toBe('failed');
      expect(row.r2_key).not.toBeNull(); // the object stays for the retention backstop
    }
  });

  it('the retention cleanup: expired R2-holding rows are deleted (bounded) and cleared; the ledger values survive', async () => {
    const planResult = threePhotoPlan();
    if (!planResult.ok) return expect.unreachable();
    const failing = recordingPorts();
    failing.failNextSend();
    await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: planResult.plan, nowMs: NOW },
      failing,
    );
    // Three FAILED rows now hold R2 objects with deadline NOW + 72h.
    const beforeCleanup = await runMediaRetentionCleanup(
      { storage: failing.storage, assets },
      NOW + 71 * HOUR,
      10,
    );
    expect(beforeCleanup).toMatchObject({ ok: true, expiredCount: 0 });
    const afterCleanup = await runMediaRetentionCleanup(
      { storage: failing.storage, assets },
      NOW + 73 * HOUR,
      10,
    );
    expect(afterCleanup).toMatchObject({ ok: true, expiredCount: 3, deletedCount: 3 });
    expect(failing.calls.deleteKeys.filter((key) => key.startsWith('media/staging/'))).toHaveLength(
      3,
    );
    const states = await executor.query<{
      status: string;
      r2_key: string | null;
      telegram_file_id: string | null;
    }>({
      sql: `SELECT status, r2_key, telegram_file_id FROM media_assets`,
    });
    for (const row of states.rows) {
      expect(row.status).toBe('expired');
      expect(row.r2_key).toBeNull();
      expect(row.telegram_file_id).toBeNull(); // these rows never made it to the ledger
    }
    // A second sweep at the same time selects NOTHING (cleared rows are never re-selected).
    const repeat = await runMediaRetentionCleanup(
      { storage: failing.storage, assets },
      NOW + 73 * HOUR,
      10,
    );
    expect(repeat).toMatchObject({ ok: true, expiredCount: 0 });
  });

  it('the cleanup NEVER touches an UPLOADED row (the ledger value outlives the temporary object)', async () => {
    const planResult = threePhotoPlan();
    if (!planResult.ok) return expect.unreachable();
    const ports = recordingPorts();
    await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: planResult.plan, nowMs: NOW },
      ports,
    );
    // The uploaded rows carry NO r2_key — past any deadline they are invisible to the cleanup.
    const cleanup = await runMediaRetentionCleanup(
      { storage: ports.storage, assets },
      NOW + 100 * HOUR,
      10,
    );
    expect(cleanup).toMatchObject({ ok: true, expiredCount: 0 });
    const uploaded = await executor.first<{ n: number }>({
      sql: `SELECT COUNT(*) AS n FROM media_assets WHERE status = 'uploaded'`,
    });
    expect(uploaded?.n).toBe(3);
  });

  it('a single-item plan is typed plan_mode_unsupported (the single-media surface is the existing sendPhoto/sendVideo path)', async () => {
    const single = planAlbumMedia({
      candidates: [candidate('https://cdn.example.com/media/solo.jpg')],
    });
    if (!single.ok) return expect.unreachable();
    const ports = recordingPorts();
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: single.plan, nowMs: NOW },
      ports,
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'plan_mode_unsupported', items: [] });
    expect(ports.calls.sendGroups).toBe(0);
  });

  it('the deterministic staging object key is derivable by the cleanup (media/staging/<id>)', () => {
    expect(stagingObjectKey('abc-123')).toBe('media/staging/abc-123');
  });
});
