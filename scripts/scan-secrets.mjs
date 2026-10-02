#!/usr/bin/env node
/**
 * Secret-shape scanner for tracked files (Phase 0 quality gate).
 *
 * Blueprint §25 includes a secret scan in the build gate. This script scans
 * every git-tracked file for well-known credential SHAPES and fails the build
 * when one is found. Pattern coverage and reporting rules live in
 * scripts/scan-secrets-lib.mjs (ADR-0018).
 *
 * IMPORTANT: on a finding, the scanner reports the pattern name, file, and
 * line number ONLY — it never prints the matched content, so running this
 * script can never itself leak a secret.
 *
 * Usage:
 *   node scripts/scan-secrets.mjs               # scan all git-tracked files
 *   node scripts/scan-secrets.mjs --scan <path> # scan one file or directory
 *                                               # (used by the automated
 *                                               #  self-test; never commits)
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { formatFindings, scanContent } from './scan-secrets-lib.mjs';

/** @returns {string[]} */
function listTrackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return output.split('\0').filter((file) => file.length > 0);
}

/**
 * Collect readable text files under a path (single file or recursive
 * directory). Used by the self-test with fixtures in the OS temp dir.
 *
 * @param {string} target
 * @returns {string[]}
 */
function listScanTargets(target) {
  const absolute = path.resolve(target);
  const stat = statSync(absolute);
  if (stat.isFile()) {
    return [absolute];
  }
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) {
      files.push(...listScanTargets(child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

/** @returns {{ findings: {file:string,lineNumber:number,patternId:string}[], scanned: number }} */
function runScan(files, displayPath) {
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      // Binary or unreadable file: content scan is not applicable.
      continue;
    }
    scanned += 1;
    for (const finding of scanContent(content)) {
      findings.push({
        file: displayPath ? `${displayPath(file)}` : file,
        lineNumber: finding.lineNumber,
        patternId: finding.patternId,
      });
    }
  }
  return { findings, scanned };
}

const args = process.argv.slice(2);
const scanIndex = args.indexOf('--scan');
let files;
let displayPath;
if (scanIndex !== -1 && args[scanIndex + 1]) {
  const target = args[scanIndex + 1];
  files = listScanTargets(target);
  const base = statSync(path.resolve(target)).isDirectory() ? path.resolve(target) : null;
  displayPath = (file) => (base ? path.relative(base, file) : file);
} else {
  files = listTrackedFiles();
}

const { findings, scanned } = runScan(files, displayPath);

if (findings.length > 0) {
  console.error(`SECRET SCAN FAILED: ${findings.length} finding(s).`);
  for (const line of formatFindings(findings)) {
    console.error(line);
  }
  console.error('Remove the credential, then commit. Never print or paste its value.');
  process.exit(1);
}

console.log(`secret scan passed: ${scanned} files scanned, 0 findings.`);
