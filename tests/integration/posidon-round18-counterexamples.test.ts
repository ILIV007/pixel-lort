/** Independent acceptance counterexamples. No provider network. Real workerd D1 where stated. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import {
  authorizeIngestionUnit,
  readIngestionBudget,
} from '../../src/adapters/db/ingestion-budget-store';
import { createIngestionSafeFetch, type SafeFetchInput } from '../../src/shared/http/safe-http';
import { createSourcePollHandler } from '../../src/application/ingestion/poll-handler';
import { createConnectorRegistry } from '../../src/connectors/registry';
import { createRssConnector } from '../../src/connectors/rss';
import { createGithubReleasesConnector } from '../../src/connectors/github-releases';
import { connectorEffects } from '../helpers/fetch-mock';
import { INGESTION_POLL_HOLD_MS } from '../../src/shared/config/phase4';

const NOW = 1_770_000_000_000;
const db = createDbExecutor(env.DB);
const INPUT: SafeFetchInput = {
  url: 'https://blog.playstation.com/feed/',
  headers: { accept: 'application/xml' },
  byteCap: 2048,
  timeoutMs: 100,
  maxRedirects: 2,
  allowedHosts: ['blog.playstation.com'],
};
const SAVED = {
  cursor: '{"saved-window":true}',
  etag: '"saved-etag"',
  lastModified: 'Mon, 02 Feb 2026 00:00:00 GMT',
};
beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const t of ['source_items', 'source_state', 'sources', 'jobs', 'budgets'])
    await db.run({ sql: `DELETE FROM ${t}` });
  const reg = parseEmbeddedRegistry();
  if (!reg.ok) throw new Error('invalid registry');
  await seedSourcesFromRegistry(db, reg.registry, NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
});
function transport(sourceId: string, raw: typeof fetch) {
  return createIngestionSafeFetch({
    fetchFn: raw,
    authorizeUnit: async () => {
      const g = await authorizeIngestionUnit(db, { sourceId, nowMs: NOW });
      return g.kind === 'authorized'
        ? { kind: 'granted' }
        : g.kind === 'denied'
          ? { kind: 'budget_denied' }
          : { kind: 'source_missing' };
    },
  });
}

describe('Posidon Round1.8 blocking counterexamples', () => {
  it('CE1: authorization that finishes after the absolute deadline must not start any raw fetch', async () => {
    let time = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => time);
    let rawCalls = 0;
    const fetch = createIngestionSafeFetch({
      authorizeUnit: async () => {
        time = 1101;
        return { kind: 'granted' };
      },
      fetchFn: async () => {
        rawCalls++;
        return new Response(null, { status: 304 });
      },
    });
    const result = await fetch(INPUT);
    expect({ rawCalls, result }).toEqual({
      rawCalls: 0,
      result: { ok: false, reason: 'timeout', requestCount: 0 },
    });
  });
  it('CE2: the absolute deadline also bounds an authorizer that has not completed', async () => {
    let finish: ((v: { kind: 'granted' }) => void) | undefined;
    let rawCalls = 0;
    const fetch = createIngestionSafeFetch({
      authorizeUnit: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      fetchFn: async () => {
        rawCalls++;
        return new Response(null, { status: 304 });
      },
    });
    const pending = fetch({ ...INPUT, timeoutMs: 5 });
    const first = await Promise.race([
      pending.then(() => 'settled' as const),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 40)),
    ]);
    finish?.({ kind: 'granted' });
    await pending;
    expect({ first, rawCalls }).toEqual({ first: 'settled', rawCalls: 0 });
  });
  it('CE3: quota denial through the REAL handler must preserve saved validators as well as cursor', async () => {
    await db.run({
      sql: 'UPDATE sources SET enabled=1,daily_request_budget=0 WHERE id=?',
      params: ['playstation_blog'],
    });
    await db.run({
      sql: 'UPDATE source_state SET cursor=?,etag=?,last_modified=?,next_poll_at=? WHERE source_id=?',
      params: [
        SAVED.cursor,
        SAVED.etag,
        SAVED.lastModified,
        NOW + INGESTION_POLL_HOLD_MS,
        'playstation_blog',
      ],
    });
    let rawCalls = 0;
    const handler = createSourcePollHandler({
      executor: db,
      connectors: createConnectorRegistry(),
      fetchFn: async () => {
        rawCalls++;
        return new Response(null, { status: 304 });
      },
      idGenerator: { newId: () => 'unused' },
      secrets: () => undefined,
      nowMs: () => NOW,
      random: () => 0.5,
    });
    expect(
      await handler.execute({
        jobId: 'ce3',
        generation: 1,
        payload: { sourceId: 'playstation_blog', scheduledForMs: NOW },
      }),
    ).toEqual({ kind: 'success' });
    const row = await db.first<{
      cursor: string | null;
      etag: string | null;
      last_modified: string | null;
    }>({
      sql: 'SELECT cursor,etag,last_modified FROM source_state WHERE source_id=?',
      params: ['playstation_blog'],
    });
    expect({ rawCalls, ...row }).toEqual({
      rawCalls: 0,
      cursor: SAVED.cursor,
      etag: SAVED.etag,
      last_modified: SAVED.lastModified,
    });
  });
  it('CE4: RSS 429 Retry-After survives a later real quota denial in the same poll', async () => {
    await db.run({
      sql: 'UPDATE sources SET daily_request_budget=1 WHERE id=?',
      params: ['itch_discovery'],
    });
    let calls = 0;
    const fetchFn = transport('itch_discovery', async () => {
      calls++;
      return new Response(null, { status: 429, headers: { 'retry-after': '7200' } });
    });
    const result = await createRssConnector().fetch({
      sourceId: 'itch_discovery',
      config: { endpointTemplates: ['https://itch.io/feed/a', 'https://itch.io/feed/b'] },
      state: SAVED,
      effects: connectorEffects(fetchFn, {}),
    });
    expect({
      calls,
      denied: result.budgetDenied,
      retryAfterSeconds: result.retryAfterSeconds,
      requests: result.requestCount,
    }).toEqual({ calls: 1, denied: true, retryAfterSeconds: 7200, requests: 1 });
  });
  it('CE5: GitHub 429 Retry-After survives a later real quota denial in the same poll', async () => {
    await db.run({
      sql: 'UPDATE sources SET daily_request_budget=1 WHERE id=?',
      params: ['playstation_blog'],
    });
    let calls = 0;
    const fetchFn = transport('playstation_blog', async () => {
      calls++;
      return new Response(null, { status: 429, headers: { 'retry-after': '7200' } });
    });
    const result = await createGithubReleasesConnector().fetch({
      sourceId: 'playstation_blog',
      config: { repositories: ['owner/one', 'owner/two'], includePrereleases: false },
      state: SAVED,
      effects: connectorEffects(fetchFn, {}),
    });
    expect({
      calls,
      denied: result.budgetDenied,
      retryAfterSeconds: result.retryAfterSeconds,
      requests: result.requestCount,
    }).toEqual({ calls: 1, denied: true, retryAfterSeconds: 7200, requests: 1 });
  });
  it('CE4b: real RSS handler must not schedule earlier than an observed 7200-second provider bound after quota denial', async () => {
    await db.run({
      sql: 'UPDATE sources SET enabled=1,daily_request_budget=1 WHERE id=?',
      params: ['itch_discovery'],
    });
    await db.run({
      sql: 'UPDATE source_state SET next_poll_at=? WHERE source_id=?',
      params: [NOW + INGESTION_POLL_HOLD_MS, 'itch_discovery'],
    });
    let rawCalls = 0;
    const handler = createSourcePollHandler({
      executor: db,
      connectors: createConnectorRegistry(),
      fetchFn: async () => {
        rawCalls++;
        return new Response(null, { status: 429, headers: { 'retry-after': '7200' } });
      },
      idGenerator: { newId: () => 'unused' },
      secrets: () => undefined,
      nowMs: () => NOW,
      random: () => 0.5,
    });
    expect(
      await handler.execute({
        jobId: 'ce4b',
        generation: 1,
        payload: { sourceId: 'itch_discovery', scheduledForMs: NOW },
      }),
    ).toEqual({ kind: 'success' });
    const row = await db.first<{ next_poll_at: number; last_error: string | null }>({
      sql: 'SELECT next_poll_at,last_error FROM source_state WHERE source_id=?',
      params: ['itch_discovery'],
    });
    expect(rawCalls).toBe(1);
    expect(row?.last_error).toBe('budget_exhausted');
    expect(row!.next_poll_at).toBeGreaterThanOrEqual(NOW + 7_200_000);
  });
  it('CE6: a later authorization throw must not discard already observed raw attempts at the transport boundary', async () => {
    let grants = 0;
    let rawCalls = 0;
    let caught: unknown;
    const fetch = createIngestionSafeFetch({
      authorizeUnit: async () => {
        grants++;
        if (grants === 2) throw new Error('synthetic authority outage');
        return { kind: 'granted' };
      },
      fetchFn: async () => {
        rawCalls++;
        return new Response(null, {
          status: 302,
          headers: { location: 'https://blog.playstation.com/feed/final' },
        });
      },
    });
    try {
      await fetch(INPUT);
    } catch (error) {
      caught = error;
    }
    expect(rawCalls).toBe(1);
    expect(caught).toBeInstanceOf(Error);
    // An error crossing this boundary needs safe observed-attempt metadata.
    // It must remain an infrastructure throw, never a successful provider result.
    expect(caught).toHaveProperty('requestCount', 1);
  });
  it('CONTROL: concurrent grants cannot overspend a fresh one-unit bucket', async () => {
    await db.run({
      sql: 'UPDATE sources SET daily_request_budget=1 WHERE id=?',
      params: ['playstation_blog'],
    });
    const grants = await Promise.all(
      Array.from({ length: 10 }, () =>
        authorizeIngestionUnit(db, { sourceId: 'playstation_blog', nowMs: NOW }),
      ),
    );
    expect(grants.filter((g) => g.kind === 'authorized')).toHaveLength(1);
    expect(await readIngestionBudget(db, { sourceId: 'playstation_blog', nowMs: NOW })).toBe(1);
  });
});
