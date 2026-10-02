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

## 3. Trust boundaries

| Boundary                   | Posture                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram webhook (planned) | Untrusted until `x-telegram-bot-api-secret-token` passes constant-time comparison; POST + JSON + size caps; duplicate updates are harmless no-ops.                          |
| Incoming request IDs       | Honored only if strictly well-formed; otherwise regenerated.                                                                                                                |
| Source content             | Untrusted data: SSRF guards (private/loopback/metadata IP ranges, redirect cap 2, revalidation), XML external entities disabled, HTML treated as data, byte caps, timeouts. |
| Admin actions              | Fail-closed authorization with atomic permissions; opaque one-time callback tokens bound to one user; destructive actions require confirmation tokens.                      |
| AI providers (planned)     | Source text isolated as untrusted prompt data; secrets/admin IDs/private messages never sent; outputs schema- AND semantically validated.                                   |
| Media hosts (planned)      | HTTPS-only, positive host allowlist when feasible, MIME/signature over extension trust, rights gates.                                                                       |

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
- No public debug/mutation endpoints exist in any phase; the Telegram admin
  panel is the only administration UI in v1.

## 5. Prohibited practices

- Committing credentials or realistic token-shaped examples — anywhere.
- Logging or printing secret values, environment objects, or request bodies.
- Weakening TLS or certificate validation in any HTTP client.
- Executing remote scripts fetched from sources (sources are data, not code).
- Storing secrets in KV, D1, callback data, or query strings.
