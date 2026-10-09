import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createJobsEngine, DEFAULT_ENGINE_BOUNDS, type JobsEngine } from '../../src/application/jobs/engine';
import { createJobHandlerRegistry } from '../../src/domain/jobs/handler';
import { createMaintenanceHeartbeatHandler } from '../../src/application/jobs/handlers/maintenance-heartbeat';
import { createSourcePollHandler, type SourcePollHandlerOptions } from '../../src/application/ingestion/poll-handler';
import { scheduleDueSources } from '../../src/application/ingestion/scheduler';
import { createConnectorRegistry } from '../../src/connectors/registry';
import type { JobsQueueProducerPort, DlqProducerPort } from '../../src/adapters/queue/jobs-producer';
import type { QueueEnvelope } from '../../src/domain/jobs/envelope';
import { fixedClock, type MutableClock } from '../../src/shared/time/clock';
import { createFetchMock, connectorEffects } from '../helpers/fetch-mock';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import { reserveSourcePoll } from '../../src/adapters/db/source-ingest-store';

/**
 * FULL ingestion pipeline on REAL workerd D1 (Phase 4 — ADR-0038 §3–§6):
 * source due → gated scheduler creates a durable job → dispatch sends the
 * producer's envelope body → engine consumes it → REAL poll handler →
 * mocked source HTTP → normalized D1 items + fenced state → job success.
 * Redelivery, 304, stale owners, crash windows, budget exhaustion,
 * Retry-After and auth circuits are all exercised end-to-end.
 */

const NOW = 1_770_000_000_000;

const VALID_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>PS Blog</title>
<item>
  <title>New Game Announced</title>
  <link>https://blog.playstation.com/article/new-game?utm_source=rss</link>
  <guid isPermaLink="false">ps-news-1</guid>
  <pubDate>Mon, 06 Oct 2025 10:00:00 +0000</pubDate>
  <description><![CDATA[<p>A big announcement</p>]]></description>
</item>
<item>
  <title>Second Story</title>
  <link>https://blog.playstation.com/article/second</link>
  <guid isPermaLink="false">ps-news-2</guid>
  <pubDate>Mon, 06 Oct 2025 09:00:00 +0000</pubDate>
</item>
</channel></rss>`;

interface Harness {
  readonly executor: DbExecutor;
  readonly engine: JobsEngine;
  readonly clock: MutableClock;
  readonly mock: ReturnType<typeof createFetchMock>;
  readonly sentEnvelopes: QueueEnvelope[];
  readonly handlerOptions: SourcePollHandlerOptions;
}

function createHarness(options?: { random?: () => number }): Harness {
  const clock = fixedClock(NOW);
  const executor = createDbExecutor(env.DB, { clock });
  const mock = createFetchMock();
  const effects = connectorEffects(mock.fetchFn, {});

  const handlerOptions: SourcePollHandlerOptions = {
    executor,
    connectors: createConnectorRegistry(),
    safeFetch: effects.safeFetch,
    idGenerator: {
      newId: () => `item-${Math.random().toString(36).slice(2, 10)}`,
    },
    secrets: (name: string) => effects.secrets(name),
    nowMs: () => clock.now(),
    random: options?.random ?? (() => 0.5),
  };

  const sentEnvelopes: QueueEnvelope[] = [];
  const jobsProducer: JobsQueueProducerPort = {
    send: async (envelope) => {
      sentEnvelopes.push(envelope);
    },
  };
  const dlqProducer: DlqProducerPort = {
    send: async () => {},
  };

  const engine = createJobsEngine(
    {
      executor,
      handlers: createJobHandlerRegistry([
        createMaintenanceHeartbeatHandler({ executor, nowMs: () => clock.now() }) as never,
        createSourcePollHandler(handlerOptions) as never,
      ]),
      idGenerator: { newId: () => `job-${sentEnvelopes.length}-${Math.random().toString(36).slice(2, 8)}` },
      clock,
      random: options?.random ?? (() => 0.5),
      jobsProducer,
      dlqProducer,
    },
    DEFAULT_ENGINE_BOUNDS,
  );

  return { executor, engine, clock, mock, sentEnvelopes, handlerOptions };
}

async function seedAndEnable(executor: DbExecutor, sourceId: string): Promise<void> {
  const registry = parseEmbeddedRegistry();
  if (!registry.ok) throw new Error('registry invalid');
  await seedSourcesFromRegistry(executor, registry.registry, NOW);
  await executor.run({ sql: 'UPDATE sources SET enabled = 1 WHERE id = ?', params: [sourceId] });
}

async function itemCount(executor: DbExecutor, sourceId: string): Promise<number> {
  const row = await executor.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
    params: [sourceId],
  });
  return row?.n ?? 0;
}

beforeEach(async () => {
  await applyMigrations(env.DB);
  await executor.run({ sql: 'DELETE FROM source_items' });
  await executor.run({ sql: 'DELETE FROM source_state' });
  await executor.run({ sql: 'DELETE FROM sources' });
  await executor.run({ sql: 'DELETE FROM jobs' });
  await executor.run({ sql: "DELETE FROM budgets WHERE scope = 'ingestion'" });
});

const executor: DbExecutor = createDbExecutor(env.DB);

describe('full ingestion pipeline', () => {
  it('runs due → durable job → queue body → handler → normalized items + fenced state', async () => {
    const h = createHarness();
    h.mock.setResponses([
      { status: 200, headers: { 'content-type': 'application/rss+xml', etag: '"etag-1"' }, bodyText: VALID_FEED },
    ]);

    // 1. First pass on an EMPTY sources table: the scheduler seeds the
    //    catalog (enabled = 0) — nothing is scheduled yet.
    const firstPass = await scheduleDueSources({
      executor: h.executor,
      engine: h.engine,
      connectors: createConnectorRegistry(),
      secrets: () => undefined,
      nowMs: h.clock.now(),
    });
    expect(firstPass.kind).toBe('scheduled');
    if (firstPass.kind !== 'scheduled') return;
    expect(firstPass.seeded).toBe(true);
    expect(firstPass.jobsCreated).toBe(0);

    // 2. The owner enables the source (reviewed activation procedure).
    await h.executor.run({
      sql: 'UPDATE sources SET enabled = 1 WHERE id = ?',
      params: ['playstation_blog'],
    });
    const scheduled = await scheduleDueSources({
      executor: h.executor,
      engine: h.engine,
      connectors: createConnectorRegistry(),
      secrets: () => undefined,
      nowMs: h.clock.now(),
    });
    if (scheduled.kind !== 'scheduled') return;
    expect(scheduled.jobsCreated).toBe(1);
    expect(scheduled.seeded).toBe(false); // repeat pass never re-seeds

    // Reservation advanced the window to the hold. (A never-polled source
    // seeds at next_poll_at = 0 — "due since the beginning" — so its first
    // hold is 0 + HOLD_MS; the deterministic key K(source, 0) absorbs any
    // duplicate references in this seeding tick, ADR-0038 §3.)
    const afterSchedule = await h.executor.first<{ next_poll_at: number }>({
      sql: 'SELECT next_poll_at FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(afterSchedule?.next_poll_at).toBe(120_000);

    // 2. Dispatch: the producer's envelope body is what the worker receives.
    const dispatch = await h.engine.dispatchDueJobs();
    expect(dispatch.dispatched).toBe(1);
    expect(h.sentEnvelopes).toHaveLength(1);
    const envelope = h.sentEnvelopes[0]!;
    expect(envelope.type).toBe('sources.fetch_poll');

    // 3. Consume the REAL delivered body (no manual JSON round trip).
    const action = await h.engine.consumeMessage(`msg-1`, envelope);
    expect(action).toMatchObject({ action: 'ack', outcome: 'job_completed' });

    // 4. Durable normalized items with dedup-clean identities.
    expect(await itemCount(h.executor, 'playstation_blog')).toBe(2);
    const first = await h.executor.first<{ external_id: string; canonical_url: string | null; title: string; body_excerpt: string | null; published_at: number | null; content_hash: string }>({
      sql: 'SELECT external_id, canonical_url, title, body_excerpt, published_at, content_hash FROM source_items WHERE external_id = ?',
      params: ['rss:ps-news-1'],
    });
    expect(first?.canonical_url).toBe('https://blog.playstation.com/article/new-game');
    expect(first?.title).toBe('New Game Announced');
    expect(first?.body_excerpt).toBe('A big announcement');
    expect(first?.published_at).toBe(Date.parse('Mon, 06 Oct 2025 10:00:00 +0000'));
    expect(first?.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // 5. Terminal state: schedule advanced past the hold, budget recorded.
    const state = await h.executor.first<{
      next_poll_at: number; last_success_at: number | null; consecutive_failures: number; last_error: string | null; requests_today: number; budget_date: string;
    }>({
      sql: 'SELECT next_poll_at, last_success_at, consecutive_failures, last_error, requests_today, budget_date FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(state?.next_poll_at).toBeGreaterThan(NOW + 120_000);
    expect(state?.last_success_at).toBe(NOW);
    expect(state?.consecutive_failures).toBe(0);
    expect(state?.last_error).toBeNull();
    expect(state?.requests_today).toBe(1);
    expect(state?.budget_date).not.toBeNull();

    // 6. Job terminal: succeeded, durable.
    const job = await h.executor.first<{ status: string }>({
      sql: 'SELECT status FROM jobs WHERE type = ?',
      params: ['sources.fetch_poll'],
    });
    expect(job?.status).toBe('succeeded');
  });

  it('absorbs duplicate delivery and 304 polls without new records', async () => {
    const h = createHarness();
    await seedAndEnable(h.executor, 'playstation_blog');
    h.mock.setResponses([
      { status: 200, headers: { 'content-type': 'application/rss+xml', etag: '"etag-1"' }, bodyText: VALID_FEED },
      { status: 304 },
      { status: 304 },
    ]);

    await scheduleDueSources({
      executor: h.executor,
      engine: h.engine,
      connectors: createConnectorRegistry(),
      secrets: () => undefined,
      nowMs: h.clock.now(),
    });
    await h.engine.dispatchDueJobs();
    const firstAction = await h.engine.consumeMessage('msg-1', h.sentEnvelopes[0]);
    expect(firstAction.action).toBe('ack');
    expect(await itemCount(h.executor, 'playstation_blog')).toBe(2);

    // Advance past the hold: source due again → new window → new job.
    h.clock.advance(6 * 60 * 1000);
    const scheduled2 = await scheduleDueSources({
      executor: h.executor,
      engine: h.engine,
      connectors: createConnectorRegistry(),
      secrets: () => undefined,
      nowMs: h.clock.now(),
    });
    if (scheduled2.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(scheduled2.jobsCreated).toBe(1);
    await h.engine.dispatchDueJobs();
    const secondAction = await h.engine.consumeMessage('msg-2', h.sentEnvelopes[1]);
    expect(secondAction.action).toBe('ack');

    // 304: NO new items, NO duplicate rows, scheduling-only metadata.
    expect(await itemCount(h.executor, 'playstation_blog')).toBe(2);
    const state = await h.executor.first<{ last_polled_at: number; consecutive_failures: number }>({
      sql: 'SELECT last_polled_at, consecutive_failures FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(state?.last_polled_at).toBe(h.clock.now());
    expect(state?.consecutive_failures).toBe(0);

    // Redelivery of the SAME envelope (at-least-once): absorbed safely.
    const redelivered = await h.engine.consumeMessage('msg-2-redelivery', h.sentEnvelopes[1]);
    expect(redelivered).toMatchObject({ action: 'ack' });
    expect(await itemCount(h.executor, 'playstation_blog')).toBe(2);
  });

  it('classifies duplicate items honestly (external id and canonical url)', async () => {
    const h = createHarness();
    await seedAndEnable(h.executor, 'playstation_blog');
    // Same guid, same URL both polls → duplicates classified, not double-stored.
    h.mock.setResponses([
      { status: 200, headers: { 'content-type': 'application/rss+xml' }, bodyText: VALID_FEED },
      { status: 200, headers: { 'content-type': 'application/rss+xml' }, bodyText: VALID_FEED },
    ]);

    await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    await h.engine.dispatchDueJobs();
    await h.engine.consumeMessage('msg-1', h.sentEnvelopes[0]);
    expect(await itemCount(h.executor, 'playstation_blog')).toBe(2);

    h.clock.advance(6 * 60 * 1000);
    await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    await h.engine.dispatchDueJobs();
    await h.engine.consumeMessage('msg-2', h.sentEnvelopes[1]);
    // Still exactly 2 durable rows; the handler logged the duplicates.
    expect(await itemCount(h.executor, 'playstation_blog')).toBe(2);
  });

  it('fences a stale worker: items land, newer state is never overwritten', async () => {
    const h = createHarness();
    await seedAndEnable(h.executor, 'playstation_blog');

    // Poll A's job payload holds the OLD window; poll B already advanced.
    const stalePayload = { sourceId: 'playstation_blog', scheduledForMs: NOW };
    const created = await h.engine.createDurableJob({
      type: 'sources.fetch_poll',
      idempotencyKey: 'stale-poll-key',
      payload: stalePayload,
    });
    expect(created.kind).toBe('created');

    // Meanwhile a NEWER reservation moved the window (simulating poll B).
    await h.executor.run({
      sql: 'UPDATE source_state SET next_poll_at = ? WHERE source_id = ?',
      params: [NOW + 500_000, 'playstation_blog'],
    });
    // Newer poll already recorded its state.
    await h.executor.run({
      sql: `UPDATE source_state SET last_success_at = ?, last_polled_at = ? WHERE source_id = ?`,
      params: [NOW + 400_000, NOW + 400_000, 'playstation_blog'],
    });

    h.mock.setResponses([
      { status: 200, headers: { 'content-type': 'application/rss+xml' }, bodyText: VALID_FEED },
    ]);
    // Dispatch + consume the STALE job.
    await h.engine.dispatchDueJobs();
    const action = await h.engine.consumeMessage('msg-stale', h.sentEnvelopes[0]);
    expect(action.action).toBe('ack'); // poll completed durably

    // Stale items STILL land (assets, dedup-safe)…
    expect(await itemCount(h.executor, 'playstation_blog')).toBe(2);
    // …but the newer poll's state was NOT overwritten (fenced write lost).
    const state = await h.executor.first<{ last_success_at: number; next_poll_at: number }>({
      sql: 'SELECT last_success_at, next_poll_at FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(state?.last_success_at).toBe(NOW + 400_000);
    expect(state?.next_poll_at).toBe(NOW + 500_000);
  });

  it('recovers when the scheduler crashes between reservation and dispatch', async () => {
    const h = createHarness();
    await seedAndEnable(h.executor, 'playstation_blog');
    h.mock.setResponses([
      { status: 200, headers: { 'content-type': 'application/rss+xml' }, bodyText: VALID_FEED },
    ]);

    // Seed + due now: the state starts at next_poll_at = NOW (a realistic
    // due marker, like the scheduler just scanned).
    await seedAndEnable(h.executor, 'playstation_blog');
    await h.executor.run({
      sql: 'UPDATE source_state SET next_poll_at = ? WHERE source_id = ?',
      params: [h.clock.now(), 'playstation_blog'],
    });

    // Reserve ONLY (crash before job creation): the hold expires quickly.
    const reservation = await reserveSourcePoll(h.executor, {
      sourceId: 'playstation_blog',
      scheduledForMs: h.clock.now(),
      nowMs: h.clock.now(),
    });
    expect(reservation.kind).toBe('reserved');

    // The source is NOT due during the hold.
    const duringHold = await h.executor.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_state WHERE next_poll_at <= ? AND source_id = ?',
      params: [h.clock.now(), 'playstation_blog'],
    });
    expect(duringHold?.n).toBe(0);

    // After the hold expires the source self-heals back into the scan.
    h.clock.advance(121_000);
    const scheduled = await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    if (scheduled.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(scheduled.jobsCreated).toBe(1);
    await h.engine.dispatchDueJobs();
    const action = await h.engine.consumeMessage('msg-recovered', h.sentEnvelopes[0]);
    expect(action).toMatchObject({ action: 'ack' });
    expect(await itemCount(h.executor, 'playstation_blog')).toBe(2);
  });

  it('writes provider backoff and failure ladder without job retries', async () => {
    const h = createHarness();
    await seedAndEnable(h.executor, 'playstation_blog');
    h.mock.setResponses([{ failReason: 'network_error' }]);

    await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    await h.engine.dispatchDueJobs();
    const action = await h.engine.consumeMessage('msg-fail', h.sentEnvelopes[0]);
    // Provider-class failure: the JOB succeeds (attempt recorded); the
    // SOURCE owns the retry via its adaptive schedule.
    expect(action).toMatchObject({ action: 'ack', outcome: 'job_completed' });

    const state = await h.executor.first<{
      consecutive_failures: number; last_error: string | null; next_poll_at: number; last_success_at: number | null;
    }>({
      sql: 'SELECT consecutive_failures, last_error, next_poll_at, last_success_at FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(state?.consecutive_failures).toBe(1);
    expect(state?.last_error).toBe('http_status_error');
    expect(state?.last_success_at).toBeNull();
    // Backoff: interval(300s) × 2^1 ± 10% jitter → 480–600s after NOW.
    const delta = (state?.next_poll_at ?? 0) - h.clock.now();
    expect(delta).toBeGreaterThanOrEqual(480_000);
    expect(delta).toBeLessThanOrEqual(600_000);

    // Job terminal state: succeeded (one attempt durably recorded).
    const job = await h.executor.first<{ status: string; attempts: number }>({
      sql: 'SELECT status, attempts FROM jobs WHERE type = ?',
      params: ['sources.fetch_poll'],
    });
    expect(job?.status).toBe('succeeded');
    expect(job?.attempts).toBe(1);
  });

  it('honors 429 Retry-After as a TRUE lower bound', async () => {
    const h = createHarness({ random: () => 0 }); // jitter off
    await seedAndEnable(h.executor, 'playstation_blog');
    h.mock.setResponses([{ status: 429, headers: { 'retry-after': '7200' } }]); // 2 hours

    await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    await h.engine.dispatchDueJobs();
    const action = await h.engine.consumeMessage('msg-429', h.sentEnvelopes[0]);
    expect(action.action).toBe('ack');

    const state = await h.executor.first<{ next_poll_at: number }>({
      sql: 'SELECT next_poll_at FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    // No generic cap may shorten a provider's Retry-After: full 2 hours.
    const delta = (state?.next_poll_at ?? 0) - h.clock.now();
    expect(delta).toBe(7_200_000);
  });

  it('opens a circuit with a stable reason on credential rejection', async () => {
    const h = createHarness();
    await seedAndEnable(h.executor, 'github_release_watchlist');
    // Owner-supplied runtime watchlist (the registry ships an empty one).
    await h.executor.run({
      sql: 'UPDATE sources SET config_json = ? WHERE id = ?',
      params: [JSON.stringify({ repositories: ['owner/repo-a'], includePrereleases: false }), 'github_release_watchlist'],
    });
    h.mock.setResponses([{ status: 401 }]);

    await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    await h.engine.dispatchDueJobs();
    const action = await h.engine.consumeMessage('msg-401', h.sentEnvelopes[0]);
    expect(action.action).toBe('ack');

    const state = await h.executor.first<{ circuit_open_until: number | null; last_error: string | null }>({
      sql: 'SELECT circuit_open_until, last_error FROM source_state WHERE source_id = ?',
      params: ['github_release_watchlist'],
    });
    expect(state?.circuit_open_until).toBe(h.clock.now() + 30 * 60 * 1000);
    expect(state?.last_error).toBe('credentials_rejected');

    // While the circuit is open, the scan selects NOTHING (no hot loop).
    h.clock.advance(60_000);
    const scheduled = await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    if (scheduled.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(scheduled.jobsCreated).toBe(0);
  });

  it('ends budget-exhausted polls without network and without failure increments', async () => {
    const h = createHarness();
    await seedAndEnable(h.executor, 'playstation_blog');
    await h.executor.run({
      sql: 'UPDATE sources SET daily_request_budget = 0 WHERE id = ?',
      params: ['playstation_blog'],
    });

    await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    await h.engine.dispatchDueJobs();
    const action = await h.engine.consumeMessage('msg-budget', h.sentEnvelopes[0]);
    expect(action.action).toBe('ack');

    // NO network call happened.
    expect(h.mock.calls).toHaveLength(0);
    const state = await h.executor.first<{ last_error: string | null; consecutive_failures: number; next_poll_at: number }>({
      sql: 'SELECT last_error, consecutive_failures, next_poll_at FROM source_state WHERE source_id = ?',
      params: ['playstation_blog'],
    });
    expect(state?.last_error).toBe('budget_exhausted');
    expect(state?.consecutive_failures).toBe(0); // budget is not a source fault
    // Retry in 10 minutes, not a hot loop.
    expect((state?.next_poll_at ?? 0) - h.clock.now()).toBe(10 * 60 * 1000);
  });

  it('skips blocked sources at scheduling time with a stable reason (no job, no network)', async () => {
    const h = createHarness();
    await seedAndEnable(h.executor, 'steam_news_watchlist'); // registry ships NO app watchlist

    const scheduled = await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    if (scheduled.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(scheduled.jobsCreated).toBe(0);
    expect(scheduled.blockedSkipped).toBe(1);
    expect(h.mock.calls).toHaveLength(0);

    const state = await h.executor.first<{ last_error: string | null; next_poll_at: number }>({
      sql: 'SELECT last_error, next_poll_at FROM source_state WHERE source_id = ?',
      params: ['steam_news_watchlist'],
    });
    expect(state?.last_error).toBe('watchlist_empty');
    expect(state?.next_poll_at).toBe(h.clock.now() + 600_000); // interval 600s
  });

  it('never schedules catalog-only connectors (bluesky/igdb stay blocked)', async () => {
    const h = createHarness();
    const registry = parseEmbeddedRegistry();
    if (!registry.ok) throw new Error('registry invalid');
    await seedSourcesFromRegistry(h.executor, registry.registry, NOW);
    // Hostile direct enablement of an unimplemented connector.
    await h.executor.run({ sql: 'UPDATE sources SET enabled = 1 WHERE id = ?', params: ['bluesky_watchlist'] });

    const scheduled = await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    if (scheduled.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(scheduled.jobsCreated).toBe(0);
    const state = await h.executor.first<{ last_error: string | null }>({
      sql: 'SELECT last_error FROM source_state WHERE source_id = ?',
      params: ['bluesky_watchlist'],
    });
    expect(state?.last_error).toBe('connector_not_implemented');
  });

  it('derives the same deterministic window key for overlapping crons (idempotent create)', async () => {
    const h = createHarness();
    await seedAndEnable(h.executor, 'playstation_blog');
    // Steady state: a realistic due marker (not the seeding window 0).
    await h.executor.run({
      sql: 'UPDATE source_state SET next_poll_at = ? WHERE source_id = ?',
      params: [h.clock.now(), 'playstation_blog'],
    });

    // TWO overlapping scheduling passes on the SAME state.
    const pass1 = await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    const pass2 = await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    if (pass1.kind !== 'scheduled' || pass2.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(pass1.jobsCreated).toBe(1);
    expect(pass2.jobsCreated).toBe(0); // SAME window key → idempotent absorb

    const jobCount = await h.executor.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM jobs WHERE type = ?',
      params: ['sources.fetch_poll'],
    });
    expect(jobCount?.n).toBe(1);

    // A LATER legitimate poll advances the window → a FRESH key.
    h.clock.advance(6 * 60 * 1000);
    const pass3 = await scheduleDueSources({
      executor: h.executor, engine: h.engine, connectors: createConnectorRegistry(),
      secrets: () => undefined, nowMs: h.clock.now(),
    });
    if (pass3.kind !== 'scheduled') throw new Error('expected scheduled');
    expect(pass3.jobsCreated).toBe(1);
  });
});

describe('gate-off preserves Phase 3 behavior', () => {
  it('a delivered poll envelope with NO registered handler is poisoned, not executed', async () => {
    const h = createHarness();
    // Simulate the gate-off deployment: only the Phase 3 handler set.
    const engine = createJobsEngine({
      executor: h.executor,
      handlers: createJobHandlerRegistry([
        createMaintenanceHeartbeatHandler({ executor: h.executor, nowMs: () => h.clock.now() }) as never,
      ]),
      idGenerator: { newId: () => `job-${Math.random().toString(36).slice(2, 8)}` },
      clock: h.clock,
      random: () => 0.5,
      jobsProducer: { send: async () => {} },
      dlqProducer: { send: async () => {} },
    }, DEFAULT_ENGINE_BOUNDS);

    const action = await engine.consumeMessage('msg-stray', {
      version: 1,
      jobId: 'unknown-job',
      type: 'sources.fetch_poll',
      attempt: 1,
      traceId: 't1',
    });
    // D1 owns the truth: the job row does not exist → safe ack, no fetch.
    expect(action).toMatchObject({ action: 'ack', outcome: 'job_missing' });
    expect(h.mock.calls).toHaveLength(0);
    expect(await itemCount(h.executor, 'playstation_blog')).toBe(0);
  });

  it('maintenance heartbeat keeps working alongside ingestion handlers', async () => {
    const h = createHarness();
    const created = await h.engine.createDurableJob({
      type: 'jobs.maintenance_heartbeat',
      idempotencyKey: 'hb-1',
      payload: {},
    });
    expect(created.kind).toBe('created');
    await h.engine.dispatchDueJobs();
    const action = await h.engine.consumeMessage('msg-hb', h.sentEnvelopes[0]);
    expect(action).toMatchObject({ action: 'ack', outcome: 'job_completed' });
    const heartbeat = await h.executor.first<{ value_json: string }>({
      sql: "SELECT value_json FROM settings WHERE key = 'jobs_maintenance:heartbeat'",
    });
    expect(heartbeat?.value_json).not.toBeNull();
  });
});
