# ADR-0004 — Structured JSON-line logging with mandatory key redaction

- **Status:** Accepted
- **Phase:** 0
- **Date:** Phase 0

## Context

Blueprint §22 requires redacting tokens, cookies, headers, and private
message content from logs. The Worker needs observability without a logging
vendor dependency, and logs must be deterministic and testable.

## Decision

- One logging module (`src/observability/logger.ts`), the only `console`
  writer (lint-enforced elsewhere).
- JSON lines: `{ts, level, msg, ...fields}` written via `console.debug/info/
warn/error`, consumed by `wrangler tail` / Workers Logs.
- **Mandatory key-based redaction before serialization** via
  `src/shared/security/sensitive-keys.ts`: matches whole names and camel/
  kebab/snake words for `authorization`, `cookie(s)`, `token`, `apiKey`,
  `api_key`, `secret`, `password`, `telegramBotToken` and variants.
  Over-redaction is preferred over leakage.
- Bounded traversal (depth ≤ 6, entries ≤ 100) so hostile structures cannot
  exhaust CPU.
- `fields.error` values serialize to `{name, message, stack}` — logs only,
  never HTTP responses.
- Injected `clock`/`sink` make logging deterministic in tests.

## Consequences

- Callers may accidentally pass sensitive fields; the redaction layer catches
  them. Callers must still never pass bodies, headers, or env objects.
- Some harmless keys (e.g., `pageToken`) are redacted — accepted trade-off.
