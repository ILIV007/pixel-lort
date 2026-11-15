# Admin post pipeline — usage and limits (R1.20-R … R1.21)

The admin-authored channel-post pipeline. It ships **default-OFF**: both
`ADMIN_POST_ENABLED` (the whole surface) and `ADMIN_POST_LIVE_PUBLISH_ENABLED`
(the actual channel send) must be explicitly enabled by the operator. While a
flag is absent/false (or holds any invalid value) the surface does not exist
and legacy behavior applies unchanged.

## The flow (three roles, one post)

1. **editor** (`draft.create`) — `/post` opens an EXPLICIT capture session in
   a PRIVATE chat. Every plain TEXT message — or ONE photo / ONE video with
   an optional caption — then becomes a new draft version until
   `/post_cancel`. The capture reply carries the **draft id**; outside an
   open session ordinary messages stay ordinary (no reply, no state).
2. **reviewer** (`draft.view` + `draft.approve`) — `/post_preview <draftId>`
   sends the EXACT stored content (media included) plus a separate control
   message whose Approve button is bound server-side to the previewed
   version+fingerprint. `/post_preview` (no argument) previews the caller's
   own open draft.
3. **publisher** (`publication.publish`) — `/post_preview <draftId>` shows the
   Publish button (an ACTIVE approval for the current version must exist);
   `/post_status` (own draft) or `/post_status <draftId>` (any existing draft)
   shows the honest publication state and, for an uncertain/failed outcome,
   the human-confirmed **re-send** button. The destination is ALWAYS the
   operator-configured `TARGET_CHANNEL` — never user input.

The owner role holds every permission; `/post_status <id>` for non-publishers
is one honest denial with no existence disclosure; unknown ids get the same
not-found answer everywhere.

## Single media — what is accepted, what is rejected

- **Accepted**: ONE photo (Telegram's largest variant `file_id` is stored) or
  ONE video, with an optional caption (≤ 1024 UTF-16 units, byte-for-byte,
  with validated `caption_entities` and preserved UTF-16 offsets). A media
  post WITHOUT a caption is a valid distinct case.
- **Rejected explicitly**: albums (any message with `media_group_id`),
  documents, audio, animations, voice, video notes, stickers, conflicting or
  malformed media fields — never degraded into a partial post. A caption can
  never exist without its media (structural invariant, transport kind-check
  as second fence). Raw Markdown stays out of scope for the whole pipeline.
- **Honesty about file access**: a `file_id` is an opaque reference, never a
  guarantee of eternal availability. A file the Bot API rejects at send time
  (invalid/expired/unusable) is a definitive failure reported explicitly.
- No media is downloaded, stored in R2, or processed; nothing here claims any
  media rights from the fact that an admin sent the media.

## Send integrity and recovery

- Before EVERY send (first publish and confirmed re-send) the stored content
  is re-read, fully re-validated, and its fingerprint RE-DERIVED — a version
  whose stored bytes changed after approval is never sent
  (`failed_definitive`, `content_changed_after_approval`).
- Outcomes are recorded honestly: `sent` / `failed_definitive` (proved
  non-delivery) / `uncertain` (timeout, network, 5xx — the message MAY have
  arrived). NOTHING is ever auto-resent; the only re-send path is the
  human-confirmed supersede flow from `/post_status`.
- No exactly-once delivery is claimed anywhere.

## Storage shape (R1.21)

`admin_post_versions.envelope_json` holds the versioned **post-content
document**: `{ schemaVersion: 1, media: none|photo|video, fileId, text, caption }`
(text envelope for text posts, caption envelope for media captions). The
SHA-256 fingerprint covers the WHOLE document — media identity, caption text
and entities together. Legacy R1.20-R1 rows (bare envelope) remain readable
through the documented fallback and are fingerprinted the legacy way. The
migration chain is unchanged: 0004 → 0005 (schema 5, LOCAL-ONLY candidates).

## Known limits

- One OPEN draft per creator, ≤ 50 versions per draft; preview/action tokens
  and sessions live 30 minutes.
- Media: single photo/video only; no albums, no audio/document types, no
  media download or re-upload, no URL-based media.
- Publishing requires both flags ON plus a configured `TARGET_CHANNEL`;
  while the live flag is OFF the publish action stops BEFORE any
  publication row or Bot API call.

## The editorial bridge — /post_from_draft (R1.22 Phase A)

The bridge connects the REAL news pipeline to this pipeline: ONE stored
READY editorial draft (the `editorial.prepare_draft` output listed by
`/drafts`) is converted into a NEW admin post version, which then flows
through the EXISTING preview → approval → publication flow unchanged — no
bypass path exists.

- **Gate**: `EDITORIAL_TO_POST_ENABLED` (independent, fail-closed, default
  false) AND the admin post surface itself. While OFF the command keeps its
  exact unknown-command noop. The caller needs `draft.create` (private
  chat) — the same permission as capture, re-checked fail-closed in the
  service.
- **Render (deterministic, honest)**: the post text is composed ONLY from
  the stored document fields — the Persian headline (one bold entity),
  summary, the model claims each prefixed `•`, the FIXED unverified note
  (the model-claims status is structural: a stored claim that is not
  exactly `unverified` fails the conversion), and the source attribution
  line. The raw source excerpt is deliberately NOT part of the post — it
  stays in the editorial draft, reachable via `/drafts <id>`. Nothing is
  ever fabricated to fill a missing section and nothing is ever
  truncated: an over-limit composition is an explicit typed failure
  ("NOT truncated"), and a malformed/unsupported document is refused.
- **Provenance (durable, per version)**: migration 0006 rebuilt
  `admin_post_versions` with a nullable `source_update_id` plus
  `editorial_draft_id` + `editorial_draft_version` and an EXACTLY-ONE-origin
  CHECK — a captured version carries its real update id, a derived version
  carries the complete editorial pair; a fabricated update id is refused by
  the database itself. A partial UNIQUE index admits at most ONE derived
  version per editorial draft version, so the bridge is idempotent: a second
  conversion (even by a different admin) answers with an honest pointer to
  the existing post — the news can never be duplicated by re-conversion.
- **Existing-draft conversion**: converting while the caller already has an
  open draft adds the editorial content as the NEXT version of that draft —
  the same atomic batch invalidates every older approval (identical to a
  manual capture).
- **Where it stops**: the bridge creates the version and nothing more.
  Preview, approval and publication remain the exact R1.20-R1/R1.21 flows
  with their version/fingerprint bindings; the live-publish flag still
  gates every send.
