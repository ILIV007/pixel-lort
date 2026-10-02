# ADR-0007 — Phase 0 cron/queue handlers are typed no-ops that ack-all

- **Status:** Accepted (amended by ADR-0011)
- **Phase:** 0
- **Date:** Phase 0

## Context

The Worker entrypoint must expose typed `scheduled` and `queue` handlers from
the start (runtime topology requires them), but Phase 0 implements no
business workflow and no resources exist that could deliver events.

## Decision

- `scheduled` logs the trigger (cron expression, scheduled time) and does
  nothing else. Real due-work dispatch arrives with the job framework phase.
- `queue` logs `queue` name and message **count** (never bodies or envelopes)
  and calls `message.ack()` for each message. Rationale: Queues is
  at-least-once; a skeleton consumer that neither acks nor processes would
  cause unbounded redelivery if ever deployed. Ack-all is the smallest safe
  placeholder.
- The replacement semantics (D1 claim with lease, explicit per-message
  ack/retry, idempotency keys) are defined by blueprint §7 and are tracked
  for roadmap phase 3 (OD-003, closed by ADR-0011: ack-all is approved ONLY
  for the non-deployed Phase 0 skeleton and MUST be replaced before any real
  queue consumer is bound or deployed).

## Consequences

- Smoke tests pin the no-op behavior (no `waitUntil` side effects; every
  message acked exactly once).
- ADR/OD trail makes it explicit that ack-all MUST NOT survive into phase 3.
