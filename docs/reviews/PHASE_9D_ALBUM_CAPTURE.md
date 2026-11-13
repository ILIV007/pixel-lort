# Phase 9D — the album-draft CAPTURE surface (design record)

Round: 1.39.0 (schema 6, ZERO DDL). Baseline: f852c9c (the 1.38.0 Phase 9C
delivery). Plan slice: `docs/CONTINUATION_PLAN_POSIDON.md` slice 2/4 — the
honest carry «the album-draft CAPTURING side (the admin surface gathering a
media group from real Telegram updates)».

## 1. What this slice is (and is NOT)

The producer half of the album path exists (v1.36.0: the ledger-bound,
all-or-nothing `produceAlbumDraft`). What was missing is the INPUT side: an
admin gathering a real Telegram media group into durable, evidence-shaped
state. This slice delivers that gathering surface — and pins its HONEST
boundary:

- The capture is EVIDENCE GATHERING, not publication. Every captured item is
  recorded `status='candidate'` + `rights_status='unknown'` (the machine
  invents NO permission — OD-010: an admin sending media is not a license,
  the same pin R1.21 holds for single photo/video).
- The captured candidates can NEVER feed the producer — at TWO honest,
  fail-closed layers: (1) the capture-only canonical namespace
  (`album-capture:<sessionId>/<ordinal>`) is not a source-media URL, so
  the 7.2 planner refuses a captured candidate typed
  `candidate_malformed` (the suite PROVES this end-to-end after a
  successful finish: `produceAlbumDraft` refuses `plan_derivation_failed`);
  (2) even with a hypothetical URL, the ledger binding resolves ONLY
  `uploaded` + rights-cleared rows — a `candidate` + `unknown` row can
  never resolve. An admin-captured album is NOT a source-media album; the
  admin-capture production route is PART of the OD-010 owner decision (no
  route exists yet — deliberately), and the route from `unknown` evidence
  to an affirmative rights status is that same decision.
- The capture NEVER sends: no transport seam exists on this surface.

## 2. The surfaces

- `ADMIN_ALBUM_CAPTURE_ENABLED` — the independent fail-closed flag (default
  'false', invalid-present = disabled, shipped 'false' everywhere). While
  OFF the whole surface is unreachable: media-group members keep the EXACT
  legacy behavior (the admin-post capture's explicit album-member rejection
  when that gate is ON, the `not_a_command` noop otherwise).
- `/album_capture <storyId>` — starts the actor's capture session (the
  story must exist; any previous active session of the SAME actor is
  replaced, never silently shared); the reply carries the honest capture
  instructions AND the rights boundary.
- `/album_capture` — the status view (the story, the gathered count, the
  ordinals); `/album_capture finish` — the durable finish;
  `/album_capture cancel` — the explicit cancel.
- While a session is ACTIVE, media-group members (photo/video carrying
  `media_group_id`) from the SAME authorized admin in a private chat are
  APPENDED (the router emits `album_capture_media`; the service checks the
  session): 2..10 members (the Telegram media-group bound
  `MAX_MEDIA_GROUP_ORDINAL + 1`), photo/video kinds only, one caption
  (the FIRST caption-carrying member — the album document's ordinal-0
  caption rule), a duplicate file_id refuses typed. Non-album single media
  is NEVER captured here (the R1.21 single-photo path is its own surface).

## 3. The durable state (schema 6 consumed — ZERO DDL)

- The in-flight session rides the GENERIC `admin_sessions` table
  (`flow='album_capture'`, `step='active'`, `state_json` bounded, the 15
  minute TTL). The append is a FENCED read-modify-write (the rowcount is
  the authority — an expired/completed/replaced session loses honestly).
- The finish writes, in ONE batch: the N `media_assets` rows (`status
'candidate'`, `rights_status 'unknown'`, the live `telegram_file_id`,
  the deterministic bounded canonical identity
  `album-capture:<sessionId>/<ordinal>` — a namespace a real source URL
  can never collide with), the session step → 'completed', and ONE audit
  event (`album_captured`, actor_type 'admin', metadata: the story id, the
  item count, the capture version — never file content).
- RBAC: `draft.create` (the capture creates draft-adjacent evidence) for
  every disposition; private chat only; edited messages noop.

## 4. Tests (RED-first)

- `tests/unit/album-capture.test.ts` — the pure module: the argument
  grammar (start/finish/cancel/status/invalid, the whole-token story id),
  the state validation (the bounded shape, the version pin), the append
  rules (the kinds, the 2..10 bound, the one-caption rule, the duplicate
  refusal, determinism).
- `tests/integration/admin-album-capture.test.ts` — REAL D1, registered in
  `test:db`: the flag family incl. the byte-identical legacy behavior while
  OFF; the router routing family; start/status/finish/cancel; the append
  family; the finish batch (the candidate rows pinned: status/rights/
  canonical identity/file_id; ONE audit row; the session completed); the
  OD-010 boundary proven end-to-end (the producer refuses the captured
  candidates typed); the RBAC denials; the ZERO-send assertion.
