/**
 * Telegram-safe HTML formatter (Phase 2A) — small, explicit, defensive.
 *
 * Telegram's `parse_mode: "HTML"` accepts a tiny tag set; this module makes
 * it impossible to interpolate untrusted markup:
 *
 * - `escapeTelegramHtml` escapes `&`, `<`, `>` — plain text can never become
 *   markup, and Persian/RTL text, emoji, and mixed RTL/LTR content pass
 *   through untouched (no Unicode stripping, no reordering).
 * - Builder helpers (`telegramBold`, `telegramCode`, `telegramLink`) escape
 *   their text arguments and emit ONLY allowlisted tags. Link targets are
 *   validated by URL PARSING (not a shape regex — ADR-0029): https scheme
 *   only, non-empty host, no credentials, no control characters, and no
 *   attribute-hazard characters (`"`, `'`, `<`, `>`, backtick). The target
 *   is then CANONICALIZED via the URL parser and HTML-attribute-escaped
 *   before interpolation, so raw `&` and any residual hazard character can
 *   never break out of the `href="…"` attribute.
 * - `isSafeTelegramHtml` is a bounded structural validator (balanced
 *   allowlisted tags, no attributes except a validated href on <a>) used as
 *   a defense-in-depth gate before anything is handed to the Bot API. It
 *   accepts EXACTLY the href shape the builder emits: the attribute value
 *   must decode to a URL-safe target and be its canonical attribute
 *   escaping (a forged or hand-mangled value fails). The Bot API client
 *   additionally re-runs this validator at RUNTIME — a TypeScript-branded
 *   value cannot bypass the boundary.
 * - There is NO raw-HTML passthrough: source HTML is never accepted.
 *
 * The full editorial formatter (blueprint §13) is a later-phase concern.
 */

declare const telegramSafeBrand: unique symbol;
/** A string composed exclusively of escaped text and allowlisted Telegram tags. */
export type TelegramSafeHtml = string & { readonly [telegramSafeBrand]: 'TelegramSafeHtml' };

/** Tags accepted by the validator (Telegram HTML subset, author-generated). */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'code',
  'pre',
  'a',
  'blockquote',
]);

/** Maximum composed message length handed to Telegram. */
export const MAX_TELEGRAM_HTML_LENGTH = 4096;

/** Maximum nesting depth of allowlisted tags in one message. */
const MAX_TAG_DEPTH = 16;

/** Conservative link-target bound (URLs beyond this are rejected outright). */
export const MAX_HREF_LENGTH = 2048;

/**
 * Characters that must never appear raw in an interpolated href: they are
 * the classic HTML-attribute injection hazards (quote-based attribute
 * breakout, tag smuggling, and moustache-style template hazards). Raw `&`
 * is deliberately NOT on this list — it is normal in URLs and is rendered
 * safe by attribute escaping.
 */
const HREF_FORBIDDEN_CHARACTERS: ReadonlySet<string> = new Set(['"', "'", '<', '>', '`']);

/**
 * Validate a link target by URL parsing and return its CANONICAL form
 * (ADR-0029), or null when unsafe:
 * - no control characters and no attribute-hazard characters in the input;
 * - parses as an URL (malformed input rejected);
 * - protocol EXACTLY `https:`;
 * - non-empty hostname;
 * - no username/password credentials;
 * - the canonical form itself contains no attribute-hazard characters.
 */
export function safeHrefCanonical(href: string): string | null {
  if (href.length === 0 || href.length > MAX_HREF_LENGTH) {
    return null;
  }
  for (const character of href) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return null; // control characters (including tab/CR/LF)
    }
    if (HREF_FORBIDDEN_CHARACTERS.has(character)) {
      return null;
    }
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null; // malformed URL
  }
  if (url.protocol !== 'https:') {
    return null;
  }
  if (url.hostname === '') {
    return null;
  }
  if (url.username !== '' || url.password !== '') {
    return null;
  }
  const canonical = url.href;
  for (const character of HREF_FORBIDDEN_CHARACTERS) {
    if (canonical.includes(character)) {
      // Unreachable when the input is clean, but asserted so no future
      // change to URL canonicalization can silently weaken the boundary.
      return null;
    }
  }
  return canonical;
}

/** Convenience boolean wrapper around `safeHrefCanonical`. */
export function isSafeHref(href: string): boolean {
  return safeHrefCanonical(href) !== null;
}

/**
 * Escape a value for interpolation inside a double-quoted HTML attribute:
 * `&` `<` `>` `"` `'` all become entities, so a raw hazard character can
 * never appear in the emitted markup.
 */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Inverse of `escapeHtmlAttribute` for its EXACT entity set. Entities not
 * produced by the escaper (numeric codes, named aliases) are left verbatim,
 * which makes the validator's re-escape equality check reject them.
 */
export function unescapeHtmlAttribute(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => {
    switch (entity) {
      case '&amp;':
        return '&';
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&quot;':
        return '"';
      default:
        return "'";
    }
  });
}

/** Escape &, < and > so plain text can never become markup. */
export function escapeTelegramHtml(text: string): TelegramSafeHtml {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return escaped as TelegramSafeHtml;
}

/** Emit a <b>…</b> fragment with escaped content. */
export function telegramBold(text: string): TelegramSafeHtml {
  return `<b>${escapeTelegramHtml(text)}</b>` as TelegramSafeHtml;
}

/** Emit a <code>…</code> fragment with escaped content. */
export function telegramCode(text: string): TelegramSafeHtml {
  return `<code>${escapeTelegramHtml(text)}</code>` as TelegramSafeHtml;
}

/**
 * Emit an <a href="…">…</a> fragment. The target must validate as a safe
 * https URL (URL-parsed, credential-free, hazard-free — ADR-0029); the
 * CANONICAL form is attribute-escaped before interpolation. Unsafe targets
 * are rejected loudly (author error) instead of being sanitized silently.
 */
export function telegramLink(href: string, text: string): TelegramSafeHtml {
  const canonical = safeHrefCanonical(href);
  if (canonical === null) {
    throw new Error('unsafe link target rejected');
  }
  return `<a href="${escapeHtmlAttribute(canonical)}">${escapeTelegramHtml(text)}</a>` as TelegramSafeHtml;
}

/** Join validated fragments with newlines into one safe message. */
export function composeTelegramHtml(parts: readonly TelegramSafeHtml[]): TelegramSafeHtml {
  return parts.join('\n') as TelegramSafeHtml;
}

/**
 * Validate one href attribute value exactly as the builder emits it
 * (ADR-0029): the value must be the canonical attribute escaping of a
 * URL-safe https target — raw hazard characters and non-canonical entities
 * are rejected, and the decoded target must pass `safeHrefCanonical`.
 */
function isSafeHrefAttributeValue(value: string): boolean {
  const decoded = unescapeHtmlAttribute(value);
  if (escapeHtmlAttribute(decoded) !== value) {
    // Raw hazard characters or non-canonical entities present.
    return false;
  }
  const canonical = safeHrefCanonical(decoded);
  if (canonical === null) {
    return false;
  }
  return escapeHtmlAttribute(canonical) === value;
}

/**
 * Bounded structural validation of an HTML string for Telegram's parse mode:
 * only allowlisted tags, balanced, no attributes other than a single
 * safe-validated href on <a>, no self-closing tags, raw `<` that does not
 * start a valid tag is rejected. Persian/RTL text and emoji are inert here —
 * they are just text and always pass.
 */
export function isSafeTelegramHtml(html: string): boolean {
  if (html.length === 0 || html.length > MAX_TELEGRAM_HTML_LENGTH) {
    return false;
  }
  const stack: string[] = [];
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf('<', index);
    if (open === -1) {
      break; // remaining characters are plain text (no raw '<')
    }
    const close = html.indexOf('>', open);
    if (close === -1) {
      return false; // unterminated tag
    }
    const inner = html.slice(open + 1, close);
    index = close + 1;

    if (inner.length === 0) {
      return false; // "<>"
    }

    if (inner.startsWith('/')) {
      // Closing tag: exact name only, must match the innermost open tag.
      const name = inner.slice(1).trim().toLowerCase();
      if (name !== inner.slice(1) || !ALLOWED_TAGS.has(name)) {
        return false;
      }
      if (stack.pop() !== name) {
        return false;
      }
      continue;
    }

    // Opening tag: "<name>" or "<a href=\"…\">"; anything else is rejected.
    const match = /^([a-zA-Z][a-zA-Z0-9]*)(?:\s+href\s*=\s*"([^"]*)")?$/.exec(inner);
    if (match === null) {
      return false;
    }
    const name = match[1]?.toLowerCase() ?? '';
    if (!ALLOWED_TAGS.has(name)) {
      return false;
    }
    const href = match[2];
    if (href !== undefined) {
      if (name !== 'a' || !isSafeHrefAttributeValue(href)) {
        return false;
      }
    } else if (name === 'a') {
      return false; // <a> without a safe href is not accepted
    }
    if (stack.length >= MAX_TAG_DEPTH) {
      return false;
    }
    stack.push(name);
  }
  return stack.length === 0;
}
