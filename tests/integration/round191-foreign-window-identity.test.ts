/**
 * ROUND 1.9.1 — R19-02 PERMANENT COMPLETE-DURABLE-IDENTITY PROOFS.
 *
 * Posidon finding R19-02 (P2): the post-conflict classification read in
 * `schedulePollWindowOwned` selected only (id, type, payload_json, status)
 * and omitted `aggregate_type` / `aggregate_id`, so a same-key row with a
 * matching type and canonical payload but a FOREIGN aggregate was reported
 * as `outstanding_job_owns_window` (nonterminal) or `marker_moved`
 * (terminal) instead of `foreign_window_job` (counterexample CE5).
 *
 * The correction (authorized by NEXT_ROUND_1_9_1_GLM_PROMPT.md §R19-02):
 * the bounded existing-row lookup reads the COMPLETE durable identity and
 * classifies the window as FOREIGN unless job type AND aggregate_type
 * 'source' AND the source aggregate id AND the canonical payload ALL match
 * — checked BEFORE any terminal/nonterminal classification. No automatic
 * deletion, cancellation, cleanup or transfer happens in any case; the
 * foreign row and the window are left untouched for operator action.
 *
 * Coverage: wrong aggregate id and wrong aggregate type, in BOTH
 * nonterminal and terminal states, plus the matching legitimate states
 * (outstanding owns window / terminal remediation / marker moved) which
 * must behave exactly as before.
 *
 * HONESTY BOUNDARIES: real workerd D1, disposable test databases only
 * (test-only ROUND19_MIGRATION_PLAN); no remote operations anywhere.
 */
import { beforeEach, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { applyMigrations, ROUND19_MIGRATION_PLAN } from '../helpers/migrations';
import { createDbExecutor } from '../../src/adapters/db/db-executor';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../src/adapters/db/source-registry-store';
import {
  schedulePollWindowOwned,
  POLL_WINDOW_TERMINAL_REASON,
} from '../../src/adapters/db/source-ingest-store';
import { canonicalizeJson } from '../../src/domain/jobs/payloads';

const NOW = 1770000000000;
const SOURCE = 'playstation_blog';
const KEY = 'sources.poll:identity';
const PAYLOAD = canonicalizeJson({ sourceId: SOURCE, scheduledForMs: 0 });
const db = createDbExecutor(env.DB);

beforeEach(async () => {
  await applyMigrations(env.DB, ROUND19_MIGRATION_PLAN);
  for (const t of ['source_items', 'source_state', 'sources', 'jobs', 'budgets'])
    await db.run({ sql: `DELETE FROM ${t}` });
  await db.run({ sql: "UPDATE schema_metadata SET value='4' WHERE key='schema_version'" });
  const reg = parseEmbeddedRegistry();
  if (!reg.ok) throw new Error('fixture registry');
  await seedSourcesFromRegistry(db, reg.registry, NOW);
});

/**
 * Insert a same-key row with a controlled durable identity.
 * `aggregateId` / `aggregateType` default to the legitimate values.
 */
async function insertSameKeyRow(input: {
  id: string;
  status: string;
  aggregateId?: string;
  aggregateType?: string;
}): Promise<void> {
  await db.run({
    sql: `INSERT INTO jobs(id,type,aggregate_type,aggregate_id,status,priority,run_after,attempts,max_attempts,idempotency_key,payload_json,created_at,updated_at)
          VALUES(?, 'sources.fetch_poll', ?, ?, ?, 40, ?, 0, 3, ?, ?, ?, ?)`,
    params: [
      input.id,
      input.aggregateType ?? 'source',
      input.aggregateId ?? SOURCE,
      input.status,
      NOW,
      KEY,
      PAYLOAD,
      NOW,
      NOW,
    ],
  });
}

/** Contender input whose window identity matches KEY/PAYLOAD/SOURCE exactly. */
const contenderInput = {
  sourceId: SOURCE,
  scheduledForMs: 0,
  idempotencyKey: KEY,
  canonicalPayloadJson: PAYLOAD,
  jobId: 'contender',
  priority: 40,
  maxAttempts: 3,
  nowMs: NOW,
};

const foreignRow = () =>
  db.first<{ id: string; status: string; aggregate_id: string; aggregate_type: string }>({
    sql: 'SELECT id, status, aggregate_id, aggregate_type FROM jobs WHERE idempotency_key = ?',
    params: [KEY],
  });

const stateRow = () =>
  db.first<{
    next_poll_at: number;
    poll_owner_job_id: string | null;
    last_error: string | null;
  }>({
    sql: 'SELECT next_poll_at, poll_owner_job_id, last_error FROM source_state WHERE source_id = ?',
    params: [SOURCE],
  });

it('R191-F1: a same-key NONTERMINAL row with a foreign aggregate id is foreign, never the owner of this window (CE5)', async () => {
  await insertSameKeyRow({ id: 'foreign-row', status: 'pending', aggregateId: 'xbox_wire' });
  const before = await stateRow();
  const result = await schedulePollWindowOwned(db, contenderInput, 300);
  expect(result).toEqual({ kind: 'foreign_window_job', foreignJobId: 'foreign-row' });
  // No auto-cancel/delete/transfer: the foreign row is untouched…
  expect(await foreignRow()).toEqual({
    id: 'foreign-row',
    status: 'pending',
    aggregate_id: 'xbox_wire',
    aggregate_type: 'source',
  });
  // …and the window/ownership state is untouched.
  expect(await stateRow()).toEqual(before);
});

it('R191-F2: a same-key NONTERMINAL row with a foreign aggregate TYPE is foreign (complete identity, not just type+payload)', async () => {
  await insertSameKeyRow({ id: 'foreign-row', status: 'claimed', aggregateType: 'telegram' });
  const before = await stateRow();
  const result = await schedulePollWindowOwned(db, contenderInput, 300);
  expect(result).toEqual({ kind: 'foreign_window_job', foreignJobId: 'foreign-row' });
  expect(await foreignRow()).toEqual({
    id: 'foreign-row',
    status: 'claimed',
    aggregate_id: SOURCE,
    aggregate_type: 'telegram',
  });
  expect(await stateRow()).toEqual(before);
});

it('R191-F3: a TERMINAL row with a foreign aggregate id is foreign, never a silent marker_moved', async () => {
  await insertSameKeyRow({ id: 'foreign-row', status: 'succeeded', aggregateId: 'xbox_wire' });
  const before = await stateRow();
  const result = await schedulePollWindowOwned(db, contenderInput, 300);
  expect(result).toEqual({ kind: 'foreign_window_job', foreignJobId: 'foreign-row' });
  const row = await foreignRow();
  expect(row!.status).toBe('succeeded'); // terminal foreign row untouched, never deleted
  expect(await stateRow()).toEqual(before);
});

it('R191-F4: a TERMINAL row with a foreign aggregate TYPE is foreign, never a silent marker_moved', async () => {
  await insertSameKeyRow({ id: 'foreign-row', status: 'failed', aggregateType: 'telegram' });
  const before = await stateRow();
  const result = await schedulePollWindowOwned(db, contenderInput, 300);
  expect(result).toEqual({ kind: 'foreign_window_job', foreignJobId: 'foreign-row' });
  expect(await stateRow()).toEqual(before);
});

it('R191-F5 CONTROL: a legitimate same-identity NONTERMINAL row still owns the window (unchanged classification)', async () => {
  await insertSameKeyRow({ id: 'same-row', status: 'pending' });
  const result = await schedulePollWindowOwned(db, contenderInput, 300);
  expect(result).toEqual({ kind: 'outstanding_job_owns_window', jobId: 'same-row' });
});

it('R191-F6 CONTROL: a legitimate TERMINAL same-identity row still remediates the consumed window (S3 unchanged)', async () => {
  await insertSameKeyRow({ id: 'same-row', status: 'succeeded' });
  // Window at the scanned marker, unowned — exactly the S3 preconditions.
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at=0, poll_owner_job_id=NULL WHERE source_id=?',
    params: [SOURCE],
  });
  const result = await schedulePollWindowOwned(db, contenderInput, 300);
  expect(result).toEqual({
    kind: 'window_terminal_skipped',
    terminalJobId: 'same-row',
    nextPollAtMs: NOW + 300 * 1000,
  });
  const after = await stateRow();
  expect(after!.next_poll_at).toBe(NOW + 300 * 1000);
  expect(after!.last_error).toBe(POLL_WINDOW_TERMINAL_REASON);
});

it('R191-F7 CONTROL: a legitimate TERMINAL same-identity row with a moved marker still classifies marker_moved (unchanged)', async () => {
  await insertSameKeyRow({ id: 'same-row', status: 'succeeded' });
  // The marker already moved past the scanned value: S2/S3 both write 0
  // rows and the complete-identity read still matches → marker_moved.
  await db.run({
    sql: 'UPDATE source_state SET next_poll_at=?, poll_owner_job_id=NULL WHERE source_id=?',
    params: [NOW + 999, SOURCE],
  });
  const result = await schedulePollWindowOwned(db, contenderInput, 300);
  expect(result).toEqual({ kind: 'marker_moved' });
});
