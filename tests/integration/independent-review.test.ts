import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import { commitPollResults, type IngestItemRow } from '../../src/adapters/db/source-ingest-store';
import { createSafeFetch } from '../../src/shared/http/safe-http';
const db = createDbExecutor(env.DB);
const NOW = 1770000000000;
beforeEach(async () => {
  await applyMigrations(env.DB);
  await db.run({ sql: 'DELETE FROM source_items' });
  await db.run({ sql: 'DELETE FROM source_state' });
  await db.run({ sql: 'DELETE FROM sources' });
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('invalid registry');
  await seedSourcesFromRegistry(db, r.registry, NOW);
});
it('independent: actual safe HTTP port must accept 304 Not Modified', async () => {
  const safe = createSafeFetch((async () => new Response(null, { status: 304 })) as typeof fetch);
  const result = await safe({
    url: 'https://blog.playstation.com/feed/',
    headers: {},
    byteCap: 2097152,
    timeoutMs: 1000,
    maxRedirects: 2,
    allowedHosts: ['blog.playstation.com'],
  });
  expect(result).toMatchObject({ ok: true, status: 304, requestCount: 1 });
});
it('independent: invalid NOT NULL item must abort item/state batch, not advance cursor', async () => {
  const item: IngestItemRow = {
    id: 'review-item',
    sourceId: 'playstation_blog',
    externalId: 'review-external',
    canonicalUrl: null,
    title: null as unknown as string,
    excerpt: null,
    author: null,
    publishedAtMs: null,
    fetchedAtMs: NOW,
    contentHash: 'review-hash',
    rawJson: '{}',
  };
  await expect(
    commitPollResults(db, {
      sourceId: 'playstation_blog',
      items: [item],
      holdUntilMs: 0,
      nowMs: NOW,
      state: {
        cursor: 'must-not-advance',
        etag: null,
        lastModified: null,
        nextPollAtMs: NOW + 600000,
        success: true,
        lastChangedAtMs: NOW,
        lastError: null,
        consecutiveFailures: 0,
        circuitOpenUntilMs: null,
        requestsToday: 0,
        budgetDate: '2026-02-02',
      },
    }),
  ).rejects.toThrow();
});
