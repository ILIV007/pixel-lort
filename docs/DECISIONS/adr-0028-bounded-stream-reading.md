# ADR-0028: Bounded request and response stream reading

- **Status:** Accepted
- **Phase:** 2A (correction round v1.2.1)
- **Date:** 2026-10-04
- **Decided by:** Alexios

## Context

Both untrusted body-reading boundaries previously buffered the COMPLETE body
before any limit was applied:

- the Telegram webhook used `request.text()` and only then checked the byte
  count against the 64 KiB cap, and
- the Bot API client used `response.text()` (Content-Length checked early
  where present, but the full response was still allocated first).

`await text()` cannot bound allocation: a hostile or broken peer can force
the worker to buffer an arbitrarily large body before a single limit check
runs. The correction review requires TRUE bounded reading — the limit must
be enforced on actual BYTES during streaming, with the stream cancelled as
soon as the cap is crossed, and the rule must not be claimed as bounded
unless it is bounded before full allocation.

## Decision

- **One shared primitive** (`src/shared/http/bounded-reader.ts`) serves both
  boundaries: `readStreamBounded(body, maxBytes)` reads a
  `ReadableStream<Uint8Array>` up to `maxBytes` INCLUSIVE, stops consuming
  and CANCELS the reader immediately after the first chunk that crosses the
  cap, and never retains content beyond `maxBytes` plus one chunk.
- **Content-Length is an early gate, never the authority.**
  `parseContentLengthHeader` accepts only digits-only values; negative,
  non-integer, empty, or non-numeric declarations are rejected before any
  byte is read (safe 400), oversized declarations are rejected before any
  byte is read (safe 413 / response-invalid), and a declared-but-lying
  length changes nothing because the streaming cap applies regardless.
- **Strict UTF-8 decoding** (`decodeUtf8Strict`, fatal TextDecoder): a
  malformed byte sequence fails with a stable reason instead of silently
  introducing U+FFFD replacement characters and parsing "successfully".
- **Webhook application:** the declared Content-Length is checked after
  secret + content-type verification, then the body is read through the
  bounded reader with the existing 64 KiB cap; overflow → 413, malformed
  UTF-8 → 400. Body content is never logged.
- **Bot API client application:**
  - every Telegram API request is sent with `redirect: "error"`; a redirect
    failure is mapped to the retryable network-error class and never exposes
    the token, the request URL, or the redirect target (the fail-safe logger
    strips raw causes);
  - declared Content-Length is checked early when present (invalid or
    oversized → `telegram_response_invalid` before any read);
  - the response is streamed under `MAX_TELEGRAM_RESPONSE_BYTES` (1 MiB) on
    BOTH the success path and the error/429 payload path; overflow or
    malformed UTF-8 → `telegram_response_invalid`; a mid-stream transport
    failure → retryable `telegram_network_error`;
  - `retry_after` parsing remains bounded and safe: an unreadable or
    oversized error payload only means "no retry_after", never a mask of the
    classified status error;
  - response bodies are never logged.

## Consequences

- Allocation is bounded by `maxBytes` plus one chunk at both boundaries — no
  code path buffers an untrusted body before the limit applies.
- The 64 KiB webhook cap and the 1 MiB Telegram-response cap are enforced on
  bytes, immune to lying or absent `Content-Length` headers.
- Cancellation propagates promptly to the peer (the producer is signalled to
  stop), instead of silently draining the remainder.

## Verification highlights

- oversized body with no Content-Length → 413; lying small Content-Length
  with an oversized stream → 413; oversized declared → 413 before parsing;
  invalid declarations → 400; exact-limit accepted; limit+1 rejected;
- the reader cancels and consumes no further chunks after overflow;
- malformed UTF-8 rejected at both boundaries;
- client requests carry `redirect: "error"`; oversized/lying/invalid
  response declarations and streamed overflow → `telegram_response_invalid`;
  exact-limit response accepted; token and response content absent from
  every log and error serialization.
