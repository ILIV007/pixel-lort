# ADR-0065: the publication scheduler's per-outcome audit integration (po1)

- Status: Accepted
- Date: 2026-11-14
- Round: V4 v1.41.0 (schema 6 — ZERO DDL, no migration)
- Closes: the ADR-0058 explicit carry "the audit_events per-outcome
  integration is deferred to a dedicated slice"

## Context

The durable publication scheduler (ADR-0058) writes every send-path
outcome as the row's durable state — the status machine `pol1`, the
classifier's code in `last_error`, the at-most-once `publication_messages`
ledger — but `audit_events`, the operator's ONE-place ledger of durable
decisions, only recorded the HUMAN and gated-system decisions that existed
before it (the admin-post approvals, the 9C `queue_publication_cancelled`,
the ag1 `draft_auto_approved`, the 8.4 edit audit, the 9D capture). The
scheduler's own per-attempt story — what was confirmed sent, what parked
uncertain with which classifier code, what dead-lettered, what a recorded
proof healed — had to be reconstructed from the row states. This slice
closes that carry.

## Decision

1. **The audit surface is the generation-CONSUMING outcome** — exactly the
   writes the ADR-0032 gate story is made of, instrumented at the ONE
   fenced terminal funnel (`writeClaimedTerminal`) plus the three
   proof/decision writes outside it:

   | write                       | audit action                   | deterministic id                                       |
   | --------------------------- | ------------------------------ | ------------------------------------------------------ |
   | `publish` terminal          | `publication_sent_confirmed`   | `publication-outcome:<id>:<generation>:publish`        |
   | `mark_uncertain` (the park) | `publication_uncertain_parked` | `publication-outcome:<id>:<generation>:mark_uncertain` |
   | `dead_letter` terminal      | `publication_dead_lettered`    | `publication-outcome:<id>:<generation>:dead_letter`    |
   | `fail_hold` terminal        | `publication_failed_held`      | `publication-outcome:<id>:<generation>:fail_hold`      |
   | `schedule_retry` terminal   | `publication_retry_scheduled`  | `publication-outcome:<id>:<generation>:schedule_retry` |
   | boundary budget dead-letter | `publication_dead_lettered`    | `publication-outcome:<id>:boundary:dead_letter`        |
   | `healFailedToPublished`     | `publication_evidence_healed`  | `publication-outcome:<id>:healed`                      |
   | `healClaimedToPublished`    | `publication_evidence_healed`  | `publication-outcome:<id>:healed`                      |

   The two heals are mutually exclusive pre-states of one terminal row
   (`failed` vs `claimed`), so the shared generation-less id is unique, and
   a heal happens at most once per row (`published` is terminal).

2. **The actor and the metadata**: actor_type `system`, actor_id
   `publication_scheduler:pol1` (the lifecycle version the writes obey).
   The metadata carries the MEASURED data only — `outcomeVersion: 'po1'`,
   `reason`, `attempts` (the fenced generation), the classifier
   `errorCode`, `runAfterMs`, `heal` (`reconciliation`/`pre_send`),
   `boundary` — NEVER the destination, never document content, never a
   chat id (pinned on the serialized metadata).

3. **The house failure semantics**: the audit INSERT rides AFTER the
   fenced status write (the status is the authority); only a duplicate
   audit id (`db_constraint_violation`) is absorbed — the same logical
   outcome is written once even across crash retries — and any other
   audit failure propagates loudly after the status landed, exactly like
   the 9C cancel's audit semantics.

4. **The honest bounded scope (documented, deliberate)**: the writes that
   consume NO attempt stay UN-audited — the policy-defer release
   (attempts restored), the send-started marker, the stale-lease reclaim,
   and the bulk in-flight park (`parkExpiredPublishingUncertain`, whose
   bulk UPDATE returns no per-row identities). Their rows carry the state;
   every subsequent terminal, heal or cancel OF those rows IS audited, and
   a generation that crashed before any terminal leaves the honest gap
   that its own row state (and the next generation's evidence check)
   describes.

## RED-first evidence and the preservation proof

- `tests/integration/publication-95-outcome-audit.test.ts` (8 REAL-D1,
  registered in `test:db`) was written FIRST and recorded a REAL RED on
  the un-instrumented store (exit 1 — the po1 exports did not exist and no
  audit rows were written), then 8/8 GREEN: the deterministic
  id/actor/action/metadata pins for every terminal family, the
  fence-rejected NO-audit pin, the exactly-once heal, the boundary row,
  the destination/content privacy pin, and the full one-attempt chain
  auditing exactly ONE row.
- ONE in-round fixture finding fixed honestly before GREEN: the enqueue
  outcome kind is `created`, not `enqueued`.
- The FULL unit suite 206 files / 2815 tests GREEN UNMODIFIED (the 2807
  pre-existing tests untouched — the existing audit assertions are
  action/target-scoped and never collided).

## Consequences

- The ADR-0032 gate story is queryable in one place: a parked row's audit
  trail reads `parked(code) -> healed` or `parked(code) -> cancelled`,
  without joining the state machine.
- The audit volume is bounded by the attempt budget (3-5 rows per
  publication, plus at most one heal), never by scan frequency — the
  scheduling-state writes that consume no attempt are deliberately
  unaudited.
- Schema stays 6; no DDL; no flag; every live activation lane stays
  BLOCKED_LIVE (Posidon only).
