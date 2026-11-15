# ADR-0056: Phase 7.3 — the media upload path (file_id reuse, R2 retention cleanup) and the album content kind

- Status: Accepted (V4 local engineering round; Posidon independent acceptance still outstanding for every live surface)
- Date: 2026-11-11 (Asia/Tehran)
- Round: 1.23.0 / schema 6 (NO migration — a deliberate decision, see below)
- Baseline: e03d31ac23a7d6c496a3066a900aeb48ad38ca30 (the post-7.2 tick-record tip)
- Roadmap anchor: Phase 7 bullet «Telegram upload with `file_id` reuse and R2 retention cleanup»
- Blueprint anchors: §3 (`domain/media` usage history), §14 steps 8–10 (direct URL / R2 streaming / save file_id + delete on the retention schedule), §23 (temporary R2: 72 hours), architecture decision 5
- Owner directive in force: FULLER steps — every round delivered at full depth (2026-11-10 order)

## Context

Phase 7.2 delivered the media POLICY contracts (mrp1 rights, rtp1
temporary-storage lifecycle, alp1 album planning — ADR-0055) and carried
binding conditions into 7.3: the three no-separation layers extend never
weaken; the reuse-before-upload economy; R2 only with an explicit policy,
rights and free-limit design. The last Phase 7 bullet is the upload path
itself. `media_assets` and `media_usages` ALREADY EXIST in the applied
blueprint schema (migration 0001, approved v1): canonical_url, sha256,
visual_key, rights_status, r2_key, telegram_file_id, the
candidate→validated→selected→uploaded→failed→blocked→expired status
lifecycle, and expires_at.

## Decision

1. **NO parallel tables — the blueprint-approved schema IS the durable
   anchor (schema stays 6).** The FIRST draft of this round created a
   parallel `media_usage` + `media_staging` migration; it was REPLACED —
   before any commit — by the blueprint-faithful design: `media_assets`
   IS the ledger + staging anchor (canonical_url/sha256 = the ledger
   keys; telegram_file_id = the ledger value; r2_key + expires_at = the
   staging state and the 72h deadline; the status vocabulary = the
   durable lifecycle). The rtp1 POLICY machine maps onto the blueprint
   vocabulary: staged ≈ 'candidate' (r2_key set, deadline set);
   file_id_saved ≈ 'uploaded' (file_id set, r2_key/expires_at cleared);
   upload_failed ≈ 'failed' (r2_key stays for the backstop);
   retention_expired ≈ 'expired' (r2_key/expires_at cleared; an uploaded
   row KEEPS its file_id — the ledger value outlives the temporary
   object). The machine stays the policy-level truth (ADR-0055); the
   table stays the durable truth; the reader re-derives the durable
   invariants (holding an R2 object ⇔ carrying a deadline; an 'uploaded'
   row always carries its file_id).
2. **The upload service** (`src/application/media/upload-service.ts`) —
   the REAL orchestration over the FOUR documented seams (ADR-0042 §6):
   MediaFetchPort / MediaStoragePort / MediaAssetStore / TelegramMediaPort.
   The documented flow: URL-level reuse resolution (one bounded read for
   ALL plan urls) → the 7.2 mrp1 decision per not-reused item → the fetch
   (an UNKNOWN size never bypasses the cap — the decision's
   byteCapUnchecked flag binds the adapter) → hash-level reuse (the same
   bytes under another URL reuse their file_id; the fetched bytes are
   discarded) → staging ('candidate' rows with the deterministic
   `media/staging/<id>` key + the 72h deadline, written BEFORE the R2 put
   so a crash leaves honest bookkeeping) → ONE media-group send
   (ALL-OR-NOTHING: any deferred/rejected item withholds the WHOLE send —
   no partial album, no silent degrade) → the step-10 transition IN ONE
   STORE CALL (file_id saved + r2_key/expires_at cleared + status
   'uploaded') → the R2 object deleted IMMEDIATELY. A failed send marks
   the staged rows 'failed' and auto-resends NOTHING (the R1.21
   discipline).
3. **The D1 asset store** (`src/adapters/db/media-asset-store.ts`) — the
   REAL store over `media_assets`: bounded parameterized IN-list reads
   (≤32) riding the APPROVED indexes (idx_media_hash, idx_media_expiry),
   the typed-reader mapping (a stored lie is a SKIP, never a guessed
   record), and the typed transitions. `media_usages` (the per-publication
   ordinal record) is untouched — it belongs to the publication slice
   that CONSUMES the uploaded assets.
4. **The album content document** (`src/domain/media/album-content.ts`)
   — the "album media kind": the ONLY legal construction path maps a 7.2
   alp1 plan + the upload path's resolved per-item file_ids; the caption
   rides ordinal 0 ONLY (the caption travels OUTSIDE the items list —
   there is NO per-item caption field to even misuse; the 7.1
   no-separation layer EXTENDED); the deterministic serialization +
   SHA-256 fingerprint covers EVERY item (kind + fileId + canonicalUrl +
   ordinal) and the caption; the strict fail-closed reader re-derives
   every invariant (a stored lie is malformed, never guessed).
5. **The client transport** (`sendMediaGroupRich`) — 2..10 items, EXACTLY
   ONE reference per item (an existing file_id — reuse; a direct https
   URL — the direct-URL path; an attach upload — the staged-bytes path);
   the caption-ordinal-0 invariant AT THE TRANSPORT BOUNDARY (a caption on
   any other item fails typed with ZERO fetch calls); the JSON path for
   file_id/URL references and the MULTIPART FormData path for staged
   bytes (the content-type header MUST stay absent — the runtime sets the
   boundary); the honest reply parser (photo = the LARGEST variant's
   file_id, video = the video's file_id; a malformed reply fails the
   WHOLE parse — never guessed).

## Consequences

- Phase 7's engineering bullets are complete at the local level; the
  ALBUM-POST PIPELINE integration (capture/preview/approve/publish of
  album versions inside the admin-post flows) is the CARRIED surface —
  recorded in the roadmap as the Phase 8 planning input, never claimed
  here.
- The upload economy is DURABLE: a replay of the same plan reuses every
  file_id with zero fetch/storage/upload cost (the group itself still
  sends via file_id references — the send is the delivery, the reuse
  eliminates the UPLOAD cost, recorded honestly as the in-round test
  correction).
- The retention is machine-backed: the bounded cleanup chunks over
  idx_media_expiry; the 72h deadline is the backstop behind the
  immediate-after-save deletion.

## Verification

- NEW suites: tests/unit/media-usage.test.ts (13), tests/unit/
  album-content.test.ts (9), tests/unit/bot-api-client-media-group.test.ts
  (9), tests/integration/media-73-upload.test.ts (9, registered in
  test:db — the REAL service + REAL D1 with the four faked seams).
- Full gates: npm run check exit 0 (168 files/2201 tests), npm run
  test:db exit 0 (55 files/593 tests — the new suite registered).
- ZERO provider calls, ZERO live sends, ZERO R2 writes, ZERO Cloudflare
  operations by construction.
