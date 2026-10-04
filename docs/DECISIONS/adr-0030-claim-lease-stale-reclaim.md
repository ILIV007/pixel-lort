# ADR-0030: Claimed-update lease and stale-claim recovery

- **Status:** Accepted (completes ADR-0027; amends ADR-0025)
- **Phase:** 2A (second correction round v1.2.2)
- **Date:** 2026-10-04
- **Decided by:** Alexios

## Context

ADR-0027 made failed rows reclaimable but left `claimed` rows unrecoverable.
A row could remain in `status = 'claimed'` forever when:

- the Worker terminates after the durable claim but before the terminal
  transition;
- `markTelegramUpdateFailed` itself fails (the row stays claimed by design);
- the request is interrupted after the claim.

Every later delivery observed the row as in-flight and acknowledged a
duplicate. There was no claim lease and no stale-claim recovery — the update
was NOT actually recoverable and could be permanently lost. The correction
review also required that an in-flight delivery must NOT be acknowledged as a
successful duplicate: a 200 would let Telegram stop redelivering before any
stale-claim path could ever trigger.

## Decision

- **Schema (migration 0002 — the first schema change after 0001; ADR-0027's
  "no schema change" stance is superseded):** `telegram_updates` gains
  `claim_expires_at INTEGER` (the lease deadline), `failure_class TEXT NULL`
  (see ADR-0031), and `attempt_count INTEGER NOT NULL DEFAULT 0`, plus the
  `idx_tg_updates_lifecycle (status, claim_expires_at)` index that serves
  lease-expiry recovery scans (abandoned-claim audits and future operator
  tooling). The per-update_id hot path keeps using the primary key.
  Migration 0001 is untouched; `schema_metadata.schema_version` advances to
  2 inside 0002's atomic batch.
- **Every new claim writes a FULL lease state:** `status = 'claimed'`,
  `claim_expires_at = now + TELEGRAM_UPDATE_CLAIM_LEASE_MS`,
  `failure_class = NULL`, `attempt_count = 1`.
- **Lease duration is centralized and conservative:**
  `TELEGRAM_UPDATE_CLAIM_LEASE_MS = 5 minutes`
  (src/adapters/telegram/update-claims.ts). It is far above the bounded
  webhook processing time (Bot API calls are capped at 10 s each, single
  attempt), so a live claim is never mistaken for an abandoned one, and far
  below any operational recovery horizon. The boundary is tested at lease
  minus 1 ms (active), exact expiry (stale), and after expiry (stale). No
  wall-clock calls exist inside repositories: time is injected explicitly.
- **Six claim outcomes** (names chosen for explicitness):
  `claimed`, `reclaimed_retryable` (failed-retryable row re-claimed),
  `reclaimed_stale` (expired-lease row re-claimed), `already_processed`
  (terminal), `permanently_failed` (terminal — ADR-0031), `in_flight`
  (active unexpired lease held elsewhere).
- **Active lease → `in_flight`, and in-flight is NOT a successful
  duplicate.** The webhook answers safe retryable 503 semantics for an
  in-flight update so Telegram keeps redelivering until the lease resolves
  (the winner completes — a later delivery then observes
  `already_processed` — or the lease expires and the claim becomes
  reclaimable).
- **Expired lease → atomic stale reclaim.** A single guarded UPDATE
  (`WHERE update_id = ? AND status = 'claimed'
AND (claim_expires_at IS NULL OR claim_expires_at <= ?)`) admits EXACTLY
  ONE winner; losers re-read the winner's FRESH lease and observe
  `in_flight`. The reclaim refreshes the lease, clears `failure_class`, and
  increments `attempt_count`. A NULL lease (possible only for a pre-0002
  legacy row) is treated as already abandoned — recoverable, never stranded.
- **If marking a retryable failure fails**, the original request still
  returns 503 and the row may remain claimed; after lease expiry a later
  delivery reclaims it. The full sequence is proven by an integration test
  (503 → in-flight 503 → expiry → reclaim → processed).

## Consequences

- Abandoned claims self-heal through Telegram's own redelivery; no operator
  tooling is required for recovery, and no update can be lost to a crashed
  Worker between claim and completion.
- Concurrent duplicate deliveries now answer 503 while the claim is live.
  This trades a small amount of extra redelivery traffic (Telegram retries
  with backoff; the winner's completion turns later redeliveries into
  duplicate-acked `already_processed`) for the guarantee that no in-flight
  ambiguity is ever acknowledged as success.
- `attempt_count` gives an audit anchor for pathological redelivery loops;
  no retry CAP is imposed at this layer (Telegram's redelivery window is
  finite, and each attempt is one bounded execution).

## Verification highlights

- new claim writes lease + `failure_class = NULL` + `attempt_count = 1`;
- lease boundary: lease − 1 ms → `in_flight`; exact expiry →
  `reclaimed_stale`; after expiry → `reclaimed_stale`;
- exactly one concurrent stale-claim reclaim winner (losers `in_flight`);
- in-flight delivery through the worker webhook answers 503
  (`service_unavailable`), and the same update is processed after lease
  expiry (attempt_count 2);
- marking-failure sequence: 503 → row stays claimed → in-flight 503 →
  lease expiry → `reclaimed_stale` → processed;
- legacy lease-less (pre-0002) claimed row is reclaimable;
- processed rows are never reclaimable.
