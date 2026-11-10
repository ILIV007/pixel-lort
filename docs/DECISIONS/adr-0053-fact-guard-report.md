# ADR-0053: Deterministic fact-guard report (Phase 6.3 — V4, post 5→6 gate)

- Status: implemented locally (review candidate, NOT activated; all gates OFF)
- Date: 2026-11-11 (UTC)
- Version: 1.20.0 (schema 6 unchanged, no migration)
- Supersedes: none; SIBLING to ADR-0042 addendum (Evidence Guard v1, whose
  contract stays FROZEN and untouched); delivered immediately after the
  Phase 5→6 gate review (docs/reviews/PHASE_5_TO_6_GATE.md) as the roadmap's
  first post-gate Phase 6 engineering step.

## Context

The V4 roadmap's Phase 6 section had marked since 1.10.6:

> Fact guard (evidence-id references alone do NOT prove a generated claim is
> true) — still FUTURE work. (Phase 5B's Evidence Guard v1 is a BOUNDED
> text-presence check over the draft's own claims — direct observation is
> not verification and unresolved is not false; full semantic Fact Guard
> remains future.)

The V4 roadmap's Phase 6.3 defines the remaining bounded work: ادعای
بی‌شاهد (unwitnessed claims), شایعه (rumor), تضاد (contradiction),
نقل‌قول (quotations) and اعداد (numbers), each with a documented policy and
specific fixtures, where merely citing evidence never proves truth — with
Persian text, game names, injection and invalid content TESTED.

The Phase 5→6 gate review made this slice's honesty boundary BINDING:
lexical observations are NOT truth, the report must never upgrade a claim's
`unverified` status, and every bounded lens must carry its own explicit
limitations.

## Decision

A NEW pure, versioned, bounded, deterministic evaluator
(`src/domain/editorial/fact-guard.ts`, `factGuardVersion: 1`) producing an
ADDITIVE `factGuard` field inside `drafts.document_json` of the SAME fenced
atomic commit — the established house pattern (5B evidence guard, 5.2
matching, 5.3 adjudication) — under the NEW INDEPENDENT fail-closed flag
`EDITORIAL_FACT_GUARD_ENABLED` (default 'false' everywhere; NEVER implies
any other gate; unlike the adjudication slice it needs NO sibling gate —
its basis is the evidence guard's own snapshot/excerpt pair, which is
always present on this path).

Per-claim LENSES (all LEXICAL OBSERVATIONS, never verdicts):

1. **witness** — the claim's evidence basis: no references at all
   (`no_evidence_basis`) or references that are not the verified
   snapshot's evidence id (`evidence_basis_not_the_snapshot`).
2. **numbers** — number tokens (Persian ۰-۹, Arabic-Indic ٠-٩, Latin 0-9;
   digits NEVER folded across scripts) observed verbatim in the excerpt;
   missing numbers flagged with a bounded, sorted, unique token list.
3. **quotation** — quoted spans (guillemets, straight and curly quotes)
   whose inner text is/is not observed verbatim in the excerpt; unclosed,
   empty and over-cap spans are typed honest notes, never invented content.
4. **rumor** — the FIXED versioned hedging-marker list (شایعه، شایعات،
   به نقل از، ادعا می‌شود، گزارش شده است، احتمالاً، …) observed on EITHER
   side: the claim hedging beyond its source
   (`rumor_marker_not_observed_in_evidence`), the source's rumor language
   NOT reflected in the claim (`source_rumor_language_absent_from_claim` —
   the promotion-to-fact risk), or the benign reflected case
   (`rumor_language_reflected`).
5. **negation** — a small FIXED token-bounded negation vocabulary (token
   equality OR the ZWNJ-attached `نمی` verbal prefix; substrings never
   match) with polarity ASYMMETRY flagged in either direction — never a
   contradiction CONCLUSION.

`reviewRequired` is DERIVED (never a free choice): any non-benign finding ⇒
true; `rumor_language_reflected` and `number_tokens_capped` are benign.
The identity gate is INHERITED from the evidence guard: a snapshot/
evidence/draft identity mismatch evaluates NOTHING and every claim carries
exactly `identity_inconsistent`.

Fixed bounds (enforced by BOTH the builder and the reader): ≤16 number
tokens scanned (with the honest `number_tokens_capped` note), ≤8 tokens per
finding, ≤8 quoted spans, ≤120 normalized chars per span, ≤512 word tokens
per text scan, ≤120 chars per token entry. The ONE limited normalization is
the evidence guard's own `normalizeForDirectTextMatch` (NFC + whitespace +
trim) — inherited, never redefined.

## The honesty boundary (binding, tested)

- A finding is NEVER truth: `lexical_presence_not_truth`,
  `bounded_marker_lists`, `marker_lists_are_not_exhaustive`,
  `excerpt_scope_only`, `no_semantic_analysis`,
  `headline_summary_unassessed` travel inside EVERY report.
- NO claim's stored `unverified` status is ever rewritten (asserted
  end-to-end on the real path: `modelClaims` AND `facts_json`).
- The claim/excerpt texts are INERT DATA: injection-like text is observed
  lexically, never interpreted or obeyed.
- The marker lists are deliberately NON-EXHAUSTIVE and versioned — bumping
  them is a documented contract change (the version is the report's).
- The Evidence Guard v1 contract stays FROZEN — this ADR adds a sibling
  report, it does not modify the 5B one.

## Reader

`readFactGuardReport(document)` — the strict house discipline:
`absent` (pre-6.3 drafts, no backfill) / `unsupported_version` /
`malformed` are DISTINCT; a payload that merely claims version 1 while
violating the v1 contract is malformed. The reader re-derives: the fixed
code→lens mapping (no cross-lens forgeries), the token-carrying code set
(tokens on any other code are a stored lie), bounded sorted-unique token
lists, per-claim `reviewRequired` coherence with the benign set, counts
that EXACTLY describe the claims (per lens + witness + review), and the
identity-gate coherence (an "evaluated" report cannot carry identity
findings).

## Consequences

- The editorial path gains the roadmap's ۶.۳ bounded fact-guard layer at
  ZERO runtime cost (flag OFF keeps the accepted path byte-identical; flag
  ON adds zero SQL, zero provider calls, zero charges).
- Reviewers can now SEE the bounded lexical risk observations (unwitnessed
  claims, unobserved numbers, unobserved quotations, hedging asymmetry,
  negation asymmetry) next to the evidence-guard and candidate reports —
  all advisory, all flag-gated, all versioned.
- What this ADR does NOT do: no semantic analysis, no truth verification,
  no claim-status change, no publication effect, no Phase-6-completion
  claim (6.3 is one roadmap bullet; the live-model paths stay BLOCKED_LIVE).
