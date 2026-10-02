#!/usr/bin/env node
/**
 * Secret-shape scanner for tracked files (Phase 0 quality gate).
 *
 * Blueprint §25 includes a secret scan in the build gate. This script scans
 * every git-tracked file for well-known credential SHAPES and fails the build
 * when one is found.
 *
 * IMPORTANT: on a finding, the scanner reports the pattern name, file, and
 * line number ONLY — it never prints the matched content, so running this
 * script can never itself leak a secret.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  { name: 'telegram-bot-token', regex: /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/ },
  { name: 'openai-style-key', regex: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'private-key-block', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'bearer-token-literal', regex: /Bearer\s+[A-Za-z0-9._-]{30,}/ },
];

function listTrackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return output.split('\0').filter((file) => file.length > 0);
}

const files = listTrackedFiles();
const findings = [];

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    // Binary or unreadable file: content scan is not applicable.
    continue;
  }
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    for (const pattern of PATTERNS) {
      if (pattern.regex.test(lines[index])) {
        findings.push({ file, line: index + 1, pattern: pattern.name });
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`SECRET SCAN FAILED: ${findings.length} finding(s).`);
  for (const finding of findings) {
    console.error(`  [${finding.pattern}] ${finding.file}:${finding.line}`);
  }
  console.error('Remove the credential, then commit. Never print or paste its value.');
  process.exit(1);
}

console.log(
  `secret scan passed: ${files.length} tracked files, ${PATTERNS.length} patterns, 0 findings.`,
);
