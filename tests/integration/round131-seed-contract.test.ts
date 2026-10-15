import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry, type Registry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';

/**
 * Round 1.3.1 permanent coverage — corrections found by the independent
 * Round 1.3 review (evidence: pixel-round13-posidon-evidence.zip, 5 failed /
 * 1 passed), kept as regressions with the original evidence intent intact:
 *
 * 1. SeedSummary.written must count the SOURCE descriptor statements via an
 *    explicit statement-index mapping. The seed batch alternates one
 *    sources-upsert with one state-insert per source, so positional
 *    metadata indexing (metas[i]) read the wrong half of the alternation
 *    and reported a full re-import of all 14 descriptors as written = 7.
 *    The documented meaning of `written` (descriptor rows written) is
 *    preserved — the mapping was fixed, never the expectation.
 * 2. Persisted config that is valid JSON but NOT a JSON object (null, [],
 *    strings, numbers, booleans) must FAIL VISIBLY at the atomic mutation
 *    boundary and roll back the WHOLE import, leaving the original value
 *    and every other row unchanged. `json_patch` alone silently discards a
 *    non-object target (RFC-7396 MergePatch) — the in-statement
 *    `json_type(...) = 'object'` guard closes that reset path without any
 *    racy application-layer pre-read, schema/migration change, or silent
 *    repair.
 * 3. The stronger supplied rollback evidence is preserved: an ACTUAL
 *    constraint failure inside statement 3 of the real D1 seed batch rolls
 *    back the earlier source and state inserts (a wrapper throwing before
 *    batch execution would not be equivalent evidence).
 */

const db: DbExecutor = createDbExecutor(env.DB);
const NOW = 1_770_000_000_000;

const registry = (): Registry => {
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('registry invalid');
  return r.registry;
};

const seed = (reg: Registry = registry(), at = NOW) => seedSourcesFromRegistry(db, reg, at);

beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const table of ['source_items', 'source_state', 'sources', 'jobs'])
    await db.run({ sql: `DELETE FROM ${table}` });
});

describe('Round 1.3.1: SeedSummary.written counts descriptor statements correctly', () => {
  it('initial import reports written = total (every descriptor freshly inserted)', async () => {
    const summary = await seed();
    expect(summary.total).toBe(14);
    expect(summary.written).toBe(14);
  });

  it('full re-import reports written = 14 (the Round 1.3 defect under-counted 7)', async () => {
    await seed();
    const second = await seed(registry(), NOW + 1000);
    expect(second.total).toBe(14);
    expect(second.written).toBe(14);
  });

  it('state-row repair never distorts the count: written still counts descriptors only', async () => {
    await seed();
    // Delete THREE state rows → the re-import must repair them (3 state
    // statements report changes > 0) while written stays 14: state repair
    // is not a descriptor write.
    await db.run({
      sql: `DELETE FROM source_state WHERE source_id IN
              ('steam_news_watchlist', 'playstation_blog', 'reddit_crack_signals')`,
    });
    const statesBefore = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_state',
    });
    expect(statesBefore!.n).toBe(11);

    const second = await seed(registry(), NOW + 1000);
    expect(second.written).toBe(14);
    const statesAfter = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_state',
    });
    expect(statesAfter!.n).toBe(14); // repaired by the same atomic batch
  });

  it('explicit mapping holds for a SUBSET import and a mixed insert/refresh pass', async () => {
    // Two-source registry: each source contributes 2 batch statements
    // (descriptor at even indexes, state at odd) — positional counting
    // could only ever see the first statement per pair by accident.
    const subset: Registry = { ...registry(), sources: registry().sources.slice(0, 2) };
    const first = await seed(subset);
    expect(first.total).toBe(2);
    expect(first.written).toBe(2);
    const second = await seed(subset, NOW + 1000);
    expect(second.written).toBe(2); // both refreshed, counted via the map

    // Mixed pass: 2 refreshed rows + 12 inserted rows → written = 14.
    const full = await seed(registry(), NOW + 2000);
    expect(full.written).toBe(14);
  });
});

describe('Round 1.3.1: non-object persisted config fails visibly without reset', () => {
  // Valid JSON, invalid CONFIG root. `json_patch` alone replaced each of
  // these with the registry defaults (RFC-7396 MergePatch discards the
  // non-object target) — each value must now REJECT the import and remain
  // byte-identical afterwards.
  it.each(['null', '[]', '"not an object"', '42', 'true'])(
    'persisted config %s: import rejected, value and all other rows untouched',
    async (value) => {
      await seed();
      await db.run({
        sql: "UPDATE sources SET config_json = ? WHERE id = 'steam_news_watchlist'",
        params: [value],
      });

      // Full snapshots BEFORE the rejected import.
      const steamBefore = await db.first<Record<string, unknown>>({
        sql: "SELECT * FROM sources WHERE id = 'steam_news_watchlist'",
      });
      const otherBefore = await db.first<{ config_json: string; updated_at: number }>({
        sql: "SELECT config_json, updated_at FROM sources WHERE id = 'playstation_blog'",
      });
      const stateBefore = await db.first<Record<string, unknown>>({
        sql: "SELECT * FROM source_state WHERE source_id = 'steam_news_watchlist'",
      });

      await expect(seed(registry(), NOW + 1000)).rejects.toThrow();

      // The invalid value was NOT reset, replaced, or repaired.
      const steamAfter = await db.first<{ config_json: string; updated_at: number }>({
        sql: "SELECT config_json, updated_at FROM sources WHERE id = 'steam_news_watchlist'",
      });
      expect(steamAfter!.config_json).toBe(value);
      expect(steamAfter!.updated_at).toBe(steamBefore!.updated_at);
      // WHOLE-import rollback: no other row was refreshed either.
      const otherAfter = await db.first<{ config_json: string; updated_at: number }>({
        sql: "SELECT config_json, updated_at FROM sources WHERE id = 'playstation_blog'",
      });
      expect(otherAfter!.config_json).toBe(otherBefore!.config_json);
      expect(otherAfter!.updated_at).toBe(otherBefore!.updated_at);
      // Owner runtime state untouched by the aborted batch.
      const stateAfter = await db.first<Record<string, unknown>>({
        sql: "SELECT * FROM source_state WHERE source_id = 'steam_news_watchlist'",
      });
      expect(stateAfter).toEqual(stateBefore);
    },
  );

  it('malformed JSON syntax still fails visibly (unchanged behavior, same boundary)', async () => {
    await seed();
    await db.run({
      sql: "UPDATE sources SET config_json = '{broken' WHERE id = 'steam_news_watchlist'",
    });
    await expect(seed(registry(), NOW + 1000)).rejects.toThrow();
    const row = await db.first<{ config_json: string }>({
      sql: "SELECT config_json FROM sources WHERE id = 'steam_news_watchlist'",
    });
    expect(row!.config_json).toBe('{broken');
  });

  it('visible recovery: once the owner repairs the value, the import succeeds', async () => {
    await seed();
    await db.run({
      sql: "UPDATE sources SET config_json = '42' WHERE id = 'steam_news_watchlist'",
    });
    await expect(seed(registry(), NOW + 1000)).rejects.toThrow();
    await db.run({
      sql: `UPDATE sources SET config_json = ? WHERE id = 'steam_news_watchlist'`,
      params: [
        JSON.stringify({
          appsPerBatch: 10,
          maxItemsPerApp: 3,
          endpoint: 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/',
        }),
      ],
    });
    const summary = await seed(registry(), NOW + 2000);
    expect(summary.written).toBe(14);
    const row = await db.first<{ config_json: string }>({
      sql: "SELECT config_json FROM sources WHERE id = 'steam_news_watchlist'",
    });
    const config = JSON.parse(row!.config_json) as Record<string, unknown>;
    expect(config['appsPerBatch']).toBe(10); // registry key refreshed
    expect(config['endpoint']).toBe('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/');
  });
});

describe('Round 1.3.1: real mid-batch constraint failure rolls back the whole seed batch', () => {
  /**
   * PRESERVED stronger rollback evidence (independent Round 1.3 review):
   * statement 3 of the REAL D1 batch is replaced by an insert that violates
   * the sources table NOT NULL constraints. Everything the batch had done
   * so far (earlier source AND state inserts) must be rolled back — a
   * wrapper that throws BEFORE batch execution is not equivalent evidence.
   */
  it('NOT NULL violation inside statement 3 rolls back earlier source and state inserts', async () => {
    const broken = {
      ...db,
      batch: async (statements: Parameters<typeof db.batch>[0]) => {
        const copy = [...statements];
        copy[2] = {
          sql: "INSERT INTO sources (id) VALUES ('invalid-missing-required-fields')",
        };
        return db.batch(copy);
      },
    };
    await expect(seedSourcesFromRegistry(broken, registry(), NOW)).rejects.toThrow();
    const sources = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM sources',
    });
    const states = await db.first<{ n: number }>({
      sql: 'SELECT COUNT(*) AS n FROM source_state',
    });
    expect(sources!.n).toBe(0);
    expect(states!.n).toBe(0);
  });
});
