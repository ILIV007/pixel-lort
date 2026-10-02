/**
 * Pure secret-shape scanning library — no Node APIs, no side effects.
 *
 * Shared by the CLI gate (scripts/scan-secrets.mjs) and the automated
 * self-test (scripts/scan-secrets.selftest.mjs). See ADR-0018.
 *
 * Design rules:
 * - Match credential SHAPES, never specific values.
 * - Findings carry pattern id + line number ONLY. Matched content is never
 *   returned, logged, or printed, so scanning output can never leak a secret.
 * - Coverage (Phase 0 correction pass): Telegram bot tokens, OpenAI-style
 *   keys, Google API keys, AWS access key ids, GitHub legacy tokens
 *   (ghp/gho/ghu/ghs/ghr), GitHub fine-grained PATs (github_pat_), Cloudflare
 *   user API tokens (cfut_), Cloudflare account API tokens (cfat_), Groq API
 *   keys (gsk_), Slack tokens, private key blocks, and Bearer literals.
 */

/** @typedef {{ id: string, regex: RegExp }} SecretPattern */

/** @type {readonly SecretPattern[]} */
export const SECRET_PATTERNS = [
  { id: 'telegram-bot-token', regex: /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/ },
  { id: 'openai-style-key', regex: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { id: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { id: 'aws-access-key-id', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-legacy-token', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { id: 'github-fine-grained-pat', regex: /\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { id: 'cloudflare-user-api-token', regex: /\bcfut_[A-Za-z0-9_-]{20,}/ },
  { id: 'cloudflare-account-api-token', regex: /\bcfat_[A-Za-z0-9_-]{20,}/ },
  { id: 'groq-api-key', regex: /\bgsk_[A-Za-z0-9]{20,}/ },
  { id: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'private-key-block', regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/ },
  { id: 'bearer-token-literal', regex: /\bBearer\s+[A-Za-z0-9._-]{30,}/ },
];

/**
 * Scan one line of text. Returns the ids of every matching pattern.
 * Never returns or inspects the matched content beyond pass/fail.
 *
 * @param {string} line
 * @returns {string[]}
 */
export function scanLine(line) {
  const matches = [];
  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(line)) {
      matches.push(pattern.id);
    }
  }
  return matches;
}

/**
 * @typedef {{ patternId: string, lineNumber: number }} ContentFinding
 */

/**
 * Scan a whole text document. Findings identify WHERE (pattern + line) and
 * never WHAT — no matched content is included.
 *
 * @param {string} content
 * @returns {ContentFinding[]}
 */
export function scanContent(content) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    for (const patternId of scanLine(lines[index] ?? '')) {
      findings.push({ patternId, lineNumber: index + 1 });
    }
  }
  return findings;
}

/**
 * Human-readable report for findings. Contains pattern ids, file names, and
 * line numbers only — structurally incapable of containing a secret value.
 *
 * @param {{ file: string, lineNumber: number, patternId: string }[]} findings
 * @returns {string[]}
 */
export function formatFindings(findings) {
  return findings.map(
    (finding) => `  [${finding.patternId}] ${finding.file}:${finding.lineNumber}`,
  );
}
