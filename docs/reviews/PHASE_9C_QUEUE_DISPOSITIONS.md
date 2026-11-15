# Phase 9C — the write-capable queue disposition surface (design record)

Round: 1.38.0 (schema 6, ZERO DDL). Baseline: cb571fc (the 1.37.0 slice-3
delivery). Plan slice: `docs/CONTINUATION_PLAN_POSIDON.md` slice 4 (Admin
experience) — the honest carry «the write-capable queue dispositions».

## 1. What this slice is

The Phase 9A `/queue` screen is observation-only. This slice adds the ONE
human disposition the outbox machine (pol1) legally supports from the
waiting/parked states, through the existing house machinery — RBAC, opaque
scoped single-use action tokens, bounded grammar, a fenced durable write and
an audit event — and pins the honest boundary: the ambiguous-outcome rows
are STOPPED, never blind-auto-resent.

- `/queue` (no args) — the EXACT read-only screen of Phase 9A, byte-identical
  behavior, still gated by `ADMIN_QUEUE_ENABLED`.
- `/queue <publicationId>` — the NEW bounded detail surface, gated by its OWN
  independent fail-closed flag `ADMIN_QUEUE_WRITE_ENABLED` (default 'false',
  invalid-present = disabled). While OFF the one-argument form keeps the EXACT
  Phase 9A invalid-usage response (never leaking that a richer surface
  exists).
- The disposition itself: ONE action — **cancel** — legal from
  `pending` / `retry_wait` / `failed` (the pol1 `cancel` rows). A parked
  ambiguous row (`failed` with the classifier's code in `last_error`) is
  therefore human-STOPPABLE; it is never auto-resent by this surface (no
  "retry now" disposition exists here — the only re-send path in the whole
  product remains the ADR-0032 evidence heal and the 8.4 correction supersede
  flow).

## 2. The pure disposition module (`qd1`)

`src/domain/publishing/queue-disposition.ts` — the TOTAL, typed decision the
service and the store both lean on (the 7.2/8.1 house pattern: the decision
is DATA, never prose):

- `evaluateQueueDisposition(status)`:
  - `pending | retry_wait | failed` → `cancellable` (the pol1 cancel rows);
  - `claimed | publishing` → `refused: in_flight` (a worker may hold the
    lease — a racing disposition is refused typed; the operator re-checks
    after the lease resolves);
  - `published` → `refused: already_published` (the 8.4 correction supersede
    flow owns that row);
  - `dead_letter | cancelled | superseded` → `refused: terminal` (pol1: the
    terminal rows have NO exits).
- `parseQueueDispositionArgument(raw)`: the whole-token grammar (the exact
  R1.18.1/9B discipline — forbidden whitespace pattern, UTF-8 byte bound,
  the C0 control-character and DEL scan). A newline-bearing or oversized
  argument is an invalid GRAMMAR failure before any query could exist.

## 3. The fenced durable write

`cancelPublicationById` in `src/adapters/db/publication-outbox-store.ts`:

- THE FENCE: `UPDATE publications SET status='cancelled', updated_at=?
WHERE id=? AND status IN ('pending','retry_wait','failed')` — the rowcount
  is the authority (the ADR-0037/auto-approval house shape). `last_error` is
  deliberately NOT overwritten: a parked row keeps its classifier code as
  the epistemic record of WHY it parked; the cancel's story lives in the
  audit event.
- rowcount 0 → the post-fence re-read distinguishes the honest reasons:
  `not_found` (the row is gone) vs `not_cancellable` (the row exists but has
  left the fence's status set — a worker claimed it, it healed, it was
  already terminal). ZERO effect either way.
- rowcount 1 → ONE audit event (`audit_events`, actor_type `admin` (the
  CHECK vocabulary of migration 0001 — the actor is a human admin on the
  admin surface), actor_id the numeric caller, action
  `queue_publication_cancelled`, target_type `publication`) with a
  DETERMINISTIC id `queue-cancel:<publicationId>` — a duplicate (an
  impossible second cancel of a terminal row) is absorbed, never a second
  event. The metadata carries the measured data only: the disposition
  version, the prior status, the caller's permission. Never document
  content, never destinations, never secrets.

## 4. The surfaces

- **Detail view** (`queue_detail` router action): `publication.view` RBAC
  (the same permission the read screen uses — the detail is observation);
  the injected service performs ONE bounded SELECT (`findPublicationById`)
  and renders the reserved-skeleton detail (identity/status/priority/
  attempts/schedule facts/stable codes only — never draft content, never
  destinations). The cancel button is minted ONLY when the row evaluates
  `cancellable` AND the caller holds `publication.cancel` — one opaque,
  single-use, user-bound token (the Phase 2A `admin_action_tokens`
  machinery, action `queue.cancel_publication`, target
  `queue_publication`, 15-minute expiry), issued DURABLY before the message
  carrying it is sent.
- **Callback** (`action_token_callback` router action): the router emits it
  for `a:` callbacks ONLY while `ADMIN_QUEUE_WRITE_ENABLED` is ON (the
  legacy `admin_post_callback` emission is byte-identical while the write
  flag is OFF — zero behavior delta for every existing surface). The ingress
  executes it through a NEW token dispatcher that PRE-READS the token's
  action WITHOUT consuming:
  - unknown token → the honest invalid answer, nothing consumed;
  - `admin_post.*` → the existing admin-post service (absent = the honest
    retryable wiring failure) — its own consume/validate flow UNCHANGED;
  - `queue.cancel_publication` → the NEW disposition service (absent =
    retryable);
  - anything else → the honest invalid answer, NOT consumed (a foreign or
    future token can never be burned by the wrong service).
    The queue disposition callback then follows the admin-post confirm shape:
    guarded single-use consume (bound to ONE user), the permission RE-CHECKED
    at callback time (a mint-time holder whose role was revoked is refused),
    the fenced store write (the rowcount authority — a row claimed by a worker
    between view and click answers the honest `not_cancellable` with ZERO
    effect), and the audit event on the applied path.

## 5. Honest boundaries

- The disposition NEVER sends anything: no transport seam exists on this
  surface, and the whole flow is asserted to perform ZERO
  `publication_messages` / `media_usages` writes (the suite pins the SQL
  texts).
- The disposition is not an approval mint, not a rights decision, not a
  retry. The OD-010 rights-evidence model and the album-draft capturing side
  stay their own carries.
- Every activation stays Posidon's: `ADMIN_QUEUE_WRITE_ENABLED` ships
  'false' everywhere (wrangler, .env.example, .dev.vars.example, the test
  env) and the suite pins the flag-off behavior byte-identical to Phase 9A.
- LIVE surfaces BLOCKED_LIVE (Posidon only).

## 6. Tests (RED-first)

- `tests/unit/queue-disposition.test.ts` — the pure module: the TOTAL
  disposition table (every status of the pol1 vocabulary), the argument
  grammar family (empty, whitespace, newline, control characters, oversized,
  the valid opaque token), determinism.
- `tests/integration/admin-queue-disposition.test.ts` — REAL D1, registered
  in `test:db`: the flag parse family; the router grammar/RBAC/noop family;
  the detail view (cancellable/not-cancellable/missing rows; the button
  minting rules; the viewer no-button pin); the callback family (apply +
  audit row + honest answer; the second click invalid; a foreign token NOT
  consumed; the revoked permission; the raced claim → `not_cancellable`
  zero-effect; the missing service → retryable); the zero-publication-writes
  SQL-text assertion; the flag-off byte-identical Phase 9A behavior.
