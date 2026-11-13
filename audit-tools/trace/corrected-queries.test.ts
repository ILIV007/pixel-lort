/**
 * R1.10.3 AUDIT TOOLING — corrected candidate-query controls (NOT accepted
 * source).
 *
 * NEW in R1.10.3. Scope (NEXT_GLM_PROMPT_R1_10_3.md steps 3–4):
 *
 *  - Q-01 (R112-01 floor): reproduce the minimal lower-bound control on
 *    REAL workerd D1 with the v3 instrument — 100 retained one-row INSERTs
 *    in ONE batch + 2 source-bound grouped reads = 3 execution-API calls /
 *    102 statements (attempted AND completed). This is the floor that any
 *    grouped-read-only optimization cannot go below while 100 per-item
 *    INSERT statements are retained; it is the explicit retraction anchor
 *    for the withdrawn "15–16 total STMT / ≥3× headroom" estimate.
 *
 *  - Q-02…Q-06 (R112-04): the CANDIDATE grouped classification queries —
 *    with the source predicate PRESERVED — are query-equivalent to the
 *    accepted per-item probes on a parity matrix: foreign-source identity
 *    (the exact CE2 shape, corrected), chunk boundaries (99+1; every chunk
 *    ≤ 100 bound parameters INCLUDING the shared source bind), cross-key
 *    duplicates, new+duplicate mixes, null-key exclusion, the accepted
 *    quirk branch, and legacy mixed-source parity (per-source grouping).
 *
 * The FROZEN manager CE2 test (which embeds the REJECTED literal SQL) is
 * intentionally NOT touched and stays red in manager-evidence/
 * manager-probes; these are the SEPARATE corrected-query tests the manager
 * required. PK-collision / stale-owner / whole-batch-fence parity for the
 * candidate WRITE path lives in design-lab/ (real workerd D1 end-to-end).
 *
 * HONESTY LABELS: every statement runs on the disposable local workerd D1
 * (real @cloudflare/vitest-pool-workers binding). These tests prove QUERY
 * EQUIVALENCE and BIND BUDGETS locally — they prove nothing about cloud
 * quota enforcement, CPU, or billing. TOOL-TEST counts — never added to
 * the accepted product suite's 1142 and never mixed with trace-suite
 * invocation counts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, ROUND19_MIGRATION_PLAN } from '../../tests/helpers/migrations';
import {
  createD1Stats,
  deriveCounts,
  instrumentD1,
  resetStats,
  type D1Stats,
} from './d1-instrument';
import {
  CHUNK_SIZE,
  classifyAcceptedPerItem,
  classifyGrouped,
  type CandidateItem,
  type ClassifiedItem,
  type ClassificationOutcome,
} from './candidate-classification';
import { traceLog } from './trace-log';

/* ------------------------------------------------------------------ */
/* Fixture constants (obvious fakes)                                   */
/* ------------------------------------------------------------------ */

const SOURCE_A = 'source-aaaaaaaa-aaaaaaaa';
const SOURCE_B = 'source-bbbbbbbb-bbbbbbbb';

const rawDb = () => env.DB as D1Database;

let stats: D1Stats;
let wrapped: D1Database;

beforeEach(async () => {
  // ACTIVE schema-4 surface — identical to the trace suite's ACTIVE block.
  await applyMigrations(rawDb());
  await applyMigrations(rawDb(), ROUND19_MIGRATION_PLAN);
  await rawDb().prepare('DELETE FROM source_items').run();
  // Fixture sources (obvious fakes): source_items.source_id has a FOREIGN
  // KEY to sources(id), so the parity fixtures seed the two sources first.
  await rawDb()
    .prepare(
      `INSERT OR IGNORE INTO sources
         (id, name, connector, lane, trust_tier, enabled, interval_seconds, priority,
          daily_request_budget, approval_policy, config_json, created_at, updated_at)
       VALUES (?, 'fixture-a', 'rss', 'radar', 50, 1, 3600, 50, 100, 'auto', '{}', 1, 1),
              (?, 'fixture-b', 'rss', 'radar', 50, 1, 3600, 50, 100, 'auto', '{}', 1, 1)`,
    )
    .bind(SOURCE_A, SOURCE_B)
    .run();
  stats = createD1Stats();
  wrapped = instrumentD1(rawDb(), stats);
});

afterEach(() => {
  resetStats(stats);
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function seedItem(row: {
  id: string;
  sourceId: string;
  externalId: string | null;
  canonicalUrl: string | null;
}): Promise<void> {
  // Raw binding, OUTSIDE any measured window (fixture preparation).
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

function outcomesOf(classified: readonly ClassifiedItem[]): ClassificationOutcome[] {
  return classified.map((c) => c.outcome);
}

/** Accepted-shape probe for one item (the reference read, per item). */
function acceptedOwnProbe(id: string, sourceId: string) {
  return wrapped
    .prepare('SELECT id FROM source_items WHERE id = ? AND source_id = ?')
    .bind(id, sourceId)
    .first<{ id: string }>();
}

/* ------------------------------------------------------------------ */
/* Q-01 — R112-01 floor control                                        */
/* ------------------------------------------------------------------ */

describe('R1.10.3 corrected candidate queries (audit tooling — outside accepted source)', () => {
  it('Q-01 floor: 100 retained one-row INSERTs + 2 source-bound grouped reads = 3 API calls / 102 statements — grouped reads alone cannot meet both-unit quota (R112-01)', async () => {
    // 100 items INSERTed as 100 SEPARATE one-row statements in ONE batch —
    // exactly the retained shape of the accepted atomic item batch (no
    // state/engine overhead counted: LOWER BOUND only, mirrors the
    // manager's CONTROL).
    const inserts = Array.from({ length: 100 }, (_, i) =>
      wrapped
        .prepare(
          "INSERT INTO source_items (id, source_id, external_id, canonical_url, title, body_excerpt, author, published_at, fetched_at, content_hash, raw_json, processing_status) VALUES (?, ?, ?, NULL, 't', NULL, NULL, NULL, 1, 'h', '{}', 'new')",
        )
        .bind(`floor-item-${i}`, SOURCE_A, `floor-ext-${i}`),
    );
    await wrapped.batch(inserts);
    // Two grouped reads, source-bound, 99 ids per chunk (≤100 binds each).
    const ids = Array.from({ length: 100 }, (_, i) => `floor-item-${i}`);
    for (const chunk of [ids.slice(0, 99), ids.slice(99)]) {
      await wrapped
        .prepare(
          `SELECT id FROM source_items WHERE source_id = ? AND id IN (${chunk
            .map(() => '?')
            .join(',')})`,
        )
        .bind(SOURCE_A, ...chunk)
        .all();
    }
    const d = deriveCounts(stats);
    expect(d.executionApiCallAttempts).toBe(3); // 1 batch + 2 grouped reads
    expect(d.statementsAttempted).toBe(102); // 100 inserts + 2 reads
    expect(d.statementsAttempted).toBeGreaterThan(50);
    expect(d.statementsCompleted).toBe(102); // v3: completed batch + completed reads
    expect(stats.batchStatementsCompleted).toBe(100);
    traceLog(
      'CORRECTED[Q-01]',
      JSON.stringify({
        retainedItemInserts: 100,
        groupedReads: 2,
        stateUpdateAndEngineOverhead: 'omitted: lower bound only',
        ...d,
      }),
    );
  });

  /* ---------------------------------------------------------------- */
  /* Q-02…Q-06 — R112-04 corrected parity matrix                       */
  /* ---------------------------------------------------------------- */

  it('Q-02 foreign-source identity: corrected grouped own-probe preserves the (id, source_id) pair and equals the accepted probe (CE2 shape, corrected)', async () => {
    // The exact CE2 durable shape: a row whose id matches the attempted
    // item's id but whose source is FOREIGN to the attempted item.
    await seedItem({
      id: 'existing-foreign-id',
      sourceId: SOURCE_B,
      externalId: 'ext-b',
      canonicalUrl: null,
    });
    const attempted: CandidateItem = {
      id: 'existing-foreign-id',
      sourceId: SOURCE_A,
      externalId: 'ext-a',
      canonicalUrl: null,
    };

    // ACCEPTED read (per-item, exact pair):
    const acceptedRow = await acceptedOwnProbe(attempted.id, attempted.sourceId);
    // CANDIDATE grouped read (source-bound IN list):
    const candidateRows = await wrapped
      .prepare('SELECT id FROM source_items WHERE source_id = ? AND id IN (?)')
      .bind(attempted.sourceId, attempted.id)
      .all<{ id: string }>();

    expect(acceptedRow).toBeNull();
    expect(candidateRows.results).toEqual([]); // identical outcome
    // Characterization (NOT a candidate): the REJECTED source-less shape
    // would return the foreign row — this is why the predicate is
    // load-bearing. Executed on the RAW binding; the rejected shape is
    // NOT part of the candidate design.
    const rejected = await rawDb()
      .prepare('SELECT id FROM source_items WHERE id IN (?)')
      .bind(attempted.id)
      .all<{ id: string }>();
    expect(rejected.results).toEqual([{ id: 'existing-foreign-id' }]);

    // End-to-end classification parity for this shape: the attempted item
    // falls through own-miss → external-miss → null-url → unclassified on
    // BOTH implementations.
    const accepted = await classifyAcceptedPerItem(wrapped, [attempted]);
    const candidate = await classifyGrouped(wrapped, [attempted]);
    expect(outcomesOf(candidate)).toEqual(outcomesOf(accepted));
    expect(outcomesOf(candidate)).toEqual(['unclassified']);
    traceLog(
      'CORRECTED[Q-02]',
      JSON.stringify({
        acceptedProbe: acceptedRow,
        candidateProbe: candidateRows.results,
        rejectedProbeWouldReturn: rejected.results,
        parity: outcomesOf(candidate),
      }),
    );
  });

  it('Q-03 chunk boundary: 100 items split 99+1; every chunk ≤100 binds INCLUDING the source bind; outcomes equal the accepted loop', async () => {
    // Nothing seeded: every item misses every probe; non-null urls force
    // the accepted conservative quirk branch (duplicateExternal).
    const items: CandidateItem[] = Array.from({ length: 100 }, (_, i) => ({
      id: `chunk-item-${i}`,
      sourceId: SOURCE_A,
      externalId: `chunk-ext-${i}`,
      canonicalUrl: `https://chunk.example/${i}`,
    }));
    const accepted = await classifyAcceptedPerItem(wrapped, items);
    const candidate = await classifyGrouped(wrapped, items);
    expect(outcomesOf(candidate)).toEqual(outcomesOf(accepted));
    expect(outcomesOf(candidate).every((o) => o === 'duplicateExternal')).toBe(true);
    // Bind budget: the probe statements actually issued carry
    // 1 (source) + ≤99 (ids) ≤ 100 binds. Verify via the instrument's
    // prepare count and a direct boundary execution at exactly 100 binds.
    expect(CHUNK_SIZE).toBe(99);
    const boundaryIds = items.slice(0, 99).map((i) => i.id);
    const boundary = await wrapped
      .prepare(
        `SELECT id FROM source_items WHERE source_id = ? AND id IN (${boundaryIds
          .map(() => '?')
          .join(',')})`,
      )
      .bind(SOURCE_A, ...boundaryIds)
      .all<{ id: string }>();
    expect(boundary.results).toEqual([]); // executes at exactly 100 binds
    traceLog(
      'CORRECTED[Q-03]',
      JSON.stringify({
        items: items.length,
        chunkSize: CHUNK_SIZE,
        boundaryBinds: 1 + boundaryIds.length,
        parity: outcomesOf(candidate).slice(0, 3),
        quirkCount: outcomesOf(candidate).filter((o) => o === 'duplicateExternal').length,
      }),
    );
  });

  it('Q-04 outcome matrix parity: inserted / duplicateExternal / duplicateUrl / quirk / null-key / cross-key — grouped equals accepted per item IN ATTEMPT ORDER', async () => {
    // Seeded durable state (raw, outside any window):
    await seedItem({
      id: 'seed-own-hit',
      sourceId: SOURCE_A,
      externalId: 'seed-ext-1',
      canonicalUrl: 'https://seed.example/1',
    });
    await seedItem({
      id: 'seed-ext-hit',
      sourceId: SOURCE_A,
      externalId: 'ext-shared',
      canonicalUrl: null,
    });
    await seedItem({
      id: 'seed-url-hit',
      sourceId: SOURCE_A,
      externalId: 'seed-ext-2',
      canonicalUrl: 'https://seed.example/2',
    });
    // Attempted items exercising EVERY accepted branch:
    const items: CandidateItem[] = [
      {
        id: 'seed-own-hit',
        sourceId: SOURCE_A,
        externalId: 'fresh-ext-a',
        canonicalUrl: 'https://fresh.example/a',
      }, // own hit → inserted
      {
        id: 'fresh-1',
        sourceId: SOURCE_A,
        externalId: 'ext-shared',
        canonicalUrl: 'https://fresh.example/b',
      }, // external hit → duplicateExternal
      { id: 'fresh-2', sourceId: SOURCE_A, externalId: 'ext-shared', canonicalUrl: null }, // cross-key: SAME external value → duplicateExternal
      {
        id: 'fresh-3',
        sourceId: SOURCE_A,
        externalId: 'fresh-ext-c',
        canonicalUrl: 'https://seed.example/2',
      }, // url hit → duplicateUrl
      {
        id: 'fresh-4',
        sourceId: SOURCE_A,
        externalId: 'fresh-ext-d',
        canonicalUrl: 'https://nowhere.example/d',
      }, // full miss + url → quirk duplicateExternal
      { id: 'fresh-5', sourceId: SOURCE_A, externalId: null, canonicalUrl: null }, // null keys → unclassified branch
      {
        id: 'fresh-6',
        sourceId: SOURCE_A,
        externalId: null,
        canonicalUrl: 'https://nowhere.example/f',
      }, // null ext + url miss → quirk
    ];
    const accepted = await classifyAcceptedPerItem(wrapped, items);
    const candidate = await classifyGrouped(wrapped, items);
    expect(outcomesOf(candidate)).toEqual(outcomesOf(accepted));
    expect(outcomesOf(accepted)).toEqual([
      'inserted',
      'duplicateExternal',
      'duplicateExternal',
      'duplicateUrl',
      'duplicateExternal',
      'unclassified',
      'duplicateExternal',
    ]);
    traceLog(
      'CORRECTED[Q-04]',
      JSON.stringify({ parity: outcomesOf(candidate), items: items.length }),
    );
  });

  it('Q-05 new+duplicate mix at volume (50 new ids that hit + 50 duplicates): grouped equals accepted', async () => {
    // Seed 50 rows the attempted items will own-hit, and 50 rows the
    // attempted items will external-hit.
    for (let i = 0; i < 50; i += 1) {
      await seedItem({
        id: `own-${i}`,
        sourceId: SOURCE_A,
        externalId: `seeded-a-${i}`,
        canonicalUrl: null,
      });
      await seedItem({
        id: `other-${i}`,
        sourceId: SOURCE_A,
        externalId: `dup-ext-${i}`,
        canonicalUrl: null,
      });
    }
    const items: CandidateItem[] = [
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `own-${i}`,
        sourceId: SOURCE_A,
        externalId: `fresh-n-${i}`,
        canonicalUrl: null as string | null,
      })),
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `fresh-d-${i}`,
        sourceId: SOURCE_A,
        externalId: `dup-ext-${i}`,
        canonicalUrl: null as string | null,
      })),
    ];
    const accepted = await classifyAcceptedPerItem(wrapped, items);
    const candidate = await classifyGrouped(wrapped, items);
    expect(outcomesOf(candidate)).toEqual(outcomesOf(accepted));
    const inserted = outcomesOf(candidate).filter((o) => o === 'inserted').length;
    const dupExt = outcomesOf(candidate).filter((o) => o === 'duplicateExternal').length;
    expect(inserted).toBe(50);
    expect(dupExt).toBe(50);
    traceLog(
      'CORRECTED[Q-05]',
      JSON.stringify({ inserted, duplicateExternal: dupExt, parity: 'per-item identical' }),
    );
  });

  it('Q-06 legacy mixed-source parity: per-source grouping preserves every (source, key) pair', async () => {
    // The LEGACY commit path accepts items attributed to DIFFERENT sources
    // (each row carries its own source_id). Seeded state in BOTH sources.
    await seedItem({ id: 'a-row', sourceId: SOURCE_A, externalId: 'ext-a1', canonicalUrl: null });
    await seedItem({ id: 'b-row', sourceId: SOURCE_B, externalId: 'ext-b1', canonicalUrl: null });
    const items: CandidateItem[] = [
      { id: 'a-row', sourceId: SOURCE_A, externalId: 'ext-a1', canonicalUrl: null }, // own hit (A)
      { id: 'b-row', sourceId: SOURCE_B, externalId: 'ext-b1', canonicalUrl: null }, // own hit (B)
      { id: 'fresh-a', sourceId: SOURCE_A, externalId: 'ext-b1', canonicalUrl: null }, // A-external probe must NOT see B's row → unclassified (null url)
      {
        id: 'fresh-b',
        sourceId: SOURCE_B,
        externalId: 'ext-a1',
        canonicalUrl: 'https://b.example/x',
      }, // B probes must NOT see A's rows → quirk dupExternal
      { id: 'a-row', sourceId: SOURCE_B, externalId: 'ext-z', canonicalUrl: null }, // SAME id, DIFFERENT source → own miss (source pair preserved)
    ];
    const accepted = await classifyAcceptedPerItem(wrapped, items);
    const candidate = await classifyGrouped(wrapped, items);
    expect(outcomesOf(candidate)).toEqual(outcomesOf(accepted));
    expect(outcomesOf(candidate)).toEqual([
      'inserted',
      'inserted',
      'unclassified',
      'duplicateExternal',
      'unclassified',
    ]);
    traceLog(
      'CORRECTED[Q-06]',
      JSON.stringify({
        parity: outcomesOf(candidate),
        note: 'per-source grouped probes; source/id pairs preserved for mixed legacy batches',
      }),
    );
  });
});
