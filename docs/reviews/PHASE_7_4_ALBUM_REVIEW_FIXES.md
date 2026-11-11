# Phase 7.4 — the album review-blocker round (A1–A6): design and in-round review

- Version: 1.27.0 (schema 6 — ZERO DDL); baseline daff8d3 (Phase 8.4)
- Source: PIXEL_LORES_2BD1833_INDEPENDENT_REVIEW_FA.md (the A1–A6 findings,
  the adversarial-probe.ts scenarios) — every probe re-written as a
  persistent Vitest suite over the REAL service, RED on the unfixed tree
  (21 failed of 22), GREEN after the fixes (22/22 + the 7.3 regression
  suite green on the updated fake).

## 1. The fixes (one per finding)

- **A1 (rights fabrication)** — `rightsStateFor`: ONLY `official_api`
  origins and `official`/`verified_source` metadata map to a CLEARED
  state; an UNOFFICIAL metadata claim maps to `unknown` and mrp1 rejects
  it typed. The durable `rightsStatus` echoes the REAL asserted clearance
  (official / attribution_required / licensed — never a blanket
  `official`). `resolveAssetReuse` guards: `status === 'uploaded'`, a
  non-blocked rightsStatus, and (when the caller names a kind) the SAME
  type.
- **A2 (file_id mapping)** — the send response is validated
  (one non-empty id per plan ordinal) BEFORE any ledger write; the fresh
  item's id is read at `fileIds[item.ordinal]` (the fresh-only counter is
  gone); a malformed reply is the typed `invalid_send_response` with ZERO
  ledger writes and the staged rows still discoverable.
- **A3 (R2 cleanup recovery)** — the step-10 order REVERSED: the object
  is deleted FIRST (idempotent, missing = ok) and the ledger clears the
  key ONLY after a successful delete — the object can never outlive its
  row's discoverability; a failed delete leaves the row `candidate` WITH
  key + deadline and the retention backstop cleans it end-to-end (proven
  by the A3 test).
- **A4 (validation before effects + honesty)** — the destination shape
  and the caption envelope are validated BEFORE any rights decision,
  fetch, staging or channel effect (`invalid_destination` /
  `caption_invalid`, zero calls); the send failure carries the certainty
  (`proved_non_delivery` / `uncertain`, ABSENT = uncertain — no false
  certainty); the versioned deterministic `sendIdentityKey` (sha256 over
  destination + plan content + caption) is derived and returned as the
  outbox-wiring scaffold.
- **A5 (attachment contract)** — `MediaGroupAttachmentV1` + the
  `MediaGroupSendInputV1` input: the fresh BYTES cross the port under the
  SAME ref the wire item names (`item-N`); reuse items ride none; the
  real multipart adapter can build the actual request from this input
  alone (the review's seam gap closed).
- **A6 (honest outcomes)** — the pre-send vocabulary is `staged` (the old
  `uploaded` before any channel effect was a lie); the failure outcome
  carries `sentConfirmed` (true = the send call SUCCEEDED and a later
  step failed — never reportable as "not sent"); a fetch failure is the
  `fetch_failed` blocker, never summarized under `rights_rejected`.

## 2. In-round findings (self-review)

1. **The probe fake's always-failing delete** — the first A3 fixture
   failed the storage delete FOREVER, so the backstop cleanup could not
   succeed; the fixture now fails only the FIRST delete call (the
   in-upload flow) and the backstop's later deletes succeed (missing =
   ok) — the crash-window semantics the fix actually produces.
2. **The blocking-reason sweep** — the old code summarized EVERY
   non-upload blocker under `rights_rejected`; the reason now reads the
   blocker's own reason first (`fetch_failed` has its own top-level
   reason).
3. **The response-shape gate placement** — validating the reply AFTER the
   first markUploaded would already have written a possibly-wrong id; the
   gate sits BEFORE the entire step-10 loop.

## 3. Honest carries

- **The album-post pipeline wiring** (the outbox claim/lease/approval
  binding consuming `sendIdentityKey` + the attachments contract) is the
  documented next slice — the contracts it needs now EXIST; the wiring
  itself stays unbuilt (BLOCKED_LIVE surfaces unchanged).
- **The uncertain-send ledger** — a `send_uncertain` durable parking for
  albums rides on the same wiring slice (the single-photo/video admin
  path already has its own outbox; the album path joins it at wiring
  time).
- **`MediaStoragePort.read`** — the review noted the missing read; the
  current path carries the bytes in memory, so the read stays a wiring
  slice need (documented, not silently dropped).

## 4. Gates executed at delivery

- `npm run check` and `npm run test:db` — exits recorded in the round
  delivery message (the 7.4 suite included in the full run).
