# ADR-0031: Permanent versus retryable failure persistence

- **Status:** Accepted (completes ADR-0027)
- **Phase:** 2A (second correction round v1.2.2)
- **Date:** 2026-10-04
- **Decided by:** Alexios

## Context

ADR-0027 introduced retryable/permanent classification at the HTTP boundary
but persisted both classes identically: `status = 'failed'` with no class
recorded. Every failed row was therefore reclaimable — including Telegram
400/bad_request permanent failures — and the existing test explicitly proved
that a permanent failure was re-executed on manual/redelivery. That behavior
is incorrect: a deterministic failure (bad command payload, rejected markup,
permanent Bot API client error) must never execute its action again, no
matter how often the update is delivered. Distinguishing the classes at
reclaim time requires the class to be PERSISTED, not recomputed.

## Decision

- **Migration 0002 adds `failure_class TEXT NULL`** with a CHECK constraint
  limiting values to `'retryable'` / `'permanent'` / `NULL`.
- **Retryable processing failure:** `status = 'failed'`,
  `failure_class = 'retryable'`, `claim_expires_at` cleared; the webhook
  returns 503 (ADR-0027 semantics); a later delivery may atomically reclaim
  the row (`reclaimed_retryable`) and retry.
- **Permanent processing failure:** `status = 'failed'`,
  `failure_class = 'permanent'`, `claim_expires_at` cleared; the webhook
  returns 200; the row is TERMINAL — every later duplicate/redelivery
  observes the explicit `permanently_failed` claim outcome and answers 200
  WITHOUT executing the action. The reclaim UPDATE is guarded with
  `AND failure_class = 'retryable'`, so a permanent row can never be
  reclaimed by any code path.
- **Classification logic is unchanged from ADR-0027** (TelegramApiError
  classification is authoritative; deterministic AppError codes permanent;
  UNKNOWN errors retryable by default). What changed is that the decided
  class is now persisted and enforced by the reclaim guard, making the
  no-re-execution guarantee durable across processes and deliveries.
- **The ADR-0027 test that proved a permanent failed update is repeatedly
  reclaimed was removed/rewritten**: permanent failures now execute at most
  once, ever.
- **Legacy backfill (honest, fail-safe):** rows written before 0002 carry no
  class and are indistinguishable. Migration 0002 backfills every legacy
  failed row as `'retryable'`, consistent with the fail-safe principle
  (a wrong retryable guess is bounded by durable claim ownership; a wrong
  permanent guess permanently loses the update). The bounded worst case for
  a legacy row is one extra redelivery attempt of a permanent failure.
  A hypothetical unmigrated row that somehow carries NULL class at runtime
  is treated the same way (fail-safe toward retryable) by the reclaim guard.

## Consequences

- Permanent failures are acknowledged once and never re-executed: no
  repeated denial messages, no repeated HTML-gate rejections, no repeated
  400-class Bot API calls for the same update.
- The `permanently_failed` claim outcome gives the HTTP boundary an explicit
  terminal state instead of inferring from an ambiguous `failed` row.
- Recoverability of retryable failures is preserved exactly as ADR-0027
  specified; the lease mechanics of ADR-0030 are orthogonal (they recover
  claimed rows, not failed ones).

## Verification highlights

- permanent failure executes once only (counting client: one attempt, ever);
- later duplicates return 200 without executing (`permanently_failed` at
  repository level, `failed` at pipeline level, 200 at the webhook edge);
- retryable failures remain reclaimable (atomic, exactly one concurrent
  winner);
- permanent failed rows are never reclaimable, even under concurrency;
- processed rows are never reclaimable;
- legacy failed rows are backfilled retryable and stay recoverable;
- CHECK constraints reject bogus classes and negative attempt counts.
