import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { checkSchemaHealth } from '../../src/adapters/db/schema-health';

beforeEach(async () => {
  await applyMigrations(env.DB);
});

it('two targeted UPSERT clauses handle both business keys but do not hide primary-key collisions', async () => {
  await env.DB.prepare(
    'CREATE TABLE review11_keys (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL, canonical_url TEXT NOT NULL, title TEXT NOT NULL, UNIQUE(source_id,external_id), UNIQUE(source_id,canonical_url))',
  ).run();
  const sql =
    'INSERT INTO review11_keys VALUES (?,?,?,?,?) ON CONFLICT(source_id,external_id) DO NOTHING ON CONFLICT(source_id,canonical_url) DO NOTHING';
  await env.DB.prepare(sql).bind('a', 's', 'e1', 'u1', 'title').run();
  expect((await env.DB.prepare(sql).bind('b', 's', 'e1', 'u2', 'title').run()).meta.changes).toBe(
    0,
  );
  expect((await env.DB.prepare(sql).bind('c', 's', 'e2', 'u1', 'title').run()).meta.changes).toBe(
    0,
  );
  await expect(env.DB.prepare(sql).bind('a', 's', 'e3', 'u3', 'title').run()).rejects.toThrow();
  await expect(env.DB.prepare(sql).bind('d', 's', 'e4', 'u4', null).run()).rejects.toThrow();
});

it('the documented item guard permits inserts after source ownership is lost', async () => {
  await env.DB.prepare(
    'CREATE TABLE review11_jobs (id TEXT PRIMARY KEY, status TEXT, attempts INTEGER)',
  ).run();
  await env.DB.prepare(
    'CREATE TABLE review11_state (source_id TEXT PRIMARY KEY, next_poll_at INTEGER, cursor TEXT)',
  ).run();
  await env.DB.prepare(
    'CREATE TABLE review11_items (id TEXT PRIMARY KEY, source_id TEXT, external_id TEXT, canonical_url TEXT)',
  ).run();
  await env.DB.prepare("INSERT INTO review11_jobs VALUES ('j','claimed',1)").run();
  await env.DB.prepare("INSERT INTO review11_state VALUES ('s',999,'old')").run();
  const result = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO review11_items SELECT 'i','s','e','u' WHERE EXISTS(SELECT 1 FROM review11_jobs WHERE id='j' AND status='claimed' AND attempts=1) AND NOT EXISTS(SELECT 1 FROM review11_items WHERE source_id='s' AND external_id='e') AND NOT EXISTS(SELECT 1 FROM review11_items WHERE source_id='s' AND canonical_url='u')",
    ),
    env.DB.prepare(
      "UPDATE review11_state SET cursor='new' WHERE source_id='s' AND next_poll_at=120000 AND EXISTS(SELECT 1 FROM review11_jobs WHERE id='j' AND status='claimed' AND attempts=1)",
    ),
  ]);
  expect(result[0]!.meta.changes).toBe(1);
  expect(result[1]!.meta.changes).toBe(0);
});

it('schema 4 is NOT healthy for the original application expecting schema 3', async () => {
  const db = createDbExecutor(env.DB);
  expect((await checkSchemaHealth(db, 3)).ok).toBe(true);
  await env.DB.prepare("UPDATE schema_metadata SET value='4' WHERE key='schema_version'").run();
  expect(await checkSchemaHealth(db, 3)).toMatchObject({
    ok: false,
    reason: 'schema_version_mismatch',
    observedSchemaVersion: 4,
  });
});

it('adding the partial unique index fails if legacy outstanding duplicates exist', async () => {
  await env.DB.prepare(
    'CREATE TABLE review11_active (id TEXT PRIMARY KEY, type TEXT, aggregate_type TEXT, aggregate_id TEXT, status TEXT)',
  ).run();
  await env.DB.prepare(
    "INSERT INTO review11_active VALUES ('a','sources.fetch_poll','source','s','pending'),('b','sources.fetch_poll','source','s','retry_wait')",
  ).run();
  await expect(
    env.DB.prepare(
      "CREATE UNIQUE INDEX review11_active_idx ON review11_active(aggregate_type,aggregate_id) WHERE type='sources.fetch_poll' AND status IN ('pending','queued','claimed','retry_wait')",
    ).run(),
  ).rejects.toThrow();
});
