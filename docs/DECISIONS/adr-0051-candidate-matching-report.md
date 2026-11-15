# ADR-0051: Deterministic candidate-matching report (Phase 5C-4 — V4 Phase 5.2)

- Status: implemented locally (review candidate, NOT activated; all gates OFF)
- Date: 2026-11-10 (UTC)
- Version: 1.18.0 (schema 6 unchanged, no migration)
- Supersedes: none; extends ADR-0043 (fingerprints/candidate discovery +
  conservative assessment) with the matching LAYER only.

## Context

The V4 owner directive (00_PROMPT_CONTINUE_ALL_PHASES_FA.md) explicitly
lifted the former "5.2 matching waits for an owner decision" restriction
FOR LOCAL design/build/test: "عبارت «منتظر تصمیم ۵.۲» مجوز جدید را نادیده
نمی‌گیرد: اکنون این قسمت را محلی طراحی/ساخت/تست کن", with hard
constraints: deterministic, versioned, bounded, conservative, default OFF,
reversible, conflict-tested, no real-data touching, and — critically —
"هیچ ادعای یکسان‌بودن رویدادها با شباهت یا AI به‌تنهایی نکن" (never claim
event identity from similarity or AI alone).

The tree already had (Phase 5C-1/5C-2, ADR-0043): bounded fingerprint
discovery (≤3 lookups, ≤9-row probes, ≤8 reported candidates, overflow
recorded) and a conservative per-candidate ASSESSMENT that deliberately
carries NO confidence, probability, score, or threshold. Phase 5C-3
(R1.15.x, independently accepted) owns the identical-content REUSE
behavior. What was missing was the matching layer between discovery and
any future adjudication: transparent scores with reasons, report-level
ambiguity/overflow honesty, and an explicit identical-news vs
similar-event separation.

## Decision

1. **Pure derivation, zero new surface.** The `candidateMatching` report
   (`matchingVersion: 1`, `src/domain/editorial/candidate-matching.ts`)
   is derived ONLY from the sibling `candidateDiscovery` +
   `candidateAssessment` of the SAME draft — no SQL, no network, no
   clock, no model call — and rides INSIDE `drafts.document_json` of the
   SAME fenced atomic commit. Zero new statements, zero execution calls,
   zero cost. Schema stays 6.
2. **Score = canonical observation-set encoding, never confidence.**
   Fixed weights (url 4, content_hash 8, title_key 1) are chosen so every
   non-empty subset sums UNIQUELY (subset-sum injectivity): equal scores
   ⇔ identical observed signal sets. Correlated signals never compound
   (duplicates collapse). The score ranks candidates WITHIN one report
   only; it is never compared across reports and never used as a
   threshold — every candidate stays listed with its assessment verdict.
3. **Report-level outcome separates the two relations V4 asks about.**
   `identical_content_relation_observed` ONLY when the versioned
   content-composite fingerprint really matched — a LOCATOR for the
   verified 5C-3 reuse path, never itself a merge/dedup/processing
   decision. `similar_signals_only_observed` for anything weaker —
   explicitly NEVER same-news evidence. Nothing observed stays
   `no_candidates_observed`.
4. **Report-level resolution is honest about ambiguity and coverage.**
   Probe overflow OR report truncation ⇒ `unresolvable_incomplete_coverage`
   (no best-candidate claim exists under incomplete coverage); a tie at
   the top score over the SAME observed set ⇒ `ambiguous_tie_observed`;
   otherwise `single_top_candidate_observed` — an observation of the
   candidate-list shape, never a confirmation. Precedence is fixed and
   tested (incomplete > tie > single > none).
5. **Independent fail-closed gate.** `EDITORIAL_MATCHING_ENABLED`
   (default 'false' in .env.example, .dev.vars.example and BOTH wrangler
   environments) never implies EDITORIAL_ENABLED or AI_ENABLED. Flag OFF
   ⇒ the payload is never computed or stored (the key is absent, never an
   empty placeholder) and the accepted path stays byte-identical.
6. **Typed reader with real cross-validation.**
   `readCandidateMatchingReport` treats absent / unsupported_version /
   malformed as DISTINCT, requires BOTH valid siblings, mirrors entries
   1:1 in the sibling order, and RE-DERIVES verdicts, scores, outcome,
   resolution and topScore from the sibling's matched signals — a stored
   lie is malformed. `unrelatednessConcluded` stays FIXED false; the
   same unassessed tuple (same_event / truth / source_independence) rides
   verbatim; discovery truncation/overflow/coverage limits are preserved
   verbatim; candidate data is never re-fetched or re-validated.

## Alternatives rejected

- **Scores as probabilities/confidences** — rejected: unverifiable,
  invites threshold thinking, contradicts the 5C-2 contract and the V4
  rule that similarity never proves identity.
- **Threshold-based per-candidate DECISION proposals** (e.g. fixed
  same-story/related score cutoffs) — rejected for THIS slice: 5C-2
  explicitly carries NO score/threshold, and a decision layer is Phase
  5.3 territory. PRESERVED PROPOSAL: an UNMERGED, untracked and untested
  parallel draft (`sm1` rules version, weights 80/45/15 + bonus 10,
  thresholds 70/30, suppression policy, flag `STORY_MATCHING_ENABLED`,
  a dangling OD-010 reference) appeared in this worktree mid-tick from a
  dead session — it is preserved BYTE-IDENTICAL outside the build
  surface at
  `docs/reviews/unmerged-proposal-story-matching-sm1_ORIGINAL-PATH-src-domain-editorial-story-matching.ts.txt`
  (SHA-256 7a7db07eb79fa124173d7806efc9dcfb1620d34754f8facaf7879b3da35dfd33,
  original path src/domain/editorial/story-matching.ts, mtime
  2026-11-10T12:18:40Z) as a candidate input for the FUTURE Phase 5.3
  adjudication-design decision (owner/Posidon); it was NOT adopted, NOT
  deleted, and never reached any gate.
- **Fuzzy/semantic matching in this slice** (normalization beyond the ONE
  limited title rule, embeddings, AI scoring) — rejected: out of scope,
  unbudgeted, and exactly the "identity by similarity" claim V4 forbids.
  Entity-alias inputs are recorded as a FUTURE signal source, not
  invented into v1.
- **A separate matching table/DDL** — rejected: the report is a pure view
  of the lookup moment already recorded by the siblings; new DDL would be
  an unjustified schema-7 migration.
- **Report-level "best candidate" selection under truncation/overflow** —
  rejected: a best-candidate claim over an incomplete list is a lie; the
  resolution labels keep it honest instead.

## Consequences

- No behavior change with the shipped flag state (OFF everywhere): the
  accepted document shape is byte-identical and every existing suite
  keeps its contract.
- Flag ON (offline tests/demos only today) adds a bounded, zero-cost
  report inside document_json; consumers can NOW distinguish an
  identical-content locator from similar signals without re-deriving it.
- NO merge, NO adjudication consumption, NO publication effect is added
  anywhere: Phase 5.3 (adjudication/merge) remains a separate future
  slice and the roadmap's standing owner gates for engine work are
  untouched by this record. Free readiness stays NOT_READY; no
  Cloudflare operation, no live inference, no flag enabled anywhere.

## Evidence

- RED on the 512386b baseline: both new suites failed (module absent),
  `vitest run` exit 1.
- GREEN after implementation: unit suite + REAL workerd-D1 integration
  suite (31 tests, exit 0) — flag-OFF byte-identical path, stale-locator
  identical-content relation, weak-title similar-only, two-story
  ambiguous tie, 10-story overflow ⇒ unresolvable with the truncated
  8-candidate page, zero-new-SQL batch-shape equality (flag ON vs OFF),
  snapshot race writes nothing, replay free and byte-stable.
- Full gates re-run at delivery: `npm run check` + `npm run test:db` +
  design-lab suite, real exit codes recorded in the delivery report.
