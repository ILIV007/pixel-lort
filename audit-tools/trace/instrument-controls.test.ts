/**
 * R1.10.3 AUDIT TOOLING — instrument unit controls (NOT accepted source).
 *
 * C-01…C-09 pin the CORRECTED counter semantics required by R1.10.2 TR-01
 * (unchanged semantics; R112-03 field renames only: the all-result
 * unavailable total now lives at `stats.metaAggregates.unavailableTotal`).
 * C-10…C-16 are NEW R1.10.3 controls pinning the R112-03 corrections:
 * failed-batch statements are NOT completed (C-10), mixed success/failure
 * sequences (C-11), reset (C-12), snapshot isolation (C-13), reservoir
 * saturation without retained-record mutation (C-14), complete all-result
 * aggregates under truncation (C-15), and the conservative gap label
 * (C-16).
 * These counts are TOOL-TEST counts — never added to the accepted product
 * suite's 1142 and never mixed with the trace-suite invocation counts.
 *
 * Cross-check anchor: the manager's independent C1 control (manager-evidence/
 * probes/manager.test.ts, run against the ORIGINAL R1.10.1 wrapper) proved
 * prepare-is-not-execution on the OLD stats shape. C-01/C-02/C-03/C-04 below
 * re-prove the same three facts against THIS corrected wrapper and its
 * honest unit vocabulary.
 *
 * HONESTY LABELS: local workerd + disposable D1 only; proves nothing about
 * cloud quotas; no product source is imported here except through the
 * wrapper under test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createD1Stats,
  deriveCounts,
  instrumentD1,
  resetStats,
  snapshot,
  type D1Stats,
} from './d1-instrument';

let stats: D1Stats;
let wrapped: D1Database;
const rawDb = () => env.DB as D1Database;

beforeEach(() => {
  stats = createD1Stats();
  wrapped = instrumentD1(rawDb(), stats);
});

afterEach(() => {
  resetStats(stats);
});

describe('R1.10.2 D1 instrument unit controls (audit tooling — outside accepted source)', () => {
  it('C-01 an UNUSED prepare is construction only: prepares=1, zero execution-API calls', async () => {
    wrapped.prepare('SELECT 1');
    const d = deriveCounts(stats);
    expect(stats.prepares).toBe(1);
    expect(stats.terminalAttempts).toBe(0);
    expect(stats.batchAttempts).toBe(0);
    expect(d.executionApiCallAttempts).toBe(0);
    expect(d.executionApiCallsCompleted).toBe(0);
    console.log('CONTROL[C-01]', JSON.stringify({ prepares: stats.prepares, ...d }));
  });

  it('C-02 a 2-statement batch is ONE execution-API call carrying TWO statements; EVERY result metadata captured', async () => {
    const a = wrapped.prepare('SELECT 1 AS x');
    const b = wrapped.prepare('SELECT 2 AS y');
    const results = await wrapped.batch([a, b]);
    expect(results.length).toBe(2);
    const d = deriveCounts(stats);
    expect(stats.prepares).toBe(2);
    expect(stats.batchAttempts).toBe(1);
    expect(stats.batchStatements).toBe(2);
    expect(d.executionApiCallAttempts).toBe(1);
    expect(d.statementsAttempted).toBe(2);
    expect(stats.batchResultRecords).toBe(2);
    // TR-01 fix: EVERY batch result metadata is captured (v1 kept only result[0]).
    expect(d.metaRecordsAvailable).toBe(2);
    expect(stats.metaRecords.filter((m) => m.origin === 'batch')).toHaveLength(2);
    console.log(
      'CONTROL[C-02]',
      JSON.stringify({
        prepares: stats.prepares,
        batches: stats.batchAttempts,
        batchStatements: stats.batchStatements,
        ...d,
      }),
    );
  });

  it('C-03 one REUSED prepared statement executed twice = prepares 1, terminal attempts 2', async () => {
    const s = wrapped.prepare('SELECT 41 AS v');
    await s.all();
    await s.all();
    const d = deriveCounts(stats);
    expect(stats.prepares).toBe(1);
    expect(stats.terminalAttempts).toBe(2);
    expect(stats.terminalCompleted).toBe(2);
    expect(d.executionApiCallAttempts).toBe(2);
    expect(d.statementsAttempted).toBe(2);
    console.log(
      'CONTROL[C-03]',
      JSON.stringify({ prepares: stats.prepares, terminalAttempts: stats.terminalAttempts, ...d }),
    );
  });

  it('C-04 bind identity is preserved through the wrapper (terminal + batch paths)', async () => {
    // Terminal path: bound value round-trips.
    const s = wrapped.prepare('SELECT ?1 AS v');
    const bound = s.bind('TRACE-BIND-42');
    const r1 = await bound.first<{ v: string }>();
    expect(r1?.v).toBe('TRACE-BIND-42');
    // Batch path: bound statements unwrap to the ORIGINAL underlying
    // statements; results reflect the SAME binds.
    const b1 = wrapped.prepare('SELECT ?1 AS v').bind('TRACE-BIND-A');
    const b2 = wrapped.prepare('SELECT ?1 AS v').bind('TRACE-BIND-B');
    const results = await wrapped.batch([b1, b2]);
    const rows = results.map((r) => (r as { results: { v: string }[] }).results[0]?.v);
    expect(rows).toEqual(['TRACE-BIND-A', 'TRACE-BIND-B']);
    console.log(
      'CONTROL[C-04]',
      JSON.stringify({
        terminalRows: ['TRACE-BIND-42'],
        batchRows: rows,
        prepares: stats.prepares,
        batches: stats.batchAttempts,
      }),
    );
  });

  it('C-05 failures are counted as attempted+failed and never silently dropped; no metadata invented', async () => {
    const s = wrapped.prepare('SELECT * FROM __definitely_missing_table_1102__');
    await expect(s.all()).rejects.toBeTruthy();
    const d1 = deriveCounts(stats);
    expect(stats.terminalAttempts).toBe(1);
    expect(stats.terminalFailed).toBe(1);
    expect(stats.terminalCompleted).toBe(0);
    expect(d1.executionApiCallAttempts).toBe(1);
    expect(d1.executionApiCallsFailed).toBe(1);
    expect(d1.metaRecordsAvailable).toBe(0);
    // Failed batch: one failed execution-API call; statements submitted counted.
    const p1 = wrapped.prepare('SELECT 1');
    await expect(wrapped.batch([p1, wrapped.prepare('SELECT * FROM __also_missing_1102__')]))
      .rejects.toBeTruthy();
    const d2 = deriveCounts(stats);
    expect(stats.batchAttempts).toBe(1);
    expect(stats.batchFailed).toBe(1);
    expect(stats.batchStatements).toBe(2);
    expect(d2.executionApiCallAttempts).toBe(2); // 1 failed terminal + 1 failed batch
    console.log(
      'CONTROL[C-05]',
      JSON.stringify({
        terminalAttempts: stats.terminalAttempts,
        terminalFailed: stats.terminalFailed,
        batchAttempts: stats.batchAttempts,
        batchFailed: stats.batchFailed,
        batchStatements: stats.batchStatements,
        ...d2,
      }),
    );
  });

  it('C-06 NON-instrumented fixture probes never move the counters', async () => {
    await rawDb().prepare('SELECT 1').all();
    await rawDb().prepare('CREATE TABLE IF NOT EXISTS __probe_1102__ (x TEXT)').run();
    await rawDb().prepare('INSERT INTO __probe_1102__ (x) VALUES (?)').bind('raw').run();
    await rawDb().prepare('SELECT x FROM __probe_1102__').all();
    await rawDb().prepare('DROP TABLE __probe_1102__').run();
    expect(stats.prepares).toBe(0);
    expect(stats.terminalAttempts).toBe(0);
    expect(stats.batchAttempts).toBe(0);
    expect(deriveCounts(stats).executionApiCallAttempts).toBe(0);
    console.log('CONTROL[C-06]', JSON.stringify({ allCountersZero: true }));
  });

  it('C-07 metadata that is unavailable is LABELED unavailable, never zero-filled', async () => {
    // Direct .first(): workerd returns the row itself (no meta object) —
    // the record must say UNAVAILABLE, not zero.
    const s = wrapped.prepare('SELECT 7 AS v');
    const row = await s.first<{ v: number }>();
    expect(row?.v).toBe(7);
    expect(stats.metaRecords.length).toBe(1);
    expect(stats.metaRecords[0]?.hasRawMeta).toBe(false);
    // R112-03 v3: the all-result unavailable total (was metaUnavailableCount).
    expect(stats.metaAggregates.unavailableTotal).toBe(1);
    // .all() via the same instrument DOES expose meta on workerd.
    await wrapped.prepare('SELECT 8 AS v').all();
    expect(stats.metaRecords[1]?.hasRawMeta).toBe(true);
    // A .first() on an empty result: null row → unavailable, labeled.
    await wrapped.prepare('SELECT 9 AS v WHERE 1 = 0').first();
    expect(stats.metaAggregates.unavailableTotal).toBe(2);
    console.log(
      'CONTROL[C-07]',
      JSON.stringify({
        metaRecords: snapshot(stats).metaRecords.map((m) => ({
          origin: m.origin,
          method: m.method,
          hasRawMeta: m.hasRawMeta,
          unavailableReason: m.unavailableReason ?? null,
        })),
        metaUnavailableTotal: stats.metaAggregates.unavailableTotal,
      }),
    );
  });

  it('C-08 raw() is counted as a terminal attempt with honest metadata labeling', async () => {
    const s = wrapped.prepare('SELECT 1 UNION ALL SELECT 2');
    const rawResult = await (s as unknown as { raw: () => Promise<unknown> }).raw();
    expect(stats.terminalByMethod.raw.attempts).toBe(1);
    expect(stats.terminalCompleted).toBe(1);
    // Honest either way: meta present (captured) OR labeled unavailable.
    const m = stats.metaRecords[0];
    expect(m?.method).toBe('raw');
    if (m?.hasRawMeta === false) {
      expect(stats.metaAggregates.unavailableTotal).toBe(1);
      expect(m.unavailableReason).toBeTruthy();
    }
    console.log(
      'CONTROL[C-08]',
      JSON.stringify({
        rawAttempted: 1,
        metaAvailable: m?.hasRawMeta === true,
        metaUnavailableTotal: stats.metaAggregates.unavailableTotal,
        resultKind: Array.isArray(rawResult) ? 'array' : typeof rawResult,
      }),
    );
  });

  it('C-09 declared unsupported surfaces (exec/withSession) pass through uncounted', () => {
    expect(stats.prepares).toBe(0);
    // The surfaces exist on the binding (passthrough), are named in the
    // instrument header as unsupported, and calling prepare remains the
    // only counted construction path.
    expect(typeof (wrapped as { withSession?: unknown }).withSession).not.toBe('undefined');
    expect(typeof (wrapped as { exec?: unknown }).exec).toBe('function');
    wrapped.prepare('SELECT 1');
    expect(stats.prepares).toBe(1);
    expect(deriveCounts(stats).executionApiCallAttempts).toBe(0);
    console.log('CONTROL[C-09]', JSON.stringify({ passthroughDeclared: true, prepares: 1 }));
  });

  // ---------------------------------------------------------------------
  // R1.10.3 — R112-03 corrections (new controls; semantics pinned on the
  // SAME real workerd D1). These mirror the manager's frozen CE1/CE3
  // probes and extend them with reset/snapshot/mixed-sequence coverage.
  // ---------------------------------------------------------------------

  it('C-10 a FAILED batch completes NOTHING: submitted statements stay attempted-but-unconfirmed (R112-03/CE1)', async () => {
    await rawDb()
      .prepare('CREATE TABLE IF NOT EXISTS __r1103_probe__ (id TEXT PRIMARY KEY NOT NULL, v TEXT)')
      .run();
    await rawDb().prepare('DELETE FROM __r1103_probe__').run();
    // One valid INSERT + one PRIMARY-KEY collision → UNIQUE constraint →
    // whole batch rolls back (same accepted rollback trigger family as the
    // manager's CE1 NOT NULL violation).
    await expect(
      wrapped.batch([
        wrapped.prepare("INSERT INTO __r1103_probe__ (id, v) VALUES ('ok', 'a')"),
        wrapped.prepare("INSERT INTO __r1103_probe__ (id, v) VALUES ('ok', 'b')"), // PK collision
      ]),
    ).rejects.toBeTruthy();
    const d = deriveCounts(stats);
    expect(stats.batchAttempts).toBe(1);
    expect(stats.batchFailed).toBe(1);
    expect(stats.batchCompleted).toBe(0);
    expect(stats.batchStatements).toBe(2);
    expect(stats.batchStatementsCompleted).toBe(0); // R112-03: the fix
    expect(d.executionApiCallAttempts).toBe(1);
    expect(d.executionApiCallsCompleted).toBe(0);
    expect(d.executionApiCallsFailed).toBe(1);
    expect(d.statementsAttempted).toBe(2);
    expect(d.statementsCompleted).toBe(0); // was 2 under v2 — the reported bug
    expect(d.statementsNotConfirmedCompleted).toBe(2); // UNKNOWN outcome, labeled
    // Durable proof: the valid INSERT is NOT visible — the transaction rolled back.
    const rows = await rawDb().prepare('SELECT id FROM __r1103_probe__').all();
    expect(rows.results).toEqual([]);
    console.log('CONTROL[C-10]', JSON.stringify({ ...d, durableRows: rows.results.length }));
  });

  it('C-11 MIXED success/failure sequence: only completed units count as completed (R112-03)', async () => {
    await rawDb()
      .prepare('CREATE TABLE IF NOT EXISTS __r1103_mixed__ (id TEXT PRIMARY KEY)')
      .run();
    await rawDb().prepare('DELETE FROM __r1103_mixed__').run();
    // Batch 1 succeeds: 3 statements.
    await wrapped.batch([
      wrapped.prepare("INSERT INTO __r1103_mixed__ (id) VALUES ('a')"),
      wrapped.prepare("INSERT INTO __r1103_mixed__ (id) VALUES ('b')"),
      wrapped.prepare("INSERT INTO __r1103_mixed__ (id) VALUES ('c')"),
    ]);
    // Terminal fails.
    await expect(wrapped.prepare('SELECT * FROM __also_missing_1103__').all()).rejects.toBeTruthy();
    // Batch 2 fails: 2 submitted statements roll back (PK collision).
    await expect(
      wrapped.batch([
        wrapped.prepare("INSERT INTO __r1103_mixed__ (id) VALUES ('d')"),
        wrapped.prepare("INSERT INTO __r1103_mixed__ (id) VALUES ('a')"), // collides with batch-1 row
      ]),
    ).rejects.toBeTruthy();
    // Terminal succeeds after the failure.
    await wrapped.prepare('SELECT COUNT(*) AS n FROM __r1103_mixed__').first();
    const d = deriveCounts(stats);
    expect(d.executionApiCallAttempts).toBe(4); // batch + terminal + batch + terminal
    expect(d.executionApiCallsCompleted).toBe(2);
    expect(d.executionApiCallsFailed).toBe(2);
    expect(d.statementsAttempted).toBe(3 + 1 + 2 + 1);
    expect(d.statementsCompleted).toBe(3 + 1); // batch1 statements + final terminal ONLY
    expect(d.statementsNotConfirmedCompleted).toBe(3); // failed terminal + failed batch's 2
    expect(stats.batchStatementsCompleted).toBe(3);
    console.log('CONTROL[C-11]', JSON.stringify(d));
  });

  it('C-12 resetStats restores ALL v3 counters including batchStatementsCompleted, reservoir and aggregates', async () => {
    await wrapped.batch([wrapped.prepare('SELECT 1'), wrapped.prepare('SELECT 2')]);
    await wrapped.prepare('SELECT 3').all();
    expect(stats.batchStatementsCompleted).toBe(2);
    expect(stats.metaAggregates.availableTotal).toBe(3);
    resetStats(stats);
    const d = deriveCounts(stats);
    expect(stats.batchStatements).toBe(0);
    expect(stats.batchStatementsCompleted).toBe(0);
    expect(stats.metaRecords.length).toBe(0);
    expect(stats.metaDroppedFromReservoir).toBe(0);
    expect(stats.metaAggregates.availableTotal).toBe(0);
    expect(stats.metaAggregates.unavailableTotal).toBe(0);
    expect(stats.metaAggregates.sums.rowsWritten).toBe(0);
    expect(d.statementsAttempted).toBe(0);
    expect(d.statementsCompleted).toBe(0);
    expect(d.statementsNotConfirmedCompleted).toBe(0);
    console.log('CONTROL[C-12]', JSON.stringify({ resetAllZero: true }));
  });

  it('C-13 snapshot deep-copies v3 fields; later mutations never leak into the snapshot', async () => {
    await wrapped.batch([wrapped.prepare('SELECT 1'), wrapped.prepare('SELECT 2')]);
    const snap = snapshot(stats);
    expect(snap.batchStatementsCompleted).toBe(2);
    expect(snap.metaAggregates.availableTotal).toBe(2);
    // Mutate the live stats afterwards.
    await wrapped.prepare('SELECT 3').all();
    await wrapped.batch([wrapped.prepare('SELECT 4')]);
    expect(snap.batchStatementsCompleted).toBe(2); // unchanged
    expect(snap.metaAggregates.availableTotal).toBe(2); // unchanged
    expect(snap.metaRecords.length).toBe(2); // unchanged
    expect(stats.batchStatementsCompleted).toBe(3); // live moved on
    console.log(
      'CONTROL[C-13]',
      JSON.stringify({
        snapBatchStmtsCompleted: snap.batchStatementsCompleted,
        liveBatchStmtsCompleted: stats.batchStatementsCompleted,
      }),
    );
  });

  it('C-14 reservoir saturation NEVER rewrites a retained record; the overflow is counted (R112-03/CE3)', async () => {
    // Fake binding exercises ONLY instrument-memory behavior (no quota claim),
    // mirroring the manager's CE3 construction: result #4096 has NO meta,
    // every other result carries rows_written.
    let value = 0;
    const fake = {
      prepare() {
        return {
          async run() {
            value += 1;
            return value === 4096 ? { success: true } : { success: true, meta: { rows_written: value } };
          },
        };
      },
    } as unknown as D1Database;
    const s = createD1Stats();
    const w = instrumentD1(fake, s);
    for (let i = 0; i < 4097; i += 1) await w.prepare('FAKE').run();
    const d = deriveCounts(s);
    expect(s.terminalCompleted).toBe(4097);
    expect(s.metaRecords.length).toBe(4096); // reservoir full
    expect(d.metaReservoirDropped).toBe(1); // result 4097 dropped, counted
    expect(d.metaReservoirTruncated).toBe(true);
    // The LAST RETAINED record is result #4096's OWN record: no meta
    // (unavailable) — result #4097's metadata was NEVER written onto it
    // (v2 bug: it landed there; R112-03 forbids retained-record mutation).
    const lastRetained = s.metaRecords[s.metaRecords.length - 1];
    expect(lastRetained?.hasRawMeta).toBe(false);
    expect(lastRetained?.rowsWritten).toBeUndefined();
    // Record #4095 (retained earlier) still carries ITS OWN rowsWritten=4095.
    expect(s.metaRecords[4094]?.rowsWritten).toBe(4095);
    // Complete all-result aggregates: available = 4095 + the dropped #4097.
    expect(d.metaRecordsAvailable).toBe(4096);
    expect(d.metaRecordsUnavailable).toBe(1);
    expect(s.metaAggregates.presence.rowsWritten).toBe(4096);
    expect(s.metaAggregates.sums.rowsWritten).toBe(4095 * 4096 / 2 + 4097); // 1..4095 + 4097
    console.log(
      'CONTROL[C-14]',
      JSON.stringify({
        completed: s.terminalCompleted,
        retainedRecords: s.metaRecords.length,
        dropped: d.metaReservoirDropped,
        lastRetainedHasMeta: lastRetained?.hasRawMeta ?? null,
        availableTotal: d.metaRecordsAvailable,
      }),
    );
  });

  it('C-15 aggregate sums stay COMPLETE when the reservoir truncates; retained detail is bounded and labeled', async () => {
    let n = 0;
    const fake = {
      prepare() {
        return {
          async run() {
            n += 1;
            return { success: true, meta: { rows_written: n, changes: 1, duration: 0.5 } };
          },
        };
      },
    } as unknown as D1Database;
    const s = createD1Stats();
    const w = instrumentD1(fake, s);
    const total = 5000; // beyond the 4096 reservoir
    for (let i = 0; i < total; i += 1) await w.prepare('FAKE').run();
    const d = deriveCounts(s);
    expect(s.metaRecords.length).toBe(4096);
    expect(d.metaReservoirDropped).toBe(total - 4096);
    // Complete totals over ALL results, not just the retained prefix.
    expect(d.metaRecordsAvailable).toBe(total);
    expect(d.metaRecordsUnavailable).toBe(0);
    expect(s.metaAggregates.sums.rowsWritten).toBe((total * (total + 1)) / 2);
    expect(s.metaAggregates.presence.rowsWritten).toBe(total);
    expect(s.metaAggregates.sums.changes).toBe(total);
    expect(s.metaAggregates.sums.durationMs).toBeCloseTo(total * 0.5, 5);
    console.log(
      'CONTROL[C-15]',
      JSON.stringify({
        total,
        retained: s.metaRecords.length,
        dropped: d.metaReservoirDropped,
        sumsComplete: true,
      }),
    );
  });

  it('C-16 the completed/unconfirmed gap is exposed and labeled UNKNOWN — never renamed to failed', async () => {
    await expect(
      wrapped.batch([wrapped.prepare('SELECT * FROM __also_missing_1103__')]),
    ).rejects.toBeTruthy();
    const d = deriveCounts(stats);
    expect(d.statementsAttempted).toBe(1);
    expect(d.statementsCompleted).toBe(0);
    expect(d.statementsNotConfirmedCompleted).toBe(1);
    // The label is part of the derived shape (documented in the header).
    expect(Object.keys(d)).toContain('statementsNotConfirmedCompleted');
    console.log('CONTROL[C-16]', JSON.stringify(d));
  });
});
