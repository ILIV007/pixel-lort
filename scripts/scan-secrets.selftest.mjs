#!/usr/bin/env node
/**
 * Automated self-test for the secret scanner (ADR-0018).
 *
 * Runs as part of `npm run check` (script `test:secrets`) and proves:
 *   1. every expected credential SHAPE is detected;
 *   2. harmless placeholders are NOT detected;
 *   3. findings never print or return the secret value;
 *   4. the CLI process exits non-zero on a finding (and zero when clean).
 *
 * IMPORTANT: token-shaped fixture strings are CONSTRUCTED DYNAMICALLY from
 * separate fragments so this source file never contains a contiguous
 * token-shaped string — the repo scanner must not report its own tests.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFindings, scanContent, scanLine, SECRET_PATTERNS } from './scan-secrets-lib.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixture construction — fragments only; tokens exist solely at runtime.
// ---------------------------------------------------------------------------

/**
 * @param {...string} fragments
 * @returns {string}
 */
const join = (...fragments) => fragments.join('');

/** Token-shaped fixture strings, each assembled from disjoint fragments. */
const FIXTURES = [
  {
    patternId: 'telegram-bot-token',
    token: join('123456789', ':AA', 'z'.repeat(35)),
    placeholder: join('123456789', ':AA', 'placeholder'),
  },
  {
    patternId: 'openai-style-key',
    token: join('s', 'k-', 'a'.repeat(30)),
    placeholder: join('s', 'k-', 'your-key-here'),
  },
  {
    patternId: 'google-api-key',
    token: join('AI', 'za', 'a'.repeat(35)),
    placeholder: join('AI', 'za', 'short'),
  },
  {
    patternId: 'aws-access-key-id',
    token: join('AK', 'IA', 'A1'.repeat(8)),
    placeholder: join('AK', 'IA', 'short'),
  },
  {
    patternId: 'github-legacy-token',
    token: join('gh', 'p_', 'a'.repeat(36)),
    placeholder: join('gh', 'p_', 'exampletoken'),
  },
  {
    patternId: 'github-fine-grained-pat',
    token: join('github', '_pat_', 'a'.repeat(22), '_', 'b'.repeat(59)),
    placeholder: join('github', '_pat_', 'example'),
  },
  {
    patternId: 'cloudflare-user-api-token',
    token: join('cf', 'ut_', 'T'.repeat(24)),
    placeholder: join('cf', 'ut_', 'PLACEHOLDER'),
  },
  {
    patternId: 'cloudflare-account-api-token',
    token: join('cf', 'at_', 'T'.repeat(24)),
    placeholder: join('cf', 'at_', 'PLACEHOLDER'),
  },
  {
    patternId: 'groq-api-key',
    token: join('gs', 'k_', 'k'.repeat(30)),
    placeholder: join('gs', 'k_', 'example-key'),
  },
  {
    patternId: 'slack-token',
    token: join('xox', 'b-', 'a'.repeat(20)),
    placeholder: join('xox', 'b-', 'short'),
  },
  {
    patternId: 'private-key-block',
    token: join('-----BEGIN ', 'RSA ', 'PRIVATE KEY', '-----'),
    placeholder: join('-----BEGIN ', 'CERTIFICATE', '-----'),
  },
  {
    patternId: 'bearer-token-literal',
    token: join('Bearer ', 'x'.repeat(40)),
    placeholder: join('Bearer ', '<token>'),
  },
];

/** Harmless lines that must never be reported. */
const CLEAN_LINES = [
  'cfut_PLACEHOLDER cfat_PLACEHOLDER gsk_example',
  'github_pat_example ghp_exampletoken',
  'Bearer <token> Bearer ${TOKEN} Bearer token',
  'ENVIRONMENT=development',
  'LOG_LEVEL=info',
  'APP_VERSION=1.1.0',
  'visit https://example.com/docs for help',
  '-----BEGIN CERTIFICATE-----',
  'x-request-id: integration-test-req-0001',
];

let checks = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}

// ---------------------------------------------------------------------------
// 1. Expected credential shapes are detected.
// ---------------------------------------------------------------------------

check('every scanner pattern id is covered by a fixture', () => {
  const covered = new Set(FIXTURES.map((fixture) => fixture.patternId));
  for (const pattern of SECRET_PATTERNS) {
    assert.ok(covered.has(pattern.id), `no fixture for pattern: ${pattern.id}`);
  }
});

check('expected credential shapes are detected on their own line', () => {
  for (const fixture of FIXTURES) {
    const line = `value=${fixture.token}`;
    assert.deepEqual(scanLine(line), [fixture.patternId], `pattern ${fixture.patternId}`);
  }
});

check('detection works mid-document with correct line numbers', () => {
  const first = FIXTURES[0];
  assert.ok(first, 'fixture list must not be empty');
  const doc = ['header', ...CLEAN_LINES, `secret=${first.token}`, 'footer'].join('\n');
  const findings = scanContent(doc);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].patternId, 'telegram-bot-token');
  assert.equal(findings[0].lineNumber, CLEAN_LINES.length + 2);
});

// ---------------------------------------------------------------------------
// 2. Harmless placeholders are not detected.
// ---------------------------------------------------------------------------

check('harmless placeholders are not detected', () => {
  for (const fixture of FIXTURES) {
    const line = `value=${fixture.placeholder}`;
    assert.deepEqual(scanLine(line), [], `placeholder must not match: ${fixture.patternId}`);
  }
});

check('clean document produces zero findings', () => {
  assert.deepEqual(scanContent(CLEAN_LINES.join('\n')), []);
});

// ---------------------------------------------------------------------------
// 3. Findings never print or return the secret value.
// ---------------------------------------------------------------------------

check('findings carry only pattern id and line number', () => {
  const openai = FIXTURES[1];
  assert.ok(openai, 'fixture list must not be empty');
  const findings = scanContent(`token ${openai.token} embedded`);
  assert.equal(findings.length, 1);
  assert.deepEqual(Object.keys(findings[0]).sort(), ['lineNumber', 'patternId']);
});

check('formatted report never contains the secret value', () => {
  for (const fixture of FIXTURES) {
    const findings = scanContent(`${fixture.token}\n`).map((finding) => ({
      file: 'fixture.txt',
      lineNumber: finding.lineNumber,
      patternId: finding.patternId,
    }));
    const report = formatFindings(findings).join('\n');
    assert.ok(report.includes(fixture.patternId), 'report names the pattern');
    // The exact value and every distinctive fragment of it must be absent.
    assert.ok(!report.includes(fixture.token), 'report must not contain the value');
    const core = fixture.token.slice(4, 14);
    assert.ok(!report.includes(core), 'report must not contain any value fragment');
  }
});

// ---------------------------------------------------------------------------
// 4. CLI process exit behavior.
// ---------------------------------------------------------------------------

/**
 * Run the scanner CLI against a file inside a temp dir.
 *
 * @param {string} fileName
 * @param {string} content
 * @returns {{ status: number | null, output: string }}
 */
function runCli(fileName, content) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pixel-secret-scan-'));
  try {
    const file = path.join(dir, fileName);
    writeFileSync(file, content, 'utf8');
    const result = spawnSync(
      process.execPath,
      [path.join(scriptDir, 'scan-secrets.mjs'), '--scan', file],
      { encoding: 'utf8' },
    );
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

check('CLI exits non-zero on a finding and never prints the value', () => {
  const google = FIXTURES[2];
  assert.ok(google, 'fixture list must not be empty');
  const token = google.token;
  const { status, output } = runCli('leak-fixture.txt', `key=${token}\n`);
  assert.notEqual(status, 0, 'exit code must be non-zero on a finding');
  assert.ok(output.includes('SECRET SCAN FAILED'), 'CLI reports the failure');
  assert.ok(output.includes('google-api-key'), 'CLI reports the pattern id');
  assert.ok(!output.includes(token), 'CLI output must not contain the value');
});

check('CLI exits zero on a clean file', () => {
  const { status, output } = runCli('clean-fixture.txt', `${CLEAN_LINES.join('\n')}\n`);
  assert.equal(status, 0, 'exit code must be zero when clean');
  assert.ok(output.includes('0 findings'), 'CLI reports success');
});

check('repo scan of tracked files stays clean', () => {
  const result = spawnSync(process.execPath, [path.join(scriptDir, 'scan-secrets.mjs')], {
    encoding: 'utf8',
    cwd: path.dirname(scriptDir),
  });
  assert.equal(result.status, 0, `repo scan failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
});

console.log(`\nsecret scanner self-test passed: ${checks} checks, 0 failures.`);
