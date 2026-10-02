# src/admin — planned (not implemented in Phase 0)

Private Telegram admin interface (blueprint §17–§21):

- RBAC with atomic permission strings (owner, chief_editor, editor,
  reviewer, source_manager, viewer).
- Command map and screens: dashboard, inbox, review, story, source, queue,
  calendar, system.
- Opaque one-time action tokens (`a:<base64url_token>`, 64-byte callback
  limit) persisted in D1 `admin_action_tokens`.
- Multi-step admin sessions with TTL, one active flow per admin per chat.

The Telegram admin panel is the ONLY administration UI in v1. No code exists
in Phase 0.
