# ADR-0017 — Fail-safe error logging and 4xx/5xx observability policy

- **Status:** Accepted (amends ADR-0004)
- **Phase:** 0 (correction pass)
- **Date:** 2026-10-02
- **Decided by:** Alexios (Phase 0 review)

## Context

The Phase-0 logger serialized raw `Error.message`, `Error.stack`, and
`Error.cause` for log lines. Key-based redaction cannot protect secrets
embedded INSIDE a string: `new Error("provider request failed using token
<secret>")` has the non-sensitive key `message`, yet the value contains a
credential that would reach Cloudflare logs. Additionally, a routine 404
produced an error-level log with a full stack trace — noise that hides real
incidents.

## Decision

**Error logging is fail-safe; key-based redaction is no longer the only
defense.**

- Production-style logging must NOT serialize raw unknown Error messages,
  stacks, causes, response bodies, or provider payloads — at any depth.
- The default logger emits only safe fields: error name, stable application
  code, HTTP status, and correlation ID. `src/observability/safe-error.ts`
  is the single fail-safe serializer (`toSafeErrorFields`).
- Known AppError codes MAY be logged (author-controlled constants).
- Raw stack traces are NOT emitted by the default logger at all.
- Error instances found ANYWHERE in log fields (not only under `error`) are
  reduced to safe fields by the redaction walk.

**Failed-request observability policy:**

- Expected 4xx application errors produce ONE concise `warn` event
  (`http.request.client_error`) with stable code + HTTP status.
- Unexpected 5xx errors may use `error` level — still fail-safe fields only.
- Neither path exposes raw stacks or arbitrary thrown values.
- HTTP responses are unchanged and remain governed by
  `src/shared/errors/serialize.ts`.

## Consequences

- Stack-trace debugging moves to runtime-native mechanisms (uncaught
  exception reporting in Workers Logs) instead of application log lines.
- `serializeError` (name/message/stack/cause output) was removed; tests pin
  the new behavior, including token-like strings in message/stack/cause.
- ADR-0004's error serialization bullet is superseded by this ADR.
