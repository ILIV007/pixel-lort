#!/usr/bin/env node
/**
 * PIXEL R1.10.4.1 — LOCAL-ONLY probe-plan feasibility validator.
 *
 * Proves, from the machine-readable case schedule
 * (audit/PROBE_CASE_SCHEDULE.json) against the ACTUAL repository files:
 *
 *   V-01 schedule structural integrity (ids, order, phase invocation sums)
 *   V-02 bind-formula derivation from design-lab/candidate-sql.ts source
 *   V-03 owned/legacy SQL templates derived from the same source ('?' counts)
 *   V-04 S3 control tier + S4 owned tier on real migrations in local SQLite
 *        (tier boundary proven: owned predicate cannot compile on S3)
 *   V-05 latch-seed.sql AND sources-seed.sql regenerated from the schedule,
 *        byte-identical to the committed files (drift fences)
 *   V-06 per-statement admissibility: every registered statement legal
 *        (owned 11*rows+7 <= 100; legacy 11*rows <= 100); NO 16/32/50-row rungs
 *   V-07 fixtures: exact canonical-URL bytes, distinctness, raw RSS under the
 *        2 MiB feed bound
 *   V-08 reachable gate: aggregate rung-2 payload >= 2x the exact F-CJK batch
 *        payload P_req (the R1.10.4 single-statement ladder defect is closed)
 *   V-09 internal-budget proofs (OversizedRowPlanError arithmetic; the 2-row
 *        conservative chunking boundary behind P-03's 50 INSERTs)
 *   V-10 full local replay of the case schedule against the real S4 schema:
 *        guarded inserts land, the fence blocks wrong generations, the
 *        partial-unique-index negative probe rejects, and the replay executes
 *        EXACTLY the registered statement counts
 *   V-11 resource reconciliation (documented-accounting rows written, MEASURED
 *        local storage growth incl. index amplification) vs caps and docs
 *   V-12 invocation/statement/api-call totals vs registered caps
 *   V-13 conservative rows-read bounds vs the registered cap
 *   V-14 coverage boundary: the static large-single-URL counterexample computes
 *   V-15 plan-document cross-checks (the plan cites the schedule's numbers)
 *   V-16 quota-unit discriminator structure (non-mutating, typed outcomes)
 *   V-17 protected invocation artifacts (latch DDL, kill switch, seeded rows)
 *
 * LOCAL ONLY: node:sqlite + the repository tree. No network, no account
 * operations, no credentials. Local SQLite numbers are feasibility proxies,
 * NOT cloud measurements.
 *
 * Run: node audit-tools/probe-plan/validate-probe-plan.mjs
 *      (Node >= 23.4 for node:sqlite without a flag; on Node 22 run with
 *       node --experimental-sqlite)
 * Optional: --write-seeds regenerates latch-seed.sql and sources-seed.sql
 */

import { readFileSync, writeFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextEncoder } from 'node:util';

const ROOT = new URL('../..', import.meta.url).pathname;
const SCHEDULE_PATH = join(ROOT, 'audit/PROBE_CASE_SCHEDULE.json');
const PLAN_PATH = join(ROOT, 'audit/PREVIEW_RESOURCE_PROBE_PLAN.md');
const LATCH_SEED_PATH = join(ROOT, 'audit-tools/probe-plan/latch-seed.sql');
const SOURCES_SEED_PATH = join(ROOT, 'audit-tools/probe-plan/sources-seed.sql');
const PROBE_DDL_PATH = join(ROOT, 'audit-tools/probe-plan/probe-ddl.sql');
const CANDIDATE_SQL_PATH = join(ROOT, 'design-lab/candidate-sql.ts');

const WRITE_SEEDS = process.argv.includes('--write-seeds');
const out = (s) => process.stdout.write(s + '\n');
const encoder = new TextEncoder();
const byteLen = (s) => encoder.encode(s).length;
const bindBytes = (v) => (typeof v === 'string' ? byteLen(v) : 8);

let failures = 0;
let checkCount = 0;
const report = { checks: [], numbers: {} };
function check(id, name, ok, detail) {
  checkCount += 1;
  out(`${id} ${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` — ${detail}` : ''}`);
  report.checks.push({ id, name, ok, detail });
  if (!ok) failures += 1;
}

// ---------------------------------------------------------------------------
// Load inputs
// ---------------------------------------------------------------------------
const schedule = JSON.parse(readFileSync(SCHEDULE_PATH, 'utf8'));
const candidateSqlText = readFileSync(CANDIDATE_SQL_PATH, 'utf8');
const probeDdlText = readFileSync(PROBE_DDL_PATH, 'utf8');
let planText = null;
try {
  planText = readFileSync(PLAN_PATH, 'utf8');
} catch {
  planText = '';
}

// ---------------------------------------------------------------------------
// V-01 schedule structural integrity
// ---------------------------------------------------------------------------
{
  const caseIds = schedule.cases.map((c) => c.caseId);
  const unique = new Set(caseIds);
  const contiguous = schedule.cases.every((c, i) => c.order === i + 1);
  const phaseSums = {};
  for (const c of schedule.cases) phaseSums[c.phase] = (phaseSums[c.phase] || 0) + c.invocations;
  const total = schedule.cases.reduce((a, c) => a + c.invocations, 0);
  const ok =
    unique.size === caseIds.length &&
    contiguous &&
    phaseSums['G2'] === 1 &&
    phaseSums['G3'] === 18 &&
    phaseSums['G4'] === 1 &&
    total === schedule.caps.invocationsRegistered;
  check(
    'V-01',
    'schedule structural integrity',
    ok,
    `cases=${caseIds.length} unique=${unique.size} contiguous=${contiguous} phaseSums G2:${phaseSums['G2']} G3:${phaseSums['G3']} G4:${phaseSums['G4']} total=${total}/${schedule.caps.invocationsRegistered}`,
  );
  report.numbers.totalInvocations = total;
}

// ---------------------------------------------------------------------------
// V-02 bind-formula derivation from the ACTUAL repo source
// ---------------------------------------------------------------------------
{
  const columnsMatch = candidateSqlText.match(/export const ITEM_VALUE_COLUMNS[^;]*;/s);
  const columnCount = columnsMatch ? (columnsMatch[0].match(/'[^']+'/g) || []).length : -1;
  const ownedShared = Number(
    (candidateSqlText.match(/export const OWNED_SHARED_BINDS\s*=\s*(\d+)/) || [])[1],
  );
  const legacyShared = Number(
    (candidateSqlText.match(/export const LEGACY_SHARED_BINDS\s*=\s*(\d+)/) || [])[1],
  );
  const maxBinds = Number(
    (candidateSqlText.match(/export const MAX_BOUND_PARAMS\s*=\s*(\d+)/) || [])[1],
  );
  const budgetExpr = (candidateSqlText.match(
    /export const MAX_SQL_STATEMENT_BYTES\s*=\s*([^;]+);/,
  ) || [])[1];
  let maxBytes = -1;
  if (budgetExpr) {
    const mul = budgetExpr.match(/(\d+)\s*\*\s*(\d+)/);
    maxBytes = mul ? Number(mul[1]) * Number(mul[2]) : Number(budgetExpr.trim());
  }
  const acc = schedule.accounting;
  const ok =
    columnCount === 11 &&
    ownedShared === 7 &&
    legacyShared === 0 &&
    maxBinds === 100 &&
    maxBytes === 102400 &&
    acc.maxBindsPerStatement === maxBinds &&
    acc.internalCombinedByteBudget === maxBytes &&
    acc.maxOwnedRowsPerStatement === Math.floor((maxBinds - ownedShared) / columnCount) &&
    acc.maxLegacyRowsPerStatement === Math.floor(maxBinds / columnCount);
  check(
    'V-02',
    'bind formula derived from design-lab/candidate-sql.ts (11 values/row + 7 owned guards; <= 100 binds; 102,400-byte budget)',
    ok,
    `ITEM_VALUE_COLUMNS=${columnCount} OWNED_SHARED_BINDS=${ownedShared} LEGACY_SHARED_BINDS=${legacyShared} MAX_BOUND_PARAMS=${maxBinds} MAX_SQL_STATEMENT_BYTES=${maxBytes} => maxOwnedRows=${acc.maxOwnedRowsPerStatement} maxLegacyRows=${acc.maxLegacyRowsPerStatement}`,
  );
}

// ---------------------------------------------------------------------------
// V-03 SQL templates derived from the same source; '?' counts match formulas
// ---------------------------------------------------------------------------
function valuesClause(k) {
  const row = `(${Array.from({ length: 11 }, () => '?').join(', ')})`;
  return Array.from({ length: k }, () => row).join(', ');
}
function valueColumnNames() {
  return Array.from({ length: 11 }, (_, i) => `column${i + 1}`).join(', ');
}
function extractTemplate(fnName) {
  const BT = String.fromCharCode(96); // backtick, kept out of nested literals
  const pattern =
    'export function ' +
    fnName +
    '\\(k: number\\): string \\{\\s*return ' +
    BT +
    '([^' +
    BT +
    ']+)' +
    BT +
    ';';
  return candidateSqlText.match(new RegExp(pattern, 's'))?.[1] ?? null;
}
const TARGETED_CONFLICTS =
  candidateSqlText.match(/const TARGETED_CONFLICTS = `([^`]+)`;/s)?.[1] ?? null;
function buildSql(fnName, k) {
  const tpl = extractTemplate(fnName);
  if (!tpl || !TARGETED_CONFLICTS) return null;
  return tpl
    .replace('${valueColumnNames()}', valueColumnNames())
    .replace('${valuesClause(k)}', valuesClause(k))
    .replace('${TARGETED_CONFLICTS}', TARGETED_CONFLICTS);
}
const C_OWNED_STATE_WRITE =
  candidateSqlText.match(/export const C_OWNED_STATE_WRITE = `([^`]+)`;/s)?.[1] ?? null;
const LEGACY_STATE_WRITE =
  candidateSqlText.match(/export const LEGACY_STATE_WRITE = `([^`]+)`;/s)?.[1] ?? null;
{
  let ok = TARGETED_CONFLICTS != null && C_OWNED_STATE_WRITE != null && LEGACY_STATE_WRITE != null;
  const detail = [];
  for (const k of [1, 2, 4, 8, 9]) {
    const owned = buildSql('buildOwnedMultiRowInsertSql', k);
    const legacy = buildSql('buildLegacyMultiRowInsertSql', k);
    if (!owned || !legacy) {
      ok = false;
      detail.push(`template extraction failed at k=${k}`);
      continue;
    }
    const ownedQ = (owned.match(/\?/g) || []).length;
    const legacyQ = (legacy.match(/\?/g) || []).length;
    if (ownedQ !== 11 * k + 7 || legacyQ !== 11 * k) {
      ok = false;
      detail.push(
        `k=${k} owned '?'=${ownedQ} (want ${11 * k + 7}), legacy '?'=${legacyQ} (want ${11 * k})`,
      );
    }
  }
  check(
    'V-03',
    "owned/legacy INSERT templates extracted from source; '?' counts = 11k+7 / 11k for k in {1,2,4,8,9}; both fenced state writes extracted",
    ok,
    detail.join('; ') || 'templates OK (owned k=8 -> 95 binds; legacy k=9 -> 99 binds)',
  );
}

// ---------------------------------------------------------------------------
// Statement splitting (CLI statement counts for migrations)
// ---------------------------------------------------------------------------
function splitStatements(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const stripped = noBlock
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
  return stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Fixture builders (per the schedule's registered shapes)
// ---------------------------------------------------------------------------
function cjkRawPath(cjkChars, index) {
  const filler = 'あ'.repeat(Math.max(0, cjkChars - 1));
  const last = String.fromCharCode(0x4e00 + (index % 500));
  return `${filler}${last}`;
}
function cjkCanonicalUrl(host, cjkChars, index) {
  const encoded = [...cjkRawPath(cjkChars, index)].map((c) => encodeURIComponent(c)).join('');
  return `https://${host}/${encoded}`;
}
function asciiCanonicalUrl(host, targetBytes, index) {
  const prefix = `https://${host}/`;
  const tail = `-${index}`;
  return prefix + 'a'.repeat(targetBytes - prefix.length - tail.length) + tail;
}
function buildFixture(fx) {
  const rows = [];
  for (let i = 0; i < fx.items; i += 1) {
    const rv = fx.rowValues;
    const row = {
      id: rv.idPattern.replace('<index>', String(i)),
      externalId: rv.externalIdPattern.replace('<index>', String(i)),
      canonicalUrl: null,
      title: rv.title,
      excerpt: rv.excerpt,
      author: rv.author,
      publishedAt: rv.publishedAt,
      fetchedAt: rv.fetchedAt,
      contentHash: rv.contentHash,
      rawJson: rv.rawJson,
    };
    if (fx.kind === 'ascii') {
      row.canonicalUrl = asciiCanonicalUrl(fx.host, fx.canonicalUrlBytes, i);
    } else if (fx.kind === 'cjk') {
      row.canonicalUrl = cjkCanonicalUrl(fx.host, fx.cjkChars, i);
    } else if (fx.kind === 'cjk-ladder') {
      const cjkChars = fx.cjkCharsBase - Math.floor(i / fx.perStep);
      row.canonicalUrl = cjkCanonicalUrl(fx.host, cjkChars, i % fx.perStep);
    } else if (fx.kind === 'mixed') {
      row.canonicalUrl =
        i < fx.shortItems
          ? asciiCanonicalUrl(fx.host, fx.shortCanonicalUrlBytes, i)
          : cjkCanonicalUrl(fx.host, fx.cjkChars, i - fx.shortItems);
    } else {
      throw new Error(`unknown fixture kind ${fx.kind}`);
    }
    rows.push(row);
  }
  return rows;
}
// 66-byte wrapper; chosen so the static counterexample document computes to
// EXACTLY the reviewer-registered 1,800,116 raw RSS bytes.
const RSS_WRAPPER = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>';
function rssBytes(host, rawPath) {
  return (
    byteLen(RSS_WRAPPER) +
    byteLen('<item><link>') +
    byteLen(`https://${host}/`) +
    byteLen(rawPath) +
    byteLen('</link></item>\n')
  );
}
function fixtureRssBytes(fx, offset, count) {
  let total = byteLen(RSS_WRAPPER);
  for (let i = offset; i < offset + count; i += 1) {
    if (fx.kind === 'cjk') total += rssBytes(fx.host, cjkRawPath(fx.cjkChars, i));
    else if (fx.kind === 'mixed' && i >= fx.shortItems)
      total += rssBytes(fx.host, cjkRawPath(fx.cjkChars, i - fx.shortItems));
    else total += rssBytes(fx.host, `short-${i}`);
  }
  return total;
}

// ---------------------------------------------------------------------------
// V-07 fixtures: exact bytes, distinctness, raw RSS under the feed bound
// ---------------------------------------------------------------------------
const fixtures = {};
{
  let ok = true;
  const detail = [];
  for (const fx of schedule.fixtures) {
    const rows = buildFixture(fx);
    const urls = rows.map((r) => r.canonicalUrl);
    const byteSet = [...new Set(urls.map((u) => byteLen(u)))].sort((a, b) => a - b);
    const distinct = new Set(urls).size === urls.length;
    const allUnderRowLimit = urls.every((u) => byteLen(u) <= 2000000);
    if (!distinct || !allUnderRowLimit) {
      ok = false;
      detail.push(`${fx.id}: distinct=${distinct} underRowLimit=${allUnderRowLimit}`);
    }
    const rss = fixtureRssBytes(fx, 0, Math.min(fx.items, 100));
    if ((fx.kind === 'cjk' || fx.kind === 'mixed') && rss >= 2097152) {
      ok = false;
      detail.push(`${fx.id} raw RSS ${rss} >= 2097152`);
    }
    fixtures[fx.id] = { def: fx, rows, urls, byteSet, rss };
    report.numbers[`fixture_${fx.id}`] = {
      items: rows.length,
      canonicalUrlBytes: byteSet,
      rssBytes: rss,
    };
  }
  const fcjk = fixtures['F-CJK'];
  if (!(fcjk.byteSet.length === 1 && fcjk.byteSet[0] === 45023)) {
    ok = false;
    detail.push(`F-CJK bytes != 45023 (${fcjk.byteSet.join(',')})`);
  }
  const fhetero = fixtures['F-HETERO'];
  if (!(
    fhetero.byteSet.length === 2 &&
    fhetero.byteSet.includes(45023) &&
    fhetero.byteSet.includes(2048)
  )) {
    ok = false;
    detail.push(`F-HETERO bytes != {2048,45023} (${fhetero.byteSet.join(',')})`);
  }
  const frowsize = fixtures['F-ROWSIZE'];
  if (!(frowsize.byteSet.length === 1 && frowsize.byteSet[0] === 1899995)) {
    ok = false;
    detail.push(`F-ROWSIZE bytes != 1899995 (${frowsize.byteSet.join(',')})`);
  }
  const oversize = fixtures['F-OVERSIZE'];
  if (!(oversize.byteSet.length === 1 && oversize.byteSet[0] === 102500)) {
    ok = false;
    detail.push(`F-OVERSIZE bytes != 102500 (${oversize.byteSet.join(',')})`);
  }
  const ladder = fixtures['F-CJK-L'];
  if (ladder.urls.length !== 538 || new Set(ladder.urls).size !== 538) {
    ok = false;
    detail.push('F-CJK-L distinct URLs != 538');
  }
  check(
    'V-07',
    'fixtures: exact canonical-URL byte counts (F-CJK 45,023; F-ROWSIZE 1,899,995; F-OVERSIZE 102,500), distinct URLs, raw RSS < 2 MiB feed bound',
    ok,
    detail.join('; ') ||
      `F-CJK RSS=${fcjk.rss} B; F-HETERO RSS=${fixtures['F-HETERO'].rss} B; F-ROWSIZE RSS=${frowsize.rss} B (all < 2,097,152)`,
  );
}

// ---------------------------------------------------------------------------
// V-08 reachable gate: rung-2 aggregate payload >= 2x the F-CJK batch payload
// ---------------------------------------------------------------------------
function rowBindBytesOf(row, sourceId) {
  return (
    bindBytes(row.id) +
    bindBytes(sourceId) +
    bindBytes(row.externalId) +
    bindBytes(row.canonicalUrl) +
    bindBytes(row.title) +
    bindBytes(row.excerpt) +
    bindBytes(row.author) +
    bindBytes(row.publishedAt) +
    bindBytes(row.fetchedAt) +
    bindBytes(row.contentHash) +
    bindBytes(row.rawJson)
  );
}
function guardBindBytes(sourceId, hold, jobId, generation) {
  return (
    bindBytes(sourceId) +
    bindBytes(hold) +
    bindBytes(jobId) +
    bindBytes(jobId) +
    bindBytes(sourceId) +
    bindBytes(generation) +
    bindBytes(sourceId)
  );
}
const HOLD = 4102444800000;
{
  const fcjk = fixtures['F-CJK'];
  const src = 'probe-p-02';
  let pReq = 0;
  for (const r of fcjk.rows.slice(0, 100)) pReq += rowBindBytesOf(r, src);
  pReq += 13 * guardBindBytes(src, HOLD, 'job-p-02-1', 1);
  const ladder = fixtures['F-CJK-L'];
  const lsrc = 'probe-p-01b';
  let p208 = 0;
  for (let i = 122; i < 330; i += 1) p208 += rowBindBytesOf(ladder.rows[i], lsrc);
  p208 += 26 * guardBindBytes(lsrc, HOLD, 'job-p-01b-1', 1);
  const multiple = p208 / pReq;
  const dri = schedule.decisionRuleInputs;
  const ok =
    p208 >= dri.p01bRequiredPayloadMultiple * pReq &&
    dri.p01bMaxRungRows === 208 &&
    dri.p01bMaxRungStatements === 26;
  report.numbers.p_req_bytes = pReq;
  report.numbers.p_208_bytes = p208;
  report.numbers.p_208_multiple_of_p_req = Number(multiple.toFixed(3));
  check(
    'V-08',
    'reachable gate: aggregate rung-2 (26 legal 8-row statements, 208 rows, one db.batch) total bind payload >= 2x the exact F-CJK batch payload P_req — the R1.10.4 single-statement ladder defect (CE1) is closed',
    ok,
    `P_req=${pReq.toLocaleString('en-US')} B; P_208=${p208.toLocaleString('en-US')} B; multiple=${multiple.toFixed(3)}x (rule: >= ${dri.p01bRequiredPayloadMultiple}x)`,
  );
}

// ---------------------------------------------------------------------------
// V-09 internal-budget proofs (OversizedRowPlanError arithmetic)
// ---------------------------------------------------------------------------
{
  const auditOf = (sql, binds) => byteLen(sql) + binds.reduce((a, v) => a + bindBytes(v), 0);
  const ownedSql1 = buildSql('buildOwnedMultiRowInsertSql', 1);
  const guards = (src, job) => [src, HOLD, job, job, src, 1, src];
  const rowBinds = (r, src) => [
    r.id,
    src,
    r.externalId,
    r.canonicalUrl,
    r.title,
    r.excerpt,
    r.author,
    r.publishedAt,
    r.fetchedAt,
    r.contentHash,
    r.rawJson,
  ];
  const oversize = fixtures['F-OVERSIZE'].rows[0];
  const oversizeAudit = auditOf(ownedSql1, [
    ...rowBinds(oversize, 'probe-p-06'),
    ...guards('probe-p-06', 'job-p-06-1'),
  ]);
  const rowsize = fixtures['F-ROWSIZE'].rows[0];
  const rowsizeAudit = auditOf(ownedSql1, [
    ...rowBinds(rowsize, 'probe-p-06b'),
    ...guards('probe-p-06b', 'job-p-06b-1'),
  ]);
  const cjk = fixtures['F-CJK'].rows[0];
  const cjk2 = auditOf(buildSql('buildOwnedMultiRowInsertSql', 2), [
    ...rowBinds(cjk, 'probe-p-03'),
    ...rowBinds({ ...cjk, id: 'x', externalId: 'x' }, 'probe-p-03'),
    ...guards('probe-p-03', 'job-p-03-1'),
  ]);
  const cjk3 = auditOf(buildSql('buildOwnedMultiRowInsertSql', 3), [
    ...rowBinds(cjk, 'probe-p-03'),
    ...rowBinds({ ...cjk, id: 'x', externalId: 'x' }, 'probe-p-03'),
    ...rowBinds({ ...cjk, id: 'y', externalId: 'y' }, 'probe-p-03'),
    ...guards('probe-p-03', 'job-p-03-1'),
  ]);
  const ok =
    oversizeAudit > 102400 &&
    rowsizeAudit > 102400 &&
    byteLen(rowsize.canonicalUrl) < 2000000 &&
    cjk2 <= 102400 &&
    cjk3 > 102400;
  report.numbers.oversize_single_row_audit_bytes = oversizeAudit;
  report.numbers.rowsize_single_row_audit_bytes = rowsizeAudit;
  report.numbers.cjk_2row_audit_bytes = cjk2;
  report.numbers.cjk_3row_audit_bytes = cjk3;
  check(
    'V-09',
    'internal-budget proofs: F-OVERSIZE (102,500 B) and F-ROWSIZE (1,899,995 B) single rows exceed the 102,400-byte budget => plan-time OversizedRowPlanError (F-ROWSIZE still under the documented 2,000,000-byte row limit); F-CJK 2-row statement fits and 3-row does not => P-03 registers exactly 50 INSERTs',
    ok,
    `oversize=${oversizeAudit} rowsize=${rowsizeAudit} (URL ${byteLen(rowsize.canonicalUrl)} B) cjk2row=${cjk2} cjk3row=${cjk3}`,
  );
}

// ---------------------------------------------------------------------------
// Real-schema work: local SQLite databases
// ---------------------------------------------------------------------------
const workDir = join(tmpdir(), `pixel-probe-plan-validator-${Date.now()}`);
mkdirSync(workDir, { recursive: true });
const dbPath = join(workDir, 'replay.db');
let db;
try {
  db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
} catch {
  db = new DatabaseSync(dbPath);
}

const cliStatements = { s3: 0, s4: 0, probeDdl: 0, latchSeed: 0, sourcesSeed: 0 };
for (const rel of schedule.schemas.S3.migrations) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  db.exec(text);
  cliStatements.s3 += splitStatements(text).length;
}
db.exec(probeDdlText);
cliStatements.probeDdl = splitStatements(probeDdlText).length;

function schemaVersion() {
  return Number(
    db.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get().value,
  );
}

// --- V-04a S3 control tier ---
{
  const v3 = schemaVersion();
  const cols = db
    .prepare('PRAGMA table_info(source_state)')
    .all()
    .map((r) => r.name);
  const ownedColS3 = cols.includes('poll_owner_job_id');
  let prepareFailsOnS3 = false;
  try {
    db.prepare('SELECT poll_owner_job_id FROM source_state LIMIT 0');
  } catch {
    prepareFailsOnS3 = true;
  }
  const ok =
    v3 === 3 &&
    cliStatements.s3 === schedule.schemas.S3.statementCount &&
    !ownedColS3 &&
    prepareFailsOnS3;
  check(
    'V-04a',
    'S3 control tier: real migrations 0001-0003 applied to local SQLite (71 statements), schema_version=3, poll_owner_job_id ABSENT, owned compile-probe FAILS to prepare (the CE2 tier boundary is real)',
    ok,
    `version=${v3} statements=${cliStatements.s3}/${schedule.schemas.S3.statementCount} ownedColumn=${ownedColS3} prepareFails=${prepareFailsOnS3}`,
  );
}

// --- Generated seed files (latch + sources) ---
function generateLatchSeed() {
  const lines = [
    '-- PIXEL — PROBE-ONLY latch seeding (R1.10.4.1). GENERATED from',
    '-- audit/PROBE_CASE_SCHEDULE.json by audit-tools/probe-plan/validate-probe-plan.mjs.',
    '-- Applied ONLY to the disposable probe database at G1 (CLI, literal VALUES,',
    "-- no binds). The __global__ row is the kill switch: status = 'aborted'",
    '-- hard-stops every case.',
    '',
    'INSERT INTO probe_run_state',
    '  (case_id, invocations_registered, invocations_used, statements_registered, statements_used, status, last_invocation_at_ms, updated_at_ms)',
    'VALUES',
  ];
  const rows = [['__global__', 0, 0, 'open']];
  for (const c of schedule.cases) {
    rows.push([c.caseId, c.invocations, c.statements.reduce((a, s) => a + s.count, 0), 'open']);
  }
  lines.push(
    ...rows.map(
      (r, i) =>
        `  ('${r[0]}', ${r[1]}, 0, ${r[2]}, 0, '${r[3]}', NULL, 0)${i === rows.length - 1 ? ';' : ','}`,
    ),
  );
  return lines.join('\n') + '\n';
}
function probeSourceIds() {
  const ids = [];
  for (const c of schedule.cases) if (c.sourceId && c.caseId !== 'P-06') ids.push(c.sourceId);
  return [...new Set(ids)];
}
function generateSourcesSeed() {
  const now = 4102444800000;
  const lines = [
    '-- PIXEL — PROBE-ONLY sources seeding (R1.10.4.1). GENERATED from',
    '-- audit/PROBE_CASE_SCHEDULE.json by audit-tools/probe-plan/validate-probe-plan.mjs.',
    '-- Applied ONLY to the disposable probe database at G1 (CLI, literal VALUES,',
    '-- no binds). One sources row per probe case that needs one; sources is',
    '-- unchanged by migration 0004 (S3-compatible).',
    '',
    'INSERT INTO sources',
    '  (id, name, connector, lane, trust_tier, interval_seconds, priority, daily_request_budget, approval_policy, created_at, updated_at)',
    'VALUES',
  ];
  const ids = probeSourceIds();
  lines.push(
    ...ids.map(
      (id, i) =>
        `  ('${id}', 'probe ${id}', 'probe', 'official', 50, 60, 50, 100, 'auto', ${now}, ${now})${i === ids.length - 1 ? ';' : ','}`,
    ),
  );
  return lines.join('\n') + '\n';
}
const latchSeedText = generateLatchSeed();
const sourcesSeedText = generateSourcesSeed();
if (WRITE_SEEDS) {
  writeFileSync(LATCH_SEED_PATH, latchSeedText);
  writeFileSync(SOURCES_SEED_PATH, sourcesSeedText);
}
{
  let latchOk = false;
  let sourcesOk = false;
  try {
    latchOk = readFileSync(LATCH_SEED_PATH, 'utf8') === latchSeedText;
  } catch {
    latchOk = false;
  }
  try {
    sourcesOk = readFileSync(SOURCES_SEED_PATH, 'utf8') === sourcesSeedText;
  } catch {
    sourcesOk = false;
  }
  check(
    'V-05',
    'latch-seed.sql AND sources-seed.sql regenerated from the schedule are byte-identical to the committed files (drift fences)',
    latchOk && sourcesOk,
    `latch rows=${schedule.cases.length + 1} (1 statement); sources rows=${probeSourceIds().length} (1 statement)${latchOk && sourcesOk ? '' : ' — run with --write-seeds'}`,
  );
}
db.exec(latchSeedText);
db.exec(sourcesSeedText);
cliStatements.latchSeed = 1;
cliStatements.sourcesSeed = 1;

// --- Apply 0004 (S4) ---
{
  const text = readFileSync(join(ROOT, 'migrations/0004_source_poll_ownership.sql'), 'utf8');
  db.exec(text);
  cliStatements.s4 = splitStatements(text).length;
}

// --- V-04b S4 owned tier ---
{
  const v4 = schemaVersion();
  const cols = db
    .prepare('PRAGMA table_info(source_state)')
    .all()
    .map((r) => r.name);
  const ownedColS4 = cols.includes('poll_owner_job_id');
  let prepareOkOnS4 = true;
  try {
    db.prepare('SELECT poll_owner_job_id FROM source_state LIMIT 0');
  } catch {
    prepareOkOnS4 = false;
  }
  const idx = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_jobs_source_outstanding_poll'",
    )
    .all();
  const ok =
    v4 === 4 &&
    ownedColS4 &&
    prepareOkOnS4 &&
    idx.length === 1 &&
    cliStatements.s4 === 5 &&
    schedule.schemas.S4.statementCount === cliStatements.s3 + cliStatements.s4 &&
    schedule.cliSetupStatements.total ===
      cliStatements.s3 +
        cliStatements.s4 +
        cliStatements.probeDdl +
        cliStatements.latchSeed +
        cliStatements.sourcesSeed;
  check(
    'V-04b',
    'S4 owned tier: + migration 0004 applied (5 statements), schema_version=4, poll_owner_job_id PRESENT, owned compile-probe prepares, partial unique index exists; CLI setup totals reconcile (79)',
    ok,
    `version=${v4} statements=${cliStatements.s4} index=${idx.length === 1} cliTotal=${cliStatements.s3 + cliStatements.s4 + cliStatements.probeDdl + cliStatements.latchSeed + cliStatements.sourcesSeed}/${schedule.cliSetupStatements.total}`,
  );
}

// ---------------------------------------------------------------------------
// V-06 per-statement admissibility of every registered statement
// ---------------------------------------------------------------------------
function parseChunking(chunking) {
  return (chunking || '').split(';').flatMap((part) => {
    const m = part.trim().match(/^(\d+)x(\d+)$/);
    return Array.from({ length: Number(m?.[1] ?? 0) }, () => Number(m?.[2] ?? 0));
  });
}
{
  let ok = true;
  const detail = [];
  for (const c of schedule.cases) {
    for (const s of c.statements) {
      if (s.kind !== 'multi-row-insert') continue;
      const rungs = s.rungs ?? parseChunking(s.chunking);
      const bindsPer = (row) => (s.form === 'owned' ? 11 * row + 7 : 11 * row);
      const maxRows =
        s.form === 'owned'
          ? schedule.accounting.maxOwnedRowsPerStatement
          : schedule.accounting.maxLegacyRowsPerStatement;
      for (const r of rungs) {
        if (bindsPer(r) > 100 || r > maxRows) {
          ok = false;
          detail.push(`${c.caseId}: illegal ${r}-row ${s.form} statement (${bindsPer(r)} binds)`);
        }
      }
      if (rungs.reduce((a, r) => a + r, 0) !== s.rows || rungs.length !== s.count) {
        ok = false;
        detail.push(
          `${c.caseId}: chunking mismatch (rows ${rungs.reduce((a, r) => a + r, 0)}/${s.rows}; count ${rungs.length}/${s.count})`,
        );
      }
    }
  }
  const scheduleText = JSON.stringify(schedule);
  const illegalRungsPresent = /"(?:16|32|50)"/.test(
    scheduleText.match(/"rungs":\s*\[[^\]]*\]/g)?.join('') || '',
  );
  check(
    'V-06',
    'per-statement admissibility: every registered multi-row statement legal (owned <= 8 rows / 95 binds; legacy <= 9 rows / 99 binds); the illegal 16/32/50-row single statements are GONE (CE1 root cause removed)',
    ok && !illegalRungsPresent,
    detail.join('; ') || 'all registered statements legal',
  );
}

// ---------------------------------------------------------------------------
// Full replay of the case schedule against the real S4 schema
// ---------------------------------------------------------------------------
const NOW = 4102444800001;
function seedJob(jobId, aggregateId, status, attempts) {
  db.prepare(
    'INSERT OR REPLACE INTO jobs (id, type, aggregate_type, aggregate_id, status, priority, run_after, attempts, max_attempts, idempotency_key, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    jobId,
    'sources.fetch_poll',
    'source',
    aggregateId,
    status,
    50,
    NOW - 1000,
    attempts,
    3,
    `idem-${jobId}`,
    '{}',
    NOW - 2000,
    NOW - 1000,
  );
}
function seedSourceState(sourceId, jobId) {
  db.prepare(
    'INSERT OR REPLACE INTO source_state (source_id, next_poll_at, poll_owner_job_id, updated_at) VALUES (?, ?, ?, ?)',
  ).run(sourceId, HOLD, jobId ?? null, NOW);
}
function ownedInsertBinds(rows, sourceId, jobId, generation, hold = HOLD) {
  const binds = [];
  for (const r of rows) {
    binds.push(
      r.id,
      sourceId,
      r.externalId,
      r.canonicalUrl,
      r.title,
      r.excerpt,
      r.author,
      r.publishedAt,
      r.fetchedAt,
      r.contentHash,
      r.rawJson,
    );
  }
  binds.push(sourceId, hold, jobId, jobId, sourceId, generation, sourceId);
  return binds;
}

const replay = {
  statementsExecuted: 0,
  localChanges: 0,
  documentedRowsWritten: 0,
  bindPayloadBytes: 0,
  rowsReadBound: 0,
  perCase: [],
};
const ROWS_WRITTEN_MULTIPLIER = {
  'multi-row-insert': 6,
  'seed-job': 4,
  'seed-source-state': 2,
  'ownership-acquire': 2,
  'state-write': 2,
  'job-terminal': 4,
  'engine-claim-cas': 4,
  'latch-increment': 2,
  'negative-probe-insert': 0,
};
function executeStatement(kind, sql, binds, changesExpected) {
  const res = db.prepare(sql).run(...binds);
  replay.statementsExecuted += 1;
  replay.localChanges += res.changes;
  replay.bindPayloadBytes += binds.reduce((a, v) => a + bindBytes(v), 0);
  replay.documentedRowsWritten += res.changes * (ROWS_WRITTEN_MULTIPLIER[kind] ?? 0);
  if (changesExpected != null && res.changes !== changesExpected) {
    throw new Error(`${kind}: changes ${res.changes} != expected ${changesExpected}`);
  }
  return res.changes;
}
const LATCH_SQL = `UPDATE probe_run_state
         SET invocations_used = invocations_used + 1,
             statements_used = statements_used + ?,
             last_invocation_at_ms = ?,
             updated_at_ms = ?
       WHERE case_id = ?
         AND status = 'open'
         AND invocations_used < invocations_registered
         AND NOT EXISTS (SELECT 1 FROM probe_run_state g WHERE g.case_id = '__global__' AND g.status = 'aborted')`;

function rowsForCase(c) {
  const insertEntry = c.statements.find((s) => s.kind === 'multi-row-insert');
  if (!insertEntry) return [];
  const fx = fixtures[c.fixture];
  const offset = c.fixtureOffset || 0;
  const rows = fx.rows.slice(offset, offset + insertEntry.rows);
  if (rows.length !== insertEntry.rows)
    throw new Error(`${c.caseId}: fixture rows ${rows.length} != ${insertEntry.rows}`);
  return rows;
}

const claimSeeded = new Set();
for (const c of schedule.cases) {
  const registeredStatements = c.statements.reduce((a, s) => a + s.count, 0);
  let caseStatements = 0;
  const bump = (n = 1) => {
    caseStatements += n;
  };
  const sourceId = c.sourceId;
  // The job id derives from the SOURCE, not the case id: the P-01b rung
  // invocations share one source ('probe-p-01b') and therefore share the
  // job/state seeded by rung 1 (r2/r3 register no seeds of their own).
  const jobId = `job-${(sourceId ?? c.caseId.toLowerCase()).replace(/^probe-/, '')}-1`;
  // The owned guards fence on the OBSERVED hold. Cases that run the full
  // claim -> ownership-acquire sequence must fence on the POST-acquisition
  // hold (HOLD + 60000); seed-only cases fence on the seeded hold.
  let effectiveHold = HOLD;

  // latch increment first (conservative consumption — replay of the runtime gate)
  const latchChanges = db.prepare(LATCH_SQL).run(registeredStatements, NOW, NOW, c.caseId).changes;
  replay.statementsExecuted += 1;
  replay.localChanges += latchChanges;
  replay.documentedRowsWritten += 2;
  replay.rowsReadBound += 3;
  bump();
  if (latchChanges !== 1) throw new Error(`${c.caseId}: latch refused the invocation`);

  const rows = rowsForCase(c);
  const hasClaim = c.statements.some((s) => s.kind === 'engine-claim-cas');

  for (const s of c.statements) {
    const times = s.kind === 'multi-row-insert' ? 1 : s.count;
    for (let t = 0; t < times; t += 1) {
      switch (s.kind) {
        case 'latch-increment':
          break;
        case 'seed-job': {
          if (c.caseId === 'X-SETUP-S4') {
            seedJob('job-negprobe-1', 'probe-negprobe-agg', 'claimed', 1);
          } else {
            seedJob(jobId, sourceId, hasClaim ? 'queued' : 'claimed', hasClaim ? 0 : 1);
          }
          replay.statementsExecuted += 1;
          replay.localChanges += 1;
          replay.documentedRowsWritten += 4;
          replay.rowsReadBound += 8;
          bump();
          break;
        }
        case 'seed-source-state': {
          if (hasClaim) seedSourceState(sourceId, null);
          else seedSourceState(sourceId, jobId);
          replay.statementsExecuted += 1;
          replay.localChanges += 1;
          replay.documentedRowsWritten += 2;
          replay.rowsReadBound += 4;
          bump();
          break;
        }
        case 'engine-claim-read': {
          db.prepare('SELECT id, status, attempts FROM jobs WHERE id = ?').all(jobId);
          replay.statementsExecuted += 1;
          replay.rowsReadBound += 4;
          bump();
          break;
        }
        case 'engine-claim-cas': {
          executeStatement(
            'engine-claim-cas',
            "UPDATE jobs SET status = 'claimed', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'",
            [NOW, jobId],
            1,
          );
          replay.rowsReadBound += 4;
          claimSeeded.add(c.caseId);
          bump();
          break;
        }
        case 'source-select':
        case 'capability-read':
        case 'authorization':
        case 'budget-readback': {
          db.prepare('SELECT 1').all();
          replay.statementsExecuted += 1;
          replay.rowsReadBound += 4;
          bump();
          break;
        }
        case 'ownership-acquire': {
          executeStatement(
            'ownership-acquire',
            'UPDATE source_state SET next_poll_at = ?, poll_owner_job_id = ?, updated_at = ? WHERE source_id = ? AND next_poll_at = ? AND poll_owner_job_id IS NULL',
            [HOLD + 60000, jobId, NOW, sourceId, HOLD],
            1,
          );
          effectiveHold = HOLD + 60000;
          replay.rowsReadBound += 4;
          bump();
          break;
        }
        case 'classification-lookup': {
          db.prepare('SELECT 1').all();
          replay.statementsExecuted += 1;
          replay.rowsReadBound += 200;
          bump();
          break;
        }
        case 'multi-row-insert': {
          const rungs = s.rungs ?? parseChunking(s.chunking);
          let consumed = 0;
          for (const r of rungs) {
            const chunkRows = rows.slice(consumed, consumed + r);
            consumed += r;
            const sql = buildSql(
              s.form === 'owned' ? 'buildOwnedMultiRowInsertSql' : 'buildLegacyMultiRowInsertSql',
              r,
            );
            const binds =
              s.form === 'owned'
                ? ownedInsertBinds(chunkRows, sourceId, jobId, 1, effectiveHold)
                : ownedInsertBinds(chunkRows, sourceId, jobId, 1, effectiveHold).slice(0, 11 * r);
            executeStatement('multi-row-insert', sql, binds, r);
            replay.rowsReadBound += 3 * r + 6;
            bump();
          }
          break;
        }
        case 'state-write': {
          const owned = c.form === 'owned';
          const sql = owned ? C_OWNED_STATE_WRITE : LEGACY_STATE_WRITE;
          const binds = owned
            ? [
                'cursor-p',
                'etag-p',
                'lm-p',
                HOLD + 120000,
                NOW,
                null,
                null,
                null,
                null,
                0,
                null,
                1,
                '1970-01-01',
                NOW,
                sourceId,
                effectiveHold,
                jobId,
                jobId,
                sourceId,
                1,
              ]
            : [
                'cursor-p',
                'etag-p',
                'lm-p',
                HOLD + 120000,
                NOW,
                null,
                null,
                null,
                null,
                0,
                null,
                1,
                '1970-01-01',
                NOW,
                sourceId,
                effectiveHold,
              ];
          executeStatement('state-write', sql, binds, 1);
          replay.rowsReadBound += 6;
          bump();
          break;
        }
        case 'job-terminal': {
          executeStatement(
            'job-terminal',
            "UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE id = ? AND status = 'claimed'",
            [NOW, jobId],
            1,
          );
          replay.rowsReadBound += 4;
          bump();
          break;
        }
        case 'verify-select': {
          if (c.caseId === 'X-VERIFY-FINAL') {
            const probes = [
              () => {
                const n = db.prepare('SELECT COUNT(*) AS n FROM source_items').get().n;
                if (n !== 1339) throw new Error(`X-VERIFY-FINAL total=${n} != 1239`);
              },
              () => {
                const n = db
                  .prepare("SELECT COUNT(*) AS n FROM source_items WHERE source_id = 'probe-p-01b'")
                  .get().n;
                if (n !== 516) throw new Error(`X-VERIFY-FINAL p01b=${n} != 516`);
              },
              () => {
                const n = db
                  .prepare("SELECT COUNT(*) AS n FROM source_items WHERE source_id = 'probe-p-06b'")
                  .get().n;
                if (n !== 1) throw new Error(`X-VERIFY-FINAL p06b=${n} != 1`);
              },
              () => {
                const v = schemaVersion();
                if (v !== 4) throw new Error(`X-VERIFY-FINAL version=${v} != 4`);
              },
            ];
            probes[t]();
          } else {
            db.prepare('SELECT 1').all();
          }
          replay.statementsExecuted += 1;
          replay.rowsReadBound += 300;
          bump();
          break;
        }
        case 'quota-unit-select': {
          db.prepare('SELECT updated_at_ms FROM probe_run_state WHERE case_id = ?').all(
            '__global__',
          );
          replay.statementsExecuted += 1;
          replay.rowsReadBound += 2;
          bump();
          break;
        }
        case 'negative-probe-insert': {
          let rejected = false;
          try {
            db.prepare(
              'INSERT INTO jobs (id, type, aggregate_type, aggregate_id, status, priority, run_after, attempts, max_attempts, idempotency_key, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ).run(
              'job-negprobe-2',
              'sources.fetch_poll',
              'source',
              'probe-negprobe-agg',
              'claimed',
              50,
              NOW - 1000,
              1,
              3,
              'idem-job-negprobe-2',
              '{}',
              NOW - 2000,
              NOW - 1000,
            );
          } catch (e) {
            rejected = String(e.message).includes('UNIQUE constraint failed');
          }
          replay.statementsExecuted += 1;
          replay.bindPayloadBytes += 13 * 8;
          if (!rejected)
            throw new Error(
              'negative probe: partial unique index did NOT reject the second claimed job',
            );
          bump();
          break;
        }
        default:
          throw new Error(`unhandled statement kind ${s.kind} in ${c.caseId}`);
      }
    }
  }
  if (caseStatements !== registeredStatements) {
    throw new Error(
      `${c.caseId}: replay executed ${caseStatements} != registered ${registeredStatements}`,
    );
  }
  replay.perCase.push({
    caseId: c.caseId,
    statements: caseStatements,
    storageAfter: statSync(dbPath).size,
  });
}

// --- Fence proof (validator-internal; NOT part of the round schedule) ---
{
  const ladder = fixtures['F-CJK-L'];
  db.prepare(
    'INSERT INTO sources (id, name, connector, lane, trust_tier, interval_seconds, priority, daily_request_budget, approval_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('probe-fence', 'probe fence', 'probe', 'official', 50, 60, 50, 100, 'auto', NOW, NOW);
  seedJob('job-fence-1', 'probe-fence', 'claimed', 7);
  db.prepare(
    'INSERT OR REPLACE INTO source_state (source_id, next_poll_at, poll_owner_job_id, updated_at) VALUES (?, ?, ?, ?)',
  ).run('probe-fence', HOLD, 'job-fence-1', NOW);
  const rows = [ladder.rows[510], ladder.rows[511]];
  const sql = buildSql('buildOwnedMultiRowInsertSql', 2);
  const wrongGen = db
    .prepare(sql)
    .run(...ownedInsertBinds(rows, 'probe-fence', 'job-fence-1', 8)).changes;
  const rightGen = db.prepare(sql).run(
    ...ownedInsertBinds(
      rows.map((r) => ({ ...r, id: `${r.id}-x`, externalId: `${r.externalId}-x` })),
      'probe-fence',
      'job-fence-1',
      7,
    ),
  ).changes;
  check(
    'V-10f',
    'ownership fence proof: wrong-generation guarded insert changes 0 rows; correct-generation inserts 2 (the guarded predicate is live, not decorative)',
    wrongGen === 0 && rightGen === 2,
    `wrongGen changes=${wrongGen}, rightGen changes=${rightGen}`,
  );
}

// --- V-10 totals ---
{
  const registeredInvocationStatements = schedule.cases.reduce(
    (a, c) => a + c.statements.reduce((x, s) => x + s.count, 0),
    0,
  );
  const registeredApiCalls = schedule.cases.reduce((a, c) => a + c.apiCalls, 0);
  const ok = replay.statementsExecuted === registeredInvocationStatements;
  report.numbers.replay = {
    statementsExecuted: replay.statementsExecuted,
    registeredInvocationStatements,
    registeredApiCalls,
    localChanges: replay.localChanges,
  };
  check(
    'V-10',
    'full local replay against the real S4 schema: guarded inserts land, the fence blocks wrong generations, the partial-unique-index negative probe rejects, and the replay executes EXACTLY the registered invocation-side statement count (521)',
    ok,
    `replayed ${replay.statementsExecuted} statements (registered: ${registeredInvocationStatements}); registered API calls: ${registeredApiCalls}; local changes: ${replay.localChanges}`,
  );
}

// --- V-11 resource reconciliation ---
{
  const cliTotal =
    cliStatements.s3 +
    cliStatements.s4 +
    cliStatements.probeDdl +
    cliStatements.latchSeed +
    cliStatements.sourcesSeed;
  const roundStatements = replay.statementsExecuted + cliTotal;
  const caps = schedule.caps;
  const growth = statSync(dbPath).size;
  const cliDocumented = cliTotal + probeSourceIds().length * 2 + (schedule.cases.length + 1) * 2;
  const documented = replay.documentedRowsWritten + cliDocumented;
  const ok =
    roundStatements <= caps.statementsRoundTotalCap &&
    documented <= caps.rowsWrittenRoundTotalCap &&
    growth <= caps.durableStorageGrowthCapBytes &&
    replay.bindPayloadBytes <= caps.bindPayloadRoundTotalCapBytes &&
    documented <= 100000 &&
    growth <= 500000000;
  report.numbers.resources = {
    roundStatements,
    cliStatements,
    documentedRowsWritten: documented,
    localChanges: replay.localChanges,
    bindPayloadBytes: replay.bindPayloadBytes,
    measuredLocalStorageGrowthBytes: growth,
  };
  check(
    'V-11',
    'resource reconciliation: round statements (600), documented-accounting rows written, bind payload and MEASURED local storage growth (incl. UNIQUE-index storage of canonical URLs) all within the registered caps and the documented Free allowances',
    ok,
    `statements ${roundStatements}/${caps.statementsRoundTotalCap}; documented rows written ${documented}/${caps.rowsWrittenRoundTotalCap} (${(100000 / documented).toFixed(1)}x under 100,000/day); bind payload ${(replay.bindPayloadBytes / 1e6).toFixed(1)} MB/${caps.bindPayloadRoundTotalCapBytes / 1e6} MB; local storage growth ${(growth / 1e6).toFixed(1)} MB/${caps.durableStorageGrowthCapBytes / 1e6} MB (${(500000000 / growth).toFixed(1)}x under 500 MB/db; 12 KB is the EMPTY-DB figure, not the schema baseline)`,
  );
}

// --- V-12 invocation/api-call totals ---
{
  const invocations = schedule.cases.reduce((a, c) => a + c.invocations, 0);
  const apiCalls = schedule.cases.reduce((a, c) => a + c.apiCalls, 0);
  const maxStatements = Math.max(
    ...schedule.cases.map((c) => c.statements.reduce((x, s) => x + s.count, 0)),
  );
  const maxApi = Math.max(...schedule.cases.map((c) => c.apiCalls));
  const caps = schedule.caps;
  const ok =
    invocations === caps.invocationsRegistered &&
    invocations + caps.transportRetryAllowance === caps.invocationsHardCap &&
    maxStatements <= caps.statementsPerInvocationCap &&
    maxApi <= caps.apiCallsPerInvocationCap;
  report.numbers.invocations = { invocations, apiCalls, maxStatements, maxApi };
  check(
    'V-12',
    'invocation totals: 20 registered (+3 transport retries = hard cap 23); per-invocation max statements (69) and max API calls (52, P-QU-B only) within caps',
    ok,
    `invocations=${invocations} apiCalls=${apiCalls} maxStatements/invocation=${maxStatements}/${caps.statementsPerInvocationCap} maxApi/invocation=${maxApi}/${caps.apiCallsPerInvocationCap}`,
  );
}

// --- V-13 conservative rows-read bounds ---
{
  const caps = schedule.caps;
  const ok = replay.rowsReadBound <= caps.rowsReadRoundTotalCap;
  check(
    'V-13',
    'conservative rows-read bounds within the registered cap (>= 200x under the documented 5,000,000 rows/day)',
    ok,
    `bound=${replay.rowsReadBound}/${caps.rowsReadRoundTotalCap} (${(5000000 / replay.rowsReadBound).toFixed(0)}x under 5M/day)`,
  );
}

// --- V-14 coverage boundary ---
{
  const cb = schedule.coverageBoundary.staticCounterexample;
  const rawLink = 23 + 3 * cb.cjkPathChars;
  const rawRss =
    byteLen(RSS_WRAPPER) + byteLen('<item><link>') + rawLink + byteLen('</link></item>\n');
  const canonical = 23 + 9 * cb.cjkPathChars;
  const ok =
    rawRss === cb.rawRssBytes &&
    canonical === cb.canonicalUrlBytes &&
    rawRss < cb.feedBoundBytes &&
    canonical > cb.documentedRowBoundBytes;
  check(
    'V-14',
    'coverage boundary: the static counterexample computes exactly (a sub-2-MiB RSS document whose single URL expands beyond the documented 2,000,000-byte row limit) — feed-bound compliance does NOT imply row-size compliance',
    ok,
    `rawRSS=${rawRss} (registered ${cb.rawRssBytes}) < feedBound ${cb.feedBoundBytes}; canonical=${canonical} (registered ${cb.canonicalUrlBytes}) > rowBound ${cb.documentedRowBoundBytes}`,
  );
}

// --- V-15 plan cross-checks ---
{
  const required = [
    'PROBE_CASE_SCHEDULE.json',
    'validate-probe-plan.mjs',
    '2/4/8',
    '26 statements',
    '208',
    'P_req',
    '1,899,995',
    '5,400,023',
    '1,800,116',
    '9,125,888',
    'G1',
    'G2',
    'G3',
    'G4',
    'G5',
    'pre-authoriz',
    'X-Probe-Token',
    'P-QU-A',
    'P-QU-B',
    'commit-only',
    'full-poll',
    'CPUTimeMs',
    'UNKNOWN',
    '1,000',
    'S3',
    'S4',
    'schema_version',
    'NOT_READY',
    '650',
    '9,000',
    '25,000',
    '55,000,000',
    '120,000,000',
  ];
  const missing = required.filter((s) => !planText.includes(s));
  check(
    'V-15',
    'plan-document cross-checks: the plan cites the schedule, validator, ladder, fixtures, phases, protected invocation, CPU scopes, coverage numbers and reconciled caps',
    missing.length === 0,
    missing.length === 0 ? `${required.length} anchors present` : `missing: ${missing.join(', ')}`,
  );
}

// --- V-16 quota-unit discriminator structure ---
{
  const quA = schedule.cases.find((c) => c.caseId === 'P-QU-A');
  const quB = schedule.cases.find((c) => c.caseId === 'P-QU-B');
  const nonMutating =
    quA &&
    quB &&
    quA.statements.every((s) => s.kind === 'latch-increment' || s.kind === 'quota-unit-select') &&
    quB.statements.every((s) => s.kind === 'latch-increment' || s.kind === 'quota-unit-select');
  const countA = quA?.statements.find((s) => s.kind === 'quota-unit-select')?.count;
  const countB = quB?.statements.find((s) => s.kind === 'quota-unit-select')?.count;
  const matrix = Object.keys(schedule.quotaUnitDiscriminator.interpretationMatrix).length === 4;
  check(
    'V-16',
    'quota-unit discriminator: P-QU-A (batch-51) and P-QU-B (terminal-51) are non-mutating, each submits exactly 51 one-row SELECTs, and the 4-branch interpretation matrix is registered',
    !!nonMutating && countA === 51 && countB === 51 && matrix,
    `nonMutating=${!!nonMutating} counts=${countA}/${countB} matrixBranches=4`,
  );
}

// --- V-17 protected invocation artifacts ---
{
  const killSwitch =
    probeDdlText.includes('__global__') &&
    probeDdlText.includes("'open'") &&
    probeDdlText.includes("'aborted'");
  const latchRows = db.prepare('SELECT COUNT(*) AS n FROM probe_run_state').get().n;
  const globalRow = db
    .prepare("SELECT status FROM probe_run_state WHERE case_id = '__global__'")
    .get();
  const withRemainingBudget = db
    .prepare(
      "SELECT COUNT(*) AS n FROM probe_run_state WHERE status = 'open' AND invocations_used < invocations_registered AND case_id != '__global__'",
    )
    .get().n;
  const ok =
    killSwitch &&
    latchRows === schedule.cases.length + 1 &&
    globalRow.status === 'open' &&
    withRemainingBudget === 0;
  check(
    'V-17',
    "protected invocation artifacts: latch DDL carries the kill-switch states; 21 latch rows seeded; every case's registered budget consumed EXACTLY once by the replay; __global__ open (unused)",
    ok,
    `rows=${latchRows} global=${globalRow.status} casesWithRemainingBudget=${withRemainingBudget}`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
db.close();
rmSync(workDir, { recursive: true, force: true });
out('');
out('--- key computed numbers (LOCAL feasibility proxies, NOT cloud measurements) ---');
for (const [k, v] of Object.entries(report.numbers)) {
  out(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
}
out('');
out(
  `VALIDATOR RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} — ${checkCount} checks, ${failures} failures`,
);
out('LOCAL ONLY: node:sqlite + repository files; zero network/account operations.');
process.exit(failures === 0 ? 0 : 1);
