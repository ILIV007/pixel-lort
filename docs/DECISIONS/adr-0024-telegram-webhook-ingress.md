# ADR-0024: Secure Telegram webhook ingress and Phase 2 configuration gating

- **Status:** Accepted
- **Phase:** 2A
- **Date:** 2026-10-04
- **Decided by:** Alexios

## Context

Phase 2A adds `POST /telegram/webhook` — the system's first untrusted,
unauthenticated-by-default network surface. Telegram delivers a shared secret
in `X-Telegram-Bot-Api-Secret-Token`; the blueprint (§22) requires
constant-time comparison, POST/JSON enforcement, body caps, and no payload
logging. The rollout must work fully offline (no Telegram credentials exist
in Phase 2A) while preview/production stay honest once ingress is enabled.

## Decision

- **Fail-closed ingress flag.** The route exists only while
  `TELEGRAM_INGRESS_ENABLED` (non-secret var, default `false`) is `'true'`
  AND the Phase 2 configuration is fully valid. A disabled or misconfigured
  ingress behaves EXACTLY like an unknown route (uniform safe 404 —
  ADR-0006 posture); probing reveals neither route existence nor config
  state. Non-POST methods on the path fall through to the same 404.
- **Timing-safe secret comparison.** Plain-string comparison is rejected.
  Both inputs are signed with a fresh per-comparison, non-extractable
  HMAC-SHA256 key (Web Crypto `importKey` + `sign`) and only the 32-byte
  digests are compared in a fixed 32-iteration XOR loop. The HMAC step
  normalizes lengths and removes any length/prefix oracle; digest equality
  under the same key implies exact input equality. Standard Web Crypto only
  — no Node-only APIs.
- **Request lifecycle (fail-closed order):** secret → content type
  (`application/json`) → body cap (declared `Content-Length` pre-check plus
  actual byte count; the header is untrusted) → strict JSON parse → bounded
  Update parse. The body is read only after the caller is verified.
  Rejections use stable reason codes (`invalid_secret`,
  `unsupported_media_type`, `payload_too_large`, `malformed_json`,
  `invalid_update`, `secret_unavailable`) mapped to safe AppError responses;
  rejection helpers are awaited so every rejection leaves the handler
  through the async code path.
- **Body cap:** 64 KiB — far above any admin-panel update, tight enough to
  bound abuse.
- **Configuration gating (phase-scoped fail-closed, ADR-0008/0014):**
  - present-but-invalid Phase 2 values fail readiness in EVERY environment
    (never silently ignored);
  - while ingress is ENABLED, `WEBHOOK_SECRET` and `OWNER_TELEGRAM_ID` are
    REQUIRED (absence => `not_ready`) — these are the two secrets the
    Phase 2A features actually consume;
  - `BOT_TOKEN` is validated whenever present but stays OPTIONAL until
    Phase 2B live wiring: without it the ingress runs in a documented
    OFFLINE mode (routed actions are skipped, never executed against the
    network). This keeps Phase 2A deployable with zero credentials while
    making the Phase 2B gate explicit.
  - Validation issues carry field names and stable reason codes only;
    values are never echoed.
- **Logging:** request bodies, message text, usernames, phone numbers, chat
  and user ids, the Bot Token, and the webhook secret are NEVER logged.
  Logs carry stable event names, reason codes, action types, role names,
  and update_id (the idempotency key) only.

## Consequences

- Phase 2A ships with the flag `false` everywhere; no Cloudflare secrets are
  configured and no webhook is registered. Enabling ingress later is a
  deliberate, gated operator action (Phase 2B).
- The timing-safe strategy is testable offline in workerd (standard Web
  Crypto) with exact-equality properties pinned by tests.
- `degraded` readiness (ADR-0015) is still unused; Phase 2A extends only
  `not_ready` reasons.
