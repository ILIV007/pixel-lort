# ADR-0021: Phase 1A readiness behavior for schema health

- **Status:** Accepted
- **Date:** 2026-10-02 (Phase 1A)
- **Decides:** exactly how `GET /health/ready` behaves for the Phase 1A
  data foundation, without inventing Phase 1B production-binding behavior.

## Context

Phase 1A has a LOCAL D1 placeholder binding (ADR-0019) but no Cloudflare
resource. Ordinary offline development and CI must not fail merely because a
real remote D1 does not exist, while readiness must still fail closed on
genuinely broken state. This refines the general semantics of ADR-0015 for
Phase 1A scope only.

## Decision

`GET /health/ready` reports:

- **not_ready (503)** when:
  - configuration validation fails (Phase 0 surface), or
  - Phase 1A build/schema metadata is invalid (APP_COMMIT / SCHEMA_VERSION
    per ADR-0020), or
  - **a D1 binding IS present** and the schema health check fails: the
    `schema_metadata` table/rows are missing, unreadable, or the recorded
    `schema_version` mismatches the configured `SCHEMA_VERSION`.
- **ready (200)** when the configuration is valid and either no D1 binding
  exists (offline mode — the Phase 1A normal state) or the binding exists
  and the applied schema matches the configured version.

Failure REASONS are logged as stable codes only (`config_invalid`,
`metadata_config_invalid`, `schema_missing_metadata`,
`schema_version_mismatch`, `schema_query_failed`); response bodies stay the
minimal `{ ok, service, status }` shape.

## Consequences

- Fresh local databases report `not_ready` until migrations are applied
  (`npm run db:migrations:apply`) — actionable, not permanent.
- CI and offline tests apply migrations via the test helper and observe
  `ready`.
- Phase 1B will extend (not rewrite) this behavior when real bindings and
  environments exist.
