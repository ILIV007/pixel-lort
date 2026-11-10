# Phase 7.1 self-review — media compatibility preservation (the inventory)

Round: on the 1.21.0 tree + the Phase 6 gate round · 2026-11-11 (Asia/Tehran)

Scope honored: the roadmap's «۷.۱ حفظ سازگاری» — the EXISTING single
photo/video surface, file_id handling, caption and entities, and the
no-silent-separation-of-caption-from-media guarantee, verified as an
evidence-based inventory. This round builds NO new media capability: the
album model is 7.3's future design+build work; rights/origin policy is 7.2.
Everything below names the test that pins it — nothing rests on a report's
word.

## 1. The bullet → evidence matrix

| Roadmap clause                                          | Shipped behavior                                                                                                                                                                                                                                                                                                                                                                                                                                          | Pinning evidence (real, in this tree)                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single photo preserved                                  | the typed single-media extraction takes the LARGEST photo variant's file_id (bounded area math, ties keep the later entry); dimension-cap values cannot poison the math                                                                                                                                                                                                                                                                                   | `tests/unit/update-parser-media.test.ts` «extracts the LARGEST photo variant file_id», «a photo-size over the dimension cap cannot poison the area math (still extracts)»; the REAL capture→preview→publish path «photo with a formatted caption: capture → faithful preview (sendPhoto + caption_entities) → publish (sendPhoto to the channel)» in `tests/integration/admin-post-media.test.ts` |
| Single video preserved                                  | the video's file_id extracted typed; a video WITHOUT a caption is a valid distinct case sent with NO caption field at all                                                                                                                                                                                                                                                                                                                                 | unit «extracts the video file_id»; integration «video WITHOUT a caption: captured, previewed and published with NO caption field at all»; unit post-content «creates a video document WITHOUT a caption»                                                                                                                                                                                          |
| file_id discipline                                      | opaque Telegram reference: bounded (printable ASCII, 1..256 units, ≤1024 UTF-8 bytes), never interpreted; invalid file_id ⇒ typed rejection                                                                                                                                                                                                                                                                                                               | `src/domain/admin-post/post-content.ts` (bounded fileId contract) + unit post-content «rejects an unknown media kind, an invalid file_id, and every shape mismatch»                                                                                                                                                                                                                               |
| Caption preserved                                       | caption rides a REQUIRED-kind 'caption' envelope (or is absent for media); serialized as `caption` + `caption_entities` with NO `parse_mode`, exact text preserved, plain captions carry an EMPTY entity list; editMessageCaption path exists with the same discipline                                                                                                                                                                                    | unit update-parser «extracts caption + caption_entities and a plain caption with an EMPTY entity list»; `tests/unit/bot-api-client-rich-text.test.ts` «sends editMessageCaptionRich with caption + caption_entities and no parse_mode», the P1 «plain caption flows to a real editMessageCaption with exact caption and empty entities», «rejects text/caption kind mismatches before any fetch»  |
| Entities preserved (UTF-16 discipline)                  | caption entities ride the SAME rich-text envelope as text entities — the R1.18/R1.19 offset discipline (UTF-16 code units, exact semantic entities) applies unchanged; the caption cap is 1024 UTF-16 units enforced at the envelope                                                                                                                                                                                                                      | `tests/unit/rich-text-envelope.test.ts` «keeps captions at exactly 1024 UTF-16 units and rejects 1025»; the envelope suites' offset/entity assertions exercised through the caption path in bot-api-client-rich-text                                                                                                                                                                              |
| NO silent caption/media separation (the core guarantee) | THREE independent layers: (a) MODEL — a caption can NEVER exist without media: media 'none' ⇔ text envelope, no caption; caption present IFF media is photo/video AND a caption exists; any mismatch ⇒ `content_kind_mismatch`; (b) STORAGE — a caption-kind bare envelope is never readable as a post (legacy rows included); (c) SEND — a stored media version whose file_id or caption was altered after approval is BLOCKED by the fingerprint column | unit post-content «A caption can never exist without media» (→ `content_kind_mismatch`) and the mirrored text-with-media rejection; «rejects a caption-kind bare envelope as a legacy row (a caption is never a post)»; `tests/integration/admin-post-send-integrity.test.ts` «blocks the send when a MEDIA version (file_id or caption) was altered after approval»                              |
| Fingerprint covers the whole media identity             | deterministic serialization; media kind + fileId + caption text + caption entities are ALL inside the fingerprint — any change is a new version, never a silent mutation                                                                                                                                                                                                                                                                                  | unit post-content «serializes deterministically and the fingerprint covers media + caption + entities»; the send-integrity tamper cells (text and media)                                                                                                                                                                                                                                          |
| No silent degradation of ANY media shape                | documents, audio, animation, voice, video_note, sticker, albums (media_group_id), conflicting or malformed media fields ⇒ typed `unsupported` — the caller REJECTS explicitly; a single album member is never degraded into a post                                                                                                                                                                                                                        | unit «maps EVERY other media shape to unsupported», «flags album membership (media_group_id) — the capture surface rejects it»; integration «albums are rejected EXPLICITLY (a single album member is never degraded into a post)», «unsupported media (document/audio/sticker) is rejected EXPLICITLY, never degraded»                                                                           |
| Caption over-limit never truncates                      | a caption beyond 1024 units is rejected explicitly; malformed caption metadata never stores; the serialized-byte cap fails TYPED, never truncated                                                                                                                                                                                                                                                                                                         | integration «a caption beyond 1024 units is rejected explicitly; a malformed caption metadata never stores»; unit post-content «the serialized-byte cap is enforced with a typed failure (never truncation)»                                                                                                                                                                                      |
| Replay safety on media updates                          | a duplicate delivery of the SAME media update never creates a second version                                                                                                                                                                                                                                                                                                                                                                              | integration «a duplicate delivery of the SAME media update never creates a second version»                                                                                                                                                                                                                                                                                                        |
| Honest failure, no auto-resend                          | a media version whose file reference the Bot API rejects is a DEFINITIVE failure, reported honestly, NEVER auto-resent                                                                                                                                                                                                                                                                                                                                    | integration «a media version whose file reference the Bot API rejects is a DEFINITIVE failure — reported honestly, never auto-resent»                                                                                                                                                                                                                                                             |
| Legacy compatibility                                    | legacy bare-envelope text rows read via the documented fallback and re-validated; the legacy fingerprint is re-derived exactly as R1.20-R1 stored it; the send gate admits them through the documented fallback only                                                                                                                                                                                                                                      | unit post-content «reads LEGACY bare-envelope rows as text-only documents with the legacy marker»; send-integrity «a LEGACY bare-envelope row still passes the gate via the documented fallback», «the confirmed RE-SEND passes the same gate (a tampered version cannot ride the recovery path)»                                                                                                 |

## 2. Structural invariants (why no silent separation is possible)

1. **The model type makes the illegal state unrepresentable:** the post
   content document is a discriminated union — media 'none' carries a text
   envelope and NO caption field; media 'photo'/'video' carries a required
   bounded fileId and an OPTIONAL caption envelope. There is no
   representation for "a caption without media" that survives construction
   (`content_kind_mismatch`), storage (the reader re-validates every row),
   or send (the fingerprint column blocks post-approval alteration).
2. **The capture parser refuses ambiguity typed:** multi-media messages and
   every non-photo/video shape are `unsupported` — the caller rejects
   EXPLICITLY. Nothing degrades silently into "text with a caption" or a
   caption-less stray post.
3. **The Bot API client forwards the caption ONLY as part of the media
   send** (`sendPhotoRich`/`sendVideoRich`/`editMessageCaptionRich` with
   `caption` + `caption_entities`, no parse_mode) — a caption envelope can
   never be dispatched through a text-send method (kind mismatches fail
   typed BEFORE any fetch).

## 3. Gap analysis — none found

Every clause of «۷.۱» maps onto named tests across four suites
(update-parser-media, post-content, bot-api-client-rich-text /
rich-text-envelope, admin-post-media + admin-post-send-integrity). The
adversarial probes (caption-without-media at construction, storage and send;
album membership; every unsupported shape; over-limit and malformed caption
metadata; duplicate delivery; altered media after approval; legacy rows and
the re-send path) are ALL already pinned. No RED→GREEN cell was needed in
this round — recorded honestly as a verification outcome, not a skipped
obligation.

## 4. Honest limits

- No NEW media capability is delivered here: albums (multi-part, versioned,
  ordering, partial-failure) are 7.3's design+build work; R2/download and
  rights/origin policy are 7.2. Today an album member is REJECTED — the
  compatible behavior, not an album implementation.
- No live Telegram send, no real file upload/download, no R2 write: every
  proof is over the REAL webhook/D1/Bot API client with faked network
  responses (ids/tokens only from real bot replies).
- The media surface stays OFF by default in production configuration
  (`ADMIN_POST_ENABLED` and every other gate 'false'); the tests enable
  gates only inside their disposable workerd.

## 5. Conditions carried into 7.2/7.3 (binding)

1. The three no-separation layers (model/storage/send) and the explicit
   typed rejections are PRESERVATION REQUIREMENTS: any 7.3 album work must
   extend, never weaken, them (an album is a NEW media kind, not a
   loosening of 'unsupported').
2. 7.2 rights/origin keeps the honesty boundary: ambiguous rights ⇒
   reject/defer with a typed reason; YouTube stays OUTSIDE any download
   permission; R2 only with an explicit policy, rights and free-limit design.
3. No numeric-accuracy claim about media handling without a real benchmark
   (the Phase 6 gate condition applies verbatim).
4. All live paths stay BLOCKED_LIVE (Posidon only); PR #11 open/draft;
   FF-only pushes on `review/r1.10.3-sql-design`.
