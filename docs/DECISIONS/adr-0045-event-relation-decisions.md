# ADR-0045: Phase 5E-1 — bounded event-relation evaluation → durable, evidence-referenced decisions (NO MERGE)

- **Status:** Implemented on the review branch (R1.17; under independent
  Posidon review — NOT deployment, activation, or live-inference approval).
- **Phase:** 5E-1 (the FIRST bounded event-relation + decision-persistence
  slice of Phase 5 story/entity wiring)
- **Date:** 2026-10-30
- **App at delivery:** 1.12.0 candidate; **schema stays 3** (migrations
  0001–0004 untouched — ZERO DDL; the round writes ONLY to the existing
  `story_entities` (read), `drafts` (insert), `ai_runs` (insert),
  `source_items` (read/update-through-the-accepted-commit) and `budgets`
  (the SAME scope-'ai' authority) tables)
- **Instruction:** Posidon R1.17
  (`NEXT_GLM_R1.17_Event-Relation-Decisions.md`)
- **Base:** `1b11ca57b88dda27f78eb9b946db9a1a9570d14a` (R1.16.1 delivery
  HEAD, tree `fb14af3cdcb14d5568a1488bf244b081d905eec2`, app 1.11.1)

## Context

After Phase 5D (R1.16, its R1.16.1 corrections independently ACCEPTED) a
fresh draft is durably connected to its REGISTERED entities — but the
RELATION between two reports about possibly the SAME real-world event is
recorded nowhere: `candidateDiscovery` proposes previously-indexed stories
(fingerprints only) and `candidateAssessment` records what was observed,
with no evaluation and no durable decision. The roadmap's next real step
is the first event-relation path: a real candidate from D1 → a
bidirectional evidence bundle → an evaluation through the injectable real
AI path → a valid, retrievable decision in the SAME durable result.

The scope is deliberately BOUNDED (Phase 5E-1, not all of Phase 5): no
matching/merging, no compact-claim adjudication at scale, no Fact Guard,
no verified semantic accuracy, no publication path. All tests and the demo
run OFFLINE over a fixture provider port; live inference is NOT started in
this round.

## Decision

1. **Candidate retrieval (bounded, deterministic, index-only).** On the NEW
   draft path of `editorial.prepare_draft` — strictly after validation and
   the early exact-content reuse/replay (those return first with ZERO extra
   retrieval/model/charge/write), strictly before commit, and after the
   R1.16 mentions resolution — the handler unions:
   - the fingerprint-discovery candidates of THIS lookup moment (the
     existing `candidateDiscovery` report — ZERO new fingerprint probes);
   - shared-entity candidates: ≤3 deterministic probes (ascending
     entityId, `planEntityProbes`) of `idx_story_entities_entity
(entity_id, story_id)` via `findStoryCandidatesByEntities` (≤9 rows
     per probe, `ORDER BY story_id ASC` BEFORE LIMIT — the R1.13.1
     row-order lesson; overflow honestly probed).
     The union (`buildEventRelationCandidatesReport`) dedups per story with
     `origin` labels (`fingerprint:<signal>` / `entity:<entityId>`), caps at
     8 unique candidates (ascending storyId, honest `candidatesTruncated`),
     excludes self, and records unprobed entities. Smallest-ID selection is
     a COST CAP — never a "best candidate" claim. No candidate ≠ unrelated:
     news with no candidates still builds its own independent draft.

2. **Candidate basis = the durable draft record + the identity bridge.**
   For each candidate: its ready draft at the pipeline version, the
   R1.15.2 null-guarded `readReuseDocumentBasis`, and the bridged ORIGINAL
   reference row (`findEditorialSourceItem(basis.sourceItemId)`) whose
   stored `content_hash` must equal the basis's recorded snapshot identity.
   A missing draft, malformed/legacy basis, missing reference, or stale
   hash is TYPED `basis_unavailable` with its reason — never silently
   skipped, never disguised as no-candidate or different-event.

3. **Bounded bidirectional evidence bundles.** ≤2 pairs per attempt
   (`erp-1`/`erp-2`, ascending storyId): side A = THIS item's real
   composed text (full vs excerpt recorded), side B = the candidate draft's
   OWN immutable `sourceReport` excerpt (never a mutable row's text). The
   two sides' texts total ≤16 KiB UTF-8 (checked, never silently
   truncated); the canonical input hash covers BOTH bases (including the
   candidate draft's exact document bytes hash + reference identity) plus
   prompt/policy version. IDs are never mixed even on name collisions.

4. **The SEPARATE `event_relation` AI task.** The `news_draft` request
   contract and its fixed prompt are untouched. A thin
   `createEventRelationService` reuses the shared protections PRIMITIVE by
   PRIMITIVE (no framework, no unaccounted draft-service copy): the SAME
   durable budget authority (`authorizeAiRequestAttempt`, scope 'ai', the
   SAME `AI_DAILY_REQUEST_ATTEMPT_CAPS` — no separate bucket), the SAME
   versioned allowlist ladder and eligibility gates (Gemini stays
   UNVERIFIED and therefore unwired), the SAME wall-deadline primitive,
   safety refusal terminal (per pair), typed deferrals, no paid fallback.
   Step bounds: ≤2 pairs, ≤3 REAL provider attempts for the WHOLE step
   (shared across pairs), ONE 15 s wall deadline; drafting keeps its own
   deadline and respects the REMAINING budget. The task's immutable prompt
   is `pixel-event-relation-v1` (untrusted-data framing); the strict
   output schema rejects foreign references, wrong pairIds, self-pairs,
   command fields (merge/trust/HTML), incomplete/oversized JSON, and
   defines the `insufficient_evidence` citation contract EXPLICITLY (the
   two `*_proposed` verdicts MUST cite both sides; fabricated references
   are never accepted).

5. **Real storage, not logger-only.** The versioned `eventRelation` ledger
   (`eventRelationVersion: 1`, policy `er1`) rides INSIDE document_json of
   the SAME fenced draft INSERT — the decision ledger of THIS input (no
   old-draft UPDATE, no fake facts rows, no `source_items.raw_json`
   bucket). It carries pair identities, basis hashes/ids/versions, the
   proposed verdict OR a typed non-evaluation state
   (`basis_unavailable`/`bundle_invalid`/`provider_refused`/
   `provider_invalid_output`/`provider_deferred`/`skipped_deadline`/
   `skipped_budget`/`skipped_step_capacity`), citations, prompt/policy
   versions, REAL provider/model, REAL deterministic aiRunIds
   (`aiRunIdForRelationAttempt` — never colliding with the news_draft run
   or another pair/attempt), caps/coverage, and beyond-capacity candidates.
   No raw side text, no self-referential commit SHA. The typed reader
   (`readEventRelationDecision`) validates the REAL invariants (ascending
   order, evaluated shape, no verdict inside failure states, run-id shape,
   counts ≡ ledger) — a payload that merely claims the version is
   `malformed`. `drafts.ai_run_id` stays the news_draft run.

6. **SQL protection of every mutable basis.** Every statement of the commit
   batch additionally carries the R1.17 candidate-basis gate (the twin of
   the R1.16.1 catalog gate): each EVALUATED pair's side-B basis must STILL
   own its ready draft at the pinned version with the EXACT document bytes
   AND the bridged reference row identity/hash — evaluated INSIDE the
   atomic batch (a JS re-read is never a substitute). One invalidated basis
   zeroes EVERY statement → typed `eventRelationBasisChanged` (distinct
   from catalogChanged/fenceLost/snapshotChanged/contentTaken) → the REAL
   runs (drafting AND relation) recorded honestly via the standalone fenced
   insert, no refund, no stale verdict, bounded engine retry.
   `event_relation` ai_runs rows settle ATOMICALLY in the same batch
   (≤3 statements, empty on the disabled/no-candidate paths — a provider
   that never ran is never fabricated). Heaviest statement ≤35/100 of the
   D1 bound-parameter limit; empty lists keep the trivial `1 = 1` gate so
   every accepted non-relation path behaves exactly as before.

7. **Fail-closed flag.** `EVENT_RELATION_ENABLED` ('true' | 'false',
   default 'false') is an INDEPENDENT non-secret gate in ALL environments
   (wrangler root + preview, `.env.example`, `.dev.vars.example`,
   `parseAiConfig`); it NEVER implies `AI_ENABLED` or `EDITORIAL_ENABLED`
   (both stay OFF). Flag OFF ⇒ the honest `disabled` ledger with ZERO
   relation SQL, ZERO calls, ZERO writes, and the accepted normal path
   byte-intact. Only offline tests/demos turn it on with a fixture port.

## Consequences

- Verdicts are MODEL PROPOSALS over named evidence —
  `same_event_proposed` / `different_event_proposed` /
  `insufficient_evidence` — never truth, never a calibrated probability,
  never a merge/publish authorization. Shared entity/URL/title alone is
  not a same-event decision; correlated signals are not independent
  confirmation; conflicting numbers/times/negations stay recorded
  conflicts (a contradiction may still be ONE event); technical failure
  states are never the semantic `insufficient_evidence`.
- Cost is bounded and measurable per path (disabled / no-candidate /
  evaluated-2-pairs / reuse-replay / race) on the LOCAL PROXY; no "0 SQL"
  claim is made.
- The demo (`npm run demo:event-relations`) proves plumbing and fixture
  correctness ONLY — live-model semantic accuracy requires a separate free
  and allowed round.
- Everything else (merging, thresholds, compact-claim adjudication at
  scale, publication) remains explicitly future.

## Prohibitions honored

No subagents, no force/merge, no ZIP, no DDL/migration, no Cloudflare/
deploy/PreviewBuild change, no AI/ingestion activation or live inference,
no Telegram/billing/TARGET_CHANNEL changes, no new media/publisher/admin
surface, no semantic auto-merge, no truth/source-independence claim, and
no unauthorized next step.

## Correction R1.17.1 (v1.12.1) — three independent Posidon findings

Bounded to corrections ONLY (no new capability, no Phase-5 scope claim,
no semantic-model-quality claim). Each counterexample was reproduced RED
on the untouched baseline e61bb46 before its fix and GREEN after.

1. **G1 — the global AI kill switch gates the relation task.** The R1.17
   wiring let a task-specific flag bypass the global inference gate. The
   effective gate is now `AI_ENABLED AND EVENT_RELATION_ENABLED`, both
   fail-closed, in TWO layers: the production wiring passes the global
   gate into the relation service config AND into the handler's relation
   step, and the service itself refuses (`ai_disabled`, zero calls, zero
   budget writes) even for a wrongly-wired caller. Flag independence is a
   scope boundary, never a bypass license.

2. **A1 — post-provider failure exits keep the audit.** The first commit
   throw erased the generation's real invocations from `ai_runs`. Every
   post-provider exit now records the REAL invocations best-effort
   through the fenced standalone inserts with deterministic
   per-(job,generation,pair,attempt) ids and the own-row guard: charges
   stay (no refund), the next generation runs and records its OWN
   invocations (no collision, no misattribution, no free lunch), and a
   used-by-nobody orphan run is never presented as consumed by any draft.
   A persistent store outage can defeat the best-effort record — an
   honest limitation; no exactly-once guarantee is invented. Deferred
   pair ledgers carry the REAL self-side identity (the old
   empty-`sideA` placeholder failed the typed reader).

3. **D1 — the step deadline is ABSOLUTE from the first relation work.**
   Retrieval/basis reads consumed time OUTSIDE the 15 s step deadline,
   after which the service still opened a fresh provider window. The
   handler now sets the absolute deadline at the FIRST relation work and
   passes it to the service, which can only SHORTEN its local cap (never
   reset or extend; non-finite supplied values are treated as absent).
   Reads stop STARTING after expiry: no new probe (the shortfall folds
   into the honest `unprobedCount`), no new basis read (TYPED
   `basis_unavailable/step_deadline_expired`), every pair after expiry
   TYPED `skipped_deadline` with zero run rows. A pending D1 query is
   never claimed cancellable — the bounded race frees the caller only.
   The ≤2/≤3 caps and the separate drafting deadline are untouched.

Permanent regressions: unit (the deadline block + the layered G1 gate)
and integration (the real engine-env wiring matrix with a native-binding
stub and zero network; the multi-pair commit-throw audit before/after the
retry; slow probe/basis/authorization/provider with the injected
fake-clock and manual scheduler — zero real sleeps).

## Correction R1.17.2 (v1.12.2) — two second-generation findings

Bounded to corrections ONLY (no new capability, no Phase-5 scope claim).
Each counterexample was reproduced RED on the untouched baseline a783058
before its fix and GREEN after.

1. **A2 — the durable audit no longer depends on the step returning.**
   The R1.17.1 fix recorded the relation invocations through the step's
   post-return outcome mapping; a failure in the relation task's OWN
   result path after the provider answered (the injected fault class: the
   attempt-record observability write throws) still erased the invocation
   from `ai_runs` (providerCalls=1, durable delta=0 — the exact A1
   signature on a NEW exit). The service now surfaces EVERY REAL attempt
   at RECORD time — before the outcome mapping and before any
   observability sink that may itself fail — through a trusted caller
   collector (`EventRelationAttemptObservation`: pairId, attemptIndex,
   canonicalInputHash, attempt; zero fabricated observations — only
   attempts that actually reached the provider). The handler unions the
   record-time observations with the outcome-mapped rows on every
   post-provider failure exit (deterministic per-(job,generation,pair,
   attempt) ids; the fenced standalone insert's own-row guard dedups).
   Charges stay (no refund); the retry generation owns its own
   invocations (no collision, no misattribution, no free lunch).

2. **D2 — the pending reads are bounded by the step deadline.** The
   R1.17.1 delivery guarded read STARTS but left the awaited retrieval/
   basis/reference queries unbounded — a pending D1 read could suspend
   the whole relation step past expiry (expiry freed nobody; the
   "bounded race frees the caller" contract was claimed but not applied
   to the reads). The entity-probe queries
   (`findStoryCandidatesByEntities`) and the handler's basis/reference
   reads now run through `awaitWithDeadline` under the SAME absolute
   step deadline: expiry frees the CALLER while the read is still
   pending (a pending D1 query is never claimed cancellable), the late
   settlement is observed and absorbed by the primitive (handlers stay
   attached for the promise's whole lifetime — never an unhandled
   rejection), and an expiry OBSERVED by a race stops ALL further
   relation reads (typed `basis_unavailable/step_deadline_expired`; the
   honest unprobed/basis accounting is recorded). A basis whose
   reference identity was not verified before expiry is NEVER bundled
   (the bundle pins the reference content hash) — the R1.17.1
   slow-basis-read scenario's ledger surface moved from pair-level
   `skipped_deadline` to the candidate-level typed technical state with
   the assertion meaning unchanged (budget consumed, ZERO provider
   calls, the draft still commits). The ≤2/≤3 caps, the 15 s step
   deadline, the separate drafting deadline and the G1/A1/D1 corrections
   are untouched; product SQL shapes and gates are unchanged.

Permanent regressions: unit (the record-time observation contract incl.
the injected result-path fault; the absent-safe/zero-fabricated observer)
and integration (the fail-after-provider audit before/after the retry
with no collision/misattribution; the pending basis read and the pending
entity probe each freed by the deadline with late-rejection absorption
and typed ledgers — zero real sleeps).
