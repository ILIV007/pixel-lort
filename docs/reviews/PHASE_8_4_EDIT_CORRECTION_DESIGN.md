# Phase 8.4 — Edit/correction workflows: design and in-round review

- Version: 1.26.0 (schema 6 — ZERO DDL); baseline d272909
- ADR: docs/DECISIONS/adr-0059-edit-correction-workflows.md
- Test evidence: RED-first (2 suites written first, real RED: 2 files
  cannot-resolve-module), then 55/55 GREEN (30 unit + 25 REAL-D1
  integration, registered in test:db).

## 1. The delivered surface

- `src/domain/publishing/edit-correction.ts` — the PURE decision layer
  (ecl1): `planCorrectionDisposition` over the blueprint §15 classes
  (minor_detail / meaningful_update / rumor_confirmed / rumor_denied /
  correction) × (materiality, edit reachability, denial follow-up desire);
  the pinned EDIT_REACH_WINDOW_MS (48h); the versioned deterministic
  `deriveCorrectionAuditEventId` (caid1).
- `src/adapters/db/publication-correction-store.ts` — the durable ops:
  `supersedePublicationById` (conditional UPDATE over exactly the pol1
  supersedable set; not_found vs not_supersedable distinct),
  `listActivePublicationsForStory`, `markDraftSuperseded` (the crash-safe
  route for in-flight rows), `recordCorrectionAuditEvent` (the PK claim),
  `findCorrectionAuditEvent`, `finalizeCorrectionAuditEvent` (the CAS).
- `src/application/publishing/edit-correction-engine.ts` — the composition:
  gate OFF = decision-only (zero writes); the LOUD misconfiguration
  refusal; the `edits_absent` typed refusal; the supersede half
  (follow-up-only; an edit-only correction keeps the row published); the
  edit half (audit claimed BEFORE the transport — at-most-once per
  revision; outcome finalized compare-and-set; sop1 classification; NO
  auto-retry of any edit outcome).

## 2. In-round findings (self-review, found by the tests)

1. **DbQueryMeta shape** — the store initially read `result.meta.changes`;
   the executor's `run` returns the meta DIRECTLY. Found by the real-D1
   tests; fixed; no shipped-code impact.
2. **The link audit leaked into the `none` disposition** — the first cut
   recorded the correction-link audit event even when the plan decided
   `none` (zero effects). The audit trail must reflect ACTIONS, not
   non-actions; the engine now records the link only for non-`none`
   dispositions. Found by the "a none disposition writes nothing" test.
3. **The `editWithinWindow` field conflated two conditions** — the first
   cut reported time-reachability AND ledger presence in one field; the
   ledger absence is already carried by the `no_edit_target` reason. The
   field now reports TIME reachability only. Found by the
   no-recorded-delivery test.
4. **Edit-only supersede semantics (design fix before the first run)** —
   an edit-only correction must NOT supersede the prior row: the delivery
   is corrected in place and the ledger keeps the original record;
   `superseded` is reserved for rows a newer publication replaces. Pinned
   by the "records the applied outcome" test (row stays `published`).
5. **The queued-on-supersede proof** — the eligibility path is REUSED, not
   duplicated: `markDraftSuperseded` flips the draft out of the sendable
   set and the 8.2 scheduler's own check dead-letters the still-pending
   publication (eligibility_lost) with zero send attempts. No new
   scheduler code was needed — the test pins the existing behavior as the
   supersede contract.

## 3. Honest carries (NOT done in this slice)

- **Correction CONTENT rendering**: the engine transports caller-supplied
  per-message envelopes; the label-prepend/render pipeline for correction
  variants is an editorial-domain slice (depends on the fact-guard report
  shape) — carried, not silently dropped.
- **The whole-story sweep**: `listActivePublicationsForStory` REPORTS the
  other active priors; the engine supersedes one named prior per call —
  the caller drives the story-wide correction. An orchestration slice can
  consume it later.
- **Admin-surface disposition**: the correction engine is the system-actor
  path; an admin command (`/correct`) mapping to it is Phase 9 surface
  work.
- **LIVE wiring**: the gate has no production flag/entrypoint by
  construction — BLOCKED_LIVE (Posidon only), unchanged from 8.2.

## 4. Gates executed at delivery

- `npm run check` — exit recorded in the round delivery message (lint +
  format + typecheck + FULL test suite + telegram-setup + secret selftest
  - scan + version gate 1.26.0/schema 6 + dry-run build).
- `npm run test:db` — exit recorded (the 8.4 integration suite registered).
