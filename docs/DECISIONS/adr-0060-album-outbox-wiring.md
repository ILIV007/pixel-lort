# ADR-0060 — the album OUTBOX WIRING (the V4 honest carry from Phase 7.4)

- Status: ACCEPTED (delivered at app 1.31.0, schema 6 UNTOUCHED — ZERO DDL)
- Date: 2026-11-12
- Consumers: `src/application/publishing/scheduler.ts` (the send path),
  `src/domain/media/album-send-plan.ts` (the pure derivation),
  `src/adapters/db/publication-outbox-store.ts` (the per-ordinal ledger),
  `src/application/media/upload-service.ts` (the shared identity consumer)

## Context

Phase 7.4 closed the independent review's A1–A6 album blockers and left ONE
documented carry: **the album-post pipeline wiring** — the outbox
claim/lease/approval binding consuming the `sendIdentityKey` (the A4
scaffold) and the attachments contract (the A5 `MediaGroupAttachmentV1`).
Both contracts existed; the wiring itself stayed unbuilt. The Phase 8.2
durable scheduler (ADR-0058) shipped a TEXT-only send path
(`renderEditorialPostText` → `sendMessageRich`), so a draft whose durable
document is an album content document had no route to the channel.

## Decision

1. **ONE pure derivation, shared by both sides** — the new
   `src/domain/media/album-send-plan.ts`:
   - `deriveAlbumSendIdentityKey` is THE versioned send-identity derivation
     (the `album-send:v1` tag, sha256 over the delimited serialization of
     destination + every item's `kind:canonicalUrl` + the caption text).
     The upload service imports THIS function (its former private copy is
     deleted) — the two sides can never drift byte-wise.
   - `deriveAlbumSendPlan` projects a durable album content document +
     destination into the wire plan: file_id items in ordinal order, the
     caption on ordinal 0 ONLY, and an **always-EMPTY attachments array** —
     the A5 fresh-bytes contract belongs to the UPLOAD path, which already
     consumes it; a send-time album NEVER re-fetches bytes. The empty array
     is PINNED by tests, not incidental.
   - `discriminateAlbumDocument` is the TOTAL route check: only a parseable
     object declaring `media: 'album'` enters the album path; parse
     failure / oversize / any other shape routes back to the text path with
     its prior-phase behavior byte-identical.
   - The derivation is TOTAL and typed: the byte cap runs BEFORE the parse
     (an over-cap string is refused without feeding the parser), the
     document is re-validated by ITS OWN strict reader, and the identity is
     derived only from a vouched document.

2. **The scheduler consumes the contracts** (`PublicationMediaGroupTransport`):
   - the seam input IS the A5 `MediaGroupSendInputV1` (items + attachments)
     extended with the re-derived `sendIdentityKey` — the A4 scaffold is
     consumed at the send boundary, not stored anew;
   - failures THROW and classify through the SAME `sop1` classifier as the
     text path (429 proved-retryable with the 60s floor, 4xx hold, the rest
     uncertain) — one honest outcome vocabulary;
   - the constructor PAIR RULE: a media seam without the ledger it binds to
     (`mediaAssets.findAssetsByUrls`) is a construction-time
     `config_invalid` — the wiring can never half-exist.

3. **The ledger binding is fail-closed BEFORE any send**: every document
   item must resolve to an UPLOADED `media_assets` row whose
   `telegram_file_id` matches the document's file_id; a document the ledger
   cannot vouch for dead-letters typed (`ledger_binding_unresolved`) with
   ZERO transport calls. The send identity is never accepted on faith.

4. **The per-ordinal records finally consumed** (the blueprint's ordinal
   records): the response-shape gate (one usable message id per item, in
   ordinal order) runs BEFORE any ledger write (the A2 lesson); the
   delivery records land per ordinal (`publication_messages.ordinal` via
   the extended `recordPublicationMessage`, the caption hash on ordinal 0
   ONLY); the usage binding (`media_usages`, the new
   `recordPublicationMediaUsages` — ONE atomic batch) lands AFTER the
   delivery proof, so a binding failure parks the row uncertain and the
   NEXT scan's evidence check heals it from the recorded messages — a
   binding failure can never orphan a delivery proof.

5. **The LOUD misconfiguration, per shape**: a gate-ON scan with a due ALBUM
   publication and no media seam reports `misconfigured:
'media_transport_absent'` with ZERO writes (the bounded document probe
   runs before Phase A — nothing has been written at that point). A
   text-only deployment without an album due keeps working without the
   media seam; the text path is untouched.

## The gates carried over INTACT

The ADR-0032 gate is shape-blind: the pre-send evidence check heals a
crashed generation from ANY recorded delivery; the uncertain family is
NEVER auto-resent; 429 retries on the SAME row with the SAME idempotency
key bounded by the blueprint §7 budget enforced AT the claim boundary. All
pinned by the new REAL-D1 suite.

## Consequences

- The outbox can now carry album publications end-to-end at engine level;
  the PRODUCING side (an editorial/admin flow that enqueues album drafts)
  remains the documented carry — no producer exists yet, so no live surface
  changes (all LIVE wiring stays BLOCKED_LIVE, Posidon only).
- Schema 6 UNTOUCHED: `publication_messages.ordinal` / `media_group_id` and
  `media_usages` existed in migration 0001 exactly for this consumption;
  ZERO DDL, ZERO migration.
- `media_group_id` stays NULL: the Bot API `sendMediaGroup` response
  carries no group id — the honest NULL, never a fabricated group key.

## Evidence

RED-first: both suites written FIRST, real RED (cannot-resolve-module on
the unfixed tree), then GREEN. Unit `tests/unit/album-send-plan.test.ts`
(12 tests) + REAL-D1 `tests/integration/publication-85-album-wiring.test.ts`
(17 tests, registered in test:db): the file_id-only wire plan + the pinned
empty attachments + the shared identity consumed; the heal without a send;
the shape gate with zero records and no auto-resend; the timeout park; the
429 floor + same-row re-send; the 4xx hold; the three fail-closed binding
refusals; the typed content dead-letters; the untouched text path; both
misconfiguration behaviors; the per-ordinal fences. Gates at delivery:
`npm run check` exit 0 (185 files / 2535 tests), `npm run test:db` exit 0
(61 files / 702 tests).
