import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import {
  commitPollResults,
  type IngestItemRow,
  type PollTerminalState,
} from '../../src/adapters/db/source-ingest-store';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';
import { scheduleDueSources } from '../../src/application/ingestion/scheduler';
import { createConnectorRegistry } from '../../src/connectors/registry';
import type { WorkerEnv } from '../../src/shared/types/env';
const db = createDbExecutor(env.DB);
const NOW = 1770000000000;
beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs'])
    await db.run({ sql: `DELETE FROM ${table}` });
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('invalid registry');
  await seedSourcesFromRegistry(db, r.registry, NOW);
});
it('characterization D02: a revised article is discarded, even with a different content hash', async () => {
  const base: IngestItemRow = {
    id: 'original',
    sourceId: 'playstation_blog',
    externalId: 'rss:article',
    canonicalUrl: 'https://blog.playstation.com/article',
    title: 'Original announcement',
    excerpt: 'Original facts',
    author: null,
    publishedAtMs: NOW,
    fetchedAtMs: NOW,
    contentHash: 'hash-original',
    rawJson: '{}',
  };
  const terminal: PollTerminalState = {
    cursor: 'first',
    etag: null,
    lastModified: null,
    nextPollAtMs: NOW + 300000,
    success: true,
    lastChangedAtMs: NOW,
    lastError: null,
    consecutiveFailures: 0,
    circuitOpenUntilMs: null,
    requestsToday: 1,
    budgetDate: '2026-02-02',
  };
  await commitPollResults(db, {
    sourceId: base.sourceId,
    items: [base],
    state: terminal,
    holdUntilMs: 0,
    nowMs: NOW,
  });
  await db.run({
    sql: "UPDATE source_state SET next_poll_at=? WHERE source_id='playstation_blog'",
    params: [NOW + 120000],
  });
  const result = await commitPollResults(db, {
    sourceId: base.sourceId,
    items: [
      {
        ...base,
        id: 'revision',
        title: 'Corrected release date',
        excerpt: 'New date replaces old claim',
        contentHash: 'hash-revised',
      },
    ],
    state: { ...terminal, cursor: 'revised-page' },
    holdUntilMs: NOW + 120000,
    nowMs: NOW,
  });
  const rows = await db.query<{ title: string; content_hash: string }>({
    sql: "SELECT title,content_hash FROM source_items WHERE source_id='playstation_blog'",
  });
  expect(result.stateWriteWon).toBe(true);
  expect(result.duplicateExternal).toBe(1);
  expect(rows.rows).toEqual([{ title: 'Original announcement', content_hash: 'hash-original' }]);
});
it('characterization R09: three cron ticks without queue completion create three concurrent poll jobs', async () => {
  await db.run({ sql: "UPDATE sources SET enabled=1 WHERE id='playstation_blog'" });
  const r = resolveJobsEngine({
    DB: env.DB,
    JOBS_ENABLED: 'true',
    SOURCE_INGESTION_ENABLED: 'true',
    JOBS: { send: async () => {} },
    DLQ: { send: async () => {} },
  } as unknown as WorkerEnv);
  if (r.kind !== 'ready') throw new Error('not ready');
  for (let tick = 0; tick < 3; tick++)
    await scheduleDueSources({
      executor: db,
      engine: r.engine,
      connectors: createConnectorRegistry(),
      secrets: () => undefined,
      nowMs: NOW + tick * 300000,
    });
  const jobs = await db.first<{ n: number }>({
    sql: "SELECT COUNT(*) AS n FROM jobs WHERE type='sources.fetch_poll' AND aggregate_id='playstation_blog' AND status='pending'",
  });
  expect(jobs!.n).toBe(3);
});
