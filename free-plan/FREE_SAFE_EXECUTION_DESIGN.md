# PIXEL — Free-Safe Execution Design v2 (DESIGN REVIEW — R1.10.3)

**Status: DESIGN REVIEW — lab-evidenced candidate, NOTHING implemented in the
product, nothing authorized for product use.** This is the R1.10.3 revision
of the R1.10.2 design: the grouped-read-only proposal is RETRACTED as a
Free-safe design (R112-01) and replaced by a parameter-bounded MULTI-ROW
INSERT + grouped source-bound classification candidate whose semantic
parity and measured costs are proven in the DESIGN LAB on real disposable
workerd D1 (`design-lab/`). Product source stays
`f70205648922d0f8e60619e45e5d54e6e87b8f1b` (297 files, byte-identical);
no product patch, no migration, no config change, no Cloudflare operation,
no paid upgrade in R1.10.3.

## 1. The measured problem (unchanged, verified)

The accepted commit paths classify EVERY attempted item with up to three
terminal SELECT probes AFTER an atomic batch that inserts ONE row per item:
cost grows linearly with items and doubles for duplicates. Measured with
the corrected instrument (manager numbers reproduced exactly): 100 new
items = **110 execution-API-call attempts / 211 statements**; 100
duplicates = **210 / 311**; 50/50 = **160 / 261**; active batch10 = **1001
/ 1812**. The documented Free row is "**Queries per Worker invocation … 50
(Free)**" — exceeded by the single-job path under BOTH unit
interpretations, hence the standing verdict
`NOT_READY_FOR_INGESTION_ON_FREE` for the ADVERTISED profile.

## 2. RETRACTION (R112-01) — the R1.10.2 "15–16 STMT" estimate was FALSE

The R1.10.2 Option D1 (grouped classification reads only) claimed
"~15–16 total STMT/100-item poll" and "≥3× headroom under BOTH
interpretations". **That claim is retracted in full.** The manager's
independent CONTROL — reproduced here as corrected-query control Q-01 and
lab row C-10 — proves the floor: 100 RETAINED one-row INSERT statements in
the atomic batch + 2 grouped reads = **3 API calls / 102 statements**
BEFORE any state/engine/budget/acquire overhead. The R1.10.2 design kept
the atomic item batch UNCHANGED, so its real derived cost was:

- From T-13's own retained components (batchStatements 103 + terminal 108
  including 100 classification reads): replacing the 100 per-item reads
  with grouped probes yields **12 API / 113 STMT** — NOT 15–16.
- The "2-job ≈32/32" estimate (Option D4 with D1) is likewise withdrawn.
- The design's own dismissal of metadata-only classification (D2) for
  retaining 100+ write statements applied equally to D1's PRIMARY design.

Grouped reads MAY remain a worthwhile execution-call optimization; they
are NOT a complete Free-safe design. Both-unit acceptance is preserved
until the official unit question is settled; no vocabulary change hides
writes.

## 3. The R1.10.3 candidate (DESIGN-LAB-proven, not implemented)

FIRST Free preview profile (manager-directed, R112-02): **ONE supported
single-feed RSS source, queue batch 1, the current 100-item bound, ALL
redirect/authorization hops counted; the other connectors stay implemented
in the product but are OFF in this proposed profile pending separate
budget evidence.** This is temporary staging, NOT feature removal; no
config/profile was applied this round.

Candidate = parameter-bounded MULTI-ROW writes + grouped source-bound
reads:

1. **Multi-row INSERT..SELECT** (`design-lab/candidate-sql.ts`): chunked
   VALUES table (8 rows/statement owned = 88 row binds + 7 shared = 95 ≤
   100 documented binds; 9 rows/statement legacy = 99 ≤ 100), with
   - the TWO targeted conflict clauses byte-identical
     (`ON CONFLICT (source_id, external_id) DO NOTHING /
       ON CONFLICT (source_id, canonical_url) DO NOTHING`) — a PK
     collision / NOT NULL / CHECK violation still RAISES and aborts the
     whole batch (L-06);
   - OWNED path: the accepted ownership predicate P over EVERY row + the
     B1 source binding (`column2 = ?`) — a stale owner/generation writes
     ZERO items (L-03/L-04); mixed-source batches are rejected BEFORE any
     statement (L-05);
   - a conservative BYTE budget on top: SQL text + ALL bound values ≤ the
     documented "Maximum SQL statement length: 100 KB" row (L-08 audited
     the max-volume shape at 94,278 bytes for an 8-row statement);
   - `WHERE true` (legacy) / the predicate WHERE (owned) also
     disambiguates SQLite's UPSERT-after-SELECT parsing.
2. **ONE atomic batch** still carries ALL item mutations + the terminal
   state write (verbatim accepted fence SQL): losing fence ⇒ zero items,
   zero state (parity proven).
3. **Grouped classification probes, source-bound** (R112-04 corrected;
   `audit-tools/trace/candidate-classification.ts`): probe A
   `WHERE source_id = ? AND id IN (…)` (chunks of ≤99 ids + 1 source bind
   = exactly 100 binds), probe B external / probe C url with the same
   source binding; NULL keys excluded (the accepted `= NULL` probes never
   matched); per-item outcome assembly IN ATTEMPT ORDER preserving the
   accepted conservative quirk and the uncounted null-key branch. Hit sets
   are PER SOURCE — a cross-source identity leak is impossible (this exact
   hazard was caught and fixed during lab development; Q-06 pins it).

**Measured parity (lab, real workerd D1; accepted store imported
unmodified as the reference):** L-01 (100 fresh), L-02 (mixed duplicate
matrix), L-03/L-04 (stale owner/generation → zero effects), L-05
(mixed-source rejection), L-06 (PK-collision rollback), L-07
(within-statement duplicate absorption), L-10/L-11 (legacy schema-3
parity incl. the lost-fence semantics) — identical classification, IDENTICAL
durable rows and state in every scenario. Within-statement duplicate
absorption matches the accepted two-statement behavior (first row wins;
absorbed row classifies as duplicateExternal).

## 4. Measured cost ledger (LOCAL PROXY UNITS — design-lab/cost-ledger.json)

14 scenarios; the fixed per-poll sequence is the ACCEPTED one (engine
claim read+CAS, source select, capability, acquire, authorize-per-hop,
readback, terminal — imported product functions over the instrumented
binding); only commit+classification are the candidate. Targets from the
binding prompt: ≤ 40 execution-API calls AND ≤ 40 submitted statements
INCLUDING all overhead (10 below the documented 50 row).

| Row | Profile (schema, items, hops) | xAPI | STMT | Target |
|---|---|---|---|---|
| C-01 | owned, 0 new (304), 1 hop | 9 | 10 | — |
| C-02 | owned, 100 new, 1 hop | **15** | **29** | ✓ ≤40/≤40 |
| C-03 | owned, 100 dup-external, 1 hop | **15** | **29** | ✓ |
| C-04 | owned, 100 dup-url (worst probes), 1 hop | **15** | **29** | ✓ |
| C-05 | owned, 50/50 mix, 1 hop | **15** | **29** | ✓ |
| C-06 | owned, 100 new MAX content bytes, 1 hop | **15** | **29** | ✓ |
| C-07 | owned, 100 new, 3 hops (2 redirects) | **17** | **33** | ✓ |
| C-08 | owned, budget DENIED (budget 0) | 10 | 11 | — (no items) |
| C-09 | owned, budget AUTHORITY failure | 6 | 6 | — (retry_wait, zero terminal writes) |
| C-11 | legacy, 0 new, 1 hop | 8 | 9 | — |
| C-12 | legacy, 100 new, 1 hop | **14** | **27** | ✓ |
| C-13 | legacy, 100 dup-url, 1 hop | **14** | **27** | ✓ |
| C-14 | legacy, 100 new, 3 hops | **16** | **31** | ✓ |
| C-10 | BASELINE accepted per-item, 100 new | 109 | 210 | reference |

**Derived upper bound for the FIRST chosen invocation profile** (owned
candidate, 100 items, 2 redirects): lab 17 xAPI / 33 STMT PLUS the
queue-envelope scope outside the lab harness — reconciled from the
baseline row (C-10: 109/210) against the accepted trace T-13 (110/211,
sealed R1.10.2 logs): the residual is exactly **1 API call / 1 statement**
(queue envelope). Derived ceiling = **18 xAPI / 34 STMT** — the ≤40/≤40
target holds WITH the residual included. If any future composition
exceeds, the verdict is NOT_READY with the explicit blocker, never "fit".

Honesty labels (mandatory): every number is a LOCAL workerd + disposable
D1 proxy measurement under the corrected v3 units (R112-03: failed-batch
statements are NOT completed; reservoir truncation is counted and never
mutates retained records). No cloud quota enforcement, no CPU evidence
(network wait is not CPU), no billing conclusion. The mapping to the
documented "50 queries/invocation" row remains a SEPARATE documented
question (both interpretations carried in free-plan/ documents).

## 5. Durable continuation (honest scope, R112-02 wording)

- The ONE atomic batch keeps the accepted crash windows: a crash before
  the batch leaves cursor/validators/ownership unchanged; the next window
  re-fetches and dedup absorbs the overlap (idempotent, lossless).
- RSS/YouTube are cursor-LESS: continuation is full re-fetch + dedup.
  **Provider finite-feed history is NOT guaranteed by refetch**: an item
  that leaves the finite feed before the retry window is recoverable ONLY
  while the provider still serves it — the actual evidence window is
  "whatever the provider's feed currently returns", NOT a durable
  guarantee. This is the accepted supported-window contract, unchanged.
- No silent item loss, no cap lowering, no cadence-staggering claim.
- If a future profile needs single-invocation work beyond the measured
  envelope, the design REQUIRES an exact durable continuation spec
  (persisted work, ownership, crash windows, lossless in-window
  processing) BEFORE implementation — none is proposed here.

## 6. What would still gate activation (unchanged truths)

- Per-connector capacity: T-17…T-21 are REPRESENTATIVE multi-request
  traces, NOT supported-max proofs (Steam ≤25 apps × ≤10 items; YouTube
  ≤25 playlists + details; GitHub ≤25 repos; Reddit ≤10 subreddits +
  token; RSS ≤4 feeds × 100). The FIRST profile deliberately excludes
  them; their budgets must be measured separately before any broadening.
- D1 daily rows, queue operations/day, workers requests/day, CPU: UNKNOWN
  (formula margins only; no cloud observation this round).
- The Free row's official unit ("queries per Worker invocation") remains
  unsettled; BOTH interpretations are carried and both fit the ≤40/≤40
  target for the FIRST profile with ≥10 headroom.

## 7. Scope and approval boundaries

| Item | Type | Where | Status |
|---|---|---|---|
| Multi-row owned/legacy inserts + grouped source-bound probes | product code change (future round) | `src/adapters/db/source-ingest-store.ts` (+ classification) | DESIGN-LAB proven; NOT implemented |
| First-profile connector staging (others OFF) | config/profile decision | wrangler/registry config | PROPOSED ONLY; nothing applied |
| Grouped-reads-only optimization | product code change | same as above | still possible as an API-call cut; NOT sufficient alone |
| D4 batch bound | config change | `wrangler.jsonc` env.preview | not evaluated further this round |
| Migration/schema change | NOT required by this design | — | — |
| Paid features | NOT required; Free-only path | — | — |
| This round (R1.10.3) | DESIGN REVIEW — nothing implemented | this document + design-lab/ | manager acceptance first |

## 8. Non-goals (restated as commitments)

No silent item loss or drop; no disabled duplicate checks or ownership
fences; no reinterpretation of PK-collision rollback or the legacy lost
-fence semantics; no unlimited bypass of any budget; no new env knobs; no
paid upgrade; no cadence-staggering claims; no cloud-fit declaration from
local numbers; no self-authorization of the implementation round. **STOP
for Posidon review.**
