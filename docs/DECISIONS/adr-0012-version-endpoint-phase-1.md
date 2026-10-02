# ADR-0012 — /version endpoint lands in Phase 1 with safe build metadata

- **Status:** Accepted (closes OD-004)
- **Phase:** 0 (correction pass)
- **Date:** 2026-10-02
- **Decided by:** Alexios

## Context

Blueprint §5 specifies `GET /version` (version, build commit, schema
version). OD-004 asked when to implement it and how build metadata is
injected.

## Decision

Implement `GET /version` in **Phase 1**. It must return **safe build
metadata only**:

- application version
- commit identifier
- schema version
- deployment environment

Use development-safe defaults locally. CI/deployment metadata injection will
be finalized together with the deployment workflow (not before).

## Consequences

- `docs/ROADMAP.md` moves `GET /version` from phase 2 to phase 1.
- The endpoint exposes no secret inventory and no configuration values
  beyond the four metadata fields above.
