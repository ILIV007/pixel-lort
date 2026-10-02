/**
 * Sensitive key detection, shared by the logger redaction layer and the
 * error-detail sanitizer. This is the single source of truth for "what counts
 * as a sensitive field name".
 *
 * Matching is intentionally biased toward over-redaction: a value that is
 * redacted but harmless costs a little log clarity, while a leaked credential
 * is a security incident (docs/SECURITY_MODEL.md).
 */

/** Whole-name matches after normalization (lowercase, non-alphanumerics stripped). */
const SENSITIVE_WHOLE_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'cookies',
  'setcookie',
  'token',
  'tokens',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'apikey',
  'apikeys',
  'apisecret',
  'clientsecret',
  'webhooksecret',
  'telegrambottoken',
  'bottoken',
  'secret',
  'secrets',
  'password',
  'passwd',
  'pwd',
  'credential',
  'credentials',
  'privatekey',
]);

/**
 * Word-level matches after splitting camelCase / kebab-case / snake_case.
 * Example: `telegramBotToken` -> ["telegram", "bot", "token"] -> matches "token".
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  'authorization',
  'auth',
  'cookie',
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'apikey',
  'credential',
]);

/** Split a key into normalized words: camelCase, snake_case, kebab-case, dots. */
function keyToWords(key: string): string[] {
  const spaced = key
    // camelCase boundary: "botToken" -> "bot Token"
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // all-caps acronyms followed by words: "APIKey" -> "API Key"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function normalizeWhole(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Returns true when the given field name looks sensitive and its value must
 * be redacted from logs, error details, and any serialized output.
 */
export function isSensitiveKeyName(key: string): boolean {
  if (SENSITIVE_WHOLE_NAMES.has(normalizeWhole(key))) {
    return true;
  }
  return keyToWords(key).some((word) => SENSITIVE_WORDS.has(word));
}
