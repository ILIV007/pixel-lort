# ADR-0044: Phase 5D — controlled entity aliases → durable story mentions

- **Status:** Implemented on the review branch (R1.16; under independent
  Posidon review — NOT deployment, activation, or live-inference approval).
- **Phase:** 5D (the bounded next slice of Phase 5 story/entity wiring)
- **Date:** 2026-10-30
- **App at delivery:** 1.11.0 candidate; **schema stays 3** (migrations
  0001–0004 untouched — ZERO DDL; the round writes ONLY to the existing
  `entities`, `entity_aliases` (read) and `story_entities` (insert) tables)
- **Instruction:** Posidon R1.16 (`NEXT_GLM_R1.16_Entity-Aliases-and-Durable-Mentions.md`)
- **Base:** `8f68c5d4facfe9a24854d98754432bf378f2addf` (R1.15.2 delivery HEAD)

## Context

After Phase 5C-3 (R1.15, corrected and independently accepted via R1.15.2)
every snapshot owns one stable, honestly-reused draft result — but the
result is connected to NOTHING: the roadmap's next real step is that a
fresh news draft connects to its REGISTERED entities (game/studio/
publisher/platform and every other schema type), with a registered Persian
and English name of one entity resolving to the SAME id, and the connection
DURABLE in `story_entities` — visible in the data model and the demo, not
another JSON-only report. The scope is EXPLICIT-mention detection through
CONTROLLED aliases only: no homonym resolution, no guessed translation, no
fuzzy matching, no event detection, no semantic merge, no truth
verification, and a shared entity mention is NEVER a same-event proof nor
source independence.

## Decision

### 1. The versioned `em1` policy (pure, deterministic, bounded)

`src/domain/editorial/entity-mentions.ts` — same offline purity as the
mapper/Evidence Guard/fingerprints (no SQL, no network, no model, no clock):

- **Normalization is ONE limited rule** — NFC + Unicode whitespace collapse
  - trim (the SAME function the Evidence Guard and the title fingerprint
    use). NO case folding, NO ی/ک or Persian/Latin digit conversion: an alias
    matches EXACTLY the form(s) registered for it. Registration is an
    explicit mapping, never a model guess; any future equivalence needs its
    own documented collision test (none is invented here).
- **Word boundaries are structural**: tokens are maximal runs of Unicode
  letters/numbers/marks with ZWNJ (U+200C) WORD-INTERNAL — a conscious,
  tested نیم‌فاصله decision (the spaced form is a different string and does
  not match). Candidate phrases are BYTE-EXACT substrings between token
  boundaries, 1..4 tokens (`ENTITY_MENTION_MAX_ALIAS_TOKENS`), generated
  width-major (all 1-token phrases first) so single-token aliases get the
  coverage first. Consequences, all tested: `Doom` inside `Doomlike` or
  `Doom2` can never be a candidate phrase (the boundary characters are
  token chars) while `Doom` in `Doom 2` IS a boundary-valid match, and
  `Half-Life` matches byte-exactly with its internal separator.
- **Caps (recorded, never hidden; NO full-coverage claim):** ≤256 tokens
  scanned (`maxScanTokens`), ≤90 distinct phrases (`maxPhrases` — also the
  IN-list bound, under D1's 100 bound-parameters per-query limit), result
  page `LIMIT 91` = cap + ONE overflow-probe row (`maxResultRows`).

### 2. ONE bounded indexed lookup

`findEntityMentionMatches` (editorial-store): at most ONE parameterized
query per NEW-draft generation —
`SELECT entity_id, normalized_alias FROM entity_aliases WHERE normalized_alias IN (?,…) ORDER BY normalized_alias, entity_id LIMIT 91`.
The ORDER-BY-before-LIMIT page is deterministic regardless of physical
order (the R1.13.1 lesson); the +1 row honestly detects overflow. NO
full-table scan of the catalog, NO per-word unbounded queries, NO SQL
interpolation of any text. Empty phrase list → ZERO SQL. A DB error
PROPAGATES (typed bounded retry) — never a fabricated empty success. The
lookup runs strictly AFTER the input gates and the early-reuse decisions
and BEFORE any provider work: malformed/oversized input never pays for it,
and a lookup failure costs ZERO provider calls.

### 3. Ambiguity is honest; the text never writes to the catalog

A `normalized_alias` mapping to EXACTLY ONE entity resolves that entity; a
shared alias (≥2 distinct owners) is AMBIGUOUS — ZERO auto links, the
owner count is recorded, and nothing depends on row order (all outputs are
sorted and grouped by value; reversed seed order is tested). A ≥91-row
result page embeds NOTHING as unique (zero links, zero ambiguous rows —
`lookup_overflow`). Empty catalog and zero-row lookup are the SAME honest
`no_match_observed` — "no mention OBSERVED", never a proof of absence.
The news text NEVER adds an entity, alias, or canonical name to the catalog
(`textAddsToCatalog: false`); no real catalog is seeded on cloud (fixture
helpers are LOCAL-D1 test/demo only).

### 4. Durable links inside the SAME fenced atomic batch

For every unique resolution the EXISTING `commitEditorialResult` batch
gains one `story_entities` statement (`relation='mentioned'`,
`confidence=0`), carrying: the own-PK `NOT EXISTS` guard (multi-alias
mentions of one entity dedup to ONE row; replay-safe), the NEW
`ALIAS_UNIQOWN` predicate — the alias must STILL map to EXACTLY ONE entity
AND that entity must still be THIS one, evaluated INSIDE the transaction
(a JS re-read is never a substitute) — plus the standard job fence AND
snapshot predicates. A mapping deleted, remapped, or given a second owner
between the lookup and the commit no-ops ONLY that link: no invalid link,
no partial editorial state, and — deliberately — NO forced re-run of the
paid provider (a rollback would re-invoke the AI; the suppressed link is
logged honestly and the report's `lookup_moment_visibility` limitation
covers the semantics). The exact-content anchor stays LAST;
`contentTaken` classification is untouched. The batch result reports
`entityMentionsInserted`.

### 5. The versioned report and its typed reader

Every NEW draft's `document_json` gains the ADDITIVE required
`entityMentions` field (schemaVersion stays 1 — same contract extension
style as the guard/discovery/assessment reports): `mentionsVersion: 1`,
`policyVersion: 'em1'`, the source snapshot identity, the observation
(`no_phrases_observed` | `no_match_observed` | `mentions_observed` |
`ambiguous_only_observed` | `lookup_overflow`), bounded `matched` /
`ambiguous` lists, the scan flags, the caps, the fixed coverage statement,
and the fixed limitations (`controlled_aliases_only`,
`mention_not_verification`, `confidence_zero`, `no_fuzzy_no_translation`,
`bounded_scan_window`, `lookup_moment_visibility`,
`reuse_drafts_not_enriched`). `readEntityMentionsReport` separates
`entity_mentions_v1` / `absent` / `unsupported_version` / `malformed` and
validates the REAL builder invariants (count/order/identity), so a payload
that merely claims the version never passes as current; malformed
null/primitive/array data at every level reads as `malformed`, an absent
key stays the legitimate legacy shape, and all real builder round-trips
pass.

### 6. The reuse boundary is explicit

Mention resolution exists ONLY on the NEW draft path, strictly after the
early-reuse decisions: replayed and reused snapshots never run lookups and
never gain links; the R1.15 reuse commit writes NO entity links; no
historical draft/report is enriched or backfilled. The accepted R1.15.2
exact-content reuse contract (versioned relation identity, immutable basis,
fenced target predicates) is preserved byte-for-byte.

## Consequences

- A demo (`npm run demo:entity-mentions`) and a REAL-D1 acceptance suite
  (`tests/integration/entity-mentions.test.ts`) prove the durable
  connection end-to-end offline, including the mutation windows and the
  EXPLAIN QUERY PLAN index proof (LOCAL PROXY metrics only — never a
  Cloudflare cost proxy).
- The capability is bounded by design: aliases longer than 4 tokens never
  match; text beyond the 256-token/90-phrase window is honestly NOT
  scanned (`phrasesTruncated`/`tokensTruncated` recorded); an ambiguous
  alias links NOTHING until the catalog resolves it.
- NOT delivered by this round (explicitly future): semantic/fuzzy
  matching, story merging, event detection, AI adjudication, admin UI or
  import tooling for the catalog, and any real catalog seeding.
