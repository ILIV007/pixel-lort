# ADR-0043: Phase 5C-1 — durable story fingerprints + limited candidate discovery (no merge)

- **Status:** Implemented on the review branch (R1.13; under independent Posidon review — NOT deployment, activation, or live-inference approval). **R1.14 (Phase 5C-2) addendum appended — the conservative candidate ASSESSMENT, same honesty boundary.**
- **Phase:** 5C-1 (the bounded first slice of Phase 5C story matching); **5C-2 addendum: R1.14**
- **Date:** 2026-10-29
- **App at delivery:** 1.8.0 candidate (5C-1); **1.9.0 candidate (5C-2 addendum)**; **schema stays 3** (migrations 0001–0004 untouched — ZERO DDL)
- **Instruction:** Posidon R1.13 (`NEXT_GLM_R1.13_Story-Candidates.md`); **R1.14 instruction (Phase 5C-2, inline)**
- **Base:** `b29fcf00efa25fa08b9346327289904dbba5c6fb` (R1.12.1 delivery HEAD); **5C-2 base: `10045296423097a1af8f85d0d77fd70c90cce98e` (R1.13.1 delivery HEAD)**

## Context

After Phase 5A (ADR-0042) every snapshot owns exactly ONE independent story.
A second draft has no way to FIND previously-registered, possibly-related
stories, and no durable record of where such a suggestion came from. R1.13
orders the bounded fix: durable fingerprints + candidate discovery ONLY —
no merge, no duplicate marking, no supersede, no evidence-stance change, no
confidence/trust raise, no truth verification, no auto-approval. Equal URL,
equal text, or equal title NEVER proves "same event" or "independent
sources". This is NOT semantic matching, NOT entity aliasing, NOT AI
adjudication (those remain future), and NOT the full Fact Guard.

## Decision

### 1. Pure, versioned fingerprints (no SQL, no clock, no AI)

`src/domain/editorial/story-fingerprints.ts` derives AT MOST THREE signals
from the STORED item — never from a fresh fetch:

| kind           | payload                                                           | normalization                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`          | the stored `canonical_url` VERBATIM (null/empty → no signal)      | NONE — no case folding, no param/path stripping, no resolution                                                                                                                                       |
| `content_hash` | the FULL title+body composition (exactly `buildFullEvidenceText`) | none beyond that composition; INDEPENDENT of sourceItemId/sourceId (the stored `source_items.content_hash` is snapshot identity and is deliberately NOT reused as a cross-source text fingerprint)   |
| `title_key`    | the non-empty title                                               | the ONE limited rule: NFC + Unicode whitespace collapse + trim (the SAME function the Evidence Guard uses) — never case folding, never Persian–Latin digit equivalence, never negation/unit handling |

Canonical framing is LENGTH-PREFIXED (`len:part` per part), so no payload
can re-frame the tuple — collision-safe by construction and by test. Every
digest is a full fixed-length SHA-256 hex (64 chars). Raw news text and raw
URLs are NEVER stored as index values.

### 2. The real index contract (multi-owner on the EXISTING table)

`story_fingerprints` (migration 0001) has `PRIMARY KEY(kind, value)` with
`kind CHECK` including `url` / `content_hash` / `title_key`. That PK does
NOT mean "one news per title". THIS round writes and reads ONLY:

```
kind  ∈ {'url', 'content_hash', 'title_key'}
value = 'sc1' ':' <64-hex digest> ':' <storyId>
```

The story-scoped value makes the index MULTI-OWNER: many stories can hold
the same digest; each (story, signal) is exactly one row. Writes are plain
`INSERT..SELECT` with `NOT EXISTS(kind, value)` (idempotent replay of the
story's OWN row only), inside the SAME fenced atomic editorial batch —
NEVER `INSERT OR REPLACE`, never a silent collision override. Historical
rows without the `sc1:` namespace are NOT reinterpreted; lookups cover ONLY
`sc1`-indexed stories (no historical backfill).

### 3. Bounded, honest lookup

At most THREE parameterized lookups per handler execution (one per present
signal, after validation/reuse and BEFORE any provider work), each a
prefix-range scan on the PK index (`kind = ? AND value >= ? AND value < ?`
with bounds `sc1:<digest>:` … exclusive upper bound; `story_id <> ?`
excludes the current story; `LIMIT ?` = 9 — the 9th row exists to DETECT
overflow). No wildcards, no `LIKE '%…%'`, no full scans, no unbounded
reads. Determinism comes from ascending-storyId ordering in the report —
SQL row order is never relied on; signal priority is DISPLAY order only,
never confidence.

### 4. The versioned report and its typed reader

`candidateDiscovery` rides INSIDE `drafts.document_json` next to
`evidenceGuard` (additive; document `schemaVersion` stays 1), produced by
the same fenced commit as the draft and the new story's fingerprints — a
lost fence or changed snapshot writes NO draft AND NO fingerprint.
`discoveryVersion: 1` reports: snapshot identity, the current storyId
(always excluded from candidates), the signals looked up, the 9-row probe
cap, the honest overflow flag, ≤8 unique candidates (ascending storyId)
each with deduplicated matchedSignals and stable reason codes
(`url_fingerprint_match` / `content_hash_fingerprint_match` /
`title_key_fingerprint_match`), counts (lookupsPerformed, observed before
cap, reported), an explicit `candidatesTruncated` flag, the fixed coverage
statement (`maxCandidates: 8`, `indexedScope: 'index_version_sc1_only'`,
`historicalBackfill: false`), and the fixed limitations
(`candidate_only_not_merge`, `not_truth_verification`,
`lookup_moment_visibility`, `title_signal_is_weak`). Nothing found reads
`no_candidates_observed` — never "unique story", never "no related story".
The typed reader validates the REAL v1 invariants (R1.12.1 lesson applied
from birth): stripped scopes, drifted constants, inconsistent counts,
reordered/duplicate/self candidates, out-of-scope or mis-coded signals are
`malformed` — never a current result. `absent` (pre-5C drafts),
`unsupported_version`, and `malformed` stay distinct. The reader is a
shape/invariant validator — NOT authenticity, NOT semantic support.

### 5. Failure windows stay typed and bounded

A lookup DB error is NEVER a fabricated successful empty report: it maps to
the engine's typed bounded retry (`job_handler_retryable_error`) with ZERO
provider calls and ZERO AI charges (the lookup runs before the provider).
A mid-commit failure rolls back the whole batch (no orphan fingerprints, no
half report). Replay returns the stored result BEFORE the lookup/provider:
no backfill, no rewritten report, no repeated AI spend. Two stories stored
simultaneously may not see each other at their lookup moments — exactly-once
discovery is NOT claimed (`lookup_moment_visibility`).

## Consequences

- A second draft now durably carries WHO it might be about (candidates) and
  WHY (signals), without any editorial action being taken.
- The merge/adjudication layer (future) receives honest, bounded, versioned
  input instead of doing unbounded text mining.
- SQL cost on the happy path grows by ≤3 parameterized lookups (pre-provider)
  and ≤3 batched inserts — measured locally in `npm run demo:story-candidates`
  (local proxy only, NOT Cloudflare billing).
- All gates stay OFF everywhere; `ready` still means only "a draft is
  stored"; free ingestion/full-poll stay NOT_READY.

## Addendum — Phase 5C-2 (R1.14): the conservative, durable candidate ASSESSMENT (still no merge)

### Context

Discovery says WHICH candidates were found and WHY (which signals matched).
It does not yet say, in one honest place, WHAT WAS ACTUALLY OBSERVED about
each candidate's relation. R1.14 orders exactly that — a decisive,
conservative, traceable classification stored with the draft — WITHOUT any
new query surface and WITHOUT semantic adjudication (still NOT entity
aliasing, NOT NER, NOT embedding, NOT the merge layer, NOT truth
verification).

### Decision

#### 1. A PURE derivation of the discovery report — zero new SQL

`src/domain/editorial/candidate-assessment.ts` builds
`candidateAssessment` (`assessmentVersion: 1`) from the SAME draft's
`candidateDiscovery` report ALONE: no lookups, no re-fetch, no
re-validation of candidate data, no clock, no randomness, no provider
involvement. It is built before the provider call and persisted INSIDE
`drafts.document_json` next to `candidateDiscovery` by the SAME fenced
atomic commit (fence + snapshot predicates untouched — a lost fence or a
changed snapshot writes NO draft AND NO assessment). Added SQL cost: ZERO
statements, ZERO execution calls. The document `schemaVersion` stays 1.

#### 2. The four verdicts — and what they never claim

`assessCandidateSignals` classifies the deduplicated matched-signal kinds
with a fixed, tested precedence:

| observed signals             | verdict                          | never claims                                    |
| ---------------------------- | -------------------------------- | ----------------------------------------------- |
| includes `content_hash`      | `full_content_equality_observed` | truth, one event, source independence           |
| ≥2 signals (no content hash) | `multiple_signals_observed`      | independent confirmations (all reasons kept)    |
| only `url`                   | `shared_url_observed`            | one event, one content version                  |
| only `title_key`             | `shared_title_observed`          | more than the WEAK limited normalization allows |

The `content_hash` signal is the versioned FULL title+body composite
digest — deliberately NOT the `source_items.content_hash` snapshot
identity. Identical content co-occurs with the title signal by
construction; the verdict names the strongest observed relation while
`verdictReasons` preserves EVERY real reason in signal-priority order.
NO confidence, probability, score, or threshold exists anywhere.

#### 3. The report's explicit honesty statements

`basis: 'candidate_discovery_v1_signals_at_lookup_moment'`;
`unrelatednessConcluded: false` (FIXED — no candidate, an invalid or
foreign report, or missing information NEVER becomes "definitely
unrelated"); `unassessed: ['same_event', 'truth', 'source_independence']`;
`limitations` fixed seven labels (`candidate_only_not_merge`,
`not_truth_verification`, `not_same_event_proof`,
`not_source_independence_proof`,
`signals_not_independent_confirmations`,
`discovery_data_not_refetched_or_validated`, `title_signal_is_weak`);
and `discoveryLimits` preserving the sibling's
truncation/overflow/coverage verbatim. Empty discovery reads
`no_candidates_observed` with zero entries — never a negative proof.

#### 4. The typed reader cross-validates the sibling (no contradictory copies)

The assessment carries NO copy of the candidate list or the signals — its
entries are a minimal projection (`storyId`, `verdict`,
`verdictReasons`). `readCandidateAssessmentReport` validates the REAL v1
invariants: a VALID `candidate_discovery_v1` sibling must exist in the
same document (an assessment without its basis, or next to a
foreign/malformed sibling, is `malformed`); story/snapshot/observation
must mirror the sibling exactly; entries must mirror the sibling's
candidates 1:1 in the same ascending order; each verdict is RE-DERIVED
from the sibling's matched signals and each `verdictReasons` sequence
must equal the sibling's reason codes; the single count, the fixed
limitation/unassessed sets, and the preserved limits are all exact.
`absent` (pre-5C-2 drafts — no backfill), `unsupported_version`, and
`malformed` stay distinct; none of them ever means "unrelated". The
reader is a shape/invariant validator — NOT authenticity, NOT semantic
support.

#### 5. Tests and demo

Acceptance tests only (no fabricated historical red→green): 36 unit tests
(verdict derivation incl. the identical-content co-occurrence rule,
byte-identical determinism, round-trips of every builder shape, a
25-case mutation table incl. empty-sibling cases) and 9 REAL workerd D1
integration tests (the three observed relations on the real pipeline;
Persian-vs-Latin digits NOT equated — no new equivalence; the commit
batch statement-shape proof of zero new SQL; snapshot race and expired
lease writing nothing; replay byte-stability; historical absent/foreign
handling). `npm run demo:story-candidates` now runs SEVEN artificial
items: the three required pairs (identical content →
`full_content_equality_observed` with both reasons; only shared URL →
`shared_url_observed`; only shared title → the weak
`shared_title_observed`) plus a solo item — printing story/candidate ids,
observed signals, verdicts, limits, and the no-merge proof (7 stories,
confidence 0 everywhere), zero network, zero live inference, zero
Telegram.

### Consequences

- A draft now carries not only WHO it might be about (candidates) and WHY
  (signals) but WHAT WAS OBSERVED about the relation — with the limits of
  that observation stated in the same report.
- The future merge/adjudication layer receives a conservative,
  versioned, cross-validated observation record instead of raw signals —
  the boundary of THIS round: no merge, no story union, no evidence move,
  no confidence raise, no gate change.
