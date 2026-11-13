# ADR-0049: Admin post pipeline (capture → preview → approval → safe publication)

Date: R1.20-R round. Status: Accepted (review candidate; every activation
gate ships OFF). R1.20-R1 corrections recorded inline.

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
   ON — and (R1.20-R1) hands it the SAME real Bot API client instance the
   webhook builds for every other outbound action, as the direct-entity
   channel transport. No second client and no bypass path exists; the live
   flag still gates the send inside the service. Reused contracts:
   authorization/roles (blueprint permissions
   `draft.create` / `draft.view` / `draft.approve` / `publication.publish`),
   the opaque `a:<token>` callback contract with the `admin_action_tokens`
   single-use table, the direct-entity rich transport (`sendMessageRich` —
   never parse_mode), and the ADR-0035-style private-chat /
   non-edited-message guards.
   1b. **Capture is EXPLICIT (R1.20-R1).** Plain admin messages capture
   NOTHING by default: `/post` (private chat, fresh message, `draft.create`
   permission — enforced in the router AND re-checked in the service)
   opens a durable per-admin capture session (a validated JSON document in
   the existing `settings` table, `admin_post_capture:<user_id>`
   namespace; corrupt = closed). While the session is open, fresh private
   texts capture as versions; edits, media, contentless and oversize
   inputs are rejected explicitly; a role revoked mid-session can no
   longer write. `/post_cancel` always closes the session (even with no
   draft); `/post_status` always reveals it. Outside a session every
   ordinary admin message stays an ordinary message — silent legacy
   behavior, zero post data.
2. **Versioned storage is the source of truth** (migration
   `0005_admin_post_pipeline.sql`, LOCAL candidate): each
   content message appends an immutable version (serialized envelope +
   SHA-256 fingerprint + source update_id). Previews, approvals and
   publications are all built FROM THE STORED DOCUMENT, never from in-memory
   objects; a stored document that fails re-validation or fingerprint
   re-derivation fails loudly.
   R1.20-R1: the migration path is LINEAR — 0004 advances the applied chain
   3 → 4 (ownership) and 0005 advances it 4 → 5 (admin post ON TOP of the
   ownership migration, exactly the order real Wrangler applies the files).
   Schema 5 therefore MEANS "ownership present AND admin post present"; the
   capability resolver distinguishes v3/v4/v5 (and the retired non-linear
   v4-with-0005-id shape) by the recorded `migration_id` and fails closed
   on anything unknown.
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
   R1.20-R1: `/post_preview <draftId>` previews ANOTHER admin's OPEN draft
   for callers holding `draft.view` (the same permission the read-only
   review surface requires); without an argument the caller's own open
   draft is previewed. The not-found answer never distinguishes a
   nonexistent id from a closed draft. The approve write is FENCED BY THE
   DRAFT HEAD inside one atomic batch, so a capture committing between the
   bind and the write rolls the whole approval back (a stale active
   approval for an old version can never be left behind).
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
   R1.20-R1 atomic transitions: consuming the approval and creating the
   publication are ONE batch (the conditional insert doubles as the honest
   recovery for a legitimately-consumed approval whose publication never
   got created — the historical crash window heals on the next publish);
   the guarded supersede and the replacement insert are ONE batch with a
   batch-unique marker, so a second confirm can never ride a previous
   batch's superseded state. Every send re-reads the stored bytes and
   re-verifies the fingerprint BEFORE the transport call.
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

- The schema advances along the LINEAR candidate chain 3 → 4 (0004,
  ownership) → 5 (0005, admin post on top); both candidates remain
  LOCAL-ONLY until the owner separately authorizes remote application
  (documented in `migrations/README.md` and the helper plans).
- The publish path performs at most ONE Bot API call per confirmed action,
  inside the webhook request; no background worker or queue is required in
  this round.
- Version pins across config/tests were extended (schema 5, app 1.15.0).
