/**
 * `/drafts` command-argument contract (R1.18 — ADR-0046).
 *
 * The WHOLE argument remainder is parsed BEFORE any editorial SQL:
 * - no argument (`/drafts`, or a captured EMPTY remainder) -> the bounded
 *   ready-list action;
 * - exactly ONE opaque token (`/drafts <draftId>`) -> the detail action;
 * - anything else -> `invalid` (whitespace/control characters, > 128 UTF-8
 *   bytes, or extra trailing arguments). The ID is validated as a WHOLE
 *   opaque token — it is never trimmed to fit, never partially matched, and
 *   never parsed into SQL structure: the store binds it as ONE parameter.
 *
 * The parser is PURE and synchronous — validation happens in the router
 * (before a query adapter can ever be involved).
 */
import { REVIEW_DRAFT_ID_MAX_BYTES } from './review-strings';

export type DraftsArgumentParse =
  | { readonly kind: 'list' }
  | { readonly kind: 'detail'; readonly draftId: string }
  | { readonly kind: 'invalid' };

/** No whitespace of any kind may appear inside a draft-id token. */
const DRAFT_ID_FORBIDDEN_WHITESPACE = /\s/u;

/**
 * Validate the whole remainder after `/drafts`.
 *
 * Rules (R1.18 §3.C):
 * - `undefined` (no argument captured by the command grammar) or the EMPTY
 *   string (`/drafts ` with a bare trailing separator) is the LIST form —
 *   there is no argument to validate;
 * - otherwise the remainder must be a single opaque token: 1..128 UTF-8
 *   bytes, containing NO whitespace and NO control characters (C0 and DEL);
 * - any violation — including a second token after a space — is `invalid`;
 *   the raw text is never echoed back.
 */
export function parseDraftsArgument(remainder: string | undefined): DraftsArgumentParse {
  if (remainder === undefined || remainder === '') {
    return { kind: 'list' };
  }
  if (DRAFT_ID_FORBIDDEN_WHITESPACE.test(remainder)) {
    return { kind: 'invalid' };
  }
  const bytes = new TextEncoder().encode(remainder);
  if (bytes.length === 0 || bytes.length > REVIEW_DRAFT_ID_MAX_BYTES) {
    return { kind: 'invalid' };
  }
  for (const character of remainder) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return { kind: 'invalid' };
    }
  }
  return { kind: 'detail', draftId: remainder };
}
