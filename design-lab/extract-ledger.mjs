#!/usr/bin/env node
/**
 * R1.10.3 DESIGN LAB — ledger + workload extractor.
 *
 * Parses a RAW vitest run log for `LABLEDGER[{...}]` console lines (the
 * cost-ledger rows) AND `LABWORKLOAD[{...}]` console lines (the Phase 4.3
 * step 2 REAL-poll-pipeline workload rows) and writes them as JSON. The
 * delivered files are the EXACT extractions of the bound run log
 * (logs/3x-design-lab-run.log); re-running the documented command + this
 * script regenerates them.
 *
 * Usage: node design-lab/extract-ledger.mjs <raw-run-log> [ledger-json] [workload-json]
 *   defaults: design-lab/cost-ledger.json design-lab/poll-workload.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [
  ,
  ,
  logPath,
  ledgerOut = 'design-lab/cost-ledger.json',
  workloadOut = 'design-lab/poll-workload.json',
] = process.argv;
if (!logPath) {
  // eslint-disable-next-line no-console -- Node CLI tool; console IS its output channel (same exemption class as scripts/**/*.mjs)
  console.error(
    'usage: node design-lab/extract-ledger.mjs <raw-run-log> [ledger-json] [workload-json]',
  );
  process.exit(2);
}
const text = readFileSync(logPath, 'utf8');

function extractLines(tag) {
  const rows = [];
  for (const line of text.split('\n')) {
    const start = line.indexOf(tag);
    if (start === -1) continue;
    const json = line.slice(start + tag.length, line.lastIndexOf(']'));
    try {
      rows.push(JSON.parse(json));
    } catch (error) {
      // eslint-disable-next-line no-console -- Node CLI tool; console IS its output channel
      console.error(`unparsable ${tag} line ignored: ${error.message}`);
    }
  }
  return rows;
}

const ledgerRows = extractLines('LABLEDGER[');
const workloadRows = extractLines('LABWORKLOAD[');

const ledgerDoc = {
  class:
    'DESIGN-LAB measured cost ledger — LOCAL workerd proxy units; NOT cloud quota/CPU/billing evidence',
  instrument: 'audit-tools/trace/d1-instrument.ts v3 (R112-03 corrected units)',
  firstProfileTarget: { executionApiCallAttemptsMax: 40, statementsAttemptedMax: 40 },
  rows: ledgerRows,
};
writeFileSync(ledgerOut, `${JSON.stringify(ledgerDoc, null, 2)}\n`);

const workloadDoc = {
  class:
    'DESIGN-LAB Phase 4.3 step 2 REAL-poll-pipeline workload — LOCAL workerd proxy units; wallMsLocal is LOCAL WALL TIME, NOT cloud CPU; sequential consumption is NOT cloud concurrency evidence; NOT cloud quota/billing evidence',
  instrument: 'audit-tools/trace/d1-instrument.ts v3 (R112-03 corrected units)',
  pipeline:
    'REAL end-to-end wiring: scheduleDueSources -> durable job -> dispatchDueJobs -> engine claim -> per-hop authorizeIngestionUnit -> scripted network fake -> REAL RSS connector classification/normalize -> accepted ownership-fenced commit -> job terminal',
  freeQuotaNote:
    'D1 Free row "Queries per Worker invocation = 50": the mapping of LOCAL executionApiCallAttempts onto that quota row is a separate documented question (both interpretations carried in free-plan/ documents); no cloud conclusion is drawn',
  rows: workloadRows,
};
writeFileSync(workloadOut, `${JSON.stringify(workloadDoc, null, 2)}\n`);

// eslint-disable-next-line no-console -- Node CLI tool; console IS its output channel
console.log(
  `extracted ${ledgerRows.length} ledger rows -> ${ledgerOut}; ${workloadRows.length} workload rows -> ${workloadOut}`,
);
