# PIXEL — Free-Safe Execution Design v3 (DESIGN REVIEW — R1.10.3 + R1.10.3.1 + R1.10.4 + R1.10.4.1 corrections)

**Status: DESIGN REVIEW — lab-evidenced candidate, NOTHING implemented in the
product, nothing authorized for product use.** This is the R1.10.3 revision
of the R1.10.2 design: the grouped-read-only proposal is RETRACTED as a
Free-safe design (R112-01) and replaced by a parameter-bounded MULTI-ROW
INSERT + grouped source-bound classification candidate whose semantic
parity and measured costs are proven in the DESIGN LAB on real disposable
workerd D1 (`design-lab/`). R1.10.3.1 (manager verdict CHANGES REQUIRED)
adds: per-chunk byte accounting (§9.1), the RETRACTION of the universal
18 xAPI / 34 STMT ceiling as a CONDITIONAL measured scenario (§9.2), the
NOT_READY verdict for the unchanged supported RSS envelope, and a
continuation options/measurement outline (§9.4 — relabeled R1.10.4; NOT
an implementation-ready durable continuation design). R1.10.4 (Posidon
accepts the R1.10.3.1 planner/tooling corrections; the Free-safe
implementation design is still NOT accepted; NOT_READY remains) corrects
the stale universal-fit claim in §6 — the ≤40 execution-API-call target
PASSES and the ≤40 SQL-statement target FAILS for the unchanged supported
RSS envelope — relabels §9.4 as that outline, and adds the
authorization-gated preview resource probe PLAN
`audit/PREVIEW_RESOURCE_PROBE_PLAN.md` (PLAN ONLY: zero
Cloudflare/account operations, including reads, were performed in
R1.10.4). R1.10.4.1 (the G0 review of that plan returned CHANGES
REQUIRED — R114-01…R114-05) revises the plan in place: the payload gate
is split into legal per-statement admissibility plus a REACHABLE aggregate
`db.batch` ladder, the disposable schema3/schema4 tiers are specified
separately, the authorization machine is acyclic with pre-authorized
emergency teardown, every budget is reconciled from the machine-readable
`audit/PROBE_CASE_SCHEDULE.json` by a LOCAL-only feasibility validator
(`audit-tools/probe-plan/validate-probe-plan.mjs`), and the conclusions are
constrained to the measured shapes — zero Cloudflare/account operations
(including reads) in R1.10.4.1. Product source stays
`f70205648922d0f8e60619e45e5d54e6e87b8f1b` (297 files, byte-identical);
no product patch, no migration, no config change, no Cloudflare operation,
no paid upgrade in R1.10.3 / R1.10.3.1 / R1.10.4 / R1.10.4.1.

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

16 scenarios (R1.10.3.1: +C-15/C-16 envelope re-measures); the fixed
per-poll sequence is the ACCEPTED one (engine claim read+CAS, source
select, capability, acquire, authorize-per-hop, readback, terminal —
imported product functions over the instrumented binding); only
commit+classification are the candidate. Targets from the binding prompt:
≤ 40 execution-API calls AND ≤ 40 submitted statements INCLUDING all
overhead (10 below the documented 50 row).

| Row  | Profile (schema, items, hops)                    | xAPI   | STMT   | Target                               |
| ---- | ------------------------------------------------ | ------ | ------ | ------------------------------------ |
| C-01 | owned, 0 new (304), 1 hop                        | 9      | 10     | —                                    |
| C-02 | owned, 100 new, 1 hop                            | **15** | **29** | ✓ ≤40/≤40                            |
| C-03 | owned, 100 dup-external, 1 hop                   | **15** | **29** | ✓                                    |
| C-04 | owned, 100 dup-url (worst probes), 1 hop         | **15** | **29** | ✓                                    |
| C-05 | owned, 50/50 mix, 1 hop                          | **15** | **29** | ✓                                    |
| C-06 | owned, 100 new MAX content bytes, 1 hop          | **15** | **29** | ✓                                    |
| C-07 | owned, 100 new, 3 hops (2 redirects)             | **17** | **33** | ✓                                    |
| C-08 | owned, budget DENIED (budget 0)                  | 10     | 11     | — (no items)                         |
| C-09 | owned, budget AUTHORITY failure                  | 6      | 6      | — (retry_wait, zero terminal writes) |
| C-11 | legacy, 0 new, 1 hop                             | 8      | 9      | —                                    |
| C-12 | legacy, 100 new, 1 hop                           | **14** | **27** | ✓                                    |
| C-13 | legacy, 100 dup-url, 1 hop                       | **14** | **27** | ✓                                    |
| C-14 | legacy, 100 new, 3 hops                          | **16** | **31** | ✓                                    |
| C-15 | owned, 100 new ≈45 KB CJK canonical URLs, 1 hop  | **15** | **66** | **✗ STMT — NOT_READY evidence**      |
| C-16 | legacy, 100 new ≈45 KB CJK canonical URLs, 1 hop | **14** | **65** | **✗ STMT — NOT_READY evidence**      |
| C-10 | BASELINE accepted per-item, 100 new              | 109    | 210    | reference                            |

**CONDITIONAL measured scenario (RELABELED R1.10.3.1 — NOT a universal
bound):** the previously claimed "derived ceiling 18 xAPI / 34 STMT" holds
ONLY for the fixtures' URL shape (canonical URLs at the ~2 KiB documented
assumption / max content-byte shape): lab 17 xAPI / 33 STMT (C-07) PLUS the
1 API / 1 STMT queue-envelope residual (reconciled from C-10: 109/210 vs
the accepted trace T-13: 110/211, sealed R1.10.2 logs). It is a measured
SCENARIO inside the unchanged envelope, never a universal ceiling — see
§9.2 for the retraction and the counterexample that broke it.

**Envelope re-measure (R1.10.3.1, C-15/C-16):** for 100 items whose
accepted-normalizer canonical URLs are ≈45 KB (percent-encoded 5000-char
CJK paths — reachable inside the unchanged 2 MiB feed limit), the
conservative combined-byte policy yields 2 rows/statement → **50 INSERT
statements ALONE, before all other overhead**: owned 15 xAPI / 66 STMT,
legacy 14 xAPI / 65 STMT; with the +1/+1 envelope residual ≈ 16 xAPI /
67 STMT. The ≤40 xAPI target still holds; the ≤40 STMT target FAILS →
verdict for the unchanged supported RSS envelope: **NOT_READY** (exact
blocker in §9.2). Correctness is UNCHANGED (all rows land, fences intact,
every audited statement ≤ the 102,400-byte conservative budget:
C-15 max 91,728 bytes, C-16 max 90,989 bytes).

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

## 6. What still gates activation (R1.10.4-corrected)

- Per-connector capacity: T-17…T-21 are REPRESENTATIVE multi-request
  traces, NOT supported-max proofs (Steam ≤25 apps × ≤10 items; YouTube
  ≤25 playlists + details; GitHub ≤25 repos; Reddit ≤10 subreddits +
  token; RSS ≤4 feeds × 100). The FIRST profile deliberately excludes
  them; their budgets must be measured separately before any broadening.
- D1 daily rows, queue operations/day, workers requests/day, CPU: UNKNOWN
  (formula margins only; no cloud observation in any round to date).
- The Free row's official unit ("queries per Worker invocation") remains
  unsettled; BOTH interpretations are carried.
  **UNIVERSAL-FIT CORRECTION (R1.10.4 — supersedes the earlier "both fit
  the ≤40/≤40 target for the FIRST profile with ≥10 headroom" claim):**
  that fit held ONLY for the cost-ledger FIXTURE URL shapes at the ~2 KiB
  canonical-URL assumption. After the R1.10.3.1 envelope re-measure
  (C-15/C-16; §4/§9.2): **the ≤40 execution-API-call target PASSES for
  the unchanged supported RSS envelope (≈15–16 xAPI incl. the residual);
  the ≤40 SQL-statement target FAILS** (≈66–67 STMT for the 100-item CJK
  shape under the unchanged conservative combined-byte policy) — the
  envelope verdict is **NOT_READY** (§9.2). The ≤40/≤40 dual fit exists
  ONLY for the conditional measured scenario (§4), never as a universal
  bound. The authorization-gated measurement path for the remaining
  cloud unknowns is the probe PLAN `audit/PREVIEW_RESOURCE_PROBE_PLAN.md`
  (R1.10.4; PLAN ONLY — unexecuted).

## 7. Scope and approval boundaries

| Item                                                         | Type                                | Where                                                        | Status                                                  |
| ------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| Multi-row owned/legacy inserts + grouped source-bound probes | product code change (future round)  | `src/adapters/db/source-ingest-store.ts` (+ classification)  | DESIGN-LAB proven; NOT implemented                      |
| First-profile connector staging (others OFF)                 | config/profile decision             | wrangler/registry config                                     | PROPOSED ONLY; nothing applied                          |
| Grouped-reads-only optimization                              | product code change                 | same as above                                                | still possible as an API-call cut; NOT sufficient alone |
| D4 batch bound                                               | config change                       | `wrangler.jsonc` env.preview                                 | not evaluated further this round                        |
| Migration/schema change                                      | NOT required by this design         | —                                                            | —                                                       |
| Paid features                                                | NOT required; Free-only path        | —                                                            | —                                                       |
| This round (R1.10.3)                                         | DESIGN REVIEW — nothing implemented | this document + design-lab/                                  | manager acceptance first                                |
| R1.10.3.1 corrections (planner + tests + docs + CI)          | review-side only                    | design-lab/ + this document + audit/CORRECTIONS_R1_10_3_1.md | same                                                    |

## 8. Non-goals (restated as commitments)

No silent item loss or drop; no disabled duplicate checks or ownership
fences; no reinterpretation of PK-collision rollback or the legacy lost
-fence semantics; no unlimited bypass of any budget; no new env knobs; no
paid upgrade; no cadence-staggering claims; no cloud-fit declaration from
local numbers; no self-authorization of the implementation round. **STOP
for Posidon review.**

## 9. R1.10.3.1 corrections (CHANGES REQUIRED verdict — this revision)

### 9.1 FIX 1 — per-chunk byte accounting (design-lab/candidate-sql.ts)

The R1.10.3 planner derived ONE `rowsPerStatement` from the input PREFIX
and applied it blindly to every later chunk. The manager's independent
counterexample broke it: 100 normalized RSS items, first 8 with short
URLs, remaining 92 with HTTPS paths of 5000 CJK characters (the RSS XML
stays below the 2 MiB feed limit) — the prefix-derived value was 8 rows,
and the later statements overflowed to **375,637 audited SQL-plus-bind
bytes vs the declared 102,400-byte conservative budget**.

Correction (all review-side, in `design-lab/candidate-sql.ts`):

- `planInsertChunks` now builds and validates EACH chunk INDEPENDENTLY:
  it greedily extends a chunk only while its ACTUAL built SQL text
  (`buildOwnedMultiRowInsertSql(k)` / `buildLegacyMultiRowInsertSql(k)`)
  plus the ACTUAL bind bytes — the chunk's own row binds AND the shared
  guard binds (P + B1, real values, not a count) — stays within BOTH
  documented limits (≤ 100 bound parameters; the conservative
  SQL-text-plus-binds budget). Chunk sizes therefore VARY and are audited
  per chunk (`statementAudits`); no prefix-derived blanket size exists.
- A single oversized row is handled EXPLICITLY: `OversizedRowPlanError`
  (code `row_exceeds_statement_budget`) is raised at PLAN time — before
  any statement is prepared or executed — naming the row index/id and the
  measured bytes. The whole commit is rejected ATOMICALLY (zero
  statements, zero durable effects; proven by L-13); the row is never
  truncated, dropped, or silently skipped. A future implementation round
  must map this typed error onto the accepted failure-class persistence
  surface for operator-facing handling.
- Defense-in-depth: every fully built statement is re-audited
  (`assertStatementWithinBudget`) against the exact binds about to be
  sent, so planner/builder drift can never reach the engine.
- Atomicity, the ownership predicate P, the B1 source binding, and BOTH
  targeted conflict clauses are byte-identical to R1.10.3 (parity suites
  L-01…L-11 re-run green).

Reproductions: **L-12** (the manager's heterogeneous counterexample:
prefix chunk 8 rows, then 46 chunks of 2 rows = 47 INSERT statements,
every chunk audited ≤ budget, all 100 rows land with full ≈45 KB
canonical URLs, feed bytes < 2 MiB), **L-13** (single oversized row →
typed plan-time rejection, zero effects), **L-14** (uniform CJK shape →
exactly 50 chunks × 2 rows).

### 9.2 FIX 2 — the worst-case claim is RETRACTED as universal; NOT_READY

Claimed basis of the old bound: the cost-ledger fixtures assumed canonical
URLs at a ~2 KiB documented assumption. **The accepted normalizer
(`src/connectors/normalize.ts`, byte-identical, unmodified) enforces NO
canonical-URL length cap** — it percent-encodes every non-ASCII path byte
(3 UTF-8 bytes → 9 URL bytes per CJK char) and preserves the path
verbatim. For 100 items sharing the 5000-char CJK path shape, the
accepted normalizer produces canonical URLs of **exactly 45,023 bytes**
(pinned by L-14 through the real `normalizeRawItem`), while the
equivalent raw-CJK RSS XML remains ≈1.4 MB < the 2 MiB feed limit — i.e.
the shape is INSIDE the unchanged supported RSS envelope.

Consequences under the (unchanged, conservative) combined-byte policy:
2 rows/statement → **50 INSERT statements alone, before all other
overhead** — measured end-to-end as C-15 (owned: 15 xAPI / 66 STMT) and
C-16 (legacy: 14 xAPI / 65 STMT). The ≤40 xAPI target still holds; the
≤40 STMT target FAILS.

Verdict: the previous "18 xAPI / 34 STMT derived ceiling" is RETRACTED as
a universal bound and RELABELED a **conditional measured scenario**
(valid only for fixture URL shapes at the ~2 KiB assumption; §4). For the
UNCHANGED supported RSS envelope the candidate is **NOT_READY** against
the BOTH-targets requirement (the ≤40 xAPI target PASSES; the ≤40 STMT
target FAILS — see the §6 universal-fit correction, R1.10.4). Exact blocker: canonical-URL byte expansion is uncapped
by the accepted normalizer, and the conservative combined
SQL-text-plus-binds budget then caps such rows at 2/statement, so a
100-item CJK-shaped poll cannot meet ≤40 STMT regardless of planner
correctness.

No truncation of URLs/items, no lowering of supported caps, no discarding
of work, no weakening of fences, and no assumption of a paid plan was
done or is proposed.

### 9.3 Platform-limit justification (documented rows vs internal policy)

Basis: the manager-retrieved official excerpts (provenance:
`free-plan/FREE_PLAN_OFFICIAL_SOURCES.md`, shipped in the sealed
R1.10.2/R1.10.3 packages as `manager-evidence/official/d1-limits.json`):

- "Maximum SQL statement length | 100,000 bytes (100 KB)" — applies to
  the SQL TEXT, "to each statement contained within a batch statement".
- "Maximum bound parameters per query | 100" — a COUNT row.
- "Maximum string, `BLOB` or table row size | 2,000,000 bytes (2 MB)" —
  a ≈45 KB canonical URL is far below the documented ROW-size row.
- There is **NO documented row for a maximum bound-parameter byte size or
  a maximum batch payload**. The candidate's combined
  SQL-text-plus-binds ≤ 100 KB policy is therefore an INTERNAL
  CONSERVATIVE MARGIN — strictly stronger than the documented rows, and
  NOT the same as the documented SQL-TEXT limit. R1.10.3.1 keeps it
  enforced (no weakening without measured evidence).

Remaining risks that the conservative margin deliberately covers (and
that any policy revision must first measure):

- **Payload risk:** a 100-item CJK-shaped poll sends ≈4.6 MB of binds in
  ONE batch; the platform's actual enforcement of large bind payloads on
  the D1 Worker binding is undocumented/unknown.
- **CPU risk:** Workers Free CPU is 10 ms per invocation (documented);
  normalizing 100 × ≈15 KB raw CJK URLs plus ≈45 KB canonical strings and
  hashing them is NOT measured — local elapsed wall time is not CPU
  evidence.
- **Quota risk:** rows read/written daily allowances (documented rows)
  are formula-margined only; no cloud observation exists.

### 9.4 Continuation options and measurement OUTLINE (RELABELED R1.10.4 — NOT an implementation-ready durable continuation design)

**R1.10.4 relabel (Posidon verdict carried: the R1.10.3.1 planner/tooling
corrections are accepted; the Free-safe implementation design is NOT
accepted; NOT_READY remains).** What follows is an OPTIONS/MEASUREMENT
OUTLINE — a survey of the candidate paths and the measurements each would
need — NOT the implementation-ready durable continuation design that §5
requires (persisted work, cross-window ownership/fencing, crash windows,
lossless in-window processing are designed NOWHERE; nothing in this
section is executable as written). Stated plainly: **the ≤40
execution-API-call target PASSES for the unchanged supported RSS
envelope; the ≤40 SQL-statement target FAILS** (§6/§9.2). The concrete,
authorization-gated measurement gate for item 1 below is the probe PLAN
`audit/PREVIEW_RESOURCE_PROBE_PLAN.md` — PLAN ONLY, zero
Cloudflare/account operations performed in R1.10.4/R1.10.4.1, unexecuted
until its own separate authorization checkpoints pass. **R1.10.4.1: the
plan was REVISED after its G0 review returned CHANGES REQUIRED
(R114-01…R114-05, addressed in place — see
`audit/CORRECTIONS_R1_10_4_1.md`); a NEW G0 review is requested.**

To lift NOT_READY honestly, a future round (NOT authorized by this
round) must deliver, in this order:

1. **Measurement gate (requires authorized Cloudflare operations on the
   PREVIEW database — none performed in R1.10.3/R1.10.3.1):** a scripted,
   reviewable probe plan that measures on the real preview D1 (a) the
   largest bind payload accepted by the documented-limits-only policy,
   (b) end-to-end commit cost for the CJK shape under that policy, and
   (c) Worker CPU for the same poll. Probes run only with explicit owner
   authorization; results are bound to logs and only then may the
   internal combined-byte policy be JUSTIFIABLY revised (or kept).
   **R1.10.4: this plan now EXISTS as
   `audit/PREVIEW_RESOURCE_PROBE_PLAN.md` (PLAN ONLY — it has NOT been
   executed, performs zero account operations itself, and execution
   requires its own separate authorization checkpoints). R1.10.4.1: the
   plan is REVISED in place per the G0 CHANGES REQUIRED verdict (legal
   aggregate ladder; S3/S4 tiers; acyclic authorization machine;
   schedule-reconciled budgets + LOCAL validator; exact coverage claim),
   with `audit/PROBE_CASE_SCHEDULE.json` as the machine-readable source of
   truth.**
2. **Policy decision rule (pre-committed):** if measured evidence shows
   the documented SQL-TEXT limit (≤ 100 KB text, ≤ 100 params) alone is
   safe for the envelope, the planner switches to documented-limits
   accounting with the conservative margin kept as a WARN-level audit —
   the CJK shape then fits far more rows per statement (the SQL text for
   N rows is placeholder scaffolding only; the ≈45 KB values ride as
   binds), restoring ≤40 STMT measurably. If evidence is negative or
   unavailable, the envelope verdict stays NOT_READY — never "fit by
   assumption".
3. **Durable multi-window alternative (no policy change needed):** split
   one poll's items across SEVERAL queue envelopes (bounded item
   windows) so every single invocation stays ≤40/≤40 under the CURRENT
   conservative policy. This REQUIRES the exact durable continuation spec
   the design already demands (§5): persisted work, cross-window
   ownership and fencing, crash windows, lossless in-window processing —
   none of it is designed or implemented here; it is named as the only
   product-side path that does not depend on undocumented platform
   behavior.
4. **Accepted non-goals (unchanged):** no URL/item truncation, no cap
   lowering, no silent drops, no paid plan, no schema/migration change,
   no config change, no Cloudflare operation in the review round itself.

### 9.5 FIX 3 — CI restored green (this branch)

- All added review-side files now pass `eslint .` and
  `prettier --check .` (see `audit/CORRECTIONS_R1_10_3_1.md` for the
  exact mechanical changes; measurement `console` output is channeled
  through documented single-exception helpers
  `design-lab/lab-log.ts` / `audit-tools/trace/trace-log.ts` because the
  workerd test pool reaches the host log ONLY through console and the
  ledger extractor parses those lines).
- The frozen manager probe source is preserved BYTE-IDENTICAL as an
  opaque fixture
  (`manager-evidence/manager-probes/design-counterexamples.test.ts.frozen`)
  and is materialized TEMPORARILY by `manager-evidence/reproduce.sh` (and
  the documented commands) for its standalone run only; the expected
  outcome stays **exit 1 = 1 failed / 3 passed** with CE2 intentionally
  historical red. No ignore lists, no disabled CI, no weakened
  assertions; historical evidence bytes and the frozen-probe expectations
  are untouched.

## 10. R1.10.4 corrections (LOCAL docs ONLY — PLAN, no operations)

Posidon independently ACCEPTS the R1.10.3.1 planner/tooling corrections.
This does NOT accept a Free-safe implementation design; **NOT_READY
remains** for the unchanged supported RSS envelope.

- **§6 universal-fit claim corrected (stale):** the earlier "both
  interpretations fit the ≤40/≤40 target for the FIRST profile with ≥10
  headroom" held ONLY for the fixture URL shapes at the ~2 KiB
  canonical-URL assumption. Stated plainly: **the ≤40 execution-API-call
  target PASSES for the unchanged envelope (≈15–16 xAPI incl. the
  residual); the ≤40 SQL-statement target FAILS** (≈66–67 STMT for the
  CJK shape; C-15/C-16, §4/§9.2) → NOT_READY.
- **§9.4 relabeled** a continuation options/measurement OUTLINE — NOT an
  implementation-ready durable continuation design; the §5-required
  durable continuation spec (persisted work, ownership/fencing, crash
  windows, lossless in-window processing) still does not exist.
- **NEW `audit/PREVIEW_RESOURCE_PROBE_PLAN.md`** — the
  authorization-gated preview resource probe PLAN: official-limit
  re-verification with URLs, page dates and exact units (retrieved
  2026-10-19; no page change affecting the carried rows); isolated
  disposable preview resources; synthetic fixtures; quota / SQL
  statements / bind payloads / row usage / REAL Worker CPU measurement
  definitions (documented CPU surfaces: Workers Logs invocation logs and
  the Workers Trace Events `CPUTimeMs` field; wall time is NEVER CPU);
  normal, heterogeneous-size, Unicode/CJK and oversized-row cases; exact
  bounded invocation/data totals; prerequisites; abort criteria;
  cleanup; evidence collection; pre-committed decision rules; the
  internal combined-byte policy kept strictly distinct from official
  SQL-text limits; and a separate authorization checkpoint before ANY
  account operation.
- **Compliance record:** R1.10.4 performs ZERO Cloudflare/account
  operations (including reads); no product implementation, no resource
  creation, no deployment, no real D1 writes, no migration, no
  activation, no billing upgrade, no merge. The 297 product files stay
  byte-identical to `f70205648922d0f8e60619e45e5d54e6e87b8f1b`; ordinary
  commits on the same branch; no force push. Details:
  `audit/CORRECTIONS_R1_10_4.md`. **STOP for Posidon review.**
