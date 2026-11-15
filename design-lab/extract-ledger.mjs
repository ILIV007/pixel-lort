#!/usr/bin/env node
/**
 * R1.10.3 DESIGN LAB — ledger + workload extractor.
 *
 * Parses a RAW vitest run log for `LABLEDGER[{...}]` console lines (the
 * cost-ledger rows), `LABWORKLOAD[{...}]` console lines (the Phase 4.3
 * step 2 REAL-poll-pipeline workload rows) AND `LABSTORAGE[{...}]`
 * console lines (the OD-009 non-destructive storage-measurement rows)
 * and writes them as JSON. The delivered files are the EXACT extractions
 * of the bound run log (logs/3x-design-lab-run.log); re-running the
 * documented command + this script regenerates them.
 *
 * Usage: node design-lab/extract-ledger.mjs <raw-run-log> [ledger-json] [workload-json] [storage-json]
 *   defaults: design-lab/cost-ledger.json design-lab/poll-workload.json design-lab/od009-storage.json
 *   Pass the literal '-' as an output path to SKIP writing that output
 *   (keeps previously extracted files byte-stable when only one surface
 *   is re-extracted).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [
  ,
  ,
  logPath,
  ledgerOut = 'design-lab/cost-ledger.json',
  workloadOut = 'design-lab/poll-workload.json',
  storageOut = 'design-lab/od009-storage.json',
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
const storageRows = extractLines('LABSTORAGE[');

function writeDoc(path, doc) {
  if (path === '-') return;
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

const ledgerDoc = {
  class:
    'DESIGN-LAB measured cost ledger — LOCAL workerd proxy units; NOT cloud quota/CPU/billing evidence',
  instrument: 'audit-tools/trace/d1-instrument.ts v3 (R112-03 corrected units)',
  firstProfileTarget: { executionApiCallAttemptsMax: 40, statementsAttemptedMax: 40 },
  rows: ledgerRows,
};
writeDoc(ledgerOut, ledgerDoc);

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
writeDoc(workloadOut, workloadDoc);

const storageDoc = {
  class:
    'DESIGN-LAB OD-009 non-destructive storage measurement — LOCAL workerd proxy payload bytes; extrapolation rows are ARITHMETIC, NOT cloud storage forecasts; OD-009 stays an OPEN owner decision',
  instrument:
    'SQLite BLOB byte lengths of stored TEXT payload components + PRAGMA page info when available',
  decisionNote:
    'OD-009 (docs/OPEN_DECISIONS.md) remains OPEN: no deletion performed, proposed, or scheduled; these measurements arm the owner decision (Option C: measure first)',
  rows: storageRows,
};
writeDoc(storageOut, storageDoc);

// eslint-disable-next-line no-console -- Node CLI tool; console IS its output channel
console.log(
  `extracted ${ledgerRows.length} ledger rows -> ${ledgerOut}; ${workloadRows.length} workload rows -> ${workloadOut}; ${storageRows.length} storage rows -> ${storageOut}`,
);
