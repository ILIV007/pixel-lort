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
 * Checked ACTIVE release metadata (R1.12 hardening):
 *   - VERSION.json             (ACTIVE metadata ONLY — appVersion must equal
 *                               package.json, schemaVersion must equal the
 *                               applied schema version (3), source identity
 *                               must be 40-hex, and artifactFilename must be
 *                               null OR name an artifact of THIS appVersion
 *                               — a stale/fabricated ZIP filename fails the
 *                               gate. Historical narratives live in
 *                               docs/VERSION_HISTORY.md and are NOT scanned.)
 *
 * Checked schema-version touch points (expected: 3 — migrations 0001+0002+0003):
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
// Schema version — the LINEAR migration candidate chain: the applied
// 0001+0002+0003 base + the LOCAL-ONLY candidates 0004 (ownership) → 4 and
// 0005 (admin post) → 5 (R1.20-R1). The real applied runtime stays 3 until
// the owner authorizes the remote migration.
// ---------------------------------------------------------------------------

const EXPECTED_SCHEMA_VERSION = '6';

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

// ---------------------------------------------------------------------------
// ACTIVE release metadata — VERSION.json (R1.12 hardening).
// VERSION.json holds ACTIVE metadata ONLY: it must agree with package.json
// and the applied schema version, and it must never fabricate an artifact
// filename for a ZIP that was not built in the current round. Historical
// narratives are frozen in docs/VERSION_HISTORY.md and never scanned here.
// ---------------------------------------------------------------------------

let versionJson = null;
try {
  versionJson = JSON.parse(read('VERSION.json'));
} catch (error) {
  failures.push(`VERSION.json: unparseable JSON (${error.message})`);
}
if (versionJson !== null) {
  if (versionJson.appVersion !== appVersion) {
    failures.push(
      `VERSION.json: appVersion (${versionJson.appVersion}) must equal package.json version (${appVersion})`,
    );
  }
  if (String(versionJson.schemaVersion) !== EXPECTED_SCHEMA_VERSION) {
    failures.push(
      `VERSION.json: schemaVersion (${versionJson.schemaVersion}) must equal the applied schema version (${EXPECTED_SCHEMA_VERSION})`,
    );
  }
  for (const field of ['sourceCommit', 'sourceTree']) {
    if (!/^[0-9a-f]{40}$/.test(versionJson[field] ?? '')) {
      failures.push(`VERSION.json: ${field} must be a full 40-char hex SHA`);
    }
  }
  if (typeof versionJson.sourceBranch !== 'string' || versionJson.sourceBranch.length === 0) {
    failures.push('VERSION.json: sourceBranch must be a non-empty string');
  }
  if (typeof versionJson.reviewRevision !== 'string' || versionJson.reviewRevision.length === 0) {
    failures.push('VERSION.json: reviewRevision must be a non-empty string');
  }
  if (
    typeof versionJson.reviewPullRequest !== 'string' ||
    !versionJson.reviewPullRequest.includes('github.com/ILIV007/pixel-lort/pull/')
  ) {
    failures.push('VERSION.json: reviewPullRequest must reference the ILIV007/pixel-lort PR');
  }
  // An artifact filename that does not exist / was not built in THIS round
  // must never be recorded: null is the honest value. A recorded name must
  // belong to THIS appVersion (never a stale older candidate filename).
  if (versionJson.artifactFilename !== null) {
    if (
      typeof versionJson.artifactFilename !== 'string' ||
      !versionJson.artifactFilename.startsWith(`Pixel-Lores_v${appVersion}_`)
    ) {
      failures.push(
        `VERSION.json: artifactFilename must be null (no ZIP built this round) or start with "Pixel-Lores_v${appVersion}_" — stale or fabricated names fail the gate`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The zod runtime dependency gate (Phase 10 tracked carry — the zod v4
// migration for GHSA-mrhx-c7xc-m3w5, "memory exhaustion while validating
// oversized constrained collections", fixed in 4.6.6; house pin >= 4.6.7).
// Both the DECLARED range (package.json) and the INSTALLED version
// (node_modules) must be the fixed v4 — a downgrade or a stale install
// fails the gate exactly like a version drift.
// ---------------------------------------------------------------------------

const ZOD_MIN = [4, 6, 7];

/** @param {string} version @param {number[]} min */
function versionAtLeast(version, min) {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < min.length; i += 1) {
    const p = Number.isNaN(parts[i]) ? 0 : parts[i];
    if (p > min[i]) return true;
    if (p < min[i]) return false;
  }
  return true;
}

const declaredZod = packageJson?.dependencies?.zod;
if (typeof declaredZod !== 'string' || !/^\^?(\d+)\.(\d+)\.(\d+)/.test(declaredZod)) {
  failures.push(
    `package.json: dependencies.zod missing or unparseable ("${declaredZod ?? ''}") — the v4 migration contract expects ^4.6.7 or higher`,
  );
} else if (!versionAtLeast(declaredZod.replace(/^\^/, ''), ZOD_MIN)) {
  failures.push(
    `package.json: dependencies.zod ("${declaredZod}") must be >= ${ZOD_MIN.join('.')} (GHSA-mrhx-c7xc-m3w5 fix)`,
  );
}

let installedZod = null;
try {
  installedZod = JSON.parse(read('node_modules/zod/package.json'));
} catch {
  failures.push(
    'node_modules/zod/package.json: unreadable — run npm install (the zod gate needs the installed dependency)',
  );
}
if (installedZod !== null) {
  const installedVersion = installedZod?.version;
  if (typeof installedVersion !== 'string' || !versionAtLeast(installedVersion, ZOD_MIN)) {
    failures.push(
      `node_modules/zod: installed version ("${installedVersion ?? ''}") must be >= ${ZOD_MIN.join('.')} (GHSA-mrhx-c7xc-m3w5 fix) — run npm install`,
    );
  }
}

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
