# ADR-0061 — the correction CONTENT RENDER (the V4 honest carry from Phase 8.4)

- Status: ACCEPTED (delivered at app 1.32.0, schema 6 UNTOUCHED — ZERO DDL)
- Date: 2026-11-12
- Consumers: `src/application/publishing/edit-correction-engine.ts` (the
  `edits` input — byte-shape-compatible, engine code UNCHANGED),
  `src/domain/publishing/correction-render.ts` (the pure derivation), the
  future Phase 9 `/correct` admin surface (the same domain slice)

## Context

Phase 8.4 (ADR-0059) delivered the edit/correction workflows with ONE
documented carry: the engine transports caller-supplied per-message
envelopes — the label-prepend/render pipeline for correction variants was
left as an editorial-domain slice. Without it, every correction caller has
to hand-build the edited message content, and nothing pins WHAT the reader
actually sees after an in-place edit: the original text could be re-worded,
the entities could be dropped or mis-offset, and the fixed correction label
could drift per caller.

The dependency noted in the 8.4 carry ("depends on the fact-guard report
shape") is resolved conservatively: the fact-guard v1 report (ADR-0053) is
stable, but the EDIT content does not need to parse it — the editorial
correction statement is supplied by the editorial flow verbatim, and this
slice never fabricates verdict lines from stored reports.

## Decision

1. **ONE pure derivation** — the new `src/domain/publishing/correction-render.ts`
   (`crn1`):
   - `renderCorrectionEditEnvelope` composes EXACTLY
     `<label>: <statement>\n\n<original text>`: the fixed authored Persian
     label per editable class (`به‌روزرسانی` / `تأیید` / `تکذیب` /
     `اصلاحیه` — the `EDITORIAL_POST_LABELS` house pattern), the editorial
     statement verbatim (never re-worded), and the ORIGINAL text surviving
     byte-for-byte as the suffix.
   - ONE fixed bold entity covers the label + ': ' only (never the
     statement); every ORIGINAL entity survives with its offset shifted by
     exactly the UTF-16 prefix length (the unit Telegram offsets are
     expressed in) and every other field byte-identical. No overlap is
     possible by construction (the statement is non-empty).
   - The original envelope is re-read defensively (`readRichTextEnvelope`)
     and the claimed kind must match the stored kind (`kind_mismatch`) —
     the transport's own re-validation is never surprised.
   - The gates, in order: type checks (`invalid_input`) → the class gate
     (`minor_detail` refused typed — the ecl1 planner never edits a minor
     detail, so such an edit payload can only be an abuse) → the kind
     vocabulary → `statement_empty` → the statement cap
     (`CORRECTION_STATEMENT_MAX_UNITS` = 1024 UTF-16 units, checked BEFORE
     any parse work — the house cap-before-parse ordering) → the envelope
     re-read failures forwarded verbatim → the composed content must fit
     the kind cap (`text_too_large` / `caption_too_large`) — NO
     truncation-to-fit ever exists.
   - TOTAL and JSON-equal deterministic (the 7.2/8.1/8.2 house pattern);
     runtime-invalid values never throw.
2. **The batch derivation is the engine's input** — `deriveCorrectionEdits`
   maps the ledger's per-message view (chatId, messageId, ordinal, kind,
   original envelope JSON) to the EXACT `CorrectionEditMessage` shape
   `applyCorrection` consumes (`shape` + `content {kind, text, entities}`);
   the input order is preserved (the caller passes the ledger's ordinal
   order); the first failing message reports its index; the batch cap
   (`CORRECTION_EDITS_MAX_MESSAGES` = 16) is aligned with the engine's own
   `MAX_EDITS_PER_PASS` and refuses wholesale BEFORE any per-message work.
3. **The engine stays byte-identical** — the render is a pure domain slice;
   the engine's code is NOT touched. The composition chain is proven
   end-to-end over REAL D1 (publication-86): the stored draft document →
   `renderEditorialPostText` (the SAME render the scheduler sends — the
   correction edits what the readers actually saw, never a parallel text) →
   canonical serialization → the correction render → `applyCorrection` with
   the gate ON → the transport receives the label-prepended text with the
   shifted entities; the edit-only contract (the row stays `published`, the
   ledger keeps the ORIGINAL delivery record) and the full
   edit_and_follow_up supersede both hold.

## Consequences

- The 8.4 carry "correction CONTENT rendering" is CLOSED; the remaining
  correction carries are unchanged (the whole-story sweep orchestration,
  the Phase 9 `/correct` admin surface, the LIVE wiring BLOCKED_LIVE).
- The fact-guard report is NOT consumed by the render — the editorial
  statement is authoritative; a future slice may add typed verdict
  reference lines WITHOUT changing this module's composition contract.
- Schema 6 untouched; no flag exists for the render (pure domain); all
  LIVE surfaces stay BLOCKED_LIVE (Posidon only).
