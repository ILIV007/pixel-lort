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
  `src/shared/config/phase0.ts`.
- `.env.example` contains variable names and empty placeholders only.
- `npm run scan:secrets` (part of `npm run check`) fails the gate on
  credential-shaped strings in tracked files and never prints matched content.

## 2. Logging and redaction rules

- All Worker logging flows through `src/observability/logger.ts`
  (lint blocks other `console` usage). One JSON object per line.
- Values whose keys look sensitive are replaced with `[REDACTED]` BEFORE
  serialization. Required redaction targets include: `authorization`,
  `cookie`, `token`, `apiKey`, `api_key`, `secret`, `password`,
  `telegramBotToken` (plus common variants; see
  `src/shared/security/sensitive-keys.ts`). Over-redaction is preferred.
- Never log: request bodies, authorization headers, cookies, full environment
  objects, Telegram update payloads, provider responses.
- HTTP request logs contain method + path only — **never the query string**.
- Error stacks may appear in logs (private tail/Workers Logs), NEVER in HTTP
  responses. Error bodies are produced exclusively by
  `src/shared/errors/serialize.ts`: code + safe message + requestId +
  sanitized details.
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
  separate resources and separately configured secrets (naming: OD-008).
- Production readiness (`/health/ready`) is fail-closed per feature phase:
  missing configuration or secrets for an active feature => `not_ready`
  (ADR-0008, OD-006).
- No public debug/mutation endpoints exist in any phase; the Telegram admin
  panel is the only administration UI in v1.

## 5. Prohibited practices

- Committing credentials or realistic token-shaped examples — anywhere.
- Logging or printing secret values, environment objects, or request bodies.
- Weakening TLS or certificate validation in any HTTP client.
- Executing remote scripts fetched from sources (sources are data, not code).
- Storing secrets in KV, D1, callback data, or query strings.
