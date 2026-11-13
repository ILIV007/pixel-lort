# ADR-0063: the measurable AUTO-publish candidate gate and the fenced auto-approval transition

- Status: Accepted (engine level; every live activation stays BLOCKED_LIVE)
- Date: 2026-11-13
- Round: V4 slice-3 (v1.37.0, schema 6 — ZERO DDL)
- Plan: docs/CONTINUATION_PLAN_POSIDON.md slice 3 ("End-to-end editorial and fact safety")

## Context

The plan's slice 3 requires measurable, fail-closed AUTO gates — for
unsupported claims, uncertainty, schema errors and prompt injection — that
keep legitimate automated publishing possible, without equating references
alone with semantic proof. The engine already had every ingredient EXCEPT
the candidate gate and the durable route from an eligible candidate to the
status the outbox consumes:

- the schema-6 `drafts` CHECK and the outbox `MODE_STATUS_MATRIX` already
  accept `auto_approved` for the `auto`/`safe_auto` modes — but NO writer
  produced that status (the vocabulary existed without its producer);
- the fact-guard report (6.3) rides the prepare-draft commit under its
  independent flag and pins per-claim `reviewRequired` — but nothing
  consumed it as a publishing decision;
- the review's a279e13 round (OD-010) established that the machine mints
  no clearance and that provenance is not permission — the same honesty
  applies to approval: a measurable policy route, never a blanket one.

## Decision

1. **The pure candidate gate (`ag1`)** — `evaluateAutoPublishGate` over the
   stored draft bytes only (no database access, no provider call):

   - the document re-read through the send path's own strict reader
     (`renderEditorialPostText`): a shape the renderer refuses (including a
     laundered claim status) refuses `document_unreadable`; a composition
     over the send caps refuses `composition_not_sendable` — a doomed
     publication is never created quietly;
   - the fact-guard report must be present (absence = the flag-off
     historical shape = the fail-closed refusal, never a pass), well-formed,
     version-supported and snapshot-bound;
   - the report must be TOTAL over the document's own claim indices (no
     gaps, no strangers) — `report_claims_incomplete` otherwise;
   - ANY non-benign finding on ANY claim ⇒ `requires_review` carrying the
     per-claim finding CODES; zero findings on every claim ⇒
     `eligible_auto` carrying the report's own limitation labels VERBATIM.

   The honesty boundary: the gate NEVER claims semantic detection. Its
   injection containment is measurable and bounded — injection text is
   inert data (never interpreted, never obeyed), and a claim it generated
   has no lexical basis in the stored excerpt and refuses BY CODE
   (`number_not_observed_in_evidence`, `no_evidence_basis`, …). The
   limitation labels (`lexical_presence_not_truth`,
   `marker_lists_are_not_exhaustive`, …) ride every verdict — references
   alone are not semantic proof.

2. **The fenced durable transition** — `approveDraftForAutoPublication`:
   ELIGIBILITY IS NOT ACTIVATION (both the eligible verdict AND the
   independent enablement flag are required; either missing refuses with
   ZERO writes); the fence is `UPDATE drafts SET status='auto_approved'
WHERE id = ? AND status = 'ready'` (the rowcount is the authority; the
   post-fence re-read distinguishes the honest `already_auto_approved`
   idempotent absorption from `not_ready`); a non-eligible verdict refuses
   BEFORE any write; ONE system audit event (`draft_auto_approved`,
   actor `auto_gate:ag1`) carries the measured data (gate version, claim
   count, fact-guard version, limitation labels) — never document content.

3. **The connected demonstration** — the slice-3 suite proves the WHOLE
   chain over real D1: real snapshot → real durable job → real
   prepare-draft (fake provider port) → real fenced commit with the
   fact-guard report → the gate over the STORED bytes → the fenced
   transition → real idempotent enqueue (auto mode) → real scheduler
   scan/claim/policy → real rendered send through the FAKE transport → the
   at-most-once ledger → published — plus the refusal family at the same
   chain, each with ZERO writes.

## Consequences

- The AUTO lane is now REACHABLE end-to-end at engine level: a draft the
  gate finds eligible can be transitioned, enqueued (`auto` mode) and sent
  by the unmodified scheduler — legitimate automated publishing stays
  possible.
- Nothing is activated: the enablement flag ships OFF, the transition is
  an explicit call, and LIVE surfaces stay BLOCKED_LIVE — the staged
  `safe_auto → auto` rollout remains Posidon's decision (Phase 13), now
  with a measurable per-candidate gate to activate instead of a prose
  policy.
- The human path is untouched: every non-eligible verdict, every
  disabled flag and every fenced state keeps the draft exactly where the
  human workflows left it.
- Schema 6 UNTOUCHED (ZERO DDL): the `auto_approved` value the producer
  now writes was already in the drafts CHECK and the outbox matrix.
- OD-010 is unaffected: the gate decides TEXT drafts only; media stays
  behind the rights-EVIDENCE owner decision.

## Evidence

RED-first: `tests/unit/auto-gate.test.ts` (15) and
`tests/integration/editorial-94-auto-gate-e2e.test.ts` (6 REAL-D1) written
FIRST with real RED (cannot-resolve-module on both) then GREEN; the four
defect suites (publication-90/91/92, media-93), the d65d811 families
(publication-85/87/88/89, publication-send-safety), editorial-64 and
publication-82 green UNMODIFIED. Gates recorded in PROJECT_STATUS.md.
