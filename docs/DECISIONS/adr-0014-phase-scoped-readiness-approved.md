# ADR-0014 — Phase-scoped fail-closed readiness is approved

- **Status:** Accepted (closes OD-006; confirms ADR-0008)
- **Phase:** 0 (correction pass)
- **Date:** 2026-10-02
- **Decided by:** Alexios

## Context

Blueprint §1.10 requires fail-closed readiness. ADR-0008 proposed gating
each secret/binding from the phase that consumes it (OD-006 asked for
confirmation).

## Decision

**Phase-scoped fail-closed readiness is approved.** A credential or binding
becomes required when the feature consuming it is introduced.

## Consequences

- ADR-0008 is confirmed and stays in force; OD-006 is closed.
- Adding a feature phase without adding its readiness gate violates
  fail-closed behavior — enforced by review and AGENTS.md rules.
