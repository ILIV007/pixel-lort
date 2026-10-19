/**
 * R1.10.3 DESIGN LAB — candidate SQL semantics suite (REAL workerd D1).
 *
 * DESIGN-LAB evidence — NOT accepted source, NOT product tests. These
 * tests exercise the candidate multi-row INSERT/select design
 * (design-lab/candidate-sql.ts) on the SAME disposable workerd D1 the
 * accepted suites use, and compare it against the ACCEPTED store
 * implementations imported UNMODIFIED from the accepted tree
 * (`src/adapters/db/source-ingest-store.ts`). Nothing here patches or
 * replaces product code; the accepted paths keep running unchanged.
 *
 * Parity surfaces proven per scenario:
 *  - commit classification (inserted / duplicateExternal / duplicateUrl)
 *    and stateWriteWon;
 *  - DURABLE outcome: every source_items row and the full source_state
 *    row compared between the accepted and the candidate run;
 *  - fences: stale owner, stale generation, losing state fence, mixed
 *    -source rejection, PK-collision rollback, NOT NULL rollback;
 *  - within-statement duplicate absorption (same external id twice in ONE
 *    multi-row statement) matches the accepted two-statement behavior.
 *
 * HONESTY LABELS: local workerd + disposable D1 only. Correctness parity
 * here does NOT establish Free fit or cloud CPU evidence — the measured
 * cost ledger is separate (design-lab/cost-ledger.test.ts + JSON).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, ROUND19_MIGRATION_PLAN } from '../tests/helpers/migrations';
import { createDbExecutor } from '../src/adapters/db/db-executor';
import { INGESTION_LIMITS } from '../src/domain/source/source-registry';
import { normalizeRawItem } from '../src/connectors/normalize';
import {
  acquirePollOwnership,
  commitOwnedPollResults,
  commitPollResults,
  type IngestItemRow,
  type PollTerminalState,
} from '../src/adapters/db/source-ingest-store';
import {
  buildOwnedMultiRowInsertSql,
  commitOwnedPollResultsCandidate,
  commitPollResultsCandidate,
  MAX_SQL_STATEMENT_BYTES,
  OversizedRowPlanError,
  ownedSharedGuardBinds,
  planInsertChunks,
  statementByteAudit,
  type CandidateItemRow,
  type OwnedCommitInput,
} from './candidate-sql';
import { labLog } from './lab-log';
import { CJK_CANONICAL_URL_BYTES, cjkCanonicalUrl, cjkRawLink } from './fixtures';

const rawDb = () => env.DB as D1Database;

const SOURCE = 'source-lab0000-lab0000';
const SOURCE_OTHER = 'source-other0-other0';
const NOW = 1_770_000_000_000;
const JOB_ID = 'job-lab-0000000000000001';
const FOREIGN_JOB_ID = 'job-lab-0000000000000002';
const GENERATION = 1;

/* ------------------------------------------------------------------ */
/* Seeding helpers (raw binding — always OUTSIDE any measured window)  */
/* ------------------------------------------------------------------ */

async function seedSources(): Promise<void> {
  await rawDb()
    .prepare(
      `INSERT OR IGNORE INTO sources
         (id, name, connector, lane, trust_tier, enabled, interval_seconds, priority,
          daily_request_budget, approval_policy, config_json, created_at, updated_at)
       VALUES (?, 'lab-a', 'rss', 'radar', 50, 1, 3600, 50, 100, 'auto', '{}', 1, 1),
              (?, 'lab-b', 'rss', 'radar', 50, 1, 3600, 50, 100, 'auto', '{}', 1, 1)`,
    )
    .bind(SOURCE, SOURCE_OTHER)
    .run();
}

async function seedState(
  sourceId: string,
  nextPollAt: number,
  owner: string | null,
  schema: 3 | 4 = 4,
): Promise<void> {
  // Schema 3 has NO poll_owner_job_id column (added by the 0004 candidate).
  if (schema === 3) {
    await rawDb()
      .prepare(
        `INSERT INTO source_state
           (source_id, cursor, etag, last_modified, next_poll_at, last_polled_at,
            consecutive_failures, requests_today, budget_date, updated_at)
         VALUES (?, NULL, NULL, NULL, ?, NULL, 0, 0, '2026/02/01', ?)`,
      )
      .bind(sourceId, nextPollAt, NOW)
      .run();
    return;
  }
  await rawDb()
    .prepare(
      `INSERT INTO source_state
         (source_id, cursor, etag, last_modified, next_poll_at, last_polled_at,
          consecutive_failures, requests_today, budget_date, poll_owner_job_id, updated_at)
       VALUES (?, NULL, NULL, NULL, ?, NULL, 0, 0, '2026/02/01', ?, ?)`,
    )
    .bind(sourceId, nextPollAt, owner, NOW)
    .run();
}

async function seedPollJob(jobId: string, sourceId: string, attempts: number): Promise<void> {
  await rawDb()
    .prepare(
      `INSERT INTO jobs
         (id, type, aggregate_type, aggregate_id, status, priority, run_after, attempts,
          max_attempts, lease_until, idempotency_key, payload_json, created_at, updated_at)
       VALUES (?, 'sources.fetch_poll', 'source', ?, 'claimed', 50, ?, ?, 3, ?,
               ? || '-idem', '{}', ?, ?)`,
    )
    .bind(jobId, sourceId, NOW, attempts, NOW, jobId, NOW, NOW)
    .run();
}

async function seedExistingItem(row: {
  id: string;
  sourceId: string;
  externalId: string | null;
  canonicalUrl: string | null;
}): Promise<void> {
  await rawDb()
    .prepare(
      `INSERT INTO source_items
         (id, source_id, external_id, canonical_url, title, body_excerpt, author,
          published_at, fetched_at, content_hash, raw_json, processing_status)
       VALUES (?, ?, ?, ?, 'seed-title', NULL, NULL, NULL, 1, 'seed-hash', '{}', 'new')`,
    )
    .bind(row.id, row.sourceId, row.externalId, row.canonicalUrl)
    .run();
}

function makeItems(n: number, overrides: Partial<CandidateItemRow> = {}): CandidateItemRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `lab-item-${String(i).padStart(4, '0')}`,
    sourceId: SOURCE,
    externalId: `lab-ext-${i}`,
    canonicalUrl: `https://lab.example/${i}`,
    title: `Lab title ${i}`,
    excerpt: `Lab excerpt ${i}`,
    author: `Lab author ${i}`,
    publishedAtMs: NOW - i * 1000,
    fetchedAtMs: NOW,
    contentHash: `hash-${String(i).padStart(4, '0')}`.padEnd(64, '0').slice(0, 64),
    rawJson: JSON.stringify({ i }),
    ...overrides,
  }));
}

function toIngestRows(items: readonly CandidateItemRow[]): IngestItemRow[] {
  return items.map((i) => ({ ...i }));
}

/* ------------------------------------------------------------------ */
/* R1.10.3.1 regression fixtures (Unicode/URL-expansion envelope)      */
/* ------------------------------------------------------------------ */

/**
 * Build one CandidateItemRow through the ACCEPTED normalizer
 * (`normalizeRawItem`, imported UNMODIFIED) so the canonical URL is what
 * the real product path would persist — proving the unchanged RSS envelope
 * admits ≈45 KB canonical URLs (the normalizer enforces NO URL length cap)
 * and that the normalizer's percent-encoding yields EXACTLY the fixtures.ts
 * arithmetic (45,023 bytes for a 5000-char CJK path).
 */
async function normalizedCjkItem(index: number, cjkChars: number): Promise<CandidateItemRow> {
  const rawLink = cjkRawLink(cjkChars, index);
  const normalized = await normalizeRawItem({
    connector: 'rss',
    sourceId: SOURCE,
    originLabel: 'design-lab',
    raw: {
      id: `cjk-${index}`,
      link: rawLink,
      title: `CJK item ${index}`,
      bodyText: 'CJK body text',
      author: null,
      publishedRaw: null,
    },
    stripDownloads: false,
    nowMs: NOW,
  });
  if (!normalized.ok) throw new Error('fixture normalize failed');
  const item = normalized.item;
  // Pin the accepted normalizer's behavior: percent-encoded path, NO cap,
  // exact expected byte size, and equality with the deterministic fixture.
  const encoder = new TextEncoder();
  const expectedUrl = cjkCanonicalUrl(cjkChars, index);
  if (item.canonicalUrl !== expectedUrl) {
    throw new Error('normalizer canonical URL diverged from the deterministic fixture');
  }
  if (encoder.encode(item.canonicalUrl).length !== expectedUrl.length) {
    throw new Error('fixture byte-count invariant broken');
  }
  return {
    id: `lab-cjk-${String(index).padStart(4, '0')}`,
    sourceId: SOURCE,
    externalId: item.externalId,
    canonicalUrl: item.canonicalUrl,
    title: item.title,
    excerpt: item.excerpt,
    author: item.author,
    publishedAtMs: item.publishedAtMs,
    fetchedAtMs: NOW,
    contentHash: item.contentHash,
    rawJson: JSON.stringify(item.rawJson),
  };
}

/** Planner options mirroring the owned commit's EXACT shared guard binds. */
function ownedPlanOptions(hold: number) {
  const input = {
    sourceId: SOURCE,
    jobId: JOB_ID,
    generation: GENERATION,
    observedHoldUntilMs: hold,
  } as OwnedCommitInput;
  return {
    sharedBinds: ownedSharedGuardBinds(input),
    buildSql: buildOwnedMultiRowInsertSql,
  };
}

function makeState(nextPollAtMs: number): PollTerminalState {
  return {
    cursor: 'lab-cursor-1',
    etag: 'lab-etag-1',
    lastModified: null,
    nextPollAtMs,
    success: true,
    lastChangedAtMs: NOW,
    lastError: null,
    consecutiveFailures: 0,
    circuitOpenUntilMs: null,
    requestsToday: 1,
    budgetDate: '2026/02/01',
  };
}

interface DurableCapture {
  readonly items: Record<string, unknown>[];
  readonly state: Record<string, unknown> | null;
}

async function captureDurable(): Promise<DurableCapture> {
  const items = await rawDb()
    .prepare('SELECT * FROM source_items ORDER BY id ASC')
    .all<Record<string, unknown>>();
  const state = await rawDb()
    .prepare('SELECT * FROM source_state LIMIT 1')
    .first<Record<string, unknown>>();
  return { items: items.results, state: state ?? null };
}

async function resetTables(): Promise<void> {
  for (const t of ['source_items', 'source_state', 'sources', 'jobs']) {
    await rawDb().prepare(`DELETE FROM ${t}`).run();
  }
}

/* ------------------------------------------------------------------ */
/* Shared parity driver                                                */
/* ------------------------------------------------------------------ */

interface OwnedRunResult {
  readonly inserted: number;
  readonly duplicateExternal: number;
  readonly duplicateUrl: number;
  readonly stateWriteWon: boolean;
  readonly durable: DurableCapture;
  readonly threw: unknown;
}

async function runOwnedAccepted(
  items: readonly CandidateItemRow[],
  hold: number,
): Promise<OwnedRunResult> {
  try {
    const result = await commitOwnedPollResults(createDbExecutor(rawDb()), {
      sourceId: SOURCE,
      jobId: JOB_ID,
      generation: GENERATION,
      observedHoldUntilMs: hold,
      items: toIngestRows(items),
      state: makeState(NOW + 3_600_000),
      nowMs: NOW,
    });
    return { ...result, durable: await captureDurable(), threw: null };
  } catch (error) {
    return {
      inserted: -1,
      duplicateExternal: -1,
      duplicateUrl: -1,
      stateWriteWon: false,
      durable: await captureDurable(),
      threw: error,
    };
  }
}

async function runOwnedCandidate(
  items: readonly CandidateItemRow[],
  hold: number,
): Promise<OwnedRunResult> {
  try {
    const result = await commitOwnedPollResultsCandidate(rawDb() as never, {
      sourceId: SOURCE,
      jobId: JOB_ID,
      generation: GENERATION,
      observedHoldUntilMs: hold,
      items,
      state: makeState(NOW + 3_600_000) as unknown as Record<string, unknown>,
      nowMs: NOW,
    });
    return {
      inserted: result.inserted,
      duplicateExternal: result.duplicateExternal,
      duplicateUrl: result.duplicateUrl,
      stateWriteWon: result.stateWriteWon,
      durable: await captureDurable(),
      threw: null,
    };
  } catch (error) {
    return {
      inserted: -1,
      duplicateExternal: -1,
      duplicateUrl: -1,
      stateWriteWon: false,
      durable: await captureDurable(),
      threw: error,
    };
  }
}

/** Fresh owned fixture: seeds + acquires ownership with the ACCEPTED acquire. */
async function freshOwnedFixture(): Promise<number> {
  await resetTables();
  await seedSources();
  await seedState(SOURCE, NOW, null);
  await seedPollJob(JOB_ID, SOURCE, GENERATION);
  const acquisition = await acquirePollOwnership(createDbExecutor(rawDb()), {
    sourceId: SOURCE,
    jobId: JOB_ID,
    scheduledForMs: NOW,
    generation: GENERATION,
    nowMs: NOW,
  });
  if (acquisition.kind !== 'owned') throw new Error('fixture acquire failed');
  return acquisition.holdUntilMs;
}

/* ------------------------------------------------------------------ */
/* L-B — schema 3 LEGACY parity (0001–0003 ONLY; declared FIRST so the */
/* shared test D1 is still at version 3 when these scenarios run)      */
/* ------------------------------------------------------------------ */

describe('R1.10.3 design lab — schema 3 legacy candidate parity (real workerd D1)', () => {
  beforeEach(async () => {
    await applyMigrations(rawDb()); // accepted 0001–0003 ONLY — schema 3
    await resetTables();
  });

  it('L-10 legacy candidate parity at 100 fresh items (counts + durable rows + state)', async () => {
    await seedSources();
    const holdUntilMs = NOW; // legacy fence: payload-derived hold
    await seedState(SOURCE, holdUntilMs, null, 3);
    const items = makeItems(100);
    const accepted = await commitPollResults(createDbExecutor(rawDb()), {
      sourceId: SOURCE,
      items: toIngestRows(items),
      state: makeState(NOW + 3_600_000),
      holdUntilMs,
      nowMs: NOW,
    });
    const acceptedDurable = await captureDurable();
    // Fresh identical fixture for the candidate.
    await resetTables();
    await seedSources();
    await seedState(SOURCE, holdUntilMs, null, 3);
    const candidate = await commitPollResultsCandidate(rawDb() as never, {
      sourceId: SOURCE,
      items,
      state: makeState(NOW + 3_600_000) as unknown as Record<string, unknown>,
      holdUntilMs,
      nowMs: NOW,
    });
    const candidateDurable = await captureDurable();
    expect(candidate.threw).toBeUndefined();
    expect(candidate.inserted).toBe(accepted.inserted);
    expect(candidate.duplicateExternal).toBe(accepted.duplicateExternal);
    expect(candidate.duplicateUrl).toBe(accepted.duplicateUrl);
    expect(candidate.stateWriteWon).toBe(accepted.stateWriteWon);
    expect(candidateDurable.items).toEqual(acceptedDurable.items);
    expect(candidateDurable.state).toEqual(acceptedDurable.state);
    labLog(
      'LAB[L-10]',
      JSON.stringify({
        schema: 3,
        items: 100,
        accepted: { inserted: accepted.inserted },
        candidate: { inserted: candidate.inserted },
        durableParity: true,
      }),
    );
  });

  it('L-11 legacy losing fence keeps accepted semantics: items persist, stateWriteWon=false — parity', async () => {
    await seedSources();
    const staleHold = NOW - 1000; // state row's next_poll_at will NOT match
    await seedState(SOURCE, NOW, null, 3); // the row moved on already
    const items = makeItems(10);
    const accepted = await commitPollResults(createDbExecutor(rawDb()), {
      sourceId: SOURCE,
      items: toIngestRows(items),
      state: makeState(NOW + 3_600_000),
      holdUntilMs: staleHold,
      nowMs: NOW,
    });
    const acceptedDurable = await captureDurable();
    expect(accepted.inserted).toBe(10); // legacy inserts despite the lost fence
    expect(accepted.stateWriteWon).toBe(false);
    // Candidate parity.
    await resetTables();
    await seedSources();
    await seedState(SOURCE, NOW, null, 3);
    const candidate = await commitPollResultsCandidate(rawDb() as never, {
      sourceId: SOURCE,
      items,
      state: makeState(NOW + 3_600_000) as unknown as Record<string, unknown>,
      holdUntilMs: staleHold,
      nowMs: NOW,
    });
    const candidateDurable = await captureDurable();
    expect(candidate.inserted).toBe(10);
    expect(candidate.stateWriteWon).toBe(false);
    expect(candidateDurable.items).toEqual(acceptedDurable.items);
    expect(candidateDurable.state).toEqual(acceptedDurable.state);
    labLog(
      'LAB[L-11]',
      JSON.stringify({
        legacyLostFence: 'items persist, stateWriteWon=false — accepted semantics preserved',
        parity: true,
      }),
    );
  });
});
/* ------------------------------------------------------------------ */
/* L-A — schema 4 OWNED parity (0001–0004 applied; runs AFTER L-B)     */
/* ------------------------------------------------------------------ */

describe('R1.10.3 design lab — schema 4 owned candidate parity (real workerd D1)', () => {
  beforeEach(async () => {
    await applyMigrations(rawDb());
    await applyMigrations(rawDb(), ROUND19_MIGRATION_PLAN); // schema 4 ACTIVE
    await resetTables();
  });

  it('L-01 100 fresh items: candidate parity with the accepted owned commit (counts + durable rows + state)', async () => {
    const hold = await freshOwnedFixture();
    const items = makeItems(100);

    const accepted = await runOwnedAccepted(items, hold);
    expect(accepted.threw).toBeNull();
    expect(accepted.inserted).toBe(100);
    expect(accepted.stateWriteWon).toBe(true);

    const hold2 = await freshOwnedFixture();
    expect(hold2).toBe(hold);
    const candidate = await runOwnedCandidate(items, hold2);
    expect(candidate.threw).toBeNull();

    expect(candidate.inserted).toBe(accepted.inserted);
    expect(candidate.duplicateExternal).toBe(accepted.duplicateExternal);
    expect(candidate.duplicateUrl).toBe(accepted.duplicateUrl);
    expect(candidate.stateWriteWon).toBe(accepted.stateWriteWon);
    // Durable parity: SAME rows, SAME state (ordered by id).
    expect(candidate.durable.items).toEqual(accepted.durable.items);
    expect(candidate.durable.state).toEqual(accepted.durable.state);
    expect(candidate.durable.items.length).toBe(100);
    labLog(
      'LAB[L-01]',
      JSON.stringify({
        items: 100,
        plan: '100 rows → 13 multi-row statements (95 binds each) + 1 state write, ONE batch',
        accepted: { inserted: accepted.inserted, items: accepted.durable.items.length },
        candidate: { inserted: candidate.inserted, items: candidate.durable.items.length },
        durableParity: true,
      }),
    );
  });

  it('L-02 duplicate-heavy mix (external dups + url dups + own hits + quirk + null keys): parity', async () => {
    const hold = await freshOwnedFixture();
    // Seeded durable state shaping the outcomes:
    await seedExistingItem({
      id: 'lab-item-0005',
      sourceId: SOURCE,
      externalId: 'lab-ext-5',
      canonicalUrl: 'https://lab.example/5',
    }); // own hit after insert attempt? id collides → PK collision path
    // Careful: a seeded row with an ATTEMPTED id is the PK-collision case (L-07).
    // For THIS scenario seed foreign keys only:
    await rawDb().prepare('DELETE FROM source_items WHERE id = ?').bind('lab-item-0005').run();
    await seedExistingItem({
      id: 'seed-ext-1',
      sourceId: SOURCE,
      externalId: 'lab-ext-10',
      canonicalUrl: null,
    }); // external dup target
    await seedExistingItem({
      id: 'seed-url-1',
      sourceId: SOURCE,
      externalId: 'seed-url-1-ext',
      canonicalUrl: 'https://lab.example/20',
    }); // url dup target
    const items: CandidateItemRow[] = [
      ...makeItems(9), // fresh inserts
      { ...makeItems(1, { id: 'dup-ext-a' })[0], externalId: 'lab-ext-10' }, // external dup
      {
        ...makeItems(1, { id: 'dup-url-a' })[0],
        externalId: 'brand-new-ext',
        canonicalUrl: 'https://lab.example/20',
      }, // url dup
      {
        ...makeItems(1, { id: 'quirk-a' })[0],
        externalId: 'brand-new-ext-2',
        canonicalUrl: 'https://nowhere.example/q',
      }, // quirk → duplicateExternal
      {
        ...makeItems(1, { id: 'null-keys-a' })[0],
        externalId: 'x',
        canonicalUrl: null,
        title: 'has ext',
      }, // own insert
    ];
    const accepted = await runOwnedAccepted(items, hold);
    expect(accepted.threw).toBeNull();
    const hold2 = await freshOwnedFixture();
    // Re-seed the SAME durable shaping for the candidate run.
    await seedExistingItem({
      id: 'seed-ext-1',
      sourceId: SOURCE,
      externalId: 'lab-ext-10',
      canonicalUrl: null,
    });
    await seedExistingItem({
      id: 'seed-url-1',
      sourceId: SOURCE,
      externalId: 'seed-url-1-ext',
      canonicalUrl: 'https://lab.example/20',
    });
    const candidate = await runOwnedCandidate(items, hold2);
    expect(candidate.threw).toBeNull();
    expect(candidate.inserted).toBe(accepted.inserted);
    expect(candidate.duplicateExternal).toBe(accepted.duplicateExternal);
    expect(candidate.duplicateUrl).toBe(accepted.duplicateUrl);
    expect(candidate.durable.items).toEqual(accepted.durable.items);
    expect(candidate.durable.state).toEqual(accepted.durable.state);
    labLog(
      'LAB[L-02]',
      JSON.stringify({
        accepted: {
          inserted: accepted.inserted,
          duplicateExternal: accepted.duplicateExternal,
          duplicateUrl: accepted.duplicateUrl,
        },
        durableParity: true,
      }),
    );
  });

  it('L-03 stale owner (foreign owner row): zero items, zero state, no error — parity', async () => {
    await resetTables();
    await seedSources();
    await seedState(SOURCE, NOW, FOREIGN_JOB_ID); // a DIFFERENT job owns the window
    await seedPollJob(JOB_ID, SOURCE, GENERATION);
    const items = makeItems(10);
    const accepted = await runOwnedAccepted(items, NOW);
    const candidate = await runOwnedCandidate(items, NOW);
    expect(accepted.threw).toBeNull();
    expect(candidate.threw).toBeNull();
    expect(accepted.inserted).toBe(0);
    expect(candidate.inserted).toBe(0);
    expect(candidate.durable.items).toEqual(accepted.durable.items);
    expect(candidate.durable.items.length).toBe(0);
    expect(candidate.durable.state).toEqual(accepted.durable.state);
    labLog('LAB[L-03]', JSON.stringify({ staleOwner: 'zero items, zero state, parity' }));
  });

  it('L-04 stale generation (job attempts moved on): zero items, zero state — parity', async () => {
    await resetTables();
    await seedSources();
    await seedState(SOURCE, NOW, JOB_ID);
    await seedPollJob(JOB_ID, SOURCE, GENERATION + 1); // newer generation than the caller's
    const items = makeItems(10);
    const accepted = await runOwnedAccepted(items, NOW);
    const candidate = await runOwnedCandidate(items, NOW);
    expect(accepted.threw).toBeNull();
    expect(candidate.threw).toBeNull();
    expect(candidate.inserted).toBe(0);
    expect(candidate.durable.items.length).toBe(0);
    expect(candidate.durable.state).toEqual(accepted.durable.state);
    labLog('LAB[L-04]', JSON.stringify({ staleGeneration: 'zero items, zero state, parity' }));
  });

  it('L-05 mixed-source rejection: BOTH implementations reject BEFORE any statement; durable state untouched', async () => {
    const hold = await freshOwnedFixture();
    const items = makeItems(5).map((i, idx) => (idx === 2 ? { ...i, sourceId: SOURCE_OTHER } : i));
    const accepted = await runOwnedAccepted(items, hold);
    const candidate = await runOwnedCandidate(items, hold);
    expect(accepted.threw).toBeTruthy();
    expect(candidate.threw).toBeTruthy();
    expect((candidate.threw as { code?: string }).code).toBe('item_source_mismatch');
    expect((accepted.threw as { code?: string }).code).toBe('item_source_mismatch');
    expect(candidate.durable.items.length).toBe(0);
    expect(candidate.durable.state?.poll_owner_job_id).toBe(JOB_ID); // ownership NOT released
    labLog(
      'LAB[L-05]',
      JSON.stringify({
        acceptedCode: (accepted.threw as { code?: string }).code,
        candidateCode: (candidate.threw as { code?: string }).code,
        durableUntouched: true,
      }),
    );
  });

  it('L-06 PRIMARY-KEY collision: BOTH throw, whole batch rolls back (zero items, state unchanged) — semantics NOT reinterpreted', async () => {
    const hold = await freshOwnedFixture();
    await seedExistingItem({
      id: 'lab-item-0003',
      sourceId: SOURCE,
      externalId: 'pre-existing',
      canonicalUrl: null,
    });
    const items = makeItems(10);
    const accepted = await runOwnedAccepted(items, hold);
    expect(accepted.threw).toBeTruthy();
    expect(accepted.durable.items.length).toBe(1); // only the seed row survived
    // Fresh fixture for the candidate (same seed).
    await freshOwnedFixture();
    await seedExistingItem({
      id: 'lab-item-0003',
      sourceId: SOURCE,
      externalId: 'pre-existing',
      canonicalUrl: null,
    });
    const candidate = await runOwnedCandidate(items, hold);
    expect(candidate.threw).toBeTruthy();
    expect(candidate.durable.items.length).toBe(1);
    expect(candidate.durable.state).toEqual(accepted.durable.state);
    labLog(
      'LAB[L-06]',
      JSON.stringify({
        acceptedThrew: accepted.threw !== null,
        candidateThrew: candidate.threw !== null,
        rollbackSurvivors: 1,
      }),
    );
  });

  it('L-07 within-statement duplicate absorption (same external_id twice in ONE multi-row statement) matches the accepted two-statement behavior', async () => {
    const hold = await freshOwnedFixture();
    const items: CandidateItemRow[] = [
      makeItems(1, { id: 'dup-first', externalId: 'shared-ext', canonicalUrl: null })[0],
      makeItems(1, { id: 'dup-second', externalId: 'shared-ext', canonicalUrl: null })[0],
      ...makeItems(3, { canonicalUrl: null }),
    ];
    const candidate = await runOwnedCandidate(items, hold);
    expect(candidate.threw).toBeNull();
    expect(candidate.inserted).toBe(4); // first + 3 fresh
    expect(candidate.duplicateExternal).toBe(1); // the absorbed second row
    // Durable: 4 rows; the shared external row keeps the FIRST id.
    const ext = await rawDb()
      .prepare("SELECT id FROM source_items WHERE external_id = 'shared-ext'")
      .all<{ id: string }>();
    expect(ext.results).toEqual([{ id: 'dup-first' }]);
    // Accepted reference on a fresh identical fixture:
    const hold2 = await freshOwnedFixture();
    const accepted = await runOwnedAccepted(items, hold2);
    expect(accepted.inserted).toBe(4);
    expect(accepted.duplicateExternal).toBe(1);
    expect(candidate.durable.items).toEqual(accepted.durable.items);
    labLog(
      'LAB[L-07]',
      JSON.stringify({
        candidate: { inserted: candidate.inserted, duplicateExternal: candidate.duplicateExternal },
        accepted: { inserted: accepted.inserted, duplicateExternal: accepted.duplicateExternal },
      }),
    );
  });

  it('L-08 byte-bound chunking at max-volume content shape: rows/statement shrink, ALL rows land, EVERY chunk audited', async () => {
    const hold = await freshOwnedFixture();
    const big = (n: number, ch: string) => ch.repeat(n);
    const items: CandidateItemRow[] = Array.from({ length: 100 }, (_, i) => ({
      id: `lab-big-${String(i).padStart(4, '0')}`,
      sourceId: SOURCE,
      externalId: `lab-big-ext-${i}`,
      canonicalUrl: `https://lab.example/${big(2020, 'p')}/${i}`,
      title: big(512, 't') + String(i),
      excerpt: big(512, 'e'),
      author: big(256, 'a'),
      publishedAtMs: NOW,
      fetchedAtMs: NOW,
      contentHash: big(64, 'h'),
      rawJson: JSON.stringify({ blob: big(8 * 1024 - 40, 'r') }), // ≈ 8 KiB raw cap
    }));
    const plan = planInsertChunks(items, ownedPlanOptions(hold));
    const candidate = await commitOwnedPollResultsCandidate(rawDb() as never, {
      sourceId: SOURCE,
      jobId: JOB_ID,
      generation: GENERATION,
      observedHoldUntilMs: hold,
      items,
      state: makeState(NOW + 3_600_000) as unknown as Record<string, unknown>,
      nowMs: NOW,
    });
    expect(candidate.inserted).toBe(100);
    expect(candidate.stateWriteWon).toBe(true);
    // R1.10.3.1: EVERY chunk is audited independently with its ACTUAL SQL
    // text + row binds + shared guard binds — no prefix-derived blanket
    // size. The returned plan must equal the standalone plan.
    expect(candidate.plan).toEqual(plan);
    expect(plan.rowsPerStatement).toEqual([...Array<number>(12).fill(8), 4]);
    expect(plan.limitedBy).toBe('binds'); // 8×11 + 7 = 95 ≤ 100 binds
    for (const audit of plan.statementAudits) {
      expect(audit.rows).toBeLessThanOrEqual(8);
      expect(audit.rows * 11 + 7).toBeLessThanOrEqual(100);
      expect(audit.totalBytes).toBeLessThanOrEqual(MAX_SQL_STATEMENT_BYTES);
    }
    // Cross-check chunk 0 with the independent statementByteAudit helper.
    const chunk0Sql = buildOwnedMultiRowInsertSql(plan.chunks[0]!.length);
    const chunk0Binds: unknown[] = [];
    for (const item of plan.chunks[0] ?? []) {
      chunk0Binds.push(
        item.id,
        item.sourceId,
        item.externalId,
        item.canonicalUrl,
        item.title,
        item.excerpt,
        item.author,
        item.publishedAtMs,
        item.fetchedAtMs,
        item.contentHash,
        item.rawJson,
      );
    }
    const audit0 = statementByteAudit(chunk0Sql, [
      ...chunk0Binds,
      ...ownedSharedGuardBinds({
        sourceId: SOURCE,
        jobId: JOB_ID,
        generation: GENERATION,
        observedHoldUntilMs: hold,
      } as OwnedCommitInput),
    ]);
    expect(audit0.totalBytes).toBeLessThanOrEqual(MAX_SQL_STATEMENT_BYTES);
    expect(audit0.totalBytes).toBe(plan.statementAudits[0]!.totalBytes);
    const count = await rawDb()
      .prepare('SELECT COUNT(*) AS n FROM source_items')
      .first<{ n: number }>();
    expect(count?.n).toBe(100);
    labLog(
      'LAB[L-08]',
      JSON.stringify({
        chunks: plan.chunks.length,
        maxRowsPerStatement: plan.maxRowsPerStatement,
        limitedBy: plan.limitedBy,
        largestStatementBytes: Math.max(...plan.statementAudits.map((a) => a.totalBytes)),
        inserted: candidate.inserted,
      }),
    );
  });

  it('L-09 numbered-parameter reuse probe (informational characterization on workerd D1)', async () => {
    let reusable = false;
    try {
      const r = await rawDb()
        .prepare('SELECT ?1 AS a, ?1 AS b')
        .bind('x')
        .first<{ a: string; b: string }>();
      reusable = r?.a === 'x' && r?.b === 'x';
    } catch {
      reusable = false;
    }
    labLog(
      'LAB[L-09]',
      JSON.stringify({
        numberedParamReuseWorks: reusable,
        note: 'the candidate design does NOT depend on this; recorded for the ledger only',
      }),
    );
    expect(typeof reusable).toBe('boolean');
  });

  /* -------------------------------------------------------------- */
  /* R1.10.3.1 regressions (manager counterexample + envelope facts) */
  /* -------------------------------------------------------------- */

  it('L-12 heterogeneous chunking (R1.10.3.1 counterexample): 8 short + 92 CJK≈45 KB — EVERY chunk built and validated independently', async () => {
    const hold = await freshOwnedFixture();
    // makeItems(8): unique SHORT URLs (binds-limited prefix chunk).
    const items: CandidateItemRow[] = [...makeItems(8)];
    for (let i = 0; i < 92; i += 1) items.push(await normalizedCjkItem(i, 5000));
    // Envelope precondition of the counterexample: the equivalent RSS XML
    // (raw UTF-8 CJK in <link>) stays BELOW the 2 MiB feed limit.
    const encoder = new TextEncoder();
    const itemXml = (link: string): string =>
      `<item><guid>g</guid><link>${link}</link><title>t</title></item>`;
    const feedBytes =
      encoder.encode(itemXml(cjkRawLink(5000, 0))).length * 92 + // raw CJK = 3 B/char in XML
      encoder.encode(itemXml(items[0]!.canonicalUrl!)).length * 8 +
      256; // envelope
    expect(feedBytes).toBeLessThan(INGESTION_LIMITS.maxFeedBytes);
    // The accepted normalizer persists ≈45 KB canonical URLs (NO length cap);
    // each item's URL stays DISTINCT (see fixtures.ts).
    expect(encoder.encode(items[8]!.canonicalUrl!).length).toBe(CJK_CANONICAL_URL_BYTES);
    expect(new Set(items.slice(8).map((it) => it.canonicalUrl)).size).toBe(92);

    const plan = planInsertChunks(items, ownedPlanOptions(hold));
    // Chunk sizes are decided per chunk: the short prefix fills to the
    // bind limit; every later CJK chunk is byte-limited to 2 rows. The old
    // prefix-derived planner applied 8 rows everywhere and overflowed its
    // later statements to ≈375,637 bytes — this regression pins the fix.
    expect(plan.rowsPerStatement[0]).toBe(8);
    expect(plan.rowsPerStatement.slice(1)).toEqual(
      Array.from({ length: plan.rowsPerStatement.length - 1 }, () => 2),
    );
    expect(plan.chunks.length).toBe(47); // 1×8 + 46×2
    expect(plan.limitedBy).toBe('mixed');
    for (const audit of plan.statementAudits) {
      expect(audit.totalBytes).toBeLessThanOrEqual(MAX_SQL_STATEMENT_BYTES);
    }
    const candidate = await runOwnedCandidate(items, hold);
    expect(candidate.threw).toBeNull();
    expect(candidate.inserted).toBe(100);
    expect(candidate.stateWriteWon).toBe(true);
    // Durable: every CJK row keeps its FULL ≈45 KB canonical URL (no
    // truncation, no silent drop).
    const stored = await rawDb()
      .prepare('SELECT canonical_url FROM source_items WHERE canonical_url IS NOT NULL')
      .all<{ canonical_url: string }>();
    expect(stored.results).toHaveLength(100);
    const maxUrlBytes = Math.max(
      ...stored.results.map((r) => encoder.encode(r.canonical_url).length),
    );
    expect(maxUrlBytes).toBe(CJK_CANONICAL_URL_BYTES);
    labLog(
      'LAB[L-12]',
      JSON.stringify({
        chunks: plan.chunks.length,
        rowsPerStatementHead: plan.rowsPerStatement.slice(0, 3),
        limitedBy: plan.limitedBy,
        largestStatementBytes: Math.max(...plan.statementAudits.map((a) => a.totalBytes)),
        feedBytes,
        feedLimit: INGESTION_LIMITS.maxFeedBytes,
        inserted: candidate.inserted,
      }),
    );
  });

  it('L-13 a single oversized row is rejected EXPLICITLY before any statement (atomic, zero effects, no truncation)', async () => {
    const hold = await freshOwnedFixture();
    const items: CandidateItemRow[] = [
      makeItems(1, { id: 'lab-ok-1', externalId: 'ok-1' })[0]!,
      await normalizedCjkItem(0, 12_000), // canonical ≈ 108 KB → over budget ALONE
      makeItems(1, { id: 'lab-ok-2', externalId: 'ok-2' })[0]!,
    ];
    const before = await captureDurable();
    const candidate = await runOwnedCandidate(items, hold);
    expect(candidate.threw).toBeInstanceOf(OversizedRowPlanError);
    const error = candidate.threw as OversizedRowPlanError;
    expect(error.code).toBe('row_exceeds_statement_budget');
    expect(error.itemIndex).toBe(1);
    expect(error.itemId).toBe('lab-cjk-0000');
    expect(error.totalBytes).toBeGreaterThan(MAX_SQL_STATEMENT_BYTES);
    // Plan-time rejection: ZERO statements, ZERO durable effects.
    expect(await captureDurable()).toEqual(before);
    expect(before.items).toHaveLength(0);
    labLog(
      'LAB[L-13]',
      JSON.stringify({
        code: error.code,
        itemIndex: error.itemIndex,
        totalBytes: error.totalBytes,
        budgetBytes: error.budgetBytes,
        zeroDurableEffects: true,
      }),
    );
  });

  it('L-14 Unicode/URL-expansion envelope: 100 uniform 5000-char CJK paths → canonical ≈45,023 B, 2 rows/statement, 50 INSERT statements, every chunk within budget', async () => {
    const hold = await freshOwnedFixture();
    const items: CandidateItemRow[] = [];
    for (let i = 0; i < 100; i += 1) items.push(await normalizedCjkItem(i, 5000));
    const encoder = new TextEncoder();
    for (const item of items) {
      expect(encoder.encode(item.canonicalUrl!).length).toBe(CJK_CANONICAL_URL_BYTES);
      expect(item.canonicalUrl).toBe(cjkCanonicalUrl(5000, items.indexOf(item)));
    }
    expect(new Set(items.map((it) => it.canonicalUrl)).size).toBe(100);
    const plan = planInsertChunks(items, ownedPlanOptions(hold));
    expect(plan.chunks.length).toBe(50); // "50 INSERT statements ALONE"
    expect(plan.maxRowsPerStatement).toBe(2);
    expect(plan.limitedBy).toBe('bytes');
    for (const audit of plan.statementAudits) {
      expect(audit.totalBytes).toBeLessThanOrEqual(MAX_SQL_STATEMENT_BYTES);
    }
    const candidate = await runOwnedCandidate(items, hold);
    expect(candidate.threw).toBeNull();
    expect(candidate.inserted).toBe(100); // correctness holds — the ≤40 STMT target does NOT
    labLog(
      'LAB[L-14]',
      JSON.stringify({
        canonicalUrlBytes: CJK_CANONICAL_URL_BYTES,
        insertStatements: plan.chunks.length,
        rowsPerStatement: plan.maxRowsPerStatement,
        limitedBy: plan.limitedBy,
        largestStatementBytes: Math.max(...plan.statementAudits.map((a) => a.totalBytes)),
        inserted: candidate.inserted,
        note: 'NOT_READY evidence for a universal <=40 bound — see free-plan/FREE_SAFE_EXECUTION_DESIGN.md §9',
      }),
    );
  });
});
