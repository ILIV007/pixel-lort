# Phase 5.4 — tests & self-review (V4 local round, delivered ON the 1.19.0 tree)

**Round identity**: tests + docs ONLY on top of the delivered 5.1→5.3 surfaces —
version stays **1.19.0** (no product-code change, no version bump), schema **6**
untouched, every gate stays OFF, `BLOCKED_LIVE` unchanged, Free readiness stays
NOT_READY, PR #11 stays open/draft. Built by the V4 autopilot on 2026-11-10
after the owner's explicit order to take FULLER, more complete steps.

**Method (the owner's order applied honestly)**: a coverage survey FIRST —
every Phase 5.4 roadmap dimension was mapped onto the EXISTING suites; NEW
tests were written ONLY for the dimensions with a proven gap. No duplicated
coverage was added. New deliverables:

- `tests/integration/editorial-54-adversarial.test.ts` — 7 tests on the REAL
  workerd-D1 editorial path (real engine, real fingerprint index, real fenced
  atomic commit; the ONLY artificial piece stays the provider port).
- `tests/unit/editorial-54-adversarial.test.ts` — 3 unit cells completing the
  adjudication merge-disposition matrix.
- This self-review (the roadmap's "self-review" deliverable).

## Matrix — roadmap bullet → coverage (existing first, the 5.4 gap second)

| Roadmap bullet                        | Already proven by existing suites                                                                                                                                                                                 | The proven 5.4 gap → new test                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **collision**                         | unit score-injectivity over all signal subsets (candidate-matching); real-path TWO-exact typed conflict; the anchor PRIMARY KEY collision = `contentTaken` (exact-content suite)                                  | the ≥3 exact-identity boundary keeps the typed conflict (unit); the whole-batch rollback under a D1-layer outage (integration crash test)                                                                                                                                                                                                                         |
| **نام مشابه (similar name)**          | real-path weak-title defer (adjudication persistence); unit title-only stance; the ONE limited normalization (NFC/whitespace/ZWNJ) and Persian/Latin digits NEVER equated (story-fingerprints)                    | two DIFFERENT stories sharing one normalized title tie at the weak score → `ambiguous_tie` + similarity-only defer, explicitly NOT a conflict (integration)                                                                                                                                                                                                       |
| **نسخه/تاریخ (version/date)**         | the composite digest is the FULL title+body composition only (story-fingerprints unit); reuse suite: same URL different content → independent draft                                                               | a version UPDATE at the same URL through the matching/adjudication REPORTS → url-only defer, never identity, never a locator (integration); crash→retry recomputes FRESH reports (integration)                                                                                                                                                                    |
| **بازی‌های هم‌نام (same-name games)** | two items with the same title create two independent stories (source-to-draft); digits/case/negation never folded (story-fingerprints)                                                                            | the two-candidate same-name tie with the ambiguity-vs-conflict distinction at the report level (integration)                                                                                                                                                                                                                                                      |
| **محتوای تکراری از منبع مستقل**       | TWO-exact conflict (candidates seeded from ONE source); conflict precedence incl. suppression                                                                                                                     | the SAME duplicate content fingerprinted by TWO stories from TWO INDEPENDENT sources → typed conflict + every candidate-owned row byte-untouched + `unassessed` verbatim + raw_json preserved (integration — the flagship P1 false-merge proof)                                                                                                                   |
| **contradiction**                     | typed conflict precedence (unit, incl. incomplete-beats-conflict); 21 stored-lie reader cases; evidence-guard identity gate (`invalid_snapshot_identity`)                                                         | the ZERO-candidates-under-overflow cell (`no_ground` still wins) + the derived reviewRequired↔disposition coherence over the honest shape space (unit)                                                                                                                                                                                                            |
| **replay**                            | replay free + byte-stable, no provider call (adjudication persistence); re-execution free (source-to-draft); SAME-snapshot replay of a reused item (exact-content)                                                | the replay AFTER A FAILED generation: attempt-2 recomputes coherent, FRESH flag-gated sibling reports (integration)                                                                                                                                                                                                                                               |
| **race**                              | snapshot race writes NOTHING (adjudication + matching suites); racing deliveries → exactly one owner (source-to-draft); expired lease/old generation write NOTHING; anchor-race loser retries into verified reuse | the ENQUEUE-boundary window: a duplicate enqueue resolves the SAME durable job row (`existing`, same jobId) → one job, one draft (integration)                                                                                                                                                                                                                    |
| **crash**                             | source-to-draft scenario 4: mid-commit failure leaves ZERO rows, no fake processed, honest at-least-once retry with the R1.17.1 orphan-run audit                                                                  | the SAME crash scenario WITH BOTH 5.2/5.3 gates ON: rollback → retry → the flag-gated discovery/matching/adjudication reports are recomputed fresh and coherent (integration); the failure is injected at the D1 LAYER (a constraint violation appended after the real batch) — the same error class as a production store outage, not a JS wrapper throw         |
| **false merge (P1)**                  | "merges NOTHING (stories=2)" (single exact locator echo); conflict never auto-picked; zero-new-SQL batch-shape equality; the advisory-by-construction report (nothing to undo)                                    | byte-level before/after snapshots of EVERY candidate-owned table (stories, claims, evidence, story_fingerprints, drafts) plus the reference items' raw_json under the independent-source conflict; NO `"executed"` key anywhere in the stored document (integration)                                                                                              |
| **provenance loss (P1)**              | witness chain (story → source_report claim → mentions evidence → ai_run) in source-to-draft; evidence-guard identity gate; the immutable reuse document basis                                                     | the FULL witness walk on the flag-gated path: the stored item's snapshot identity recomputable, raw_json byte-preserved (OD-009), the ≤3 fingerprints + the exact-content GROUP anchor RECOMPUTABLE from the stored state, the document's discovery/guard snapshot identities equal the stored item, and NO dangling model-claim evidence reference (integration) |

## P1 analysis — false merge

Four INDEPENDENT layers make a false merge unreachable on the delivered
surfaces, and 5.4 exercises each:

1. **The reports are pure projections** — matching + adjudication are
   deterministic derivations that mutate NOTHING (zero new SQL on the commit
   path — proven by the batch-shape equality suite and re-asserted here by
   the byte-identical candidate-row snapshots).
2. **The only identity-grade output is an ECHO of the verified 5C-3 reuse
   path**, which itself byte-verifies the stored text before ANY reuse and
   never rewrites a story (the reuse suite's refusal/race/fence proofs).
3. **The typed conflict never auto-picks** — ≥2 exact-identity candidates
   (including the new ≥3 cell and the independent-source scenario) defer with
   `conflict_never_auto_resolved` and `reviewRequired: true`.
4. **Suppression precedes every proposal under incomplete coverage** — probe
   overflow or truncation defers even when an exact-identity candidate is
   visible; zero candidates stay `no_ground_no_candidates` even under both
   coverage flags (the new precedence cell).

## P1 analysis — provenance loss

The witness walk proves the item→draft path preserves a COMPLETE, RECOMPUTABLE
chain: draft → story → source_report claim → mentions evidence → stored source
item (snapshot hash + untouched raw_json) → the story's fingerprints + the
exact-content group anchor (all recomputable FROM the stored item) → the
document's discovery/evidence-guard snapshot identities → the recorded ai_run.
A model claim that referenced a missing witness would fail the walk; the
evidence guard's identity gate already rejects foreign snapshots at build
time. Crash paths preserve the audit (R1.17.1 fenced orphan runs) — re-proven
here with the flag-gated reports on the retry generation.

## Findings during the round (honest)

1. **The exact-content GROUP anchor row**: the initial 5.4 test expectation of
   3 fingerprint rows was WRONG — the shipped path writes 4 rows owned by the
   new story (the url/content_hash/title_key signal rows PLUS the group anchor
   `sc1:<digest>` with no story suffix, R1.15). The tests were corrected, not
   the product; the anchor is now asserted as a recomputable witness.
2. **Model-claim evidence identity**: `AiEvidenceSnippet.id` is BY CONTRACT the
   ingestion-side source_item id — model claims reference THAT id, while the
   durable evidence row ids are a separate layer. The walk asserts both layers
   explicitly (the claims reference the real item; the claim→evidence→item
   chain is separate and complete).
3. **The crash model was upgraded mid-round**: the first injection threw a JS
   error from the executor wrapper; the delivered injection fails at the D1
   layer instead (a constraint violation appended after the real batch rolls
   the whole transaction back). Same expected outcomes (zero rows, typed
   retry, charged runs), closer to a real store outage, and the same error
   path the existing anchor-collision suites already exercise.

## Honest limitations — what 5.4 does NOT claim

- The provider stays a captured fake (ADR-0042 §6): NO live model inference
  (BLOCKED_LIVE — Posidon only).
- `same_event` / `truth` / `source_independence` are UNASSESSED BY DESIGN;
  5.4 proves the reports never CLAIM them — not that they are established.
- NO live Cloudflare/deploy/migration/flag/Telegram/data-deletion operation
  happened (BLOCKED_LIVE; schema 6 untouched).
- Phase 5 is NOT claimed complete: 5.4 is the tests/self-review round over the
  delivered 5.1–5.3 surfaces; Free readiness stays NOT_READY; no
  Phase-5-completion claim is made anywhere.
