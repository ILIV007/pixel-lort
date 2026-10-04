# src/application — use cases and workflows

Application use cases that orchestrate domain ports. Do not import
Cloudflare-specific types from this layer — depend on ports and inject
adapters instead (blueprint §3).

Implemented in Phase 2A:

- `telegram-ingress.ts` — the durable Telegram update lifecycle:
  claim by update_id (duplicates acknowledged without reprocessing) ->
  fail-closed actor resolution -> command routing to TYPED actions ->
  action execution through the injected Bot API client (offline skip
  without BOT_TOKEN) -> guarded terminal transition (processed | failed).
  Logs carry stable events, update_id, action types, and role names only.
