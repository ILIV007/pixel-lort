# ADR-0025: Durable Telegram update idempotency on telegram_updates

- **Status:** Accepted
- **Phase:** 2A
- **Date:** 2026-10-04
- **Decided by:** Alexios

## Context

Telegram delivers updates at-least-once: retries, network duplicates, and
redeliveries are normal. The blueprint (§9) requires durable deduplication in
D1 keyed by `update_id`, with duplicate deliveries acknowledged without side
effects. The `telegram_updates` table (approved schema, migration 0001)
already provides the needed shape: `update_id` primary key, `received_at`,
`processed_at`, and a `status` CHECK in ('claimed','processed','failed').

## Decision

- **update_id is the idempotency boundary.** Each verified update first
  attempts a durable claim: `INSERT INTO telegram_updates (update_id,
received_at, status) VALUES (?, ?, 'claimed')`. Exactly one delivery wins;
  the primary key serializes concurrent claims, and losers observe the
  constraint violation and read back the winner's status (duplicate).
- **State machine:** `claimed -> processed` and `claimed -> failed`, both
  guarded by `WHERE status = 'claimed'` so terminal states are never
  overwritten. `processed` and `failed` are TERMINAL in Phase 2A: duplicate
  redeliveries are acknowledged without reprocessing (blueprint §9: "200 on
  duplicates, no side effects").
- **Failed processing is observable and recoverable — by operators, not by
  redelivery.** A duplicate of a failed update is still a duplicate (no
  automatic reprocessing), so recovery is an explicit operator action in a
  later admin slice (e.g. a re-queue tool in Phase 9); the stable `failed`
  status plus fail-safe log codes are the observable trail. If even the
  failure marking fails, the row remains `claimed` — also observable, never
  falsely processed.
- **Transient claim failures are NOT claimed.** A D1 failure during the
  claim insert surfaces as a mapped AppError (safe 5xx); nothing is marked,
  and because nothing was durably claimed, a Telegram redelivery retries
  the update from scratch.
- **HTTP semantics:** once an update IS durably claimed, the webhook answers
  a fast deterministic 2xx regardless of the processed/failed terminal
  state. A 5xx after claiming would only trigger a redelivery that is
  duplicate-acked without reprocessing — noise without benefit. The D1 row
  is the source of truth.
- **No KV, no memory:** D1 is the only dedup authority (blueprint §2);
  there is no in-memory dedup layer.
- **Parameterized SQL only; no payload storage.** The schema stores only
  update_id, timestamps, and the status word — no Telegram payload content
  is persisted (and none may be added without a schema ADR).
- The orchestration lives in `src/application/telegram-ingress.ts`; the D1
  statements live in `src/adapters/telegram/update-claims.ts` behind the
  typed DbExecutor boundary (ADR-0022).

## Consequences

- Exactly-once command execution per update_id is guaranteed for the admin
  panel commands (proven by counting-fake-client tests for sequential and
  concurrent redeliveries).
- A failed update needs an operator/future-admin recovery path; this is
  recorded as deferred work for the Phase 9 admin screens slice, not as an
  open design question.
