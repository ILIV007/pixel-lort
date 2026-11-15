# ADR-0062 — the album DRAFT PRODUCER and the WHOLE-STORY correction sweep

- Status: ACCEPTED (delivered at app 1.36.0, schema 6 UNTOUCHED — ZERO DDL)
- Date: 2026-11-12
- Consumers: `src/application/publishing/album-draft-producer.ts`,
  `src/adapters/db/album-draft-store.ts`,
  `src/application/publishing/edit-correction-engine.ts` (the sweep)

## Context

Two documented carries stayed open after 1.35.0 (both recorded in
`docs/CONTINUATION_PLAN_POSIDON.md` slice 2 — «Album and correction»):

1. **The album-draft PRODUCING side** (ADR-0060's honest carry): the
   scheduler's album send path has consumed durable album content
   documents since 1.31.0, but **no flow produced one** — an
   editorial/admin flow that enqueues album drafts did not exist.
2. **The whole-story correction sweep** (ADR-0059's honest carry): the 8.4
   engine corrected ONE prior publication per call and merely REPORTED the
   story's other active priors (`correction_engine.other_active_priors`) —
   no orchestration drove them.

## Decision

### 1. The album draft producer (`produceAlbumDraft` + `enqueueAlbumDraft`)

- **LEDGER-BOUND ONLY**: the plan comes from the pure 7.2 planner
  (`planAlbumMedia` — the ONLY legal plan path) and every plan item must
  resolve to an UPLOADED `media_assets` row through the SAME
  `resolveAssetReuse` predicate the scheduler's send path and the evidence
  path enforce (uploaded + `PUBLICATION_MEDIA_RIGHTS_V1` + the kind
  match). There is NO fetch, NO staging, NO transport and NO license
  invented here — the machine mints no clearance (OD-010): an `unknown`
  durable echo refuses the item exactly like the send gate, so the
  producer's world is honest by construction (nothing is producible until
  the owner's evidence-backed affirmative statuses exist).
- **ALL-OR-NOTHING**: one unresolved item refuses the WHOLE album typed
  (`ledger_binding_unresolved`) with the per-item reason distinguished
  (`no_uploaded_asset` / `rights_not_publishable` / `kind_mismatch`) and
  ZERO durable writes — a partial album can never exist and a doomed
  publication is never created quietly.
- **THE ONLY LEGAL DOCUMENT PATH**: the document comes from
  `createAlbumContentDocument` (the 7.3 strict construction) — the
  fingerprint is derived from the exact bytes stored.
- **THE MACHINE MINTS NO APPROVAL**: the draft ships `ready` (layout
  `album`, version = story max+1, the UNIQUE(story_id, version) fence the
  authority over a racing producer); `enqueueAlbumDraft` refuses every
  non-sendable status — an explicit approval transition (owner/policy) is
  the ONLY route a publication row is created. The enqueue itself is the
  existing idempotent `enqueuePublication` (the pidek1 key), gated first
  by the ADR-0060 album discriminator: a text draft can never ride the
  album enqueuer (`not_album_document`).
- The draft store (`src/adapters/db/album-draft-store.ts`) maps the two
  constraint fences honestly (`duplicate_draft_id` vs `version_conflict`)
  — never a silent overwrite.

### 2. The whole-story correction sweep (`engine.applyCorrectionSweep`)

- **ONE revision drives EVERY active prior** of the story through the
  engine's own `applyCorrection` (one prior at a time, the store's
  deterministic oldest-first order) — one contract reused, no parallel
  semantics.
- **PER-PRIOR AT-MOST-ONCE**: the deterministic caid1 LINK audit id
  (revision, prior) is the skip anchor — a prior the revision already
  drove is `already_swept` with ZERO channel effects; a different revision
  drives the priors again by construction.
- **THE ORIGINAL IS VERIFIED**: the per-prior original envelope is
  re-derived from the STORED draft document (the text render the scheduler
  sent; the album's ordinal-0 caption) and checked against the ledger's
  exact-bytes `text_hash` BEFORE the edits are derived — a document
  altered after publication refuses that prior
  (`content_changed_after_publication`); the correction is never prepended
  onto text the readers did not actually see.
- **AN ALBUM PRIOR CORRECTS ONLY ITS ORDINAL-0 CAPTION** (the caption
  seam): a photo ordinal is not text-editable and is honestly untouched —
  the follow-up publication route remains for deeper corrections.
- **BOUNDED**: 16 priors per sweep pass; beyond the cap the WHOLE sweep
  refuses typed (`too_many_priors`) with zero writes — a sweep is never an
  unbounded fan-out; the human drives the remainder one prior at a time.
- **PER-PRIOR ISOLATION**: one refused prior never blocks the others —
  the aggregate reports every prior (`applied` / `already_swept` /
  `decision_only` / `refused` with the honest reason).
- **THE GATE IS THE ENGINE'S**: OFF = per-prior decision-only plans, ZERO
  writes, ZERO transport calls; ON without a transport = the engine's own
  loud misconfiguration refusal per prior.

## Consequences

- The outbox's album lane is now producible end-to-end at engine level:
  plan → ledger resolution → durable document → draft → (explicit
  approval) → idempotent enqueue → the 1.31.0 send path. No live surface
  changes (all LIVE wiring stays BLOCKED_LIVE, Posidon only).
- A whole-story correction is one call with an honest aggregate — the 8.4
  "drive them one prior at a time" note is the sweep's internal loop, not
  the caller's burden.
- Schema 6 UNTOUCHED (the drafts/publications/publication_messages/
  audit_events tables consumed as approved); ZERO DDL, ZERO migration.
- The OD-010 owner decision remains the gate for ANY live media
  publication: the producer cannot mint clearance, so machine-staged
  media stays unpublishable until the evidence model exists.

## Evidence

RED-first: both suites written FIRST on the unfixed tree —
`tests/integration/album-draft-producer.test.ts` real RED (cannot-resolve-
module: the producer module did not exist) and
`tests/integration/publication-93-correction-sweep.test.ts` real RED
(11/11 failed: `engine.applyCorrectionSweep is not a function`) — then
GREEN (16 + 11). The correction/album regressions (publication-84/85/86)
green UNMODIFIED. Gates at delivery recorded in PROJECT_STATUS.md.
