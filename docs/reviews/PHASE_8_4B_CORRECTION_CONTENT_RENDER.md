# Phase 8.4b — the correction content render: design and delivery

- Version: 1.32.0 (schema 6 — ZERO DDL); baseline 5e51996 (the 1.31.0
  album-wiring carry)
- ADR: docs/DECISIONS/adr-0061-correction-content-render.md
- Test evidence: RED-first (2 suites written first, real RED:
  2 files cannot-resolve-module), then 32/32 GREEN (20 unit + 12 REAL-D1
  integration, registered in test:db).

## 1. The delivered surface

- `src/domain/publishing/correction-render.ts` (`crn1`) — the PURE
  deterministic label-prepend pipeline the 8.4 design carried:
  - `renderCorrectionEditEnvelope`: `<label>: <statement>\n\n<original
text>`; the fixed authored Persian labels per editable class
    (`به‌روزرسانی`/`تأیید`/`تکذیب`/`اصلاحیه`); the original text byte-for-byte
    as the suffix; ONE bold entity over the label + ': ' only; every
    original entity offset-shifted by the UTF-16 prefix length with every
    other field byte-identical;
  - the fail-closed gates in order: type checks → `minor_detail` refused
    (`class_not_editable` — the ecl1 planner never edits a minor detail) →
    the kind vocabulary → `statement_empty` → the statement cap (1024
    UTF-16 units, BEFORE any parse work) → the defensive envelope re-read
    failures forwarded verbatim → `kind_mismatch` between the claim and the
    stored envelope → the composed kind cap (`text_too_large` /
    `caption_too_large`) — NO truncation-to-fit anywhere;
  - `deriveCorrectionEdits`: the ledger's per-message view → the EXACT
    engine `CorrectionEditMessage` shapes, input order preserved, the first
    failing message reporting its index, the 16-message batch cap aligned
    with the engine's `MAX_EDITS_PER_PASS` refusing wholesale first.
- `tests/unit/correction-render.test.ts` (20) — the composition, the
  per-class labels, the zero-entity and payload-preservation cases, the
  JSON-equal determinism, every fail-closed gate, the no-truncation caps,
  the batch derivation contract.
- `tests/integration/publication-86-correction-render.test.ts` (12 REAL-D1,
  registered in test:db) — the REAL chain end-to-end: the stored editorial
  draft → `renderEditorialPostText` (the SAME render the scheduler sends) →
  canonical serialization → the correction render → `applyCorrection` (gate
  ON, the transport the only artificial piece): the transport receives the
  label-prepended content with the shifted headline entity; the audit event
  records the applied outcome; the edit-only contract (row stays
  `published`, the ledger keeps the original delivery record); the
  edit_and_follow_up supersede; the minor_detail decision-only honesty
  (zero durable writes); the caption seam routing.

## 2. In-round findings (self-review, found by the tests)

1. **The `applied` semantics on a none disposition** — the first cut of the
   integration test expected `applied: false` for a gate-ON minor_detail
   pass. The shipped 8.4 contract (pinned by publication-84) is
   `applied: true` with `disposition: 'none'`: the flag reports the PASS
   executed; the honesty lives in the disposition vocabulary and the zero
   durable writes. The test was corrected to the shipped contract; no
   shipped-code change.
2. **The audit read shape** — the first cut read `findCorrectionAuditEvent`
   as a discriminated outcome; the store returns `{id, metadata_json} |
null`. Corrected in the test; no shipped-code impact.

## 3. Honest carries (NOT done in this slice)

- **The album-draft PRODUCING side** (an editorial/admin flow that enqueues
  album drafts) — unchanged, no producer exists.
- **The whole-story sweep orchestration** — `listActivePublicationsForStory`
  still REPORTS the other active priors; the caller drives them one prior
  at a time.
- **The Phase 9 `/correct` admin surface** — the command mapping to the
  engine + THIS render is Phase 9 surface work (the render is now the
  ready-made domain slice it consumes).
- **The zod v4 TRACKED migration and the Phase 9 remaining screens** —
  unchanged tracked carries.
- **LIVE wiring** — the gate has no production flag/entrypoint by
  construction — BLOCKED_LIVE (Posidon only), unchanged from 8.2/8.4.

## 4. Gates executed at delivery

- `npm run check` — exit recorded in the round delivery message (lint +
  format + typecheck + FULL test suite + telegram-setup + secret selftest
  - scan + version gate 1.32.0/schema 6 + dry-run build).
- `npm run test:db` — exit recorded (the 8.4b integration suite registered).
