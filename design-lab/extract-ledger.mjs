#!/usr/bin/env node
/**
 * R1.10.3 DESIGN LAB — ledger extractor.
 *
 * Parses a RAW vitest run log for `LABLEDGER[{...}]` console lines and
 * writes design-lab/cost-ledger.json. The ledger file in the delivery is
 * the EXACT extraction of the bound run log (logs/2x-design-lab-run.log);
 * re-running the documented command + this script regenerates it.
 *
 * Usage: node design-lab/extract-ledger.mjs <raw-run-log> [out-json]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , logPath, outPath = 'design-lab/cost-ledger.json'] = process.argv;
if (!logPath) {
  // eslint-disable-next-line no-console -- Node CLI tool; console IS its output channel (same exemption class as scripts/**/*.mjs)
  console.error('usage: node design-lab/extract-ledger.mjs <raw-run-log> [out-json]');
  process.exit(2);
}
const text = readFileSync(logPath, 'utf8');
const rows = [];
for (const line of text.split('\n')) {
  const start = line.indexOf('LABLEDGER[');
  if (start === -1) continue;
  const json = line.slice(start + 'LABLEDGER['.length, line.lastIndexOf(']'));
  try {
    rows.push(JSON.parse(json));
  } catch (error) {
    // eslint-disable-next-line no-console -- Node CLI tool; console IS its output channel
    console.error(`unparsable ledger line ignored: ${error.message}`);
  }
}
const out = {
  class:
    'DESIGN-LAB measured cost ledger — LOCAL workerd proxy units; NOT cloud quota/CPU/billing evidence',
  instrument: 'audit-tools/trace/d1-instrument.ts v3 (R112-03 corrected units)',
  firstProfileTarget: { executionApiCallAttemptsMax: 40, statementsAttemptedMax: 40 },
  rows,
};
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
// eslint-disable-next-line no-console -- Node CLI tool; console IS its output channel
console.log(`extracted ${rows.length} ledger rows -> ${outPath}`);
