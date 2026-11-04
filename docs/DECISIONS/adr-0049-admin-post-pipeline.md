# ADR-0049: Admin post pipeline (capture → preview → approval → safe publication)

Date: R1.20-R round. Status: Accepted (review candidate; every activation
gate ships OFF).

## Context

The owner must be able to author channel posts directly from Telegram: send
text, see a faithful preview, approve the exact previewed version, and
publish it safely. Two prior requirements shape the design:

1. R1.19 built the canonical rich-text envelope (text byte-for-byte +
   validated entities, no parse_mode) — any post pipeline must reuse it and
   MUST NOT reinterpret the author's formatting.
2. The system-wide delivery guarantee is at-least-once with bounded
   duplicate risk (ADR-0032). A channel send is an externally visible side
   effect with NO application idempotency key on Telegram's side, so the
   pipeline must be honest about uncertain outcomes and must make
   accidental duplicate sends structurally impossible.

## Decision

1. **Reuse the existing admin spine.** The command router stays PURE and
   synchronous and emits typed `admin_post_*` actions (the R1.18 injection
   discipline); the injected `AdminPostService` owns all D1 work; the
   webhook wires it ONLY while the fail-closed `ADMIN_POST_ENABLED` gate is
   ON. Reused contracts: authorization/roles (blueprint permissions
   `draft.create` / `draft.approve` / `publication.publish`), the opaque
   `a:<token>` callback contract with the `admin_action_tokens` single-use
   table, the direct-entity rich transport (`sendMessageRich` — never
   parse_mode), and the ADR-0035-style private-chat / non-edited-message
   guards.
2. **Versioned storage is the source of truth** (migration
   `0005_admin_post_pipeline.sql`, schema 3 → 4, LOCAL candidate): each
   content message appends an immutable version (serialized envelope +
   SHA-256 fingerprint + source update_id). Previews, approvals and
   publications are all built FROM THE STORED DOCUMENT, never from in-memory
   objects; a stored document that fails re-validation or fingerprint
   re-derivation fails loudly.
3. **Approval binds to the previewed content SERVER-SIDE.** A preview sends
   the exact stored content as one message and the control surface
   (label + single-use buttons) as a SEPARATE message (control/content
   separation — the content text and its UTF-16 offsets are never altered),
   and records a durable preview session (version + fingerprint). Approve /
   publish callbacks resolve through that session: the optional fingerprint
   field in the callback payload is only an extra tamper check — omitting
   it bypasses nothing, and a foreign fingerprint is rejected as tampered.
   Knowing just the version number approves nothing. One ACTIVE approval
   per version; a content update atomically invalidates older approvals.
4. **Publication is an outbox with honest outcomes.** The destination is
   the operator-configured `TARGET_CHANNEL` (never user input). A partial
   UNIQUE index admits ONE primary publication per (draft, version), so
   double clicks, duplicate preview sessions and concurrent deliveries can
   never enqueue a second send. The send is claimed (lease + owner fence)
   and the outcome recorded as `sent` / `failed_definitive` (proved
   non-delivery: Telegram 4xx incl. 429, pre-fetch typed rejections) /
   `uncertain` (timeout, network, 5xx, unreadable response envelope — the
   message MAY have arrived). Uncertain rows are NEVER auto-resent. The
   only re-send path is the explicit human-confirmed supersede flow offered
   by `/post_status` (old row → `superseded`, new row audit-linked via
   `supersede_of`, attempt counter). A late response whose claim was
   superseded can never overwrite the newer state (fence on
   `state='claimed' AND claimed_by`). The system makes NO exactly-once
   delivery claim; after an informed manual re-send, a duplicate channel
   message remains possible and is documented.
5. **Live publication is independently gated.**
   `ADMIN_POST_LIVE_PUBLISH_ENABLED` (default OFF) gates ONLY the real
   channel send: while OFF the publish action stops BEFORE any publication
   row or Bot API call, the approval stays active, and the reply says so
   plainly. Enabling capture/approve never enables sending.
6. **Media without full support is explicitly rejected** — a caption is
   never treated as a complete post. Raw Markdown/HTML input stays deferred
   (the R1.19 boundary); the parser exposes only PASSIVE presence flags
   (`hasText`, `hasMediaAttachment`) to make oversized/media/contentless
   messages explicitly distinguishable.

## Consequences

- The schema advances 3 → 4 through the LOCAL-ONLY 0005 candidate; the
  Round 1.9 `0004_source_poll_ownership` candidate remains the alternative
  version-4 branch and the two are mutually exclusive until the owner
  decides otherwise (documented in `migrations/README.md`).
- The publish path performs at most ONE Bot API call per confirmed action,
  inside the webhook request; no background worker or queue is required in
  this round.
- Version pins across config/tests were extended (schema 4, app 1.15.0).
