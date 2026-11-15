# ADR-0044: Phase 5D — controlled entity aliases → durable story mentions

- **Status:** Implemented on the review branch (R1.16 + the R1.16.1 bounded
  corrections for the independently reproduced C1/U1/R1 probes; under
  independent Posidon review — NOT deployment, activation, or
  live-inference approval).
- **Phase:** 5D (the bounded next slice of Phase 5 story/entity wiring)
- **Date:** 2026-10-30
- **App at delivery:** 1.11.0 candidate; **schema stays 3** (migrations
  0001–0004 untouched — ZERO DDL; the round writes ONLY to the existing
  `entities`, `entity_aliases` (read) and `story_entities` (insert) tables)
- **Instruction:** Posidon R1.16 (`NEXT_GLM_R1.16_Entity-Aliases-and-Durable-Mentions.md`)
- **Base:** `8f68c5d4facfe9a24854d98754432bf378f2addf` (R1.15.2 delivery HEAD);
  corrections based on `caa7402f39ecf3a07ac87850a149cb35c3724f22` (R1.16
  delivery HEAD, app 1.11.0)

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

## R1.16.1 — bounded corrections (app 1.11.1 candidate; Posidon probes C1/U1/R1)

Three independently reproduced defects of §4–§5 are closed on the SAME
architecture (schema 3, ZERO DDL, no new capability, reuse boundary
untouched). RED for all three probes was recorded on the R1.16 delivery
HEAD (`caa7402f39ecf3a07ac87850a149cb35c3724f22`) inside the PERMANENT
suites before the fix.

1. **C1 — report↔link coherence is now SQL-enforced on the WHOLE result.**
   §4's original text accepted a deliberately weak no-op-only-link contract:
   an alias mapping invalidated inside the lookup→commit window no-oped ONLY
   its `story_entities` insert while the draft/report/processed flip still
   committed — a persisted report claiming `entitiesLinked=1` over ZERO
   durable rows (Posidon probe: `expected 1 to be 0`). CORRECTED DESIGN: a
   whole-result **catalog-mapping gate** is appended to EVERY statement of
   the fenced atomic batch — the claimed (alias, entity) pairs travel as ONE
   bound JSON parameter read through `json_each` plus ONE expected-count
   parameter (two bound parameters per statement; the heaviest statement
   stays at 23 of the D1 per-query limit of 100; EXPLAIN QUERY PLAN seeks
   `idx_entity_alias_lookup` per claimed pair, no table scan — LOCAL PROXY
   only). One invalidated mapping (deleted / remapped / second owner) zeroes
   EVERY statement → zero effects, zero orphans → the typed **`catalogChanged`**
   outcome (the zero-effect classification read gains `mappings_hold`;
   precedence snapshot > mappings > fence). The handler answers with ONE
   bounded in-handler re-resolve — a FRESH SQL lookup of the CURRENT catalog
   (never a JS reuse of the stale rows) re-committing the SAME provider
   draft: ZERO new provider calls, ZERO new charges, no fabricated outcome;
   only a SECOND `catalogChanged` hands the bounded engine retry (the real
   provider run stays recorded via the existing fenced `ai_runs` path —
   charged, never refunded, never faked). A committed report now EQUALS the
   durable rows (multi-alias mentions of one entity dedup through the
   statement PK guard); `entityMentionsInserted` equals the DISTINCT entity
   count and a mismatch is an invariant tripwire, never a tolerated state.
   Tests/docs that accepted the weak contract are corrected WITH the reason
   recorded (the alias-REMAPPED case: the commit-time mapping is what BOTH
   the report and the link say — an honest commit-time resolution, not a
   stale lookup-moment claim).

2. **U1 — the tokenizer walks code points, not UTF-16 code units.**
   §1's window builder indexed the string by unit, so a letter outside the
   BMP read as two lone surrogates and acted as a false word boundary
   (`'\u{10400}Doom\u{10400}'` produced the standalone phrase `Doom`).
   CORRECTED: `codePointAt` + `String.fromCodePoint` traversal with correct
   slice offsets — astral letters/numbers/marks are first-class token
   characters, unpaired surrogates stay separators, emoji (So) stays a
   separator; the Persian/ZWNJ/NFC/`Doomlike`/`Doom2`/`Half-Life` behavior
   is preserved byte-for-byte. The 256-token cap is enforced DURING the
   traversal (early exit at the first beyond-cap token start) and
   `tokensTruncated` is the honest probe — no build-all-then-slice.

3. **R1 — the reader enforces the real ambiguity invariants.**
   §5's reader validated (alias, entity) PAIR ascent, which still accepted
   ONE alias resolved to TWO distinct owners. CORRECTED: strict ALIAS ascent
   in `matched` (one alias can never claim two owners), `matched` ∩
   `ambiguous` = ∅, and BOTH lists share the candidate-phrase bound
   (`matched + ambiguous ≤ phrasesConsidered`). Counts/observation/caps/
   limitations checks and the full malformed/null/primitive/array table are
   unchanged; no invented alias-format or hash constraints.

The `lookup_moment_visibility` limitation label stays: the report still
describes the lookup-moment scan, and unclaimed phrases can always gain or
lose catalog matches later — but a RELIED-UPON mapping can no longer change
between the lookup and a committed result (the gate makes the lookup moment
and the commit moment agree for everything the report claims as durable).
