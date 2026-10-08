#!/usr/bin/env node
/**
 * Version-consistency gate (Phase 2A final correction round, v1.2.3).
 *
 * The correction review found active configuration files silently drifted to
 * three different application versions (.env.example at 1.1.0 while
 * .dev.vars.example was at 1.2.0 and package.json at 1.2.1). This script
 * makes such drift IMPOSSIBLE to miss: package.json is the single source of
 * truth for the application version, and every ACTIVE configuration touch
 * point must match it exactly. Historical documentation (e.g. old handoff
 * sections, superseded ADR text) is intentionally NOT scanned — only active
 * defaults, examples, and configuration.
 *
 * Checked application-version touch points:
 *   - package-lock.json        (root + packages[""] version — npm tooling)
 *   - wrangler.jsonc           (every APP_VERSION var, root + envs)
 *   - src/shared/config/phase0.ts   (DEFAULT_APP_VERSION — /version default)
 *   - .env.example             (APP_VERSION=)
 *   - .dev.vars.example        (# APP_VERSION=)
 *   - tests/helpers/test-env.ts     (APP_VERSION: '<version>-test')
 *
 * Checked schema-version touch points (expected: 2 — migrations 0001+0002):
 *   - src/shared/config/phase1a.ts  (EXPECTED_SCHEMA_VERSION)
 *   - wrangler.jsonc           (every SCHEMA_VERSION var)
 *   - .env.example             (SCHEMA_VERSION=)
 *
 * Usage: node scripts/check-versions.mjs   (wired into `npm run check`)
 * Exit 0 = consistent; exit 1 = drift detected (with file:line pointers —
 * values reported are version numbers only, never secrets).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} relativePath */
function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/** @param {string} relativePath @param {RegExp} pattern @returns {{line:number,text:string}[]} */
function findLines(relativePath, pattern) {
  return read(relativePath)
    .split('\n')
    .map((text, index) => ({ text, line: index + 1 }))
    .filter((entry) => pattern.test(entry.text));
}

const failures = [];

/**
 * Assert every line matching `pattern` in `relativePath` contains the
 * expected literal value.
 *
 * @param {string} relativePath
 * @param {RegExp} pattern
 * @param {string} expected
 * @param {string} label
 */
function expectEveryMatch(relativePath, pattern, expected, label) {
  const matches = findLines(relativePath, pattern);
  if (matches.length === 0) {
    failures.push(`${relativePath}: no line matches ${label} (expected value ${expected})`);
    return;
  }
  for (const match of matches) {
    if (!match.text.includes(expected)) {
      failures.push(
        `${relativePath}:${match.line} — ${label} expected "${expected}", found: ${match.text.trim()}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Application version — package.json is the source of truth.
// ---------------------------------------------------------------------------

const packageJson = JSON.parse(read('package.json'));
const appVersion = packageJson?.version;
if (typeof appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(appVersion)) {
  failures.push(`package.json: invalid or missing "version" field`);
} else {
  // package-lock.json (npm tooling keeps both blocks in sync).
  const lock = JSON.parse(read('package-lock.json'));
  if (lock?.version !== appVersion || lock?.packages?.['']?.version !== appVersion) {
    failures.push(
      `package-lock.json: root version (${lock?.version}) and packages[""].version (${lock?.packages?.['']?.version}) must both equal package.json version (${appVersion}) — run npm install`,
    );
  }

  expectEveryMatch(
    'wrangler.jsonc',
    /"APP_VERSION"/,
    `"APP_VERSION": "${appVersion}"`,
    'APP_VERSION var',
  );
  expectEveryMatch(
    'src/shared/config/phase0.ts',
    /DEFAULT_APP_VERSION = /,
    `DEFAULT_APP_VERSION = '${appVersion}'`,
    'DEFAULT_APP_VERSION',
  );
  expectEveryMatch('.env.example', /^APP_VERSION=/, `APP_VERSION=${appVersion}`, 'APP_VERSION');
  expectEveryMatch(
    '.dev.vars.example',
    /^# APP_VERSION=/,
    `# APP_VERSION=${appVersion}`,
    'commented APP_VERSION',
  );
  expectEveryMatch(
    'tests/helpers/test-env.ts',
    /APP_VERSION: '/,
    `APP_VERSION: '${appVersion}-test'`,
    'test APP_VERSION',
  );
}

// ---------------------------------------------------------------------------
// Schema version — the applied migrations 0001+0002 define version 2.
// ---------------------------------------------------------------------------

const EXPECTED_SCHEMA_VERSION = '2';

expectEveryMatch(
  'src/shared/config/phase1a.ts',
  /EXPECTED_SCHEMA_VERSION = /,
  `EXPECTED_SCHEMA_VERSION = ${EXPECTED_SCHEMA_VERSION};`,
  'EXPECTED_SCHEMA_VERSION',
);
expectEveryMatch(
  'wrangler.jsonc',
  /"SCHEMA_VERSION"/,
  `"SCHEMA_VERSION": "${EXPECTED_SCHEMA_VERSION}"`,
  'SCHEMA_VERSION var',
);
expectEveryMatch(
  '.env.example',
  /^SCHEMA_VERSION=/,
  `SCHEMA_VERSION=${EXPECTED_SCHEMA_VERSION}`,
  'SCHEMA_VERSION',
);

if (failures.length > 0) {
  console.error(`VERSION CONSISTENCY FAILED: ${failures.length} drift finding(s).`);
  for (const failure of failures) {
    console.error(` - ${failure}`);
  }
  console.error('Align the active configuration files with package.json / the applied migrations.');
  process.exit(1);
}

console.log(
  `version consistency passed: application version ${appVersion} and schema version ${EXPECTED_SCHEMA_VERSION} are consistent across all active configuration files.`,
);
