# ADR-0027: Retryable update reclaim semantics

- **Status:** Accepted (amends ADR-0025)
- **Phase:** 2A (correction round v1.2.1)
- **Date:** 2026-10-04
- **Decided by:** Alexios

## Context

ADR-0025 made `processed` and `failed` equally terminal: any redelivery of a
`failed` update was acknowledged as a duplicate without reprocessing, and a
processing failure answered the webhook with 200. The Phase 2A correction
review identified a permanent-update-loss defect in that model:

- A RETRYABLE failure (transient D1 outage, Telegram timeout/429/5xx, a
  missing Bot API client while an outbound action is required) marked the
  row `failed`, the webhook answered 200, and every later delivery of the
  same `update_id` was duplicate-acked forever. A temporary failure could
  therefore permanently lose an update — the exact failure mode the durable
  claim machinery exists to prevent.

## Decision

- **The claim boundary distinguishes four outcomes** on `telegram_updates`
  (no schema change; the existing `status` column is sufficient):
  - `claimed` — new delivery won the INSERT;
  - `reclaimed` — this delivery atomically transitioned a `failed` row back
    to `claimed` (retry delivery won the race);
  - `already_processed` — terminal success; acknowledged, never reprocessed;
  - `in_flight` — another delivery currently owns the row; acknowledged as a
    duplicate.
- **Failed updates are atomically reclaimable.** Reclaim is a single guarded
  UPDATE (`SET status='claimed', received_at=?, processed_at=NULL WHERE
update_id=? AND status='failed'`): exactly one concurrent caller wins;
  losers re-read the (now `claimed`) row and acknowledge as `in_flight`.
  `processed` remains TERMINAL and is never reclaimable.
- **Processing failures are classified retryable vs permanent** at the
  ingress boundary:
  - `TelegramApiError.retryable=true` (timeout, network, 429, 5xx) →
    retryable; permanent Telegram client errors (4xx, malformed responses) →
    permanent;
  - database and service-availability AppError codes (`db_query_failed`,
    `db_schema_invalid`, `service_unavailable`, `db_constraint_violation`)
    → retryable;
  - deterministic application rejections (`bad_request`, `unauthorized`,
    `not_found`, `method_not_allowed`, `payload_too_large`,
    `unsupported_media_type`, `config_invalid`, `internal_error` — e.g. a
    failed Telegram-safe HTML gate) → permanent;
  - any UNKNOWN error shape → retryable by default: a transient outage must
    never permanently lose an update. The cost of a wrong retryable guess is
    bounded (durable claims prevent double processing; Telegram's redelivery
    window is finite); the cost of a wrong permanent guess is update loss.
- **HTTP semantics:**
  - retryable failure → the row is marked `failed` (best effort, observable)
    and the handler PROPAGATES a safe AppError with HTTP 503 semantics — the
    webhook never answers 200, so Telegram redelivers and the failed row is
    reclaimed then;
  - permanent failure → the row is marked `failed` and the webhook
    ACKNOWLEDGES with 200 to avoid an infinite retry loop; logs carry only
    stable fields (update_id, event, error code, retryable flag) — never
    user text, Telegram response bodies, tokens, or secrets.
- **Authorization denial is a successfully handled action** (typed `denied`
  action), never a processing failure.
- **A missing Bot API client never fakes success.** A `noop` action
  completes without a client; an OUTBOUND action (`send_message`, `denied`,
  `answer_callback`) without a client fails retryably as
  `service_unavailable` (503). BOT_TOKEN stays optional for offline Phase 2A
  tests, but its absence can never produce a falsely processed update.

## Consequences

- A temporary D1, authorization, or Telegram API failure is retried through
  Telegram's own redelivery instead of being lost or requiring operator
  tooling.
- Retry loops are bounded by construction: Telegram only redelivers while we
  answer non-2xx, and permanent failures always answer 2xx.
- The ADR-0025 statement "failed is terminal" is superseded for redelivery
  semantics; `claimed -> failed` remains the only observable failure anchor
  and is still never overwritten in the wrong direction.

## Verification highlights

- retryable failure answers 503 and marks `failed`;
- redelivery reclaims exactly once under concurrency (exactly one
  `reclaimed` winner, others `in_flight`);
- a retried update ends `processed` and executes outbound exactly once;
- `processed` rows can never be reclaimed;
- permanent failures answer 200 and never propagate errors;
- a missing client with a required outbound action is never marked
  processed; noop updates complete offline.
