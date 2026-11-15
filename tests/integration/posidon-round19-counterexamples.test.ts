/** Independent product boundary probes. Real workerd D1; scripted raw fetch only. */
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
import { schedulePollWindowOwned } from '../../src/adapters/db/source-ingest-store';
import { createSourcePollHandler } from '../../src/application/ingestion/poll-handler';
import { createConnectorRegistry } from '../../src/connectors/registry';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';
import type { WorkerEnv } from '../../src/shared/types/env';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';
const NOW = 1770000000000;
const SOURCE = 'playstation_blog';
const db = createDbExecutor(env.DB);
beforeEach(async () => {
  await applyMigrations(env.DB, ROUND19_MIGRATION_PLAN);
  for (const t of ['source_items', 'source_state', 'sources', 'jobs', 'budgets'])
    await db.run({ sql: `DELETE FROM ${t}` });
  await db.run({ sql: "UPDATE schema_metadata SET value='4' WHERE key='schema_version'" });
  const reg = parseEmbeddedRegistry();
  if (!reg.ok) throw new Error('fixture registry');
  await seedSourcesFromRegistry(db, reg.registry, NOW);
  await db.run({ sql: 'UPDATE sources SET enabled=1 WHERE id=?', params: [SOURCE] });
});
afterEach(async () => {
  await db.run({ sql: "UPDATE schema_metadata SET value='4' WHERE key='schema_version'" });
});
async function currentOwner() {
  await db.run({
    sql: `INSERT INTO jobs (id,type,aggregate_type,aggregate_id,status,priority,run_after,attempts,max_attempts,lease_until,idempotency_key,payload_json,created_at,updated_at) VALUES ('owner-job','sources.fetch_poll','source',?,'claimed',40,?,2,3,?,'sources.poll:current',?,?,?)`,
    params: [
      SOURCE,
      NOW,
      NOW + 120000,
      canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }),
      NOW,
      NOW,
    ],
  });
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at=?,poll_owner_job_id=?,cursor=?,etag=? WHERE source_id=?',
    params: [NOW + 120000, 'owner-job', 'saved-cursor', '"saved-etag"', SOURCE],
  });
}
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
const state = () =>
  db.first<Record<string, unknown>>({
    sql: 'SELECT * FROM source_state WHERE source_id=?',
    params: [SOURCE],
  });
async function invoke(executor: DbExecutor) {
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
  await handler.execute({
    jobId: 'owner-job',
    generation: 1,
    payload: { sourceId: SOURCE, scheduledForMs: 0 },
  });
  return {
    raw,
    items: (await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM source_items' }))!.n,
  };
}
it('CE1: corrupt metadata must not schedule unfenced legacy work on an actual schema4 database', async () => {
  await db.run({ sql: "UPDATE schema_metadata SET value='bogus' WHERE key='schema_version'" });
  const before = await state();
  await scheduleDueSources({
    executor: db,
    engine: engine(),
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  const jobs = await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM jobs' });
  expect({ jobs: jobs!.n, state: await state() }).toEqual({ jobs: 0, state: before });
});
it('CE2: corrupt metadata must never let a stale generation fetch or insert items through the legacy path', async () => {
  await currentOwner();
  await db.run({ sql: "UPDATE schema_metadata SET value='bogus' WHERE key='schema_version'" });
  const before = await state();
  expect(await invoke(db)).toEqual({ raw: 0, items: 0 });
  expect(await state()).toEqual(before);
});
it('CE3: a transient capability query failure must not downgrade a stale worker to legacy authority', async () => {
  await currentOwner();
  const before = await state();
  const failing: DbExecutor = {
    ...db,
    first: async <T>(stmt: DbStatement) => {
      if (stmt.sql.includes('FROM schema_metadata')) throw new Error('simulated read failure');
      return db.first<T>(stmt);
    },
  };
  expect(await invoke(failing)).toEqual({ raw: 0, items: 0 });
  expect(await state()).toEqual(before);
});
it('CE4: unsupported schema5 metadata must not silently reactivate the legacy ingestion path', async () => {
  await currentOwner();
  await db.run({ sql: "UPDATE schema_metadata SET value='5' WHERE key='schema_version'" });
  expect(await invoke(db)).toEqual({ raw: 0, items: 0 });
});
it('CE5: a same-key row with a foreign aggregate must be reported as foreign, never as owning this source window', async () => {
  await db.run({
    sql: `INSERT INTO jobs(id,type,aggregate_type,aggregate_id,status,priority,run_after,attempts,max_attempts,idempotency_key,payload_json,created_at,updated_at) VALUES('foreign-row','sources.fetch_poll','source','xbox_wire','pending',40,?,0,3,'sources.poll:same',?,?,?)`,
    params: [NOW, canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }), NOW, NOW],
  });
  const result = await schedulePollWindowOwned(
    db,
    {
      sourceId: SOURCE,
      scheduledForMs: 0,
      idempotencyKey: 'sources.poll:same',
      canonicalPayloadJson: canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 }),
      jobId: 'contender',
      priority: 40,
      maxAttempts: 3,
      nowMs: NOW,
    },
    300,
  );
  expect(result).toEqual({ kind: 'foreign_window_job', foreignJobId: 'foreign-row' });
});
it('CONTROL: supported schema4 rejects the same stale generation before network or items', async () => {
  await currentOwner();
  const before = await state();
  expect(await invoke(db)).toEqual({ raw: 0, items: 0 });
  expect(await state()).toEqual(before);
});
it('CONTROL: supported schema3 is a distinct explicitly documented legacy mode, not an unknown version', async () => {
  await db.run({ sql: "UPDATE schema_metadata SET value='3' WHERE key='schema_version'" });
  await scheduleDueSources({
    executor: db,
    engine: engine(),
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: NOW,
  });
  expect((await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM jobs' }))!.n).toBe(1);
});
