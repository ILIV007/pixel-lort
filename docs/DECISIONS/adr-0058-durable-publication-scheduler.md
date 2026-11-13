# ADR-0058: Phase 8.2 — the durable publication scheduler (the publications outbox, claim/lease, failed-publication idempotency, the ADR-0032 gate)

- **Status:** Accepted (V4 local slice; the LIVE wiring — cron route,
  real transport, enablement flag — stays Posidon-only)
- **Phase:** 8 (the DURABLE scheduler consuming the 8.1 policy layer)
- **Date:** 2026-11-12
- **Decided by:** the V4 autopilot under the owner's FULLER-steps order

## Context

ADR-0032 (amended v1.2.3) recorded the roadmap requirement: **before
autonomous channel publishing is enabled, a publishing-side duplicate
mitigation and reconciliation layer is REQUIRED** — the planned
`publications` / `publication_messages` outbox with per-message
reconciliation — so channel-facing posts carry stronger at-most-once
protection than raw webhook responses. Phase 8.1 delivered the pure policy
layer (twp1/pcp1/arp1/psp1); its honest carry named this slice: the durable
scheduler that consumes the policy over durable state.

The blueprint-approved tables ALREADY exist (migration 0001): `publications`
(id, story_id, draft_id, the nine-value status CHECK, priority, approval_mode,
scheduled_at, run_after, lease columns, attempts, max_attempts, the UNIQUE
idempotency_key, last_error) and `publication_messages` (PK
(publication_id, ordinal), UNIQUE(chat_id, message_id), text_hash). The
applied schema is 6; **this slice is ZERO DDL** — it consumes the approved
tables exactly as Phase 7.3 consumed `media_assets` (ADR-0056).

## Decision

- **A REAL durable engine, not another policy layer.** Three pure domain
  modules (`outbox-lifecycle` pol1, `send-outcome` sop1, `publication-identity`
  pidek1), the real D1 store (`publication-outbox-store.ts`), and the
  application engine (`scheduler.ts` + `scheduler-policy.ts`). The only
  artificial seam is the Telegram transport port (the ADR-0042 §6 discipline).
- **THE VOCABULARY CONSTRAINT AND THE HONEST PARKING PIN (owned by this
  ADR).** The schema-6 status CHECK has exactly nine values and NONE of them
  is `uncertain`. Widening a CHECK in SQLite means a table rebuild, which the
  append-only house migration discipline does not do for a vocabulary. The
  ambiguous send outcome (ADR-0032) therefore parks in `failed`, whose
  durable meaning is pinned as «the attempt ended WITHOUT A CONFIRMED
  publication»: the classifier's honest code lands in `last_error`
  (telegram_timeout / telegram_server_error / ... — the reader sees exactly
  what is and is not known), and the ONLY auto exit from the parked state is
  the recorded-evidence heal to `published` (the proof outranks the earlier
  inference). Without evidence the row stays parked for the human
  dispositions (cancel / supersede). An unconfirmed attempt is NEVER
  auto-resent and never asserts proved non-delivery.
- **The identity is the blueprint §7 idempotency.** The enqueue derives
  `pidek1` — sha256 over the tagged (version, draftId, destination)
  serialization — and the UNIQUE constraint SUPPRESSES duplicates: a second
  enqueue for the same draft + destination returns the EXISTING row, never a
  second publication. A retry uses the SAME row and the SAME key (blueprint
  §15: «Retry uses the same idempotency key and claimed state»).
- **The claim is atomic and generation-fenced.** One conditional UPDATE
  (status pending|retry_wait, run_after elapsed, lease free, `attempts <
max_attempts`); the post-claim attempts value is the GENERATION every
  terminal write is fenced by (the admin-post house fence, now over the
  attempts column). A spent-budget row is never re-executed — the boundary
  dead-letters it (the ADR-0037 lesson). A release (policy defer) RESTORES
  the generation: no send was attempted, no attempt was consumed.
- **The ADR-0032 gate is DELIVERED, mechanically:** the send is preceded by
  the EVIDENCE CHECK — a recorded delivery from a crashed earlier generation
  heals the row to `published` WITHOUT a second send; the message record
  (with the exact-bytes `text_hash`) is written BEFORE the terminal, so the
  crash window between them is healed by the next generation; the ledger's
  UNIQUE(chat_id, message_id) rejects a reused/forged response id — the
  honest outcome is the unconfirmed parking, never a claimed published; the
  reconciliation scan promotes parked rows ONLY on recorded proof.
- **The retry family is narrow and bounded.** Only PROVED non-delivery with
  the server's retry_after (429) retries: `retry_wait` on the SAME row,
  honoring max(retry_after, the 60s floor), bounded by the blueprint §7
  budget (3 normal / 5 P0). The 4xx family holds for a human (no blind
  retry). The ambiguous family never retries.
- **The send-outcome classifier pins 429 as proved non-delivery**
  (sop1), per the blueprint §7 «Telegram 429: respect retry_after» and the
  admin-post classifier's own docblock. The DELIBERATE divergence from the
  admin-post CODE (which classifies 429 as uncertain while its docblock says
  definitive) is recorded as a finding: the admin-post direction is
  conservative (a 429-marked-uncertain admin post waits for human
  confirmation — no false success, no auto-resend), so it is NOT changed in
  this slice's scope; the publications engine needs the precise
  classification because it owns the bounded retry machinery. The finding is
  recorded in docs/reviews/PHASE_8_2_DURABLE_SCHEDULER_DESIGN.md §2.
- **The policy is consumed verbatim, decided INSIDE the claim.** Each due
  candidate is claimed first; the 8.1 `planPublicationTime` then runs on
  FRESH history (the provider JOINs stories/drafts over the approved tables;
  the trailing-64 layout trail and the 168h mapped category trail are built
  from durable facts). Defers release with the attempts restored: a
  time-resolvable defer records run_after = scheduled_at = the exact dueAtMs;
  a non-time-resolvable cap re-evaluates after the pinned 10-minute interval
  with scheduled_at NULL (honest: no time was planned).
- **The humanizing jitter is deterministic and cross-validated.** No
  randomness exists anywhere: the jitter is a stable hash of the candidate id
  positioned inside the candidate's class band (anti-flood 2–4 min for the
  unrelated-P0 bypass, 5–20 min latency for P1, 25–45 min normal gap
  otherwise, 0 with no previous send). The unit suite CROSS-VALIDATES every
  derived jitter against the real psp1 for every class/context — a psp1 band
  change fails loudly.
- **The content-type → mix-category map is explicit and TOTAL.** The closed
  24-label `stories.content_type` vocabulary maps onto the closed ten-label
  mix vocabulary by the labeled correspondence the blueprint names; an
  unknown label fails typed (future growth is loud, never a silent
  miscategorization).
- **The gate semantics are explicit in the engine.** `sendGate.enabled ===
false` → DECISION-ONLY observation (the due rows are read, the policy
  decisions are computed and reported, ZERO send-path durable writes — the
  evidence reconciliation still runs: it asserts recorded PROOFS, never send
  decisions). `sendGate.enabled === true` WITHOUT a transport → a LOUD
  misconfiguration: zero writes, error logged — an enablement can never
  silently stand in for a real send. The LIVE wiring (the cron route, the
  real client transport, the runtime enablement flag) is NOT built here and
  stays BLOCKED_LIVE (Posidon only).
- **The `publishing` status stays engine-unused.** The machine accepts it
  (claimed → publishing → the same exits — the schema vocabulary is a
  superset), but the engine follows the admin-post house shape
  (claimed → terminal, fenced). Documented; not a silent omission.

## Consequences

- The ADR-0032 gate's requirement («a publishing-side duplicate mitigation
  and reconciliation layer MUST exist before autonomous publishing is
  enabled») is now DELIVERED at the engine level; the roadmap's Phase 8 gate
  checkbox for the durable scheduler has its engine. The REMAINING surfaces
  before any autonomous enablement: the cron-route wiring, the real
  transport construction, the enablement flag with the owner decision — all
  Posidon-gated (BLOCKED_LIVE), plus the Phase 8 correction/edit and the
  carried album-post integration.
- The story-layer inputs (game keys for the same-game cooldown, the
  event-driven bypass) are carried with CONSERVATIVE defaults (no bypass, no
  cooldown rule, relatedness derived from the durable story identity alone);
  the real story-layer provider replaces them when the producing pipeline
  exists.
- The audit_events integration (per-outcome audit rows) is deliberately NOT
  built in this slice: the durable state + last_error + the ledger + the
  structured logs carry the record; a dedicated audit slice will add the
  writes with its own review (recorded here, not silently skipped).
- Changing any pin (the 60s retry floor, the 10-minute re-evaluation
  interval, the parking semantics) is a policy-version change with its own
  review.

## Verification highlights

- RED-first held: 5 suites (79 tests) written FIRST with real RED (5 files
  cannot-resolve-module, exit 1), then all green: 60 unit + 19 REAL-D1
  integration (registered in `test:db`).
- The tests DISCOVERED the vocabulary constraint (the machine's first draft
  used an `uncertain` status that does not exist in the schema CHECK) — the
  machine and the parking pin were redesigned accordingly, and the pin is
  now load-bearing in the machine's docblock, the store, and the engine.
- The in-round findings are recorded in
  docs/reviews/PHASE_8_2_DURABLE_SCHEDULER_DESIGN.md §2 (the vocabulary
  constraint; the claim-batch generation-read defect — the executor batch
  returns metas without rows, so the generation read is a separate
  lease-protected SELECT; the render document-contract fixture mismatch;
  the dueCount list-vs-true-count semantics; plus the admin-post 429
  doc/code mismatch finding).
- Every number in the engine is either a blueprint quote (the §7 budget
  3/5, the retry_after honor) or a marked pin (the 60s floor, the 10-minute
  re-evaluation interval, the 60s lease).
