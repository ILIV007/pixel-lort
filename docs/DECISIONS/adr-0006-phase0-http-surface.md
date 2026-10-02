# ADR-0006 — Phase 0 HTTP surface: strict allowlist routing

- **Status:** Accepted
- **Phase:** 0
- **Date:** Phase 0

## Context

Blueprint §5 enumerates the full public HTTP surface (webhook, health
variants, version) and requires that "all other paths return 404" with no
public debug or mutation endpoints. Phase 0 must expose only the health
foundation.

## Decision

- Router matches **exact** `method + path` pairs:
  `GET /health`, `GET /health/live`, `GET /health/ready`.
- Everything else — unknown paths AND unsupported methods — returns the same
  uniform safe JSON 404 (no route enumeration, no method discovery, no
  reflection of user input).
- `/health/ready` returns only `ready`/`not_ready`; reasons go to logs
  (blueprint: detailed reasons go to the owner chat in later phases).
- All responses carry `cache-control: no-store`, `x-content-type-options:
nosniff`, `referrer-policy: no-referrer`, and `x-request-id`.
- Deferred to later phases (blueprint §5): `POST /telegram/webhook` (phase 2),
  `GET /version` (phase 2, OD-004), `degraded` readiness (OD-007).

## Consequences

- The HTTP surface can only grow by explicit, reviewed allowlist entries.
- Security tests pin the uniform-404 behavior to prevent regressions.
