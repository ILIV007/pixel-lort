import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
const db = createDbExecutor(env.DB);
const NOW = 1770000000000;
function catalog() {
  const r = parseEmbeddedRegistry();
  if (!r.ok) throw new Error('invalid');
  return r.registry;
}
beforeEach(async () => {
  await applyMigrations(env.DB);
  for (const t of ['source_items', 'source_state', 'sources', 'jobs'])
    await db.run({ sql: `DELETE FROM ${t}` });
});
it('written counts source descriptor statements, not alternating source/state metadata', async () => {
  const r = catalog();
  await seedSourcesFromRegistry(db, r, NOW);
  const second = await seedSourcesFromRegistry(db, r, NOW + 1000);
  expect(second.written).toBe(r.sources.length);
});
it.each(['null', '[]', '"not an object"', '42'])(
  'non-object persisted config %s must fail without reset',
  async (value) => {
    const r = catalog();
    await seedSourcesFromRegistry(db, r, NOW);
    await db.run({
      sql: "UPDATE sources SET config_json=? WHERE id='steam_news_watchlist'",
      params: [value],
    });
    let rejected = false;
    try {
      await seedSourcesFromRegistry(db, r, NOW + 1000);
    } catch {
      rejected = true;
    }
    const row = await db.first<{ config_json: string }>({
      sql: "SELECT config_json FROM sources WHERE id='steam_news_watchlist'",
    });
    expect(row?.config_json).toBe(value);
    expect(rejected).toBe(true);
  },
);
it('real statement failure inside seed batch rolls back earlier source and state inserts', async () => {
  const broken = {
    ...db,
    batch: async (statements: Parameters<typeof db.batch>[0]) => {
      const copy = [...statements];
      copy[2] = { sql: "INSERT INTO sources (id) VALUES ('invalid-missing-required-fields')" };
      return db.batch(copy);
    },
  };
  await expect(seedSourcesFromRegistry(broken, catalog(), NOW)).rejects.toThrow();
  expect((await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM sources' }))?.n).toBe(0);
  expect(
    (await db.first<{ n: number }>({ sql: 'SELECT COUNT(*) AS n FROM source_state' }))?.n,
  ).toBe(0);
});
