# ADR-0052: Deterministic candidate-adjudication report (Phase 5.3 — V4)

- Status: implemented locally (review candidate, NOT activated; all gates OFF)
- Date: 2026-11-10 (UTC)
- Version: 1.19.0 (schema 6 unchanged, no migration)
- Supersedes: none; extends ADR-0051 (candidate-matching report) with the
  adjudication LAYER only; RESOLVES the preserved sm1 design input recorded
  there (see "The sm1 decision" below).

## Context

The V4 owner directive (00_PROMPT_CONTINUE_ALL_PHASES_FA.md, 2026-11-10)
explicitly lifted the former "5.3 adjudication/merge waits for an owner
decision" restriction FOR LOCAL design/build/test, with the hard
constraints: transparent reviewable merge conditions, audit/provenance/
version/conflict/undo-review, ambiguous-or-risky ⇒ defer/review (never a
merge), no production-data change, and — critically — "هیچ ادعای
یکسان‌بودن رویدادها با شباهت یا AI به‌تنهایی نکن" (never claim event
identity from similarity or AI alone).

The tree already had (ADR-0043 + ADR-0051): bounded fingerprint discovery,
the conservative signal assessment, the exact-content REUSE behavior
(5C-3, independently accepted), and the matching layer (transparent
set-encoded scores, identical-vs-similar outcome, ambiguity/overflow
honesty). What was missing was the ADJUDICATION layer between matching and
any future merge behavior: identity-stance modeling, a versioned merge
policy with transparent conditions, conflict records, and honest defers.

## The sm1 decision (the preserved design input)

The byte-identical preserved proposal
(`docs/reviews/unmerged-proposal-story-matching-sm1_ORIGINAL-PATH-*.ts.txt`,
SHA-256 7a7db07e…, recorded in ADR-0051) proposed threshold-based
per-candidate DECISIONS (weights content_hash 80 / url 45 / title_key 15,
bonus 10, thresholds 70/30, decisions same_story_proposed /
related_story_observed / insufficient_signal, flag STORY_MATCHING_ENABLED).
REVIEWED under the V4 authorization; outcome:

- ADOPTED (in honest form): the incomplete-window SUPPRESSION policy (an
  incomplete discovery window never yields a merge proposal — here at the
  disposition level, with the observed stances still listed);
  ambiguity-never-picks-a-winner (a tie is a typed conflict or a
  similarity-only defer, never a selection); title-only insufficiency; a
  versioned policy id (`mergePolicyVersion: 'mp1'`) so the transparent
  conditions are revisable ONLY by a documented bump.
- REJECTED: integer weights/thresholds proposing same-story identity — a
  score cutoff would claim identity from similarity, which the V4 rule
  forbids (and ADR-0051's subset-sum injectivity already makes the score a
  pure observation encoding, not a strength measure); the multi-signal
  "bonus" (correlated signals would compound toward a decision);
  the `STORY_MATCHING_ENABLED` name (this slice's gate is
  `EDITORIAL_ADJUDICATION_ENABLED`, independent of the matching gate).
- RECORD correction: the proposal referenced a dangling "OD-010" — no
  OD-010 exists in docs/OPEN_DECISIONS.md. This ADR is the design-decision
  record instead; the owner may override any mp1 condition later (a policy
  bump, never a silent rewrite). The preserved sm1 file remains
  byte-identical where it is; nothing was adopted into the build surface
  from it.

## Decision

1. **Pure derivation, zero new surface.** The `candidateAdjudication`
   report (`adjudicationVersion: 1`, `mergePolicyVersion: 'mp1'`,
   `src/domain/editorial/candidate-adjudication.ts`) is derived ONLY from
   the sibling `candidateMatching` (+ its discovery/assessment parents,
   cross-checked by the builder) of the SAME draft — no SQL, no network,
   no clock, no model call — and rides INSIDE `drafts.document_json` of
   the SAME fenced atomic commit. Zero new statements, zero execution
   calls, zero cost. Schema stays 6.
2. **Identity-stance layer.** ONLY the exact content-composite fingerprint
   equality (the assessment's `full_content_equality_observed`) is
   identity-grade: stance `exact_content_identity_observed`, disposition
   `reuse_locator_supported` — an ECHO of the verified 5C-3 reuse locator
   path, never itself an executed merge. Every weaker similarity
   (`shared_url_observed` / `shared_title_observed` /
   `multiple_signals_observed`) maps to an
   `identity_not_established_*` stance with disposition `defer_to_review`
   and the explicit `similarity_never_proves_identity` reason FIRST.
   Nothing here concludes "definitely unrelated" — a reject is not ours
   to conclude (`unrelatednessConcluded` FIXED false); support/unclear are
   the honest modeling of the roadmap's stance dimensions at THIS layer,
   and truth/same_event/source_independence stay in the fixed `unassessed`
   tuple.
3. **Versioned merge policy `mp1` with a FIXED tested precedence.** No
   candidates ⇒ `no_ground_no_candidates`; incomplete coverage (probe
   overflow OR report truncation) ⇒ `defer_incomplete_coverage`
   (suppression — observed stances stay listed, the PROPOSAL is withheld);
   ≥2 exact-identity candidates ⇒ `defer_conflict_multiple_identity_candidates`
   (a typed conflict record — never auto-picked; the undo/review property
   is that conflicts can only be resolved by review, never by the
   report); exactly 1 ⇒ `reuse_locator_single_exact_identity` (the
   verified-path echo); only weaker signals ⇒ `defer_similarity_only`.
   `reviewRequired` is DERIVED from the disposition (true for every
   defer) — never a stored opinion. Ambiguous or risky ⇒ review, never a
   merge.
4. **Independent fail-closed gates that never imply each other.**
   `EDITORIAL_ADJUDICATION_ENABLED` (default 'false' in .env.example,
   .dev.vars.example and BOTH wrangler environments) NEVER implies
   `EDITORIAL_ENABLED`, `AI_ENABLED` or `EDITORIAL_MATCHING_ENABLED`.
   The payload is produced ONLY when BOTH the adjudication gate and the
   sibling matching gate are ON; adjudication-on-without-matching ⇒ the
   payload is honestly ABSENT and a warn is logged
   (`editorial.prepare_draft.adjudication_requires_matching_gate`) — no
   silent no-op, no implied gate. Flag OFF everywhere ⇒ the accepted path
   stays byte-identical.
5. **Typed reader with real cross-validation.**
   `readCandidateAdjudicationReport` treats absent / unsupported_version /
   malformed as DISTINCT, requires the valid sibling matching chain (the
   matching reader transitively enforces discovery + assessment), mirrors
   entries 1:1 in the sibling order, and RE-DERIVES stances, dispositions,
   reasons, the merge disposition, its reasons and reviewRequired from the
   sibling's verdicts + limits — a stored lie is malformed. The sibling
   matching outcome/resolution ride verbatim as provenance mirrors.
6. **Audit/provenance/version/conflict/undo BY CONSTRUCTION.** The report
   is a PURE advisory projection: it mutates nothing (no merge, no
   duplicate marking, no supersede, no evidence change — there is nothing
   to undo); provenance = versioned basis labels + verbatim sibling
   mirrors + preserved discovery limits; versioning = `adjudicationVersion`
   - `mergePolicyVersion`; conflicts = typed disposition records. No
     production data is touched anywhere.

## Alternatives rejected

- **Executing merges when one exact-identity candidate exists** — rejected:
  the 5C-3 reuse path already owns the exact-content behavior; a story-level
  merge is a heavier, review-bound action with its own audit surface, and
  this slice's contract is an advisory projection. The locator echo keeps
  the provenance without claiming the authority.
- **The sm1 threshold decisions** — rejected (see "The sm1 decision").
- **Auto-resolving conflicts by score, recency, or any deterministic tie-
  break** — rejected: a tie-break IS a merge decision; conflicts defer to
  review, full stop.
- **Inferring source independence from signal counts** — rejected: correlated
  signals are never independent confirmations; the tuple stays unassessed.
- **A separate adjudication table/DDL** — rejected: the report is a pure
  view of the matching moment already recorded; new DDL would be an
  unjustified schema-7 migration.
- **Fuzzy/semantic/AI adjudication in this slice** — rejected: out of scope,
  unbudgeted, and exactly the "identity by similarity or AI" claim V4
  forbids.

## Consequences

- No behavior change with the shipped flag state (OFF everywhere): the
  accepted document shape is byte-identical and every existing suite keeps
  its contract.
- Flag pair ON (offline tests/demos only today) adds a bounded, zero-cost
  report inside document_json; consumers can NOW read the identity-stance
  layer and the conservative merge disposition without re-deriving it.
- NO merge, NO publication effect, NO flag enabled anywhere: the roadmap's
  standing owner gates for engine work are untouched by this record. Free
  readiness stays NOT_READY; no Cloudflare operation, no live inference.

## Evidence

- RED on the clean 514024d baseline: both new suites failed (module
  absent), `vitest run` exit 1 (recorded per suite).
- GREEN after implementation: unit suite 21/21 (exit 0) + REAL workerd-D1
  integration suite 9/9 (exit 0) — flag-OFF byte-identical path,
  adjudication-without-matching honest warn, stale-locator single
  exact-identity echo (NO story merge), weak-title similarity-only defer,
  TWO exact-identity candidates ⇒ typed conflict, 9-story overflow ⇒
  suppression, zero-new-SQL batch-shape equality (flag pair ON vs
  matching-only), snapshot race writes nothing, replay free byte-stable.
- Full gates re-run at delivery: `npm run check` + `npm run test:db` +
  design-lab suite, real exit codes recorded in the delivery report.

## Incident record (mid-tick parallel proposal, second occurrence)

DURING this tick (mtimes 2026-11-10T13:41:40Z and 13:44:00Z, inside the
active session's window — the same dead/parallel-session pattern as the
sm1 proposal recorded in ADR-0051), an UNMERGED, UNTRACKED and untested
parallel Phase 5.3 proposal ("story-adjudication", `sa1`-style) appeared
in the worktree at src/domain/editorial/story-adjudication.ts +
tests/unit/story-adjudication.test.ts. It was NOT authored by this round.
Per the recorded precedent it was preserved BYTE-IDENTICAL outside the
build surface at:

- docs/reviews/unmerged-proposal-story-adjudication-sa1_ORIGINAL-PATH-src-domain-editorial-story-adjudication.ts.txt
  (SHA-256 2d40a820a8d12bab21ffc2ecb92c98ea0033e575eaf77353857baa69c3a3effc)
- docs/reviews/unmerged-proposal-story-adjudication-sa1_ORIGINAL-PATH-tests-unit-story-adjudication.test.ts.txt
  (SHA-256 71099ed2dd75ad576b06e396df356885a082a18c3cf329504d7d911bcad16701)

NOT adopted (untested against any gate, unregistered in test:db, would
conflict with THIS round's shipped contracts), NOT deleted; recorded for
the owner/Posidon's visibility. This round's adjudication slice
(candidate-adjudication.ts + its two registered suites) is the delivered
implementation; the preserved sa1 texts are DESIGN INPUTS ONLY.
