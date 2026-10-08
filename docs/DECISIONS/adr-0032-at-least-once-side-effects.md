# ADR-0032: Honest at-least-once semantics for external Telegram side effects

- **Status:** Accepted (amends the wording of ADR-0025; complements
  ADR-0027; amended in the final correction round v1.2.3 — fenced terminal
  transitions and honest acknowledgement)
- **Phase:** 2A (second correction round v1.2.2; final correction round v1.2.3)
- **Date:** 2026-10-04
- **Decided by:** Alexios

## Context

ADR-0025 stated "exactly-once command execution per update_id is
guaranteed" for admin commands. That wording over-claims. There is an
unavoidable AMBIGUOUS WINDOW for every externally visible side effect:

1. Telegram accepts the `sendMessage` call (the message is delivered);
2. the Worker loses the response (crash, timeout after the server processed
   the call) or the D1 `processed` transition fails;
3. the next delivery (redelivery after 503, or stale-lease reclaim) may send
   the message AGAIN.

Telegram's Bot API provides no application-provided idempotency key for
`sendMessage`: once accepted, a message cannot be retractable or deduplicated
by us. Exactly-once DATABASE claim ownership therefore does not imply
exactly-once TELEGRAM MESSAGE DELIVERY, and the documentation must never
claim otherwise.

## Decision

- **The delivery contract is stated honestly, everywhere:**
  durable AT-LEAST-ONCE processing with duplicate suppression BEFORE
  execution, plus BOUNDED DUPLICATE RISK for ambiguous external side
  effects. The durable `update_id` claim makes every EXECUTION DECISION a
  single winner (deterministic `update_id` deduplication is preserved); it
  cannot make an external side effect retractable.
- **The ambiguous window is a tested, documented scenario:** an integration
  test proves that when the outbound send SUCCEEDS but the processed
  transition fails (and the failure marking fails too), the message has been
  delivered once, the row remains claimed, and after lease expiry the next
  delivery re-executes the action — the message is delivered a SECOND time.
  Duplicate suppression resumes after the terminal transition.
- **Terminal-transition uncertainty answers 503, never a false 200
  (amendment, final correction round v1.2.3):** HTTP 200 is emitted only
  after a terminal state is durably persisted. A processed transition that
  is rejected by the attempt_count generation fence (a newer owner
  reclaimed the row) or fails with a storage error produces safe retryable
  HTTP 503 semantics — even though the outbound action may already have
  executed (that is exactly the bounded duplicate risk this ADR documents,
  never a false success). The same rule covers the permanent-failure path:
  the 200 acknowledgement happens only after `failure_class = 'permanent'`
  is durably stored (see ADR-0031).
- **No false exactly-once guarantee:** ADR-0025's "exactly-once execution"
  wording is superseded (see the amendment note there). Architecture,
  security model, roadmap, and handoff texts use the honest contract
  wording. (ADR-0007's queue ack-all wording is unrelated to Telegram side
  effects and stays untouched.)
- **Roadmap requirement recorded:** before autonomous channel publishing is
  enabled (Phase 8+), a publishing-side duplicate mitigation and
  reconciliation layer is REQUIRED — e.g. the planned `publications` /
  `publication_messages` outbox with per-message reconciliation — so that
  channel-facing posts carry stronger at-most-once protection than raw
  webhook responses. No full outbox is implemented in this correction: the
  existing architecture does not yet support it safely (no publishing
  exists).

## Consequences

- Operators and future phases reason from a truthful model: duplicates are
  SUPPRESSED before execution (normal case) and BOUNDED after ambiguous
  failures (rare, only within the ambiguous window, and only until the next
  terminal transition).
- The cost asymmetry is explicit: suppressing a re-execution after an
  ambiguous failure would require remembering the unrecorded side effect
  (impossible without an outbox); allowing the bounded duplicate keeps the
  at-least-once guarantee, which the editorial workflows of Phase 3+ can
  build upon.
- Autonomous publishing stays BLOCKED until the roadmap mitigation exists —
  recorded in `docs/ROADMAP.md` as a gating item.

## Verification highlights

- the ambiguous-window integration test proves the documented duplicate-send
  scenario end to end (send → processed-transition failure → 503 → lease
  expiry → reclaim → second send → processed → duplicates suppressed);
- sequential/concurrent duplicate-delivery tests continue to prove exactly
  one EXECUTION DECISION per update_id under the normal (non-ambiguous)
  path;
- fenced-transition tests (v1.2.3): a rejected or failed terminal
  transition answers 503, never a false 200; no processed success log is
  emitted unless the transition returned true;
- documentation greps: active docs describe at-least-once processing with
  duplicate suppression and bounded duplicate risk; no active document
  claims exactly-once Telegram delivery.
