// PIXEL R1.10.4.2 — PERMANENT workerd control for the D1 prepare/terminal
// contract (R1141-02). Review-side audit tooling — NOT part of the accepted
// product suite (1,142 assertions unchanged); run with its OWN config:
//
//   npx vitest run --config audit-tools/d1-contract/vitest.config.d1.mjs
//
// What it pins (in real workerd D1 — the same engine class as the platform):
//
//   1. prepare() is CONSTRUCTION ONLY: on schema 3, building the statement
//      for a column that does not exist yet does NOT throw.
//   2. The MISSING-COLUMN rejection happens at TERMINAL execution: the FIRST
//      submitted attempt (.all()) rejects with the column name — that attempt
//      IS one attempted query (registered as such in
//      audit/PROBE_CASE_SCHEDULE.json X-SETUP-S3).
//   3. On schema 4 (after the tracked 0004 candidate is applied to the
//      disposable test database) the SAME statement constructS and terminally
//      SUCCEEDS with zero rows — the positive half of the contract.
//
// This corrects the R1.10.4.1 plan claim that the probe "throws at
// construction": that is node:sqlite LOCAL compile behavior, not D1. The
// historical counterexample (posidon-review/R1.10.4.1/manager-r11041-boundary.test.ts)
// remains intentionally red against that old claim and is preserved unedited.
import { beforeAll, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, ROUND19_MIGRATION_PLAN } from '../../tests/helpers/migrations';

beforeAll(async () => {
  // Disposable workerd test database ONLY: accepted 0001-0003 (schema 3),
  // then the tracked 0004 CANDIDATE (schema 4) — never any real database.
  await applyMigrations(env.DB);
});

it('CONTRACT: prepare() is construction-only on S3 - a missing column does NOT throw at prepare()', () => {
  expect(env.DB.prepare('SELECT poll_owner_job_id FROM source_state LIMIT 0')).toBeDefined();
});

it('CONTRACT: the missing-column rejection happens at TERMINAL execution (the attempt is the submitted query)', async () => {
  const statement = env.DB.prepare('SELECT poll_owner_job_id FROM source_state LIMIT 0');
  await expect(statement.all()).rejects.toThrow(/poll_owner_job_id/);
});

it('CONTRACT: schema metadata is 3 before the candidate', async () => {
  const row = await env.DB.prepare(
    "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
  ).first<{ value: string }>();
  expect(row?.value).toBe('3');
});

it('CONTRACT (positive half): after the 0004 candidate the SAME statement prepares AND terminally succeeds with zero rows on S4', async () => {
  await applyMigrations(env.DB, ROUND19_MIGRATION_PLAN); // applies only the pending 0004
  const version = await env.DB.prepare(
    "SELECT value FROM schema_metadata WHERE key = 'schema_version'",
  ).first<{ value: string }>();
  expect(version?.value).toBe('4');
  const statement = env.DB.prepare('SELECT poll_owner_job_id FROM source_state LIMIT 0');
  expect(statement).toBeDefined();
  const rows = await statement.all();
  expect(rows.results).toEqual([]);
});
