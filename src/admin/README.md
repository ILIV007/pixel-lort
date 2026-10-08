# src/admin — Telegram admin foundation (Phase 2A)

Private Telegram admin interface foundation (blueprint §17–§21). The admin
panel is the ONLY administration UI in v1.

Implemented in Phase 2A:

- `roles.ts` — the six approved roles and the verbatim role-to-permission
  map from `docs/blueprint/v1/pixel_admin_map_v1.json` (owner wildcard).
- `authorization.ts` — fail-closed actor resolution: `OWNER_TELEGRAM_ID`
  bootstrap identity plus active admins from D1; numeric user IDs only.
- `command-router.ts` — allowlist (/start /help /status /version) mapped to
  TYPED Telegram actions; static Persian responses; minimal denial for
  unauthorized senders; ignore-list semantics outside the allowlist.
- `telegram-html.ts` — Telegram-safe HTML: `&<>` escaper, allowlisted tag
  builders, validated https-only links, bounded structural validator.
- `callback-tokens.ts` — the `a:<base64url_token>` callback contract
  (≤ 64 bytes, base64url token, no embedded payload).

Still planned (later phases): command screens, multi-step admin sessions
(`admin_sessions`), role-mutation flows, opaque action token issuance for
real menus (Phase 9), editorial review workflows.

Authorization NEVER uses usernames and NEVER mutates roles from chat input.
