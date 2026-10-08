# ADR-0034 — Admin UI language selection (English default, per-admin persistence)

Status: Accepted (Phase 2B correction, v1.2.5). Amends ADR-0026 (denial
language and command allowlist) without superseding its security model.

## Context

The admin bot surface answered every authorized admin in static Persian,
regardless of preference, and unauthorized users received a Persian denial.
Alexios directed (Phase 2B correction packet): English must be the DEFAULT
admin bot UI language; each authorized admin — including the bootstrap
owner — must be able to select English or Persian for THEIR OWN UI via an
explicit, discoverable `/language` command; the preference must be persisted
durably by numeric Telegram user ID; and the admin UI language must be
STRICTLY SEPARATED from the channel-post/editorial language (which remains
Persian/RTL by blueprint).

## Decision

- **English default.** An admin without a stored preference — including the
  bootstrap owner — is served English. The denial for unauthorized senders
  of allowlisted commands is the fixed minimal English string ("Access
  denied."), replacing the Phase 2A Persian denial.
- **Explicit selection.** `/language` reports the current UI language and
  how to change it (discoverability); `/language en` and `/language fa`
  change the SENDER's own preference (arguments normalized
  case/space-insensitively; anything else — multi-token or unknown — is a
  malformed request answered with the localized usage text and NO state
  change).
- **Per-admin durable persistence, no schema change.** Preferences live in
  the EXISTING blueprint `settings` table under the dedicated
  `admin_ui_language:<telegram_user_id>` key namespace (strictly separated
  from editorial/system settings). Stored JSON:
  `{ language, changed_at_ms, last_update_id }`. `updated_by` is NULL on
  every write: the column carries a foreign key to `admins`, and the
  bootstrap owner is authorized WITHOUT an admins row, so a non-null value
  would make the owner's first save fail on an FK violation.
- **Monotonic write fencing.** The write is ONE atomic UPSERT guarded by
  `COALESCE(json_extract(settings.value_json,'$.last_update_id'), -1) <=
json_extract(excluded.value_json,'$.last_update_id')`: newer changes and
  same-message redeliveries (idempotent re-apply) win; an OLDER retried
  language-change message can NEVER overwrite a newer choice and is answered
  honestly ("Not applied: a newer language choice is already saved.") in the
  admin's current language. A corrupt stored value reads as "no preference"
  (English) while the COALESCE keeps the next write able to repair it.
- **Honest acknowledgement.** The pipeline persists the preference FIRST and
  sends exactly one of the router's pre-composed confirmations ONLY after
  the fenced write applied. A storage failure (write or read) propagates as
  a retryable failure (safe 503; Telegram redelivers) — never a false
  successful confirmation, never a silent English fallback.
- **Chat-scope guards.** A language change requires an authorized sender, a
  PRIVATE chat, and a fresh (non-edited) message; in groups and edited
  messages the whole `/language` command is ignored with stable noop
  reasons (`language_not_private_chat`, `language_edited_message`) — no
  feedback, no state change, no preference disclosure to group members.
  There is no syntax to change another admin's preference: the target is
  always the sender's own numeric user ID.
- **Strict separation.** The feature touches ONLY the
  `admin_ui_language:` settings namespace and the admin command surface.
  Editorial language, channel content, publishing settings, drafts
  (`language TEXT NOT NULL DEFAULT 'fa'`), and blueprint files are
  unchanged.
- **Parser addition.** The bounded update parser now extracts `chat.type`
  as `chatType` for the four known Telegram chat types only (anything else
  is absent) — the private-chat guard reads it; the field is never logged.

## Verification

- Unit: English default rendering, Persian rendering, denial language,
  allowlist (now five commands), argument normalization and malformed
  handling, group/edited-message noops, sender-targeted set actions, string
  tables and their Telegram-HTML safety, storage-key namespace, corrupt
  value handling, and the fenced UPSERT outcomes over the real workerd D1.
- Integration (workerd D1, stub Bot API capturing outbound text): English
  default for owner and admins, Persian switch + switch-back + persistence
  across new requests, per-admin isolation, bootstrap owner without an
  admins row, unauthorized/disabled denials with no writes, group and
  edited-message rejection, malformed arguments leaving no state, older
  retried messages rejected with the honest stale reply, redelivery of the
  same update answered as a duplicate, write/read storage failures answered
  503 with no confirmation, and byte-identical editorial settings rows.
- Version gate: application 1.2.5, schema 2 (no migration added).

## Consequences

The admin surface gains one localized command and per-admin presentation
state in D1. Command responses are no longer uniformly Persian; the Persian
editorial pipeline and every blueprint contract are untouched. Admin CRUD
(issue #8) and publishing remain out of scope for this correction.
