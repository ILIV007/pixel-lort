/**
 * ROUND 1.9.1 — R19-01 PERMANENT FAIL-CLOSED CAPABILITY PROOFS.
 *
 * Posidon finding R19-01 (P1 blocker): the Round 1.9 capability resolver
 * collapsed every unreadable/invalid/unsupported metadata state into
 * "ownership OFF", and callers interpreted that boolean as permission to
 * run UNFENCED LEGACY INGESTION on an actual schema-4 database
 * (counterexamples CE1–CE4). The correction (authorized by
 * NEXT_ROUND_1_9_1_GLM_PROMPT.md §R19-01) introduces three DISTINCT typed
 * capability states — known readable v3 (legacy), known readable v4
 * (ownership), and unresolved (missing row / corrupt or unsafe integer /
 * unsupported version / failed read) — and both ingestion entrypoints now
 * FAIL CLOSED on unresolved:
 *   - the scheduler stops BEFORE the completeness probe, seed/repair, the
 *     due scan, and every job/source-state effect (zero effects);
 *   - the poll handler stops BEFORE preflight, budget, network, items and
 *     source-state effects (zero effects), returning a stable typed
 *     retryable outcome — engine retry bookkeeping (the job's own
 *     attempts/lease/retry_wait rows) is deliberately distinct from
 *     ingestion effects and is asserted unchanged here.
 *
 * Deterministic coverage per the prompt: missing row, corrupt/invalid/
 * oversized metadata, unsupported version, metadata read throw, recovery
 * once valid metadata returns, known-v3/v4 controls, and stale-generation
 * handling as in the supplied evidence. The supplied independent
 * counterexamples themselves stay UNMODIFIED in
 * tests/integration/posidon-round19-counterexamples.test.ts (7/7 green).
 *
 * HONESTY BOUNDARIES: real workerd D1 (disposable test databases only —
 * the 0004 migration candidate is applied ONLY here via the explicit
 * test-only ROUND19_MIGRATION_PLAN); scripted raw fetch, no external
 * provider calls; no Cloudflare/remote operation anywhere.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, ROUND19_MIGRATION_PLAN } from '../helpers/migrations';
import {
  createDbExecutor,
  type DbExecutor,
  type DbStatement,
} from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import { scheduleDueSources } from '../../src/application/ingestion/scheduler';
import { createSourcePollHandler } from '../../src/application/ingestion/poll-handler';
import { createConnectorRegistry } from '../../src/connectors/registry';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';
import { resolveSchemaCapability } from '../../src/adapters/db/schema-health';
import type { WorkerEnv } from '../../src/shared/types/env';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';

const NOW = 1770000000000;
const SOURCE = 'playstation_blog';
const HOLD = 120_000;
const db = createDbExecutor(env.DB);

const registry = () => {
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('fixture registry');
  return r.registry;
};

const seedAndEnable = async () => {
  await seedSourcesFromRegistry(db, registry(), NOW);
  await db.run({ sql: 'UPDATE sources SET enabled=1 WHERE id=?', params: [SOURCE] });
};

beforeEach(async () => {
  await applyMigrations(env.DB, ROUND19_MIGRATION_PLAN);
  for (const t of ['source_items', 'source_state', 'sources', 'jobs', 'budgets'])
    await db.run({ sql: `DELETE FROM ${t}` });
  await db.run({ sql: "UPDATE schema_metadata SET value='4' WHERE key='schema_version'" });
  await seedAndEnable();
});

afterEach(async () => {
  // Leave the disposable database with a readable exact v4 marker (the
  // probes' afterEach convention — never leak corrupt/missing metadata).
  // UPSERT (not UPDATE): S1 legitimately deletes the row, and a plain
  // UPDATE would no-op and poison the next beforeEach's applyMigrations.
  // updated_at_ms is NOT NULL (0001 DDL) so the insert path must set it.
  await db.run({
    sql: `INSERT INTO schema_metadata (key, value, updated_at_ms)
          VALUES ('schema_version', '4', ?)
          ON CONFLICT(key) DO UPDATE SET value='4'`,
    params: [NOW],
  });
});

const stateRow = () =>
  db.first<{
    next_poll_at: number;
    poll_owner_job_id: string | null;
    cursor: string | null;
    etag: string | null;
    last_error: string | null;
    consecutive_failures: number;
  }>({
    sql: 'SELECT next_poll_at, poll_owner_job_id, cursor, etag, last_error, consecutive_failures FROM source_state WHERE source_id = ?',
    params: [SOURCE],
  });

const jobCount = async () =>
  (await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM jobs' }))!.n;

function engine() {
  const r = resolveJobsEngine({
    DB: env.DB,
    JOBS_ENABLED: 'true',
    SOURCE_INGESTION_ENABLED: 'true',
    JOBS: { send: async () => {} },
    DLQ: { send: async () => {} },
  } as unknown as WorkerEnv);
  if (r.kind !== 'ready') throw new Error('fixture engine');
  return r.engine;
}

/** An executor whose schema_metadata reads fail (transient outage fixture). */
function withFailingMetadataRead(inner: DbExecutor): DbExecutor {
  return {
    ...inner,
    first: async <T>(stmt: DbStatement) => {
      if (stmt.sql.includes('FROM schema_metadata')) {
        throw new Error('simulated capability read failure');
      }
      return inner.first<T>(stmt);
    },
    query: async <T>(stmt: DbStatement) => {
      if (stmt.sql.includes('FROM schema_metadata')) {
        throw new Error('simulated capability read failure');
      }
      return inner.query<T>(stmt);
    },
  };
}

// ---------------------------------------------------------------------------
// Scheduler — unresolved capability stops BEFORE seed/scan/job/state effects.
// ---------------------------------------------------------------------------

it('R191-S1: missing metadata row — the scheduler stops before seed, scan, job and state effects', async () => {
  // Prove the stop happens BEFORE the R08 completeness probe: a deleted
  // catalog row would normally be repaired by the pass — with an
  // unresolved capability it must stay missing.
  await db.run({ sql: "DELETE FROM sources WHERE id='steam_news_watchlist'" });
  await db.run({ sql: "DELETE FROM source_state WHERE source_id='steam_news_watchlist'" });
  await db.run({ sql: "DELETE FROM schema_metadata WHERE key='schema_version'" });

  const before = await stateRow();
  const outcome = await scheduleDueSources({
    executor: db,
    engine: engine(),
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect(outcome).toEqual({
    kind: 'capability_unresolved',
    reason: 'schema_capability_metadata_missing',
  });
  expect(await jobCount()).toBe(0);
  expect(await stateRow()).toEqual(before);
  const repaired = await db.first<{ n: number }>({
    sql: "SELECT COUNT(*) AS n FROM sources WHERE id='steam_news_watchlist'",
  });
  expect(repaired!.n).toBe(0); // NO seed/repair effect — the pass stopped first
  expect(await resolveSchemaCapability(db)).toEqual({
    kind: 'unresolved',
    reason: 'schema_capability_metadata_missing',
  });
});

it('R191-S2: corrupt metadata must not schedule unfenced legacy work (CE1 product coverage)', async () => {
  await db.run({ sql: "UPDATE schema_metadata SET value='bogus' WHERE key='schema_version'" });
  const before = await stateRow();
  const outcome = await scheduleDueSources({
    executor: db,
    engine: engine(),
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect(outcome).toEqual({
    kind: 'capability_unresolved',
    reason: 'schema_capability_metadata_invalid',
  });
  expect(await jobCount()).toBe(0);
  expect(await stateRow()).toEqual(before);
});

it('R191-S3: invalid syntax (non-integer, zero, negative) resolves unresolved-invalid and never legacy', async () => {
  for (const bad of ['v4', '4.0', '0', '-3']) {
    await db.run({
      sql: "UPDATE schema_metadata SET value=? WHERE key='schema_version'",
      params: [bad],
    });
    const before = await stateRow();
    const outcome = await scheduleDueSources({
      executor: db,
      engine: engine(),
      connectors: createConnectorRegistry(),
      secrets: () => undefined,
      nowMs: NOW,
    });
    expect(outcome).toEqual({
      kind: 'capability_unresolved',
      reason: 'schema_capability_metadata_invalid',
    });
    expect(await jobCount()).toBe(0);
    expect(await stateRow()).toEqual(before);
  }
  // An EMPTY value is indistinguishable from an absent one: `missing`.
  await db.run({ sql: "UPDATE schema_metadata SET value='' WHERE key='schema_version'" });
  const before = await stateRow();
  expect(
    await scheduleDueSources({
      executor: db,
      engine: engine(),
      connectors: createConnectorRegistry(),
      secrets: () => undefined,
      nowMs: NOW,
    }),
  ).toEqual({ kind: 'capability_unresolved', reason: 'schema_capability_metadata_missing' });
  expect(await jobCount()).toBe(0);
  expect(await stateRow()).toEqual(before);
});

it('R191-S4: an oversized integer beyond MAX_SAFE_INTEGER is invalid metadata, never a version', async () => {
  await db.run({
    sql: "UPDATE schema_metadata SET value='99999999999999999999' WHERE key='schema_version'",
  });
  expect(await resolveSchemaCapability(db)).toEqual({
    kind: 'unresolved',
    reason: 'schema_capability_metadata_invalid',
  });
  const before = await stateRow();
  const outcome = await scheduleDueSources({
    executor: db,
    engine: engine(),
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect(outcome).toEqual({
    kind: 'capability_unresolved',
    reason: 'schema_capability_metadata_invalid',
  });
  expect(await jobCount()).toBe(0);
  expect(await stateRow()).toEqual(before);
});

it('R191-S5: unsupported schema 5 must not reactivate the legacy scheduling path', async () => {
  await db.run({ sql: "UPDATE schema_metadata SET value='5' WHERE key='schema_version'" });
  expect(await resolveSchemaCapability(db)).toEqual({
    kind: 'unresolved',
    reason: 'schema_capability_version_unsupported',
  });
  const before = await stateRow();
  const outcome = await scheduleDueSources({
    executor: db,
    engine: engine(),
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect(outcome).toEqual({
    kind: 'capability_unresolved',
    reason: 'schema_capability_version_unsupported',
  });
  expect(await jobCount()).toBe(0);
  expect(await stateRow()).toEqual(before);
});

it('R191-S6: a transient metadata read failure stops the scheduler with a stable recoverable outcome', async () => {
  const failing = withFailingMetadataRead(db);
  expect(await resolveSchemaCapability(failing)).toEqual({
    kind: 'unresolved',
    reason: 'schema_capability_metadata_read_failed',
  });
  const before = await stateRow();
  const outcome = await scheduleDueSources({
    executor: failing,
    engine: engine(),
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect(outcome).toEqual({
    kind: 'capability_unresolved',
    reason: 'schema_capability_metadata_read_failed',
  });
  expect(await jobCount()).toBe(0);
  expect(await stateRow()).toEqual(before);
});

it('R191-S7: recovery — once exact v4 metadata returns, the very next pass schedules the owned window', async () => {
  await db.run({ sql: "UPDATE schema_metadata SET value='bogus' WHERE key='schema_version'" });
  expect(
    await scheduleDueSources({
      executor: db,
      engine: engine(),
      connectors: createConnectorRegistry(),
      secrets: () => undefined,
      nowMs: NOW,
    }),
  ).toEqual({ kind: 'capability_unresolved', reason: 'schema_capability_metadata_invalid' });
  expect(await jobCount()).toBe(0);

  await db.run({ sql: "UPDATE schema_metadata SET value='4' WHERE key='schema_version'" });
  const recovered = await scheduleDueSources({
    executor: db,
    engine: engine(),
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect(recovered).toEqual({
    kind: 'scheduled',
    jobsCreated: 1,
    blockedSkipped: 0,
    seeded: false,
  });
  const after = await stateRow();
  expect(after!.next_poll_at).toBe(NOW + HOLD); // CURRENT-TIME owned hold
  expect(after!.poll_owner_job_id).not.toBeNull(); // durable owner visible
});

it('R191-S8 CONTROL: readable exact v3 retains the documented legacy mode (distinct from unresolved)', async () => {
  await db.run({ sql: "UPDATE schema_metadata SET value='3' WHERE key='schema_version'" });
  expect(await resolveSchemaCapability(db)).toEqual({
    kind: 'known_v3_legacy',
    appliedSchemaVersion: 3,
  });
  const outcome = await scheduleDueSources({
    executor: db,
    engine: engine(),
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect(outcome).toEqual({ kind: 'scheduled', jobsCreated: 1, blockedSkipped: 0, seeded: false });
  expect(await jobCount()).toBe(1);
  const legacy = await stateRow();
  expect(legacy!.poll_owner_job_id).toBeNull(); // the legacy path never touches the owner column
  expect(legacy!.next_poll_at).toBe(HOLD); // legacy marker+hold (the documented schema-3 defect, honestly preserved)
});

it('R191-S9 CONTROL: readable exact v4 keeps the owned path with all fences', async () => {
  expect(await resolveSchemaCapability(db)).toEqual({
    kind: 'known_v4_ownership',
    appliedSchemaVersion: 4,
  });
  const outcome = await scheduleDueSources({
    executor: db,
    engine: engine(),
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect(outcome).toEqual({ kind: 'scheduled', jobsCreated: 1, blockedSkipped: 0, seeded: false });
  const after = await stateRow();
  expect(after!.next_poll_at).toBe(NOW + HOLD);
  expect(after!.poll_owner_job_id).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Handler — unresolved capability stops BEFORE budget/network/item/state.
// ---------------------------------------------------------------------------

/** Claimed owner fixture with attempts=2 (a newer generation than the worker). */
async function currentOwner(): Promise<void> {
  await db.run({
    sql: `INSERT INTO jobs (id,type,aggregate_type,aggregate_id,status,priority,run_after,attempts,max_attempts,lease_until,idempotency_key,payload_json,created_at,updated_at)
          VALUES ('owner-job','sources.fetch_poll','source',?,'claimed',40,?,2,3,?,'sources.poll:current',?,?,?)`,
    params: [
      SOURCE,
      NOW,
      NOW + HOLD,
      canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }),
      NOW,
      NOW,
    ],
  });
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at=?,poll_owner_job_id=?,cursor=?,etag=? WHERE source_id=?',
    params: [NOW + HOLD, 'owner-job', 'saved-cursor', '"saved-etag"', SOURCE],
  });
}

async function invokeHandler(
  executor: DbExecutor,
  generation: number,
): Promise<{
  raw: number;
  items: number;
  outcome: { kind: string; reasonCode?: string };
}> {
  let raw = 0;
  const handler = createSourcePollHandler({
    executor,
    connectors: createConnectorRegistry(),
    fetchFn: async () => {
      raw++;
      return new Response(
        '<rss><channel><item><title>Foreign stale write</title><link>https://blog.playstation.com/article/stale</link><guid isPermaLink="false">stale-one</guid><description>body</description></item></channel></rss>',
        { headers: { 'content-type': 'application/rss+xml' } },
      );
    },
    idGenerator: { newId: () => crypto.randomUUID() },
    secrets: () => undefined,
    nowMs: () => NOW,
    random: () => 0.5,
  });
  const outcome = await handler.execute({
    jobId: 'owner-job',
    generation,
    payload: { sourceId: SOURCE, scheduledForMs: 0 },
  });
  return {
    raw,
    items: (await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM source_items' }))!.n,
    outcome: {
      kind: outcome.kind,
      reasonCode: outcome.kind === 'retry' ? outcome.reasonCode : undefined,
    },
  };
}

const ownerJobRow = () =>
  db.first<{ status: string; attempts: number; lease_until: number | null }>({
    sql: "SELECT status, attempts, lease_until FROM jobs WHERE id='owner-job'",
  });

it('R191-H1: corrupt metadata must never let a stale generation fetch or insert through the legacy path (CE2 product coverage)', async () => {
  await currentOwner();
  await db.run({ sql: "UPDATE schema_metadata SET value='bogus' WHERE key='schema_version'" });
  const before = await stateRow();
  const result = await invokeHandler(db, 1);
  expect(result).toEqual({
    raw: 0,
    items: 0,
    outcome: { kind: 'retry', reasonCode: 'ingestion_capability_unresolved' },
  });
  expect(await stateRow()).toEqual(before); // cursor/etag/owner/marker preserved EXACTLY
  const job = await ownerJobRow();
  expect(job).toEqual({ status: 'claimed', attempts: 2, lease_until: NOW + HOLD }); // engine bookkeeping untouched by the handler
});

it('R191-H2: a missing metadata row stops the handler before any ingestion effect', async () => {
  await currentOwner();
  await db.run({ sql: "DELETE FROM schema_metadata WHERE key='schema_version'" });
  const before = await stateRow();
  const result = await invokeHandler(db, 1);
  expect(result).toEqual({
    raw: 0,
    items: 0,
    outcome: { kind: 'retry', reasonCode: 'ingestion_capability_unresolved' },
  });
  expect(await stateRow()).toEqual(before);
});

it('R191-H3: oversized/unsafe metadata stops the handler before any ingestion effect', async () => {
  await currentOwner();
  await db.run({
    sql: "UPDATE schema_metadata SET value='99999999999999999999' WHERE key='schema_version'",
  });
  const before = await stateRow();
  expect(await invokeHandler(db, 1)).toEqual({
    raw: 0,
    items: 0,
    outcome: { kind: 'retry', reasonCode: 'ingestion_capability_unresolved' },
  });
  expect(await stateRow()).toEqual(before);
});

it('R191-H4: unsupported schema 5 must not silently reactivate the legacy ingestion path (CE4 product coverage)', async () => {
  await currentOwner();
  await db.run({ sql: "UPDATE schema_metadata SET value='5' WHERE key='schema_version'" });
  const before = await stateRow();
  expect(await invokeHandler(db, 1)).toEqual({
    raw: 0,
    items: 0,
    outcome: { kind: 'retry', reasonCode: 'ingestion_capability_unresolved' },
  });
  expect(await stateRow()).toEqual(before);
});

it('R191-H5: a transient capability read failure must not downgrade a stale worker to legacy authority (CE3 product coverage)', async () => {
  await currentOwner();
  const before = await stateRow();
  const result = await invokeHandler(withFailingMetadataRead(db), 1);
  expect(result).toEqual({
    raw: 0,
    items: 0,
    outcome: { kind: 'retry', reasonCode: 'ingestion_capability_unresolved' },
  });
  expect(await stateRow()).toEqual(before);
  const job = await ownerJobRow();
  expect(job!.attempts).toBe(2); // no attempts reset, no handler-side bookkeeping
});

it('R191-H6: recovery — once exact v4 metadata returns, the same handler path executes normally behind the fences', async () => {
  await currentOwner();
  await db.run({ sql: "UPDATE schema_metadata SET value='bogus' WHERE key='schema_version'" });
  expect(await invokeHandler(db, 1)).toEqual({
    raw: 0,
    items: 0,
    outcome: { kind: 'retry', reasonCode: 'ingestion_capability_unresolved' },
  });

  await db.run({ sql: "UPDATE schema_metadata SET value='4' WHERE key='schema_version'" });
  // The stale generation 1 is STILL fenced out on the readable v4 database…
  const stale = await stateRow();
  expect(await invokeHandler(db, 1)).toEqual({
    raw: 0,
    items: 0,
    outcome: { kind: 'success', reasonCode: undefined },
  });
  expect(await stateRow()).toEqual(stale);
  // …while the CURRENT generation acquires the window and polls honestly.
  const recovered = await invokeHandler(db, 2);
  expect(recovered.raw).toBe(1);
  expect(recovered.items).toBe(1);
  expect(recovered.outcome.kind).toBe('success');
});

it('R191-H7 CONTROL: readable exact v3 keeps the documented legacy handler behavior (distinct from unresolved)', async () => {
  // Legacy schema-3 fixture: marker at the payload hold window (0 + HOLD);
  // no ownership column involvement. The legacy path has NO generation
  // fence by design — the documented schema-3 defect stays honestly
  // visible ONLY under an explicitly readable v3, never under unresolved.
  await db.run({
    sql: `INSERT INTO jobs (id,type,aggregate_type,aggregate_id,status,priority,run_after,attempts,max_attempts,lease_until,idempotency_key,payload_json,created_at,updated_at)
          VALUES ('owner-job','sources.fetch_poll','source',?,'claimed',40,?,2,3,NULL,'sources.poll:legacy',?,?,?)`,
    params: [SOURCE, NOW, canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }), NOW, NOW],
  });
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at=?,cursor=?,etag=? WHERE source_id=?',
    params: [HOLD, 'saved-cursor', '"saved-etag"', SOURCE],
  });
  await db.run({ sql: "UPDATE schema_metadata SET value='3' WHERE key='schema_version'" });
  expect(await resolveSchemaCapability(db)).toEqual({
    kind: 'known_v3_legacy',
    appliedSchemaVersion: 3,
  });
  const result = await invokeHandler(db, 1);
  expect(result.raw).toBe(1);
  expect(result.items).toBe(1);
  const after = await stateRow();
  expect(after!.poll_owner_job_id).toBeNull(); // the legacy commit never touches ownership
  expect(after!.next_poll_at).toBeGreaterThan(NOW); // legacy fenced commit advanced the marker
});
