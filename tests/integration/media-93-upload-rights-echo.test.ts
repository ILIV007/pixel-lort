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
import {
  uploadAlbumMediaGroup,
  type MediaUploadPorts,
} from '../../src/application/media/upload-service';
import { isPublishableRightsStatus } from '../../src/domain/media/media-usage';
import { cryptoIdGenerator } from '../../src/shared/ids/id';

/**
 * media-93 — THE HONEST DURABLE RIGHTS ECHO (the independent review
 * a279e13, item 3, RED-first over REAL workerd D1): `rightsStateFor`
 * mapped an `official_api` origin (or official/verified source metadata)
 * to a durable `official`/`attribution_required` rights_status — a
 * PUBLISHABLE clearance minted from the source's NAME alone. Being
 * published by an official source proves neither a republication license,
 * nor its scope/destination, nor an expiry, nor attribution compliance.
 * THE SAFE CONTRACT pinned here:
 *  - the machine NEVER mints a publish clearance: every machine-staged
 *    asset's durable echo is `unknown`, whatever the provenance;
 *  - an `unknown` echo never passes the publication gate and is never
 *    reusable (the d65d811 F3 allowlist semantics — now meaningful for
 *    machine-staged rows too);
 *  - the mrp1 staging decision is UNCHANGED (an allow was always
 *    `r2_temporary_only` — fetch+stage, never a publish grant): the
 *    upload path still stages and delivers its group; the ledger just
 *    stops claiming a clearance the provenance never carried.
 * The affirmative statuses (official/licensed/attribution_required) are
 * written ONLY by an explicit, evidence-backed owner action — the owner
 * decision is documented in docs/OPEN_DECISIONS.md.
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

function twoPhotoPlan(
  origin: 'official_api' | 'source_metadata',
  officiality: 'official' | 'verified_source',
) {
  const outcome = planAlbumMedia({
    candidates: [
      candidate('https://cdn.example.com/media/m0.jpg', { origin, officiality }),
      candidate('https://cdn.example.com/media/m1.jpg', { origin, officiality }),
    ],
  });
  if (!outcome.ok) throw new Error(`fixture plan invalid: ${outcome.reason}`);
  return outcome;
}

interface RecordingPorts extends MediaUploadPorts {
  readonly calls: {
    readonly fetchUrls: string[];
    readonly putKeys: string[];
    readonly sendGroups: number;
  };
}

function recordingPorts(): RecordingPorts {
  const calls = {
    fetchUrls: [] as string[],
    putKeys: [] as string[],
    deleteKeys: [] as string[],
    sendGroups: 0,
  };
  const bytes = new Uint8Array([9, 9, 9]);
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
          contentHash: `hash-${request.canonicalUrl}`,
        };
      },
    },
    storage: {
      put: async (input) => {
        calls.putKeys.push(input.objectKey);
        return { ok: true };
      },
      delete: async () => {
        calls.deleteKeys.push('deleted');
        return { ok: true };
      },
    },
    assets,
    telegram: {
      sendMediaGroup: async (input) => {
        calls.sendGroups += 1;
        return {
          ok: true,
          fileIds: input.items.map((_item, index) => `BAAC-echo-${calls.sendGroups}-${index}`),
        };
      },
    },
    ids: cryptoIdGenerator,
  };
  return { ...ports, calls };
}

async function durableEchoes(): Promise<string[]> {
  const rows = await executor.query<{ readonly rights_status: string }>({
    sql: `SELECT rights_status FROM media_assets ORDER BY canonical_url`,
  });
  return rows.rows.map((row) => row.rights_status);
}

beforeEach(async () => {
  await applyMigrations(db, MIGRATIONS);
  await executor.run({ sql: `DELETE FROM media_assets` });
});

describe('media-93: the machine never mints a publish clearance (the a279e13 review, item 3)', () => {
  it('an official_api candidate stages and delivers — but the durable echo is `unknown`, never `official`', async () => {
    const planResult = twoPhotoPlan('official_api', 'official');
    const ports = recordingPorts();
    const outcome = await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: planResult.plan, nowMs: NOW },
      ports,
    );
    expect(outcome.ok).toBe(true);

    const echoes = await durableEchoes();
    expect(echoes).toHaveLength(2);
    // THE FIX: the provenance was official — the LEDGER still holds no
    // affirmative republication evidence, so the honest echo is `unknown`.
    expect(echoes.every((echo) => echo === 'unknown')).toBe(true);
  });

  it('official/verified source metadata stages too — the durable echo stays `unknown`', async () => {
    for (const officiality of ['official', 'verified_source'] as const) {
      const planResult = twoPhotoPlan('source_metadata', officiality);
      const ports = recordingPorts();
      const outcome = await uploadAlbumMediaGroup(
        { chatId: '@pixellores', plan: planResult.plan, nowMs: NOW },
        ports,
      );
      expect(outcome.ok).toBe(true);
    }
    const echoes = await durableEchoes();
    expect(echoes).toHaveLength(4);
    expect(echoes.every((echo) => echo === 'unknown')).toBe(true);
  });

  it('an `unknown` echo is not reusable: a replay RE-STAGES (the reuse economy applies to evidence-cleared rows only)', async () => {
    const planResult = twoPhotoPlan('official_api', 'official');
    const first = recordingPorts();
    const firstOutcome = await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: planResult.plan, nowMs: NOW },
      first,
    );
    expect(firstOutcome.ok).toBe(true);

    // The replay meets the SAME media: the first round's rows hold
    // file_ids but an `unknown` echo — the A1 reuse guard refuses them
    // (an uncleared file_id is never re-sent), so the item re-stages.
    const second = recordingPorts();
    const secondOutcome = await uploadAlbumMediaGroup(
      { chatId: '@pixellores', plan: planResult.plan, nowMs: NOW + HOUR },
      second,
    );
    expect(secondOutcome.ok).toBe(true);
    if (!secondOutcome.ok) return;
    expect(secondOutcome.reusedCount).toBe(0);
    expect(secondOutcome.uploadedCount).toBe(2);
    expect(second.calls.fetchUrls).toHaveLength(2);
    expect(second.calls.putKeys).toHaveLength(2);
    // The group still delivers (staging was allowed) — the ledger simply
    // never claimed a clearance the provenance did not carry.
    expect(second.calls.sendGroups).toBe(1);

    // The durable rows: four now (two rounds), every echo `unknown`.
    const echoes = await durableEchoes();
    expect(echoes).toHaveLength(4);
    expect(echoes.every((echo) => echo === 'unknown')).toBe(true);
  });

  it('the publication gate refuses the machine-staged echo (the allowlist stays affirmative-only)', () => {
    // The pure pin: `unknown` is NOT a publishable status — the send-time
    // gate and the reuse predicate both consume this allowlist.
    expect(isPublishableRightsStatus('unknown')).toBe(false);
    expect(isPublishableRightsStatus('blocked')).toBe(false);
  });
});
