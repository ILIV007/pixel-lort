# ADR-0010 — Zod introduced in Phase 3 for envelope contracts

- **Status:** Accepted (closes OD-002)
- **Phase:** 0 (correction pass)
- **Date:** 2026-10-02
- **Decided by:** Alexios

## Context

Blueprint §12 mandates Zod parsing for AI provider outputs. The Phase-0
configuration validator is deliberately dependency-free (ADR-0003). OD-002
asked when Zod should be introduced.

## Decision

Zod is introduced in **Phase 3**, when queue envelopes and durable job
payload contracts are implemented. It is reused later for AI structured
outputs in **Phase 6**. The current lightweight configuration validator MAY
remain dependency-free; it does not have to switch to Zod.

## Consequences

- Phase 3 adds the first (and only planned new) runtime dependency.
- Phase 6 reuses the same schema library for AI output contracts.
- The hand-rolled config validator stays as-is until a phase explicitly
  replaces it (which would need its own ADR).
