# ADR-0043: Phase 5C-1 — durable story fingerprints + limited candidate discovery (no merge)

- **Status:** Implemented on the review branch (R1.13; under independent Posidon review — NOT deployment, activation, or live-inference approval)
- **Phase:** 5C-1 (the bounded first slice of Phase 5C story matching)
- **Date:** 2026-10-29
- **App at delivery:** 1.8.0 candidate; **schema stays 3** (migrations 0001–0004 untouched — ZERO DDL)
- **Instruction:** Posidon R1.13 (`NEXT_GLM_R1.13_Story-Candidates.md`)
- **Base:** `b29fcf00efa25fa08b9346327289904dbba5c6fb` (R1.12.1 delivery HEAD)

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
