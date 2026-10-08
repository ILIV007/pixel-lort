# src/application — use cases and workflows

Application use cases that orchestrate domain ports. Do not import
Cloudflare-specific types from this layer — depend on ports and inject
adapters instead (blueprint §3).

Implemented in Phase 2A (lifecycle completed through the final correction
round v1.2.3):

- `telegram-ingress.ts` — the durable Telegram update lifecycle:
  claim by update_id (duplicates of processed updates acknowledged without
  reprocessing) -> fail-closed actor resolution -> command routing to TYPED
  actions -> action execution through the injected Bot API client ->
  GENERATION-FENCED terminal transition (processed | failed).
  Logs carry stable events, update_id, action types, and role names only.
  Contract details (final correction round v1.2.3):
  - OFFLINE MODE: a `noop` action may complete without a Bot API client; an
    OUTBOUND action (`send_message` / `denied` / `answer_callback`) without
    BOT_TOKEN is a RETRYABLE `service_unavailable` (safe 503 semantics) — it
    is never silently skipped and marked processed.
  - FENCING: `attempt_count` is the claim GENERATION (fencing token), not
    merely an audit counter. Every execution-owning claim outcome carries
    its generation, and every terminal transition is guarded by it
    (`AND attempt_count = ?`), so a stale Worker resuming after a newer
    reclaim can never mutate the newer owner's claim.
  - HONEST ACKNOWLEDGEMENT: HTTP 200 is emitted only after a terminal state
    is durably persisted. Terminal-transition uncertainty — a transition
    rejected by the generation fence (stale owner) or failed by a storage
    error — produces safe retryable HTTP 503 semantics, never a false
    success, even when the outbound action already executed.
