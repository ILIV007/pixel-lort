# Phase 8.2 — the durable publication scheduler: design, findings, and honest carry

- **Phase:** 8.2 (V4; app 1.25.0; schema 6 UNTOUCHED — zero DDL)
- **ADR:** ADR-0058 (the durable scheduler; the honest parking pin)
- **Date:** 2026-11-12
- **Method:** RED-first (5 suites, 79 tests, real RED: 5 files
  cannot-resolve-module, exit 1) → implementation → GREEN → the full gates;
  every finding below was found by a REAL run and fixed in-round.

## 1. What was delivered (the surfaces)

1. `src/domain/publishing/outbox-lifecycle.ts` (pol1) — the TOTAL typed
   transition machine over the REAL nine-value schema-6 status CHECK; the
   transition table as explicit data; the blueprint §7 budget (3 normal / 5
   P0); the retry plan (max(retry_after, the 60s floor), dead-letter at the
   spent budget); the release plan (the exact dueAt, or the pinned
   10-minute re-evaluation with scheduled_at NULL).
2. `src/domain/publishing/send-outcome.ts` (sop1) — the TOTAL send-outcome
   classifier over structural TelegramApiError shapes: failed_proved{429
   retryable | 4xx hold} / uncertain (the ADR-0032 ambiguous family + every
   unknown shape); the retry_after validated against the client contract
   (1s..1h), never trusted blindly.
3. `src/domain/publishing/publication-identity.ts` (pidek1) — the versioned
   deterministic idempotency key (sha256 over the tagged draft+destination
   serialization) and the exact-bytes content hash for
   `publication_messages.text_hash`.
4. `src/adapters/db/publication-outbox-store.ts` — the REAL D1 store:
   enqueue with the UNIQUE-key duplicate suppression + the typed
   eligibility/mode/score rejections; the atomic claim (the WHERE carries
   status/run_after/lease/budget; the post-claim attempts value is the
   generation); the fenced terminal writes; the release with the attempts
   restored; the boundary budget dead-letter; the ledger writes (UNIQUE
   (chat_id, message_id) → `duplicate_message` surfaced honestly); the
   stale-lease reclaim (attempts preserved); the evidence heals
   (claimed-fenced and failed-status); the blueprint-faithful history JOIN.
5. `src/application/publishing/scheduler-policy.ts` — the TOTAL explicit
   content-type→mix-category map (24→10, unknown typed) and the
   deterministic per-candidate jitter derivation (FNV-1a of the candidate
   id positioned inside the class band; cross-validated against the real
   psp1 in the unit suite).
6. `src/application/publishing/scheduler.ts` — the engine: reconcile
   (evidence heals) → reclaim → due scan → claim → eligibility → the 8.1
   decision INSIDE the claim (fresh history) → send path (pre-send evidence
   check → send → record → fenced terminal | honest parking | bounded
   retry | hold | dead-letter) or release (deferred_time / deferred_policy)
   — plus the decision-only observe mode and the LOUD misconfiguration
   refusal.
7. Suites: `tests/unit/publishing-82-{outbox-lifecycle,send-outcome,
publication-identity,scheduler-policy}.test.ts` (60 tests) +
   `tests/integration/publication-82-scheduler.test.ts` (19 REAL-D1 tests,
   registered in `test:db`).

## 2. In-round findings (all real, all fixed or recorded)

1. **THE VOCABULARY CONSTRAINT (found by the tests, RED round).** The first
   machine draft carried an `uncertain` STATUS — which does NOT exist in
   the schema-6 `publications` CHECK (nine values only). Widening the CHECK
   needs a table rebuild — not done for a vocabulary (the append-only house
   discipline). REDESIGNED: the ambiguous outcome parks in `failed` whose
   durable meaning is pinned as «ended WITHOUT A CONFIRMED publication»,
   the code carries the epistemic truth in `last_error`, the evidence heal
   is the only auto exit, and the machine FORBIDS `claim`/`schedule_retry`
   from the parked state. The pin is load-bearing in pol1's docblock, the
   store, and the engine (ADR-0058).
2. **The claim-batch generation-read defect (self-review).** The first
   claim implementation read the attempts generation from an
   `executor.batch()` second statement — but the batch contract returns
   metas WITHOUT row data. Fixed: the generation is a separate SELECT after
   the atomic claim, which is SAFE because the row is now `claimed` under a
   fresh lease no other WHERE can match (and the stale-lease reclaim cannot
   fire on a future lease).
3. **The render document-contract fixture mismatch (integration RED).** The
   editorial render contract requires `schemaVersion: 1` and `modelClaims`
   in the stored document; the first fixtures omitted them and every
   send-path test dead-lettered with `render_failed:unsupported_version`.
   The fixtures were corrected to the REAL contract — the typed failure
   path itself was proven correct by the same accident.
4. **The dueCount semantics (integration RED).** The first report derived
   `dueCount` from the LIMIT-bounded list; a scan limit of 2 reported 2
   while 3 rows were due. Fixed: a true bounded COUNT query feeds
   `dueCount`; `processed` stays the list length.
5. **The gate-OFF reconciliation report (integration RED).** After moving
   the evidence reconciliation before the gate branch (it asserts recorded
   PROOFS, never send decisions — safe in both modes), the gate-OFF return
   still hardcoded `uncertaintyHealed: 0`. Fixed to carry the real count.
6. **THE ADMIN-POST 429 DOC/CODE MISMATCH (out-of-scope finding, recorded
   per the loop rule §5).** `isDefinitiveSendFailure`'s docblock names 429
   as proved non-delivery («the request was NOT accepted») while the CODE
   returns `retryable === false` — and the client marks 429 `retryable:
true` — so a 429 admin-post send classifies as `uncertain` in code.
   Severity: LOW (the direction is conservative: no false success, no
   auto-resend; the human confirmation path is unaffected). NOT changed in
   this slice's scope; sop1 pins 429 as failed_proved{retryable} per the
   blueprint §7 and the admin-post docblock. Owner/Posidon may align the
   admin-post path in a dedicated round.
7. **The anti-robot gap vs the same-round second send (test design).** A
   same-round second send after a successful publish is IMPOSSIBLE through
   the policy (the gap band always defers it) — the forged-message-id test
   was redesigned to advance the clock past the gap; the policy behavior
   itself is the correct anti-robot semantics and is now pinned by that
   test's structure.

## 3. Honest carry (explicit, not silent)

- The LIVE wiring (the cron route calling `scanDuePublications`, the real
  client transport construction, the runtime enablement flag and its owner
  decision) is NOT built here — BLOCKED_LIVE (Posidon only).
- The story-layer inputs (game keys, event-driven flags) default
  conservatively; the real provider arrives with the producing pipeline.
- The `audit_events` per-outcome integration is deferred to a dedicated
  slice (recorded in ADR-0058 consequences).
- The edit/correction workflows (Phase 8.4's `supersede` consumption) and
  the carried album-post pipeline integration are the next Phase 8 slices.
- The scheduler's D1 cost per scan is bounded (one COUNT + one list + per-
  candidate bounded reads/writes ≤ ~10 queries at scanLimit 10 — inside the
  Free 50-query budget per invocation); the cron cadence owns the throughput.
