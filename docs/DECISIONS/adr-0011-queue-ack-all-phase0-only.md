# ADR-0011 — Queue ack-all approved ONLY for the non-deployed Phase 0 skeleton

- **Status:** Accepted (closes OD-003; amends ADR-0007)
- **Phase:** 0 (correction pass)
- **Date:** 2026-10-02
- **Decided by:** Alexios

## Context

The Phase-0 queue handler acknowledges every message (ADR-0007) so a
hypothetical skeleton deployment cannot cause unbounded redelivery. OD-003
asked the owner to confirm the replacement plan and deployment constraints.

## Decision

The ack-all placeholder is **approved only for the non-deployed Phase 0
skeleton**. It MUST be replaced before any real queue consumer is bound or
deployed. **No intermediate deployment with ack-all behavior is allowed.**

## Consequences

- Phase 3 (job/queue framework) replaces ack-all with claim/lease/idempotent
  processing and explicit per-message ack/retry.
- Binding a real queue to this handler while it still acks-all is a review
  blocker; this ADR is the recorded gate.
- Phase 0 remains non-deployed, so the placeholder never runs in production.
