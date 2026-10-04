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
 *   their text arguments and emit ONLY allowlisted tags; link targets are
 *   validated against a conservative https-only URL shape BEFORE embedding.
 * - `isSafeTelegramHtml` is a bounded structural validator (balanced
 *   allowlisted tags, no attributes except a validated href on <a>) used as
 *   a defense-in-depth gate before anything is handed to the Bot API.
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

/**
 * Conservative link-target shape: https only, no credentials, no whitespace
 * or quotes, no control characters. Authored code paths validate BEFORE
 * interpolation; the validator re-checks anything claiming to contain a link.
 */
const SAFE_HREF_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#][!-~]*)?$/;

const MAX_TAG_DEPTH = 16;

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
 * Emit an <a href="…">…</a> fragment. The target must match the safe https
 * shape; unsafe targets are rejected loudly (author error) instead of being
 * sanitized silently.
 */
export function telegramLink(href: string, text: string): TelegramSafeHtml {
  if (!SAFE_HREF_PATTERN.test(href)) {
    throw new Error('unsafe link target rejected');
  }
  return `<a href="${href}">${escapeTelegramHtml(text)}</a>` as TelegramSafeHtml;
}

/** Join validated fragments with newlines into one safe message. */
export function composeTelegramHtml(parts: readonly TelegramSafeHtml[]): TelegramSafeHtml {
  return parts.join('\n') as TelegramSafeHtml;
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
      if (name !== 'a' || !SAFE_HREF_PATTERN.test(href)) {
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
