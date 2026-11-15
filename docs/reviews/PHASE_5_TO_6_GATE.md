# Phase 5→6 gate — V4 local engineering review (2026-11-11)

**Gate question (roadmap §8, «گیت ۵→۶»):** are the real failures and wrong
merges of Phase 5 fixed, are the unresolved assumptions and the evidence
limitations documented, and does the delivered surface structurally keep AI
from replacing truth verification or provenance?

**Verdict: PASS FOR LOCAL ENGINEERING HAND-OFF** — Phase 6 offline work
(fact-guard design, adapter contract work, E2E fixture paths) may proceed on
this tree. The gate does NOT claim Phase 5 "complete": completion of the
story/adjudication product story still requires Posidon's independent
acceptance and, for every live surface, real execution evidence that only
Posidon can produce (BLOCKED_LIVE unchanged). Free readiness stays NOT_READY.

Scope reviewed: the delivered 5.1–5.4 surfaces at the tree this document is
committed to (baseline chain `3f89544` → `514024d` → `aea26b8` → `8d0a070` →
`a7e3a00` → this tree, v1.19.0, schema 6, every gate OFF, PR #11 open/draft,
CI completed:success on the pushed tip).

---

## 1. Wrong merges — structurally unreachable on the delivered surfaces

Four independent layers (verified against code and the test suites listed in
`docs/reviews/PHASE_5_4_SELF_REVIEW.md`; nothing here is trust in a report —
each claim names the test that pins it):

1. **The matching/adjudication reports are pure projections.** They derive
   from the discovery + assessment already produced by the SAME fenced
   commit — zero new SQL statements on the commit path (pinned by the
   batch-shape equality suites of both 5.2 and 5.3: flag-ON vs flag-OFF
   produce identical SQL). No code path in
   `src/domain/editorial/candidate-matching.ts` /
   `candidate-adjudication.ts` writes, updates or deletes any row; the
   report rides inside `drafts.document_json` and mutates nothing. A stored
   report is advisory by construction — there is nothing to undo.
2. **The only identity-grade output is an ECHO of the verified 5C-3 reuse
   path** (`reuse_locator_single_exact_identity`). The reuse path it echoes
   byte-verifies the stored target text before ANY reuse, never rewrites a
   story, and its refusal/race/fence proofs are the existing exact-content
   suites (R1.15 + R1.15.2). The adjudication layer ADDS no action beyond
   that echo.
3. **Typed conflict never auto-picks.** ≥2 exact-identity candidates ⇒
   `defer_conflict_multiple_identity_candidates` with `reviewRequired: true`
   — a typed record, never a chosen winner. Pinned by the 5.3 persistence
   suite and re-proven at the ≥3 boundary by the 5.4 unit cell.
4. **Suppression precedes every proposal under incomplete coverage.** Probe
   overflow or report truncation ⇒ `defer_incomplete_coverage` even when an
   exact-identity candidate is visible; zero candidates under both coverage
   flags stay `no_ground_no_candidates` (5.4 unit precedence cell).

**The P1 independent-source proof:** the 5.4 integration suite fingerprints
the SAME duplicate content from TWO INDEPENDENT sources and asserts, at the
byte level, that every candidate-owned table (stories, claims, evidence,
story_fingerprints, drafts) and the reference items' `raw_json` remain
UNTOUCHED, the `same_event/truth/source_independence` tuple stays verbatim
`unassessed`, and no `"executed"` key exists anywhere in the stored document.
This is the false-merge proof the roadmap demands for the 5→6 gate.

## 2. Real failures — fixed and pinned (nothing silently weakened)

- **R1.15.2 snapshot-identity + null-guards** (exact-content reuse):
  independently ACCEPTED offline; the corrected reader contract is pinned by
  its own suite and re-exercised by the 5.4 witness walk.
- **R1.16.1 entity-mentions corrections** (Posidon probes C1/U1/R1):
  independently ACCEPTED offline; pinned by the entity-mentions suites.
- **VERSION.json drift in the parallel 5.3 delivery** (missing `sourceTree`
  field): caught by the `check:versions` gate (exit 1), corrected to the
  verified baseline tree `a39e74bc`, gate green — recorded in PROJECT_STATUS
  as a process note, not a product defect.
- **5.4 self-review findings (all resolved in-round, honestly):** (a) the
  exact-content GROUP anchor writes 4 fingerprint rows, not 3 — the TEST
  expectation was wrong, the product was correct, tests fixed; (b) model-
  claim evidence identity uses the ingestion-side source_item id BY CONTRACT
  — the witness walk now asserts both layers explicitly; (c) the crash
  model was upgraded mid-round from a JS wrapper throw to a REAL D1-layer
  constraint violation appended after the live batch (same error class as a
  production store outage) — same typed outcomes, stronger evidence.
- **Issue #12 race** — fixed and fenced; Posidon's independent acceptance is
  still OUTSTANDING and is carried as an open review item, not silently
  claimed.

## 3. Unresolved assumptions — explicitly documented (nowhere laundered)

| Assumption                                                | Where documented                                                                      | Effect                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `same_event` / `truth` / `source_independence` UNASSESSED | every report carries them verbatim `unassessed` (5.3/5.4 suites assert byte-verbatim) | no report claims event identity or truth                                               |
| Gemini Free-tier eligibility UNVERIFIED                   | ADR-0041 + phase6.ts contract                                                         | the Gemini fallback stays OFF in the service ladder even with its operator flag 'true' |
| OD-009 (retention/deletion) OPEN — owner decision         | docs/OPEN_DECISIONS.md; S-01..S-03 measurement delivered, no purge code               | no deletion path exists in the tree                                                    |
| Live Cloudflare state UNKNOWN                             | PROJECT_STATUS (policy)                                                               | all live ops BLOCKED_LIVE (Posidon only)                                               |
| Free plan full-ingestion readiness                        | FREE_SAFE_EXECUTION_DESIGN + ledger                                                   | NOT_READY; pilot-one-source PLAN-ONLY                                                  |
| Provider = captured fake only                             | ADR-0042 §6                                                                           | no live inference anywhere; BLOCKED_LIVE                                               |

## 4. Evidence limitations — the honesty boundaries Phase 6 must keep

- **Evidence Guard v1** (5B, contract FROZEN): a direct text match proves
  only that the text exists in the source excerpt — never that the claim is
  true; absence of a match is never `false` (paraphrase/translation/
  truncation stay `unresolved_requires_further_verification`); excerpt scope
  only; ONE limited normalization (NFC + whitespace + trim; digits and
  negation NEVER folded); headline/summary explicitly `unassessed`.
- **The bounded event-relation ledger** (5E-1) records MODEL PROPOSALS
  (`*_proposed` / `insufficient_evidence`) — never verdicts, never a merge.
- **Bounded lexical lenses are future** (rumor markers, quotation spans,
  number tokens, negation asymmetry): the 6.3 fact-guard work that follows
  this gate stays inside the same honesty boundary — lexical observations
  are NOT truth and its report must never upgrade a claim's `unverified`
  status.

## 5. AI does not replace truth verification or provenance — structural proof

1. Every model claim is stored `status: 'unverified'` (mapper; `facts_json`
   identical) and NO code path upgrades it — conversion to a channel post
   LAUNDERS NOTHING (a claim not exactly `unverified` fails the R1.22
   conversion with a typed failure).
2. The draft→story→claim→evidence→item witness chain is durable and
   RECOMPUTABLE (5.4 P1 walk): snapshot identity re-derivable from stored
   `raw_json`, fingerprints + the exact-content group anchor recomputable
   from stored state, evidence-guard identity gate rejects foreign
   snapshots at build time.
3. The evidence-guard identity gate + the acceptance guard (≥1 traced claim)
   - the evidence-ref validation mean an untraceable claim can never become
     a READY draft on this path.
4. Budget/deadline/refusal semantics (1.10.6/1.10.6.1) treat every model
   output as UNTRUSTED DATA wrapped input — the AI surface has no authority
   to write truth anywhere.

## 6. Gate conditions carried INTO Phase 6 (binding)

- Every Phase 6 deliverable keeps the fail-closed flag discipline
  (independent, default 'false', never implying another gate) and the
  additive-document pattern (absent = key never written; no backfill of
  historical drafts).
- No numeric-accuracy or model-competence claim without a REAL benchmark
  (roadmap gate); all suspicious outputs fail-closed or go to review.
- All live paths stay BLOCKED_LIVE (Posidon only): Cloudflare operations,
  real migration, flag enabling, real AI, real Telegram send, data deletion.
- PR #11 stays open/draft; FF-only pushes on
  `review/r1.10.3-sql-design`; no force, no merge, no base change.

**Next per roadmap after this gate:** Phase 6.3 fact-guard local slice
(conservative, bounded, versioned, flag OFF) — the first post-gate
engineering step, delivered separately with its own RED→GREEN, gates,
checkpoint, backup and honest report.
