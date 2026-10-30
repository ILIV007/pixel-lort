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
