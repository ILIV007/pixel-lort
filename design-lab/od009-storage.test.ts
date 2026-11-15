/**
 * R1.10.3 DESIGN LAB — OD-009 STORAGE MEASUREMENT harness (REAL workerd D1).
 *
 * DESIGN-LAB evidence — NOT accepted product source, NOT product tests.
 *
 * OD-009 (`docs/OPEN_DECISIONS.md`, OPEN) is the source-data retention
 * decision (`globalPolicies.storeRawDays = 90` validated but NOT enforced).
 * The recorded recommendation is Option C — "defer enforcement, MEASURE
 * first" — because arrival/retention actuals are UNMEASURED (risk
 * R-STORAGE; documented D1 Free cap = 500 MB per database). THIS suite
 * delivers exactly that measurement, non-destructively:
 *
 *   S-01  one REAL poll cycle ingests 100 max-shape items (URL ≈2 KiB,
 *         title/excerpt 512-char caps) through the REAL pipeline, then
 *         measures per-component PAYLOAD bytes of the committed rows
 *         (canonical_url / title / body_excerpt / raw_json / content_hash
 *         / external_id / author / ids) via SQLite BLOB byte lengths;
 *   S-02  seven sources × 20 max-shape items — per-row byte consistency
 *         at scale (avg within tolerance of S-01);
 *   S-03  extrapolation arithmetic from the measured bytes + the EMBEDDED
 *         registry (per-source intervalSeconds / dailyRequestBudget /
 *         connector caps): worst-case items/day, bytes/day, days to the
 *         documented 500 MB cap, 90-day steady state, and the Option-A
 *         raw_json-purge relief share.
 *
 * HONESTY LABELS (mandatory): LOCAL workerd proxy measurements on a
 * disposable SQLite-backed D1. Measured bytes are PAYLOAD bytes only —
 * page/index/WAL overhead is reported ONLY when PRAGMA page_count/
 * page_size is available in this pool (recorded, never guessed). INTEGER
 * column bytes are NOT measured (a nominal constant is added, labeled).
 * Extrapolation rows are ARITHMETIC on locally measured bytes — they are
 * NOT cloud storage forecasts and draw NO cloud quota conclusion. No
 * deletion is performed, proposed in code, or scheduled; OD-009 stays an
 * OPEN owner decision and Free readiness stays NOT_READY until owner/
 * Posidon end-to-end evidence.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, MIGRATIONS } from '../tests/helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../src/adapters/db/db-executor';
import {
  createJobsEngine,
  DEFAULT_ENGINE_BOUNDS,
  type JobsEngine,
} from '../src/application/jobs/engine';
import { createJobHandlerRegistry } from '../src/domain/jobs/handler';
import { createMaintenanceHeartbeatHandler } from '../src/application/jobs/handlers/maintenance-heartbeat';
import {
  createSourcePollHandler,
  type SourcePollHandlerOptions,
} from '../src/application/ingestion/poll-handler';
import { scheduleDueSources } from '../src/application/ingestion/scheduler';
import { createConnectorRegistry } from '../src/connectors/registry';
import type { JobsQueueProducerPort, DlqProducerPort } from '../src/adapters/queue/jobs-producer';
import type { QueueEnvelope } from '../src/domain/jobs/envelope';
import { fixedClock, type MutableClock } from '../src/shared/time/clock';
import { createRawFetchMock } from '../tests/helpers/fetch-mock';
import { parseEmbeddedRegistry, INGESTION_LIMITS } from '../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../src/adapters/db/source-registry-store';
import {
  createD1Stats,
  instrumentD1,
  resetStats,
  type D1Stats,
} from '../audit-tools/trace/d1-instrument';
import { labLog } from './lab-log';

const NOW = 1_770_000_000_000;
/** Documented D1 Free per-database cap (docs/OPEN_DECISIONS.md OD-009). */
const D1_FREE_CAP_BYTES = 500 * 1024 * 1024;
/**
 * Nominal per-row overhead added to measured PAYLOAD bytes: 5 INTEGER
 * columns x 8 bytes + ~8-byte record header. LABELED as nominal — not a
 * measurement.
 */
const NOMINAL_ROW_OVERHEAD_BYTES = 48;
/** Conservative default per-poll item cap for connectors whose schema
 * does not state a verifiable per-poll cap (understated risk only for
 * igdb's single daily poll; labeled in the emitted row). */
const DEFAULT_ITEMS_CAP_PER_POLL = 100;

/** All seven RSS registry entries (the only implemented connector here). */
const RSS_SOURCES = [
  'playstation_blog',
  'xbox_wire',
  'ign_games',
  'eurogamer_news',
  'moddb_news',
  'moddb_headlines',
  'itch_discovery',
] as const;
const RAW_FETCHES = RSS_SOURCES.length + 1; // 7 sources, 8 feed URLs (itch_discovery x2)

/* ------------------------------------------------------------------ */
/* Feed fixtures (same shapes as the workload harness)                 */
/* ------------------------------------------------------------------ */

interface FeedItemShape {
  readonly link: string;
  readonly title: string;
  readonly bodyText: string;
}

function xmlEscape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function rssFeed(items: readonly FeedItemShape[], etag: string): string {
  const entries = items
    .map(
      (item, i) => `  <item>
    <title>${xmlEscape(item.title)}</title>
    <link>${xmlEscape(item.link)}</link>
    <guid isPermaLink="false">od-${etag}-${i}</guid>
    <pubDate>Mon, 06 Oct 2025 10:00:00 +0000</pubDate>
    <description><![CDATA[${item.bodyText}]]></description>
  </item>`,
    )
    .join('\n');
  return `<?xml version="1.0"?>
<rss version="2.0"><channel><title>od009 storage feed</title>
${entries}
</channel></rss>`;
}

/**
 * Max documented per-item shape through the REAL connector (identical to
 * the workload harness W-06 shape): canonical URL ≈2 KiB, title 512-char
 * cap, excerpt 512-char cap. rawJson derives from the raw fields bounded
 * by the documented caps — no fixture bypasses the normalizer.
 */
function maxItems(n: number, tag: string): FeedItemShape[] {
  return Array.from({ length: n }, (_, i) => ({
    link: `https://workload.example/${'p'.repeat(2010)}/${tag}-${i}`,
    title: 't'.repeat(511) + String(i % 10),
    bodyText: 'e'.repeat(512),
  }));
}

/* ------------------------------------------------------------------ */
/* Harness (same wiring as the workload harness)                       */
/* ------------------------------------------------------------------ */

interface StorageHarness {
  readonly executor: DbExecutor;
  readonly engine: JobsEngine;
  readonly clock: MutableClock;
  readonly mock: ReturnType<typeof createRawFetchMock>;
}

let idCounter = 0;

function createStorageHarness(): StorageHarness {
  const clock = fixedClock(NOW);
  const executor = createDbExecutor(wrapped as D1Database, { clock });
  const mock = createRawFetchMock();

  const handlerOptions: SourcePollHandlerOptions = {
    executor,
    connectors: createConnectorRegistry(),
    fetchFn: mock.fetchFn,
    idGenerator: {
      newId: () => `od-item-${(idCounter += 1)}`,
    },
    secrets: () => undefined,
    nowMs: () => clock.now(),
    random: () => 0.5,
  };

  const jobsProducer: JobsQueueProducerPort = {
    send: async (envelope) => {
      pendingEnvelopes.push(envelope);
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
      idGenerator: {
        newId: () => `od-job-${(idCounter += 1)}`,
      },
      clock,
      random: () => 0.5,
      jobsProducer,
      dlqProducer,
    },
    DEFAULT_ENGINE_BOUNDS,
  );

  return { executor, engine, clock, mock };
}

let stats: D1Stats;
let wrapped: D1Database;

async function seedAndEnable(executor: DbExecutor, ids: readonly string[]): Promise<void> {
  const registry = parseEmbeddedRegistry();
  if (!registry.ok) throw new Error('registry invalid');
  await seedSourcesFromRegistry(executor, registry.registry, NOW);
  for (const id of ids) {
    await executor.run({ sql: 'UPDATE sources SET enabled = 1 WHERE id = ?', params: [id] });
  }
}

async function itemCount(executor: DbExecutor, sourceId: string): Promise<number> {
  const row = await executor.first<{ n: number }>({
    sql: 'SELECT COUNT(*) AS n FROM source_items WHERE source_id = ?',
    params: [sourceId],
  });
  return row?.n ?? 0;
}

async function runOneCycle(
  h: StorageHarness,
  tag: string,
): Promise<{ envelopes: number; itemsCommitted: number }> {
  resetStats(stats);
  const schedule = await scheduleDueSources({
    executor: h.executor,
    engine: h.engine,
    connectors: createConnectorRegistry(),
    secrets: () => undefined,
    nowMs: h.clock.now(),
  });
  if (schedule.kind !== 'scheduled') {
    throw new Error(`scheduler pass failed: ${schedule.kind}`);
  }
  await h.engine.dispatchDueJobs();
  const envelopes = pendingEnvelopes.splice(0);
  for (let i = 0; i < envelopes.length; i += 1) {
    await h.engine.consumeMessage(`od-msg-${tag}-${i}`, envelopes[i] as QueueEnvelope);
  }
  return { envelopes: envelopes.length, itemsCommitted: envelopes.length };
}

/* ------------------------------------------------------------------ */
/* Storage measurement                                                 */
/* ------------------------------------------------------------------ */

interface ComponentBytes {
  readonly n: number;
  readonly url_bytes: number;
  readonly title_bytes: number;
  readonly excerpt_bytes: number;
  readonly raw_bytes: number;
  readonly hash_bytes: number;
  readonly ext_bytes: number;
  readonly author_bytes: number;
  readonly id_bytes: number;
}

async function measureComponentBytes(executor: DbExecutor): Promise<ComponentBytes> {
  const row = await executor.first<ComponentBytes>({
    sql: `SELECT COUNT(*) AS n,
              COALESCE(SUM(length(CAST(canonical_url AS BLOB))), 0) AS url_bytes,
              COALESCE(SUM(length(CAST(title AS BLOB))), 0) AS title_bytes,
              COALESCE(SUM(length(CAST(body_excerpt AS BLOB))), 0) AS excerpt_bytes,
              COALESCE(SUM(length(CAST(raw_json AS BLOB))), 0) AS raw_bytes,
              COALESCE(SUM(length(CAST(content_hash AS BLOB))), 0) AS hash_bytes,
              COALESCE(SUM(length(CAST(external_id AS BLOB))), 0) AS ext_bytes,
              COALESCE(SUM(length(CAST(author AS BLOB))), 0) AS author_bytes,
              COALESCE(SUM(length(CAST(id AS BLOB)) + length(CAST(source_id AS BLOB))), 0)
                AS id_bytes
          FROM source_items`,
    params: [],
  });
  if (!row) throw new Error('component-byte measurement returned no row');
  return row;
}

interface PageInfo {
  readonly available: boolean;
  readonly page_size: number | null;
  readonly page_count: number | null;
  readonly totalBytes: number | null;
}

async function measureDbPages(executor: DbExecutor): Promise<PageInfo> {
  try {
    const ps = await executor.first<{ page_size: number }>({
      sql: 'PRAGMA page_size',
      params: [],
    });
    const pc = await executor.first<{ page_count: number }>({
      sql: 'PRAGMA page_count',
      params: [],
    });
    if (!ps || !pc || !ps.page_size || !pc.page_count) {
      return { available: false, page_size: null, page_count: null, totalBytes: null };
    }
    return {
      available: true,
      page_size: ps.page_size,
      page_count: pc.page_count,
      totalBytes: ps.page_size * pc.page_count,
    };
  } catch {
    return { available: false, page_size: null, page_count: null, totalBytes: null };
  }
}

interface DerivedBytes {
  readonly payloadBytes: number;
  readonly payloadPerItem: number;
  readonly wholeRowEstimatePerItem: number;
  readonly rawShare: number;
}

function deriveBytes(c: ComponentBytes): DerivedBytes {
  const payloadBytes =
    c.url_bytes +
    c.title_bytes +
    c.excerpt_bytes +
    c.raw_bytes +
    c.hash_bytes +
    c.ext_bytes +
    c.author_bytes +
    c.id_bytes;
  const payloadPerItem = payloadBytes / c.n;
  const wholeRowEstimatePerItem = payloadPerItem + NOMINAL_ROW_OVERHEAD_BYTES;
  const rawShare = c.raw_bytes / payloadBytes;
  return {
    payloadBytes,
    payloadPerItem,
    wholeRowEstimatePerItem,
    rawShare,
  };
}

interface StorageRow {
  readonly id: string;
  readonly scenario: string;
  readonly items: number;
  readonly componentBytes: ComponentBytes;
  readonly derived: {
    readonly payloadBytes: number;
    readonly payloadPerItem: number;
    readonly wholeRowEstimatePerItem: number;
    readonly rawSharePct: number;
  };
  readonly dbPages: PageInfo;
  readonly extrapolation?: Record<string, unknown>;
  readonly units: string;
  readonly honesty: string;
}

function emitStorage(row: StorageRow): void {
  labLog('LABSTORAGE[' + JSON.stringify(row) + ']');
}

const UNITS =
  'bytes = SQLite BLOB byte lengths of stored TEXT payload components (measured); ' +
  'wholeRowEstimate = payloadPerItem + NOMINAL_ROW_OVERHEAD_BYTES (nominal constant, not measured); ' +
  'dbPages available ONLY when PRAGMA page_count/page_size works in this pool';

const HONESTY =
  'DESIGN-LAB, LOCAL workerd proxy on disposable SQLite-backed D1; payload bytes are LOCAL ' +
  'measurements, page/index/WAL overhead excluded unless dbPages.available; extrapolation rows ' +
  'are ARITHMETIC on local bytes - NOT cloud storage forecasts, NO cloud quota conclusion; ' +
  'OD-009 stays an OPEN owner decision (no deletion performed, proposed, or scheduled); ' +
  'Free readiness stays NOT_READY until owner/Posidon end-to-end evidence';

/* ------------------------------------------------------------------ */
/* Migrations + reset                                                  */
/* ------------------------------------------------------------------ */

beforeEach(async () => {
  await applyMigrations(env.DB, MIGRATIONS);
  for (const t of ['source_items', 'source_state', 'sources', 'jobs']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  await env.DB.prepare(`DELETE FROM budgets WHERE scope = 'ingestion'`).run();
  stats = createD1Stats();
  wrapped = instrumentD1(env.DB as D1Database, stats);
  pendingEnvelopes.length = 0;
});

const pendingEnvelopes: QueueEnvelope[] = [];

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

describe('R1.10.3 design lab OD-009 — non-destructive storage measurement (real workerd D1)', () => {
  let s01: { component: ComponentBytes; derived: DerivedBytes; pages: PageInfo } | null = null;

  it('S-01 one REAL poll cycle: 100 max-shape items, per-component byte measurement', async () => {
    const h = createStorageHarness();
    await seedAndEnable(h.executor, [RSS_SOURCES[0] as string]);
    h.mock.setResponses([
      {
        status: 200,
        headers: { 'content-type': 'application/rss+xml', etag: '"od-1"' },
        bodyText: rssFeed(maxItems(100, 's01'), '1'),
      },
    ]);

    const cycle = await runOneCycle(h, 'a');
    const inserted = await itemCount(h.executor, RSS_SOURCES[0]);
    expect(cycle.envelopes).toBe(1);
    expect(inserted).toBe(100);

    const component = await measureComponentBytes(h.executor);
    expect(component.n).toBe(100);
    const derived = deriveBytes(component);
    // Max-shape sanity: URL > 2 KiB, title/excerpt exactly at the caps.
    expect(component.url_bytes / component.n).toBeGreaterThan(2000);
    expect(component.title_bytes / component.n).toBe(512);
    expect(component.excerpt_bytes / component.n).toBe(512);
    // raw_json is present and material (dominant-share candidate for A).
    expect(component.raw_bytes / component.n).toBeGreaterThan(0);
    const pages = await measureDbPages(h.executor);

    emitStorage({
      id: 'S-01',
      scenario:
        'one REAL poll cycle, 1 source, 100 max-shape items (URL ~2KiB + title/excerpt 512 caps); per-component stored payload bytes measured on committed rows',
      items: component.n,
      componentBytes: component,
      derived: {
        payloadBytes: derived.payloadBytes,
        payloadPerItem: Math.round(derived.payloadPerItem),
        wholeRowEstimatePerItem: Math.round(derived.wholeRowEstimatePerItem),
        rawSharePct: Math.round(derived.rawShare * 10000) / 100,
      },
      dbPages: pages,
      units: UNITS,
      honesty: HONESTY,
    });

    s01 = { component, derived, pages };
  });

  it('S-02 seven sources x 20 max-shape items: per-row byte consistency at scale', async () => {
    const h = createStorageHarness();
    await seedAndEnable(h.executor, RSS_SOURCES);
    const feed = rssFeed(maxItems(20, 's02'), '2');
    // SEVEN sources but EIGHT raw fetches: the REAL pipeline polls EVERY
    // configured feed URL of a source in one poll (itch_discovery carries
    // TWO endpointTemplates — the same documented behavior poll-workload
    // W-07 asserts as rawHttpRequests EXACTLY 8). The original fixture
    // scripted only SEVEN responses — one fetch always hit the empty
    // queue, and WHICH source starved depended on nondeterministic
    // dispatch order (the suite passed on 2026-11-06 only by luck).
    // Eight responses make every feed succeed; itch_discovery's second
    // feed dedups onto the same 20 items (UNIQUE(source_id, external_id)).
    h.mock.setResponses(
      Array.from({ length: RAW_FETCHES }, () => ({
        status: 200,
        headers: { 'content-type': 'application/rss+xml', etag: '"od-2"' },
        bodyText: feed,
      })),
    );

    const cycle = await runOneCycle(h, 'b');
    expect(cycle.envelopes).toBe(RSS_SOURCES.length);
    for (const id of RSS_SOURCES) {
      expect(await itemCount(h.executor, id as string)).toBe(20);
    }

    const component = await measureComponentBytes(h.executor);
    expect(component.n).toBe(140);
    const derived = deriveBytes(component);
    if (!s01) throw new Error('S-01 must run before S-02');
    // Same max shape => per-item bytes must be consistent across runs
    // (guid/id lengths are the only varying component; 3% tolerance).
    const drift = Math.abs(derived.payloadPerItem - s01.derived.payloadPerItem);
    expect(drift / s01.derived.payloadPerItem).toBeLessThan(0.03);
    const pages = await measureDbPages(h.executor);

    emitStorage({
      id: 'S-02',
      scenario:
        '7 RSS sources x 20 max-shape items each (per-source dedup keys), per-row byte consistency check against S-01',
      items: component.n,
      componentBytes: component,
      derived: {
        payloadBytes: derived.payloadBytes,
        payloadPerItem: Math.round(derived.payloadPerItem),
        wholeRowEstimatePerItem: Math.round(derived.wholeRowEstimatePerItem),
        rawSharePct: Math.round(derived.rawShare * 10000) / 100,
      },
      dbPages: pages,
      units: UNITS,
      honesty: HONESTY,
    });
  });

  it('S-03 extrapolation: embedded-registry worst-case arrivals x measured bytes', async () => {
    if (!s01) throw new Error('S-01 must run before S-03');
    const registry = parseEmbeddedRegistry();
    if (!registry.ok) throw new Error('registry invalid');

    // Per-poll item caps: verified bounds where the schema states them,
    // conservative DEFAULT elsewhere (labeled).
    const capPerPoll: Record<string, number> = {
      rss: INGESTION_LIMITS.maxItemsPerFeed,
      'steam-news': 25 * 10, // appsPerBatch.max x maxItemsPerApp.max (schema bounds)
      'reddit-oauth': 10 * 50, // subreddits.max x limit.max (schema bounds)
    };
    const perSource = registry.registry.sources.map((s) => {
      const pollsPerDay = Math.floor(86400 / s.intervalSeconds);
      const cap = capPerPoll[s.connector] ?? DEFAULT_ITEMS_CAP_PER_POLL;
      return {
        id: s.id,
        connector: s.connector,
        pollsPerDay,
        capPerPoll: cap,
        worstItemsPerDay: Math.min(s.dailyRequestBudget, pollsPerDay * cap),
      };
    });
    const itemsPerDay = perSource.reduce((acc, s) => acc + s.worstItemsPerDay, 0);
    const budgetCeilingPerDay = registry.registry.sources.reduce(
      (acc, s) => acc + s.dailyRequestBudget,
      0,
    );

    const wholeRowBytes = s01.derived.wholeRowEstimatePerItem;
    const normalizedOnlyBytes = wholeRowBytes - s01.component.raw_bytes / s01.component.n;

    const bytesPerDay = itemsPerDay * wholeRowBytes;
    const daysToCap500MB = D1_FREE_CAP_BYTES / bytesPerDay;
    const steadyState90d = itemsPerDay * wholeRowBytes * 90;
    const steadyState90dAfterRawPurge = itemsPerDay * normalizedOnlyBytes * 90;

    // Arithmetic sanity only — NO cloud conclusion is drawn here.
    expect(Number.isFinite(daysToCap500MB)).toBe(true);
    expect(daysToCap500MB).toBeGreaterThan(0);
    expect(steadyState90dAfterRawPurge).toBeLessThan(steadyState90d);

    emitStorage({
      id: 'S-03',
      scenario:
        'extrapolation: EMBEDDED registry worst-case arrivals (min(dailyRequestBudget, polls/day x cap)) x LOCAL measured max-shape row bytes',
      items: itemsPerDay,
      componentBytes: {
        n: s01.component.n,
        url_bytes: s01.component.url_bytes,
        title_bytes: s01.component.title_bytes,
        excerpt_bytes: s01.component.excerpt_bytes,
        raw_bytes: s01.component.raw_bytes,
        hash_bytes: s01.component.hash_bytes,
        ext_bytes: s01.component.ext_bytes,
        author_bytes: s01.component.author_bytes,
        id_bytes: s01.component.id_bytes,
      },
      derived: {
        payloadBytes: s01.derived.payloadBytes,
        payloadPerItem: Math.round(s01.derived.payloadPerItem),
        wholeRowEstimatePerItem: Math.round(wholeRowBytes),
        rawSharePct: Math.round(s01.derived.rawShare * 10000) / 100,
      },
      dbPages: s01.pages,
      extrapolation: {
        sources: perSource,
        worstCaseItemsPerDay: itemsPerDay,
        dailyRequestBudgetCeiling: budgetCeilingPerDay,
        capBasis:
          'rss cap = INGESTION_LIMITS.maxItemsPerFeed; steam-news = 25x10 and reddit-oauth = 10x50 from connector config schema bounds; DEFAULT 100 for connectors without a verified per-poll cap (conservative, may understate igdb)',
        documentedFreeCapBytes: D1_FREE_CAP_BYTES,
        wholeRowEstimateBytesPerDay: bytesPerDay,
        daysToCap500MB: Math.round(daysToCap500MB),
        steadyState90dBytes: Math.round(steadyState90d),
        optionA_steadyState90dAfterRawPurgeBytes: Math.round(steadyState90dAfterRawPurge),
        optionAReliefPct:
          Math.round((1 - steadyState90dAfterRawPurge / steadyState90d) * 10000) / 100,
        nominalRowOverheadBytes: NOMINAL_ROW_OVERHEAD_BYTES,
      },
      units: UNITS,
      honesty: HONESTY,
    });
  });
});
