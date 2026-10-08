# ADR-0029: Telegram-safe HTML link boundary (URL-parsed hrefs)

- **Status:** Accepted (amends ADR-0026)
- **Phase:** 2A (correction round v1.2.1)
- **Date:** 2026-10-04
- **Decided by:** Alexios

## Context

ADR-0026 validated link targets with a shape regex
(`^https://[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#][!-~]*)?$`). The correction
review identified that `[!-~]` admits quote and markup characters anywhere
in the path/query/fragment, so `telegramLink()` could emit
attribute-injection HTML (e.g. `href="https://x/" onload="…"` shapes) and
brand it `TelegramSafeHtml`. A shape regex is the wrong tool for URLs: the
parser already knows how to canonicalize them.

## Decision

- **URL parsing is the primary validator** (`safeHrefCanonical`), replacing
  the regex:
  - no control characters and no attribute-hazard characters (`"`, `'`,
    `<`, `>`, backtick) in the input;
  - the value must parse as an URL (malformed input rejected);
  - protocol EXACTLY `https:`; non-empty hostname; username/password
    credentials rejected;
  - the CANONICAL form (`url.href`) itself must contain no attribute-hazard
    characters (an assertion against future parser changes).
- **Canonicalize, then attribute-escape, then interpolate.** `telegramLink`
  emits `<a href="escapeHtmlAttribute(canonical)">…</a>`; the escaper covers
  `&` `<` `>` `"` `'`, so raw `&` in query strings is encoded (`&amp;`) and
  no hazard character can break out of the double-quoted attribute. Persian
  text, query parameters, fragments, and non-ASCII URLs keep working — the
  URL parser percent-encodes them safely before interpolation.
- **The validator accepts exactly the builder's output.**
  `isSafeTelegramHtml` decodes the href attribute value with the escaper's
  exact entity set, requires the value to BE the canonical attribute
  escaping of the decoded target (raw hazard characters and non-canonical
  entities like `&#38;` fail), and requires the decoded target to pass
  `safeHrefCanonical`. A forged or hand-mangled attribute cannot pass.
- **Runtime gate at the Bot API client.** `sendMessage` and
  `editMessageText` re-run `isSafeTelegramHtml` on the (branded) text before
  building the request: a forged TypeScript cast must not bypass the
  runtime boundary. A rejected value throws a deterministic
  `internal_error` (permanent — no retry) BEFORE any fetch is made.

## Consequences

- Attribute-injection through `telegramLink` is structurally impossible:
  quote-based breakouts, injected attributes, `<`/`>` smuggling, raw `&`,
  credentials, `http:`/`javascript:`/`data:` schemes, malformed URLs, and
  control characters are all rejected before interpolation.
- The branded `TelegramSafeHtml` type remains a compile-time aid only; the
  security boundary is the runtime validator, enforced twice (ingress send
  path and Bot API client).
- Hand-authored hrefs that a builder would never emit (raw `&`, non-canonical
  entities, dot-segments that canonicalize differently) are rejected by the
  validator — accepted HTML is exactly builder-shaped.

## Verification highlights

- adversarial cases: quote-based attribute injection, injected attributes,
  `<`/`>`, raw ampersands (encoded, never raw), credentials,
  `http:`/`javascript:`/`data:`, malformed URLs, control characters;
- valid HTTPS URLs with query parameters, fragments, and Unicode paths keep
  working (percent-encoded canonical form);
- a forged `TelegramSafeHtml` value is rejected by the Bot API client before
  fetch is called.
