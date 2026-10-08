# ADR-0037: Phase 3 review corrections — wire contract, attempt-budget boundary, strict activation gating

- **Status:** Accepted
- **Phase:** 3 (corrective release v1.3.1 on `phase/03-job-queue-engine`)
- **Date:** 2026-10-08
- **Decided by:** Alexios
- **Amends:** ADR-0036 (§3 wire format, §1/§4 attempt budget, §7 activation)

## Context

The independent review of the v1.3.0 Phase 3 delivery found three defects,
each demonstrated by a real integration path rather than a mocked one:

1. **The producer↔consumer wire contract was broken.** The JOBS producer
   adapter pre-serialized the envelope to a JSON STRING
   (`serializeQueueEnvelope` → `queue.send(string)`), while the consumer
   (`parseQueueEnvelope`) expected the structured OBJECT that Cloudflare
   Queues delivers for an object `send()`. In a real producer → delivered
   body → consumer test, a perfectly valid message was classified
   `poison_malformed_envelope` and discarded — no handler ever ran. The
   existing tests hid the defect because they either injected fake producer
   ports directly or manually `JSON.parse`-ed the wire body before calling
   the engine.

2. **The attempt budget was not enforced at the atomic claim/recovery
   boundary.** `claimJob`'s CAS re-claimed a row whose lease had expired
   WITHOUT checking `attempts` against `max_attempts`, and
   `reclaimExpiredClaims` moved expired claims back to `queued`
   unconditionally. A job at `attempts = 3 / max_attempts = 3` whose final
   generation crashed before persisting an outcome (the crash window) was
   re-claimed after lease expiry and EXECUTED a fourth time. The exhaustion
   check lived only in the post-execution retry decision
   (`decideRetry`), which never runs when the previous owner died.

3. **Incomplete configuration was announced as ready.**
   `resolveJobsEngine` read the flag BEFORE validation, so a
   present-but-invalid `JOBS_ENABLED` (e.g. `"not-a-flag"`) fell back to the
   disabled default and was silently treated as `disabled`. An enabled
   engine missing the `JOBS`/`DLQ` queue bindings still resolved `ready`
   (the engine's per-send fail-closed paths were documented as an offline
   convenience). `/health/ready` returned 200 in all of these states
   because it never consulted the Phase 3 resolution.

## Decision

### 1. ONE canonical wire transfer contract (structured envelope object)

- **Producers send the validated envelope OBJECT.** `toWireEnvelope`
  (Zod-validated, reference-only) returns the canonical object; the
  Cloudflare adapter hands that object to `queue.send()`. The platform
  serializes it, and the consumer receives the SAME object as
  `message.body` — no second serialization layer exists on either side, so
  producer and consumer can no longer disagree about the delivered body.
  The DLQ producer follows the same rule (structured bounded reference
  object, no `JSON.stringify`).
- **The consumer normalizes defensively.** `parseQueueEnvelope` accepts the
  canonical object AND a JSON-encoded string (ONE bounded parse,
  `ENVELOPE_WIRE_JSON_MAX_CHARS = 2048`, then the IDENTICAL Zod validation
  path). This keeps pre-upgrade in-flight string messages and offline
  operator replay tooling working; invalid JSON, oversized bodies, and
  wrong shapes remain `malformed_envelope` (fail-safe, no parse DoS
  surface).
- **Producer-side validation stays.** A contract-violating envelope fails
  the send (an ordinary recoverable enqueue failure for the engine) instead
  of putting a malformed body on the wire.
- **The acceptance path is pinned end-to-end:** producer adapter → captured
  wire body → consumer engine → durable success, with NO manual JSON round
  trip anywhere in the test path
  (`tests/integration/phase03-review-regressions.test.ts` test 1, plus
  adapter unit pins).

### 2. Attempt budget enforced AT the atomic claim/recovery boundary

- `claimJob` gains a budget branch evaluated at the boundary, BEFORE the
  CAS: when the row is otherwise claimable (dispatchable status, or
  claimed with an expired/absent lease) but `attempts >= max_attempts`, no
  execution generation is awarded. The row transitions to terminal
  `dead_letter` (`last_error = 'job_exhausted'`, `dlq_delivered_at`
  reset) by ONE guarded UPDATE fenced by the exact observed state.
- The CAS itself additionally carries `AND attempts < max_attempts`, so
  the atomic statement can never over-grant even under a read→write race.
- `reclaimExpiredClaims` applies the same rule with two MUTUALLY EXCLUSIVE
  guarded transitions per row: budget spent → `dead_letter` at the
  recovery boundary; budget intact → back to `queued` for the bounded
  dispatch scan (attempts still never incremented by recovery).
- The claim resolves as `budget_exhausted`; the consumer maps it to
  `{ action: 'ack', outcome: 'job_dead_lettered' }` — an honest
  persist-before-ack: the durable terminal write has landed BEFORE the
  message is acknowledged, fencing is preserved (the guarded UPDATE only
  fires on the exact observed state), and DLQ reconciliation delivers the
  safe reference from durable state as usual.
- Consequence: an over-budget job can NEVER execute again, no matter how
  many times it crashes mid-execution or how its stale envelopes are
  redelivered. The bounded recovery behavior is unchanged for
  budget-intact rows.

### 3. Strict activation gating shared by runtime and readiness

- `resolveJobsEngine` validates FIRST: any present-but-invalid
  `JOBS_ENABLED` is `config_invalid` — never silently `disabled`.
- An ENABLED engine requires the D1 binding AND BOTH queue bindings
  (`JOBS`, `DLQ`); a missing binding is `config_invalid`. The v1.3.0
  producer-less "ready" convenience is removed: an enabled engine must
  never half-run. Tests and offline harnesses that need a producer-less
  engine construct `createJobsEngine` directly (ports stay optional at the
  engine layer — only the ENVIRONMENT resolver is strict).
- `/health/ready` consumes the SAME resolution: `config_invalid` →
  not_ready (503, stable reason `jobs_config_invalid`). A DISABLED engine
  remains the ordinary Telegram-only ready state. Cron and queue
  entrypoints keep their existing behavior for `config_invalid` (structured
  no-op / retry-all — never acknowledge work the deployment cannot safely
  execute).

## Consequences

- Positive: the producer→consumer path is provably connected by a test
  that uses the REAL adapter output as the consumer input; crash-window
  attempt inflation is structurally impossible (boundary + CAS guards);
  readiness can no longer certify a half-configured engine.
- Positive: pre-upgrade in-flight string messages keep processing (the
  defensive normalization), so the wire-contract fix is deploy-safe.
- Cost: environments that previously "worked" with the flag on but
  bindings missing now fail readiness and the entrypoints refuse to run —
  the operator runbook (provision queues → deploy → enable) is the only
  activation path.
- Scope guard: this ADR changes ONLY the three reviewed defects. Schema
  stays at version 3 (migration 0003 untouched); lifecycle, fencing,
  dispatch reconciliation, retry/backoff, DLQ semantics, and the
  activation runbook otherwise follow ADR-0036 unchanged.

## Final correction (same release v1.3.1 — no-throw consumer boundary)

The independent review of the v1.3.1 corrective release found ONE remaining
defect in the same area: `consumeMessage` resolved the claimed case with a
bare `return executeClaimed(...)`. The promise was returned OUTSIDE the
engine's try boundary, so a storage exception thrown by the fenced
succeeded/retry_wait/dead_letter persistence later rejected the whole
`consumeMessage` promise instead of resolving the safe retry action. The
queue entrypoint's defensive backstop still retried (no ack was lost), but
the engine's advertised no-throw contract was violated and the fault
coverage was incomplete (an independent 10-test persistence false/throw
matrix failed 4 cases).

Decision: the claimed execution AND its fenced terminal persistence run
AWAITED inside the existing try (`return await executeClaimed(...)`), so
every storage exception resolves `{ action: 'retry', outcome:
'consumer_error' }` with a stable code only — never a rejected promise. The
entrypoint backstop is preserved unchanged (defense in depth, not the
primary boundary).

Coverage pinned by the reviewer's fault suite, delivered VERBATIM as
`tests/integration/phase03-v131-review-faults.test.ts` (persistence
false/throw matrix over all three terminal transitions, boundary
exhaustion-write faults, repeated completion-write failures reaching the
budget with NO fourth handler execution, and an active final lease that is
never prematurely exhausted), plus worker.queue-level additions in
`tests/integration/job-entrypoints.test.ts` (producer→consumer round trip
with safe duplicate delivery; entrypoint-level terminal-write fault →
retry/no-ack with the row left claimed; each missing DB/JOBS/DLQ binding
failing configuration SEPARATELY; invalid activation retrying without a
handler execution). Maintenance settings SQL moved from the application
handler into the typed DB adapter `upsertMaintenanceHeartbeat`
(`src/adapters/db/jobs-maintenance-store.ts`) — behavior unchanged, no new
framework. Runbook Step 1 and Steps 3–4 corrected: a live schema upgrade
while the old Worker still expects schema 2 may temporarily report
`not_ready` (expected, fail-closed), and the queue consumer attaches AT
deployment regardless of the `JOBS_ENABLED` flag — the flag gates
processing, never attachment.
