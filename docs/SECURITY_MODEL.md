# Security Model

This document defines the security boundaries implemented or planned by
Pixel. The blueprint (§22) remains authoritative; this file is the operational
digest.

## 1. Secret boundaries

| Boundary                                              | Rule                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Source code                                           | Secrets NEVER appear in source, fixtures, docs, tests, or comments.       |
| wrangler.jsonc                                        | Vars only (non-secret). No secret values, no secret-shaped strings.       |
| Deployment secrets                                    | `wrangler secret put <NAME>` or Cloudflare dashboard only.                |
| Local development                                     | `.dev.vars` (git-ignored); template `.dev.vars.example` has empty values. |
| Logs / audit metadata / callback data / query strings | Secrets are never written to any of these.                                |
| Environment object                                    | Never printed, logged, or serialized (in whole or per-variable values).   |

- Secret NAMES are contract (`PixelSecrets` in `src/shared/types/env.ts`);
  the future secret catalog with owning phases lives in
  `src/shared/config/phase0.ts`. `TARGET_CHANNEL` is non-secret
  configuration (ADR-0009) and is intentionally absent from the catalog.
- `.env.example` contains variable names and empty placeholders only.
- `npm run scan:secrets` (part of `npm run check`) fails the gate on
  credential-shaped strings in tracked files and never prints matched
  content. Coverage includes Telegram, OpenAI-style, Google, AWS, GitHub
  legacy (`ghp_/gho_/ghu_/ghs_/ghr_`) and fine-grained (`github_pat_`)
  tokens, Cloudflare user/account tokens (`cfut_`/`cfat_`), Groq keys
  (`gsk_`), Slack tokens, private-key blocks, and Bearer literals
  (ADR-0018). An automated self-test (`npm run test:secrets`, also part of
  `npm run check`) proves detection, placeholder safety, no-value-leak
  reporting, and non-zero exit on findings.

## 2. Logging and redaction rules

- All Worker logging flows through `src/observability/logger.ts`
  (lint blocks other `console` usage). One JSON object per line.
- Values whose keys look sensitive are replaced with `[REDACTED]` BEFORE
  serialization. Required redaction targets include: `authorization`,
  `cookie`, `token`, `apiKey`, `api_key`, `secret`, `password`,
  `telegramBotToken` (plus common variants; see
  `src/shared/security/sensitive-keys.ts`). Over-redaction is preferred.
- **Fail-safe error logging (ADR-0017):** key-based redaction is NOT the
  only defense. Error instances found at ANY depth are reduced to safe
  fields (`errorKind`, `name`, stable `code`, `httpStatus`) by
  `src/observability/safe-error.ts`. Raw unknown Error messages, stacks,
  causes, response bodies, and provider payloads are NEVER emitted — even
  when embedded inside strings under non-sensitive keys. Arbitrary thrown
  values are never stringified.
- Never log: request bodies, authorization headers, cookies, full environment
  objects, Telegram update payloads, provider responses.
- HTTP request logs contain method + path only — **never the query string**.
- **Failed-request levels (ADR-0017):** expected 4xx application errors log
  ONE concise `warn` event (code + status); only unexpected 5xx errors log
  at `error` level. Neither path exposes raw stacks or arbitrary thrown
  values. The default logger emits no raw stack traces at all.
- **Database observability (ADR-0022, Phase 1A):** all D1 access flows
  through `src/adapters/db/`. Logs carry ONLY stable operation names,
  durations, result counts, and stable error codes. SQL text and bind
  parameters are NEVER logged (parameters may carry user or source content);
  full rows are NEVER logged. D1 driver errors are classified into stable
  codes (`db_constraint_violation`, `db_schema_invalid`,
  `db_query_failed`); raw driver messages are never surfaced or serialized,
  and migration errors never print secrets or environment objects.
- HTTP error BODIES are produced exclusively by
  `src/shared/errors/serialize.ts`: code + safe message + requestId +
  sanitized details — unchanged by the logging policy.
- Redaction traversal is depth- and size-bounded against hostile input.
- **Telegram event logging (Phase 2A, ADR-0024/0025/0026):** webhook and
  pipeline logs carry stable event names, reason codes, action types, role
  names, and update_id (the idempotency key) ONLY. Request bodies, message
  text, captions, usernames, phone numbers, chat and user ids, callback
  data, the Bot Token, and the webhook secret are NEVER logged — verified
  by canary tests. Bot API client logs contain the method name and a stable
  error code; raw Telegram descriptions are discarded.

## 3. Trust boundaries

| Boundary                    | Posture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Telegram webhook (Phase 2A) | Untrusted until `x-telegram-bot-api-secret-token` passes TIMING-SAFE comparison (fresh-key HMAC-SHA256 over both inputs via Web Crypto — ADR-0024); route exists only behind the fail-closed ingress flag with valid config; JSON content type + TRUE bounded 64 KiB body reading (strict Content-Length pre-check, streamed byte cap that stops and cancels after the limit, strict UTF-8 — ADR-0028); the body is read only after the caller is verified; duplicate updates are harmless no-ops (durable D1 claims — ADR-0025); retryable processing failures propagate 503 so Telegram redelivery reclaims the failed row — a temporary failure never permanently loses an update (ADR-0027). |
| Incoming request IDs        | Honored only if strictly well-formed; otherwise regenerated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Source content              | Untrusted data: SSRF guards (private/loopback/metadata IP ranges, redirect cap 2, revalidation), XML external entities disabled, HTML treated as data, byte caps, timeouts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Admin actions (Phase 2A)    | Fail-closed authorization with the approved atomic permission map; owner resolves ONLY via a valid OWNER_TELEGRAM_ID bootstrap identity; disabled admins and unknown users unauthorized; numeric user IDs only; callback data is an opaque `a:<token>` (≤ 64 bytes) resolved server-side through single-use, user-bound, expiring `admin_action_tokens` whose inputs are validated before any database access (ADR-0026); commands explicitly addressed to another bot are ignored.                                                                                                                                                                                                              |
| AI providers (planned)      | Source text isolated as untrusted prompt data; secrets/admin IDs/private messages never sent; outputs schema- AND semantically validated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Media hosts (planned)       | HTTPS-only, positive host allowlist when feasible, MIME/signature over extension trust, rights gates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Planned boundaries are marked planned; they are enforced when their phase
implements the related feature (see `docs/ROADMAP.md`).

## 4. Preview vs production expectations

- Phase 0: no deployments at all. `npm run build` is an offline dry-run.
- Later phases: preview and production are separate Workers environments with
  separate resources and separately configured secrets (planned names:
  Workers `pixel` / `pixel-preview`; resources `pixel-*-production` /
  `pixel-*-preview` — ADR-0016, closed OD-008). No resources were created in
  Phase 0 or the correction pass.
- Production readiness (`/health/ready`) is fail-closed per feature phase:
  missing configuration or secrets for an active feature => `not_ready`
  (ADR-0008, approved by ADR-0014). Readiness semantics for
  `ready/degraded/not_ready` are fixed by ADR-0015.
- **Phase 2 gating (ADR-0024):** any present-but-invalid Phase 2 value fails
  readiness in every environment. While `TELEGRAM_INGRESS_ENABLED` is
  `true`, `WEBHOOK_SECRET` and `OWNER_TELEGRAM_ID` are REQUIRED and a D1
  binding must exist; without `BOT_TOKEN` the ingress runs in documented
  OFFLINE mode (no live calls) until the Phase 2B gate. No Cloudflare
  secrets are configured in Phase 2A and the flag ships `false`.
- No public debug/mutation endpoints exist in any phase; the Telegram admin
  panel is the only administration UI in v1.

## 5. Prohibited practices

- Committing credentials or realistic token-shaped examples — anywhere.
- Logging or printing secret values, environment objects, or request bodies.
- Weakening TLS or certificate validation in any HTTP client.
- Executing remote scripts fetched from sources (sources are data, not code).
- Storing secrets in KV, D1, callback data, or query strings.
- Passing raw/untrusted HTML to Telegram: outbound text is composed with the
  escaper/builders and re-validated by the bounded allowlist validator
  before every send, and the Bot API client re-validates at runtime so a
  forged branded value cannot bypass the boundary (ADR-0026/0029). Link
  targets must survive URL-parsed validation (https only, no credentials,
  no attribute-hazard characters), canonicalization, and attribute escaping
  before interpolation (ADR-0029).
- Automatic retries of Telegram API calls (retry storms): the client makes a
  single attempt per call and classifies errors for future policies.
- Buffering an untrusted body before the limit applies: webhook request
  bodies and Telegram API responses are read through the shared bounded
  stream reader — the byte cap is enforced during streaming, the stream is
  cancelled once crossed, and Content-Length is only an early, untrusted
  gate (ADR-0028).
- Acknowledging a retryably-failed update with 200: retryable processing
  failures propagate 503 semantics so Telegram redelivery reclaims the
  failed row; only permanent failures are acknowledged (ADR-0027).
