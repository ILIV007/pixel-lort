# ADR-0026: Telegram admin interaction contracts (roles, commands, HTML, callback tokens)

- **Status:** Accepted (amended v1.2.5 by ADR-0034: the unauthorized-sender denial is now the fixed minimal ENGLISH string "Access denied.", the allowlist gains `/language`, and command responses are rendered in the sender's persisted admin UI language — English default. The security model is unchanged.)
- **Phase:** 2A
- **Date:** 2026-10-04
- **Decided by:** Alexios

## Context

Phase 2A lays the admin foundation: authorization, command routing, outbound
message formatting, and the callback-data contract. The approved admin map
blueprint (`docs/blueprint/v1/pixel_admin_map_v1.json`) fixes roles,
permissions, commands, actions, and the callback encoding
(`a:<base64url_token>`, 64 bytes, state in D1 `admin_action_tokens`). The
blueprint's editorial renderer (blueprint §13) is a LATER-phase concern;
Phase 2A needs only a safe admin-facing formatter. ADR-0010 keeps Zod out of
this phase.

## Decision

- **Roles and permissions are a typed mirror of the blueprint.**
  `src/admin/roles.ts` mirrors `pixel_admin_map_v1.json` verbatim (owner
  wildcard; chief_editor / editor / reviewer / source_manager / viewer
  lists). The blueprint file remains authoritative; any permission change
  must change the blueprint first. `owner` is also the only role holding the
  owner-only permissions (admin.manage, emergency.control, backup.export)
  via the wildcard.
- **Fail-closed actor resolution.** The owner resolves ONLY through a valid
  `OWNER_TELEGRAM_ID` bootstrap identity; active admins resolve through the
  D1 `admins` table (status = 'active'); disabled admins, unknown users,
  and identity-less updates are unauthorized. Authorization decisions use
  the numeric Telegram user ID only — never usernames. A database failure
  during lookup THROWS (transient internal failure -> update marked failed)
  rather than masquerading as an authorization denial.
- **Command routing is separate from HTTP routing.** The router maps a
  normalized update + actor to TYPED actions
  (`send_message` / `answer_callback` / `noop` / `denied`) — never an
  immediate fetch. Phase 2A allowlist: `/start`, `/help`, `/status`,
  `/version` (extended to `/language` by ADR-0034). Authorized senders get
  static Persian admin responses (since v1.2.5: in the sender's persisted
  admin UI language, English default — ADR-0034); unauthorized senders get
  a minimal fixed denial (Phase 2A: "دسترسی مجاز نیست."; since v1.2.5:
  "Access denied." — ADR-0034); commands outside the allowlist are IGNORED
  for every sender (no probe feedback). No role-mutation endpoints and no
  publishing controls exist in Phase 2A.
- **Offline-mode action execution.** Actions execute through the injected
  Bot API client only when `BOT_TOKEN` is configured (ADR-0024); otherwise
  they are logged as skipped. Every outbound text passes the Telegram-safe
  HTML validator as a final gate before reaching the client.
- **Telegram-safe HTML: builder + validator, no raw passthrough.**
  `escapeTelegramHtml` escapes `&`, `<`, `>` (entity-safe order); builder
  helpers emit only allowlisted tags with escaped content; link targets
  must match a conservative https-only shape BEFORE interpolation;
  `isSafeTelegramHtml` is a bounded structural validator (balanced
  allowlisted tags, no attributes except a validated href on `<a>`, no
  self-closing, depth cap) used as defense-in-depth. Persian text, RTL
  markers, mixed RTL/LTR content, and emoji pass through untouched.
  The full editorial formatter (blueprint §13) remains a later phase.
- **Callback data: opaque token only.** Contract
  `a:<base64url_token>` with total data ≤ 64 UTF-8 bytes (checked on BYTES):
  `parseCallbackData`/`formatCallbackData` with stable failure codes. No
  JSON payload, no permission decision, no identity in callback data. The
  repository boundary over `admin_action_tokens` proves single-use
  consumption bound to one user with expiry (guarded atomic UPDATE); the
  full menu that issues/consumes tokens is the Phase 9 admin-screens slice.

## Consequences

- Future approval, scheduling, and editor workflows attach at the
  command-router/action boundary without touching webhook security.
- Phase 2A's admin surface is intentionally minimal: four commands, static
  responses, no menus, no sessions (admin_sessions stays untouched).
- Any future parser need beyond these Update shapes must either extend the
  explicit parser or justify Zod with a new ADR (ADR-0010 boundary).
