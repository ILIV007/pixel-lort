# ADR-0046: R1.18 — the first READ-ONLY admin review surface (`/drafts` via the existing Telegram stack)

- **Status:** Implemented on the review branch (R1.18; under independent
  Posidon review — NOT deployment, activation, or live-inference approval).
- **Phase:** 9A early slice (an explicit dependency-driven pull-forward of
  ONLY the read-only part of Phase 9, consuming already-built Phase 5
  output — NOT a completion of Phase 5, 6 or 9)
- **Date:** 2026-10-31
- **App at delivery:** 1.13.0 candidate; **schema stays 3** (ZERO DDL — the
  surface adds exactly TWO read-only SELECT statement shapes and writes
  NOTHING editorial)
- **Instruction:** Posidon R1.18
  (`NEXT_GLM_R1.18_ReadOnly-Editorial-Review.md`)
- **Base:** `474116a1494b39700f23d4e95f90d3967fe1eb15` (R1.17.2 corrected
  delivery HEAD, tree `3c32cc74b00443d9e7d38aafea4d6a20f5e7339b`, app 1.12.3)

## Context

Phase 5 persists rich, strictly-read drafts (`document_json` with the
Evidence Guard, candidate discovery/assessment, entity mentions and the
event-relation ledger), but an authorized admin has no human-readable way
to LOOK at the stored result: the blueprint admin map already registers the
`drafts` command with the `draft.view` permission, yet the router allowlist
does not carry it, so `/drafts` is an unknown command. The gap is
presentation, not generation — and filling it must NOT add another AI
capability, report-writing engine, semantic matcher, automatic merger, new
endpoint, cron, queue or callback machinery.

## Decision

1. **ONE fail-closed flag.** `ADMIN_REVIEW_ENABLED` ('true' | 'false',
   default 'false'; `src/shared/config/phase9.ts`) gates ONLY the new
   read-only commands and their `/help` advertisement. Absent=false; an
   invalid-present value records the config issue and stays disabled —
   never truthy-coerced. Ships 'false' in wrangler.jsonc (root + preview),
   `.env.example`, `.dev.vars.example` and the shipped test-env default.
   The gate NEVER implies AI/editorial/ingestion/relation gates, the
   Telegram ingress itself, or any write path; historical drafts remain
   reviewable with every inference flag OFF.
2. **The EXISTING stack, unchanged contracts.** The synchronous pure router
   (`command-router.ts`) validates the whole `/drafts` argument remainder
   BEFORE any editorial SQL (single opaque token ≤128 UTF-8 bytes, no
   whitespace/control characters, no trailing arguments) and emits two NEW
   typed actions (`drafts_list` / `drafts_detail`) — it never queries D1.
   Access requires the authorization resolution the ingress already
   performs, the EXISTING blueprint `draft.view` permission (roles.ts
   unchanged — owner wildcard; chief_editor/editor/reviewer/viewer
   permitted; source_manager NOT), a PRIVATE chat and a FRESH message;
   wrong-bot targeting, groups/channels, edited messages and unsupported
   contexts keep the existing noop/denial semantics with zero disclosure
   (new stable noop reasons `review_not_private_chat` /
   `review_edited_message`; new denial reason `insufficient_permission`
   localized for authorized actors). The ingress executes the read actions
   through ONE injected application service and sends through the EXISTING
   `sendSafely` gate; a missing service is an honest retryable
   `service_unavailable`, never a silent skip-and-ack. Production wiring
   lives in `telegram-webhook.ts` (flag ON ⇒ the service is constructed on
   the SAME executor) — the offline demo shares the SAME factories.
3. **Two bounded SELECTs, nothing else.** `editorial-review-store.ts` is
   the ONLY editorial SQL of this feature: (a) the ready first page — ONE
   parameterized, LIMIT-6 (5 visible + 1 probe for honest `more_available`)
   SELECT over `idx_drafts_status_time (status, created_at DESC)` with the
   implicit rowid tie order (verified by a REAL `EXPLAIN QUERY PLAN` on
   schema 3: pure index search, NO temp B-tree, no full scan; rowid is NOT
   a public identity), projecting bounded title text and NO document JSON,
   no COUNT(*), no OFFSET, no pagination; (b) the detail — ONE parameterized
   PK lookup with a SQL byte-length guard
   (`length(CAST(document_json AS BLOB))` ≤ 128 KiB) and a conditional
   projection, so an oversized foreign row's content is NEVER transferred;
   the typed too-large state shows safe metadata only. ZERO editorial
   writes; the only writes in a review update are the EXISTING
   `telegram_updates` claim/lifecycle rows.
4. **The saved document, read by the REAL readers.** The projection never
   trusts the stored document: the five additive reports are read through
   the EXISTING strict typed readers (`readEventRelationDecision` on the
   JSON STRING; evidence-guard / discovery / assessment / mentions on the
   parsed document), so `absent` / `unsupported_version` / `malformed` stay
   VISIBLE and distinct PER REPORT — a corrupt optional report never
   crashes the preview and never displays as a zero/no-match; a non-1
   `schemaVersion` or broken core renders the typed unsupported/malformed
   states with safe row metadata only. The view shows the SAVED draft:
   no recomputation from mutable source rows, no side-B reconstruction, no
   fresh basis check, no backfill, no provider calls, no charges, no
   ai_runs rows from a read. The detail composes the stored
   IDs/version/status with the explicit `ready = stored draft, NOT
approved/published` notice, the Persian headline/summary, the bounded
   immutable sourceReport excerpt with the saved snapshot identity, bounded
   UNVERIFIED claim samples with cited evidence ids, the guard's
   direct-text/unresolved summary with the unassessed warning, the
   candidates/mentions historical observations, and the event-relation
   pairs (≤2) with the proposal-vs-technical distinction verbatim.
5. **Budget-first safe rendering.** The renderer composes ≤3500 UTF-16
   code units INCLUDING escaped HTML: per-section budgets decided BEFORE
   composition, code-point-safe truncation (never through an entity or a
   surrogate pair), priority-ordered safety notices that are never silently
   dropped in favor of long content, ONE explicit display-truncated notice,
   always valid Telegram-safe HTML under hostile markup/bidi/astral
   content. Admin-surface labels localize (en default / persisted fa via
   the EXISTING `/language` preference); stored editorial Persian content
   is never translated or rewritten.

## Consequences

- An authorized admin can finally READ what Phase 5 stored — offline in
  this round via `npm run demo:editorial-review` (real workerd D1, the real
  ingress/router/service construction, a fake Bot API, clearly fictional
  fixtures, LOCAL PROXY counters: 1 editorial SELECT per list, 1 per
  detail, zero editorial writes, zero provider calls).
- The read surface adds no new trust: everything shown is labeled as
  stored/unverified/observed; nothing is approvable, publishable or
  mergeable from here. Approval/publishing stays Phase 9 future work with
  its own owner decisions.
- Honest limitations: the bounded first page is not completeness (the
  probe only proves more rows exist); a >128 KiB document shows metadata
  only; legacy/malformed reports show explicit unavailable states; Telegram
  replies remain honest at-least-once as before.

## Addendum — R1.18.1 review-correctness correction (app 1.13.1; schema still 3)

Independent review of the R1.18 slice returned CHANGES_REQUIRED with three
ORIGINAL acceptance counterexamples; this correction-only addendum records
their closure (no new capability, no new engine/endpoint, no DDL):

1. **S1 — safety space is now RESERVED before variable content.** The
   mandatory notices (ready ≠ approved/published; claims UNVERIFIED and
   presence ≠ truth incl. the section header; guard-unassessed where
   applicable; candidates ≠ same-event proof; the three relation
   proposal/technical/no-candidate notices) and every typed report read
   outcome (absent / unsupported_version / malformed) reserve their exact
   escaped size BEFORE any stored content is composed. Long but bounded
   stored text is truncated MORE instead of any mandatory distinction
   being dropped; omissions by caps/space raise the ONE explicit
   display-truncated notice (incl. pair-cap, reason/reference/run caps,
   dropped claim samples and the pair-tail head-only fallback).
2. **V1 — argument-grammar failure is never the list action.** The command
   remainder is now extracted in three distinguishable states (`none` /
   `remainder` / `malformed`) from the ACTUAL whole text: only the
   documented no-argument form reaches the ready-list action; newline- or
   control-bearing and extra-token arguments are rejected by the existing
   whole-token validator BEFORE any editorial SQL (zero SELECTs), with
   `/language` behavior byte-for-byte preserved.
3. **C1 — stored conflicts are displayed.** Each rendered pair shows its
   stored `conflicts` entries verbatim (bounded escaped, DISTINCT from
   reasons; never translated, replaced or inferred; no new assessment) and
   omits nothing silently: cap/space omissions raise the honest
   truncation notice.

The ORIGINAL Posidon R1.18 probes run verbatim (assertions unchanged) in
the small permanent suite `tests/integration/admin-review-originals.test.ts`
(RED 3-failed on the untouched `93e279a` baseline with counters identical
to the independent review log; GREEN after this correction).
