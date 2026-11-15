# Phase 7.3 self-review — the upload path (file_id reuse, R2 retention cleanup) and the album content kind

Round: on the post-7.2 tick-record tree (e03d31a) · 1.23.0 / schema 6 ·
2026-11-11 (Asia/Tehran) · ADR-0056

Scope honored: the roadmap bullet «Telegram upload with `file_id` reuse
and R2 retention cleanup» — delivered as the REAL upload path over the
FOUR documented seams plus the album CONTENT kind and the media-group
client transport. Everything below names the test that pins it — nothing
rests on a report's word.

## 1. The bullet → evidence matrix

| Roadmap/blueprint clause                        | Shipped behavior                                                                                                                                                                                                                                                                                                                           | Pinning evidence (real, in this tree)                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compare URL/hash history (§14 step 2)           | EXACT canonical-url or sha256 equality against an UPLOADED asset reuses its file_id; a staged (non-uploaded) row never resolves as reuse; a near-miss URL never matches                                                                                                                                                                    | `tests/unit/media-usage.test.ts` «an exact canonical-url hit…», «an exact sha256 hit…», «a staged (non-uploaded) row NEVER resolves…», «a near-miss URL is a STAGE outcome», «an item WITHOUT a hash never matches by hash»                                                                                                                                                                                                             |
| Direct URL when limits permit (§14 step 8)      | the sendMediaGroupRich client accepts a direct https URL reference (bounded; the full transport rules stay in the 7.2 policy)                                                                                                                                                                                                              | `tests/unit/bot-api-client-media-group.test.ts` «a plain-http direct URL fails typed», the JSON-transport cells                                                                                                                                                                                                                                                                                                                         |
| Otherwise stream to R2 (§14 step 9)             | staging = a 'candidate' media_assets row (r2_key = the deterministic `media/staging/<id>`, expires_at = now+72h) written BEFORE the storage put + the bytes staged                                                                                                                                                                         | `tests/integration/media-73-upload.test.ts` «the full happy path» (3 puts, 3 rows with r2_key+deadline); the r2_key⇔expires_at reader invariant in «the durable rtp1 invariant…»                                                                                                                                                                                                                                                        |
| Save file_id + delete on schedule (§14 step 10) | the step-10 transition IN ONE STORE CALL (telegram_file_id + r2_key NULL + expires_at NULL + status 'uploaded') followed by the IMMEDIATE R2 object deletion; the 72h deadline is the backstop                                                                                                                                             | «the full happy path» (3 deletes right after the sends; all rows uploaded/cleared); the retention cells below                                                                                                                                                                                                                                                                                                                           |
| Retention 72h (§23)                             | the bounded, chunked cleanup over idx_media_expiry: the expired R2-holding rows are deleted (missing = ok) and cleared to 'expired'; an UPLOADED row's file_id SURVIVES the cleanup; terminal rows are never re-selected                                                                                                                   | «the retention cleanup: expired R2-holding rows…», «the cleanup NEVER touches an UPLOADED row…», the bounded/capped cells in «the selection is CAPPED…», «a zero or negative limit selects NOTHING»                                                                                                                                                                                                                                     |
| Replay/idempotence                              | a replay reuses EVERY file_id with ZERO fetch/zero storage cost (the group itself still sends via the reused file_id references — the reuse eliminates the UPLOAD cost, recorded honestly as the in-round correction)                                                                                                                      | «the ECONOMY rule: a replay reuses EVERY file_id…», «the hash-level reuse: the same bytes under a DIFFERENT URL…»                                                                                                                                                                                                                                                                                                                       |
| Failure honesty (R1.21 discipline)              | a failed send marks the staged rows 'failed' (the objects stay for the backstop), the ledger carries NO poisoned rows, NOTHING auto-resent; the ALL-OR-NOTHING group withholds the send on ANY deferred/rejected item                                                                                                                      | «a failed send marks the staged rows failed…», «the ALL-OR-NOTHING group: one deferred item withholds the WHOLE send…»                                                                                                                                                                                                                                                                                                                  |
| Album 2–10, caption on ordinal 0 (§14 step 7)   | the album CONTENT kind: the ONLY construction path = a 7.2 alp1 plan + the resolved per-item fileIds; the caption rides ordinal 0 ONLY (NO per-item caption field exists to misuse); the fingerprint covers EVERY item and the caption                                                                                                     | `tests/unit/album-content.test.ts` «builds the document…», «a caption-less album is a valid distinct case…», «a fileIds array whose length mismatches…», «a hand-built list outside the plan discipline…», «round-trips through serialize → read with the SAME fingerprint», «a changed fileId / caption / item order changes the fingerprint»                                                                                          |
| The client transport                            | sendMediaGroupRich: 2..10 items, EXACTLY ONE reference (file_id/URL/attach); the caption-ordinal-0 invariant AT THE TRANSPORT BOUNDARY (typed, ZERO fetch); the JSON path + the MULTIPART FormData path (no content-type header); the honest reply parser (photo largest variant / video file_id; a malformed reply fails the WHOLE parse) | `tests/unit/bot-api-client-media-group.test.ts` «sends 2..10 items with NO parse_mode…», «a caption rides the ordinal-0 item ONLY», «sends a FormData body WITHOUT a JSON content-type…», «a MIXED group…», «a caption on a NON-ordinal-0 item fails typed before any fetch», «fewer than 2 or more than 10 items fail typed», «an item with ZERO or MULTIPLE references…», «a plain-http direct URL fails typed», «a malformed reply…» |
| The blueprint tables, not parallel ones         | the durable anchor IS the approved media_assets table (canonical_url/sha256 keys, telegram_file_id value, r2_key/expires_at staging, the status vocabulary); NO migration; schema 6 untouched; media_usages untouched (the publication slice's record)                                                                                     | the store maps through `readMediaAssetRecordV1`; the integration suite drives media_assets over REAL D1; ADR-0056 documents the mapping                                                                                                                                                                                                                                                                                                 |

## 2. The in-round design correction (recorded honestly)

The FIRST draft created a parallel `media_usage` + `media_staging`
migration 0007; the survey of the applied blueprint schema then showed
that `media_assets`/`media_usages` ALREADY exist (migration 0001,
approved) with exactly the needed columns (canonical_url, sha256,
visual_key, rights_status, r2_key, telegram_file_id, the status
lifecycle, expires_at). Per the house rule («چیزی که قبلاً وجود دارد
دوباره پیاده نشود») the parallel design was REPLACED before any commit:
the migration file, its helper registration and its test were removed;
the store/service/domain were re-targeted at the approved table; the
rtp1 machine maps onto the blueprint vocabulary (ADR-0056). No fabricated
artifacts remain in the tree.

A SECOND in-round correction: the ECONOMY test initially expected
«zero sends on replay»; the honest contract is that the reuse eliminates
the UPLOAD cost (fetch/storage/attach) while the group still sends via
the reused file_id references (the send is the delivery). The test was
corrected to reality and the service's behavior documented.

## 3. Structural invariants

1. **The economy is durable**: reuse resolves against UPLOADED assets
   only (a saved telegram_file_id is the ledger value); the lookup rides
   the APPROVED indexes; EXACT equality only.
2. **All-or-nothing albums**: a media group cannot silently drop a
   member — one defer/reject withholds the WHOLE send typed.
3. **The step-10 transition is atomic at the store level**: file_id
   saved + the R2 reference cleared in ONE UPDATE; the object deletion
   follows immediately; the deadline is the crash backstop.
4. **The reader re-derives the machine's durable invariants**: holding
   an R2 object ⇔ carrying a deadline; an 'uploaded' row always carries
   its file_id; a stored lie is a SKIP in the store, malformed in the
   reader — never a guessed record.

## 4. Honest limits

- NO live capability: the real fetch adapter, the real R2 binding and
  the real Telegram send are live surfaces (BLOCKED_LIVE — Posidon
  only); the tests fake exactly those four seams.
- The album-post PIPELINE integration (capture/preview/approve/publish
  of album versions in the admin-post flows) is NOT built in this round —
  carried into Phase 8 planning with the album content kind ready.
- The v1 upload path derives the rights input from the candidate
  (kind⇒mime, origin⇒rightsState); richer collector metadata rides in
  later slices.
- No numeric-accuracy claim anywhere (the Phase 6 gate condition); the
  byte caps are the documented Bot API contract values, not measurements.

## 5. Conditions carried into Phase 8 planning (binding)

1. The three no-separation layers extend never weaken: the album-post
   pipeline must consume the album content document AS IS (the caption
   rides ordinal 0; the fingerprint binds approvals to the WHOLE album).
2. The upload path is the ONLY door to media_assets' uploaded state:
   the publication slice must reuse assets through the same EXACT
   equality rules (never re-upload an already-ledgered asset).
3. The retention cleanup must stay chunked and bounded (never a
   full-table sweep).
4. All live surfaces stay BLOCKED_LIVE (Posidon only); PR #11 open/draft;
   FF-only pushes on `review/r1.10.3-sql-design`.
