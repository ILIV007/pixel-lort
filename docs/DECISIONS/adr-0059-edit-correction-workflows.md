# ADR-0059: Phase 8.4 edit/correction workflows (ecl1)

- Status: Accepted (local engineering; review candidate, NOT activated)
- Date: 2026-11-12
- Phase: V4 Phase 8.4 (app 1.26.0, schema 6 — ZERO DDL)
- Supersedes: none; consumes ADR-0058's `supersede` reservation

## Context

The blueprint §15 defines the publication/edit scenarios (minor detail,
meaningful update, rumor confirmed, rumor denied, failed publication) and §7
pins the audit identity «edit action: revision ID + target message ID unique
in audit». The 8.2 durable scheduler (ADR-0058) reserved the machine-legal
`supersede` transition (pending/retry_wait/published/failed → superseded;
`published` only yields to `superseded`) but nothing CONSUMED it. Schema 6
has no `uncertain` publication status and no correction table — the
append-only migration discipline does not rebuild a table for a vocabulary,
so the correction workflow must live inside the EXISTING approved schema.

## Decision

1. **The decision layer is PURE (ecl1)** — `src/domain/publishing/
edit-correction.ts`: a TOTAL, deterministic `planCorrectionDisposition`
   over the five blueprint §15 classes with the pinned EDIT REACH WINDOW
   (48h — a documented policy constant: an in-place edit only reaches
   readers while the post is current; after the window the plan prefers the
   follow-up). The decision never touches I/O.
2. **The supersede is machine-legal only** — `supersedePublicationById`
   conditionally updates over exactly the pol1 supersedable set;
   claimed/publishing rows (owned by an in-flight generation) and terminal
   rows are refused. The crash-safe route for in-flight rows is the DRAFT
   supersede (`markDraftSuperseded`): a superseded draft leaves the
   sendable set, so the scheduler's existing eligibility check
   dead-letters the publication without a send (proven by test).
3. **An edit-only correction keeps the row `published`** — the delivery was
   corrected in place; the ledger records the original delivery; `superseded`
   is reserved for rows a NEWER publication replaces. `edit_and_follow_up`
   supersedes (the follow-up replaces) and edits.
4. **The audit is the at-most-once claim** — the deterministic caid1 event
   id (`edit:1:<sha256>` over revision+chat+message, version tag inside the
   hashed bytes) inserted into `audit_events` BEFORE the transport call; the
   PK conflict is the honest `duplicate` absorption; the outcome is
   finalized compare-and-set (a stale generation cannot overwrite another
   claim's row). The blueprint §7 «revision ID + target message ID unique in
   audit» is enforced by construction, with no new table.
5. **The edit outcomes reuse the sop1 classification**: 429 is a proved
   non-delivery of the EDIT (recorded retryable, NEVER auto-retried by the
   engine — a parked edit is re-driven by a later correction pass or a
   human); timeout/network/5xx/unknown is the ambiguous window (the edit MAY
   have applied — recorded uncertain, never re-applied automatically). No
   exactly-once claim is made anywhere.
6. **The gate** mirrors the 8.2 house pattern: OFF = decision-only (the plan
   is computed and reported, zero durable writes); ON with an edit
   disposition and no transport = the LOUD misconfiguration refusal (zero
   writes); an edit disposition without edit payloads = the typed
   `edits_absent` refusal (zero writes).

## Alternatives considered

- A new `publication_edits` table: rejected — schema 6 has no such approved
  table, and the audit_events PK already provides the deterministic claim
  the blueprint names.
- Editing Telegram messages through the admin-post path only: rejected —
  the correction workflow must serve the AUTO/scheduler path (the blueprint
  §15 rumor scenarios are story-level, not session-level).
- Auto-retrying parked edits on a schedule: rejected for this slice — an
  uncertain edit needs a re-read of the live message state before a second
  attempt, which is a live-surface concern (BLOCKED_LIVE); the engine
  records the code honestly instead.

## Consequences

- The follow-up path requires the caller to enqueue the new draft version's
  publication through the existing `enqueuePublication` (the idempotency
  identity is unchanged); the engine supersedes the prior row + draft and
  records the link audit.
- The corrected CONTENT construction (the label prepend, the version
  binding) stays with the caller — the engine transports what the caller
  supplies per recorded message; content rendering for corrections is an
  editorial-domain carry (recorded in the phase review doc).
- Live wiring (the cron route, the real transport, the enablement flag)
  stays BLOCKED_LIVE (Posidon only). Zero Cloudflare/Telegram/R2/AI
  operations by construction.
