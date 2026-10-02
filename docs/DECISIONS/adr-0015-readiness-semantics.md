# ADR-0015 — Readiness semantics: ready / degraded / not_ready

- **Status:** Accepted (closes OD-007)
- **Phase:** 0 (correction pass)
- **Date:** 2026-10-02
- **Decided by:** Alexios

## Context

Blueprint §5 allows `ready/degraded/not_ready`. Phase 0 can only emit
`ready`/`not_ready`. OD-007 asked which failures constitute `degraded` versus
`not_ready` once subsystem checks exist.

## Decision

- **`ready`** — all required core dependencies for the deployed phase are
  functional.
- **`degraded`** — core publishing control remains safe and functional, but
  a non-critical source, optional provider, fallback provider, or optional
  media subsystem is unavailable.
- **`not_ready`** — required configuration is missing, or a core dependency
  required for safe operation is unavailable.

Core dependencies in later phases include: required Telegram authentication,
D1, and any queue path required by enabled publishing workflows.

## Consequences

- `degraded` semantics arrive with phase 2+ subsystem checks; phase 0 keeps
  emitting only `ready`/`not_ready`.
- Readiness bodies stay minimal (status words only); reasons go to logs.
