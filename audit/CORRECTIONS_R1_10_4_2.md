# CORRECTIONS — R1.10.4.2 (LOCAL proof-scope, fixture, and accounting corrections ONLY)

**Scope:** continuation of Draft PR #11 (`review/r1.10.3-sql-design`) after
the R1.10.4.1 G0 review returned **PARTIALLY ACCEPTED / CHANGES REQUIRED**
(findings R1141-01…R1141-05 with three supplied probes — validator 19/19,
D1 counterexample 1F/2P, fixture counterexample 1F/2P, latch control 1P —
all reproduced this round BEFORE any edit, bound at
`logs/51-reviewer-evidence-repro-r11042.log`). This round fixes **the PLAN
and its LOCAL tooling only** — not the product, not Cloudflare resources,
not any account state. ZERO Cloudflare/account operations (including reads)
were performed. **ZERO GitHub remote writes: publication is HELD (R1141-05)
— ordinary LOCAL commits only, unpushed.** Product source stays
`f70205648922d0f8e60619e45e5d54e6e87b8f1b` — all 297 accepted product files
remain byte-identical (re-verified after the commit). Reviewed starting HEAD:
`fc679f1f051f6d223356515160068980727f768b` (ordinary LOCAL commits only; no
push, no force push).

## CR11042-01 — the unsupported "FULL replay" assertion is retracted; proof scope is labeled (R1141-01)

- **Defect:** the R1.10.4.1 validator labeled its execution a "full local
  replay", but it substitutes `SELECT 1` for source-select, capability-read,
  authorization, budget-readback and classification, uses simplified SQL for
  ownership/terminal operations, replays every case after S4 setup, and sums
  API counts from the schedule instead of observing calls. The real
  `authorizeIngestionUnit` executes a guarded UPDATE plus INSERT..SELECT in
  one atomic batch and mutates budgets on a grant — the substitute does
  neither. 521 substitute statements therefore proved neither the full-poll
  call chain nor the exact row/read/bind ledger nor API grouping.
- **Fix:** every full-replay label RETRACTED. The execution is now the
  **STRUCTURAL SQL/payload/storage SIMULATION** (validator V-10, plan §16,
  schedule `proofScope.structuralSimulation`) with the substituted kinds
  DECLARED; the schedule registers exactly what the simulation proves and
  does not. The **full-poll-equivalent harness** (accepted claim/source/
  capability/authorization/ownership/terminal operations + the design-only
  commit candidate + actual source-bound grouped probes, observing actual
  execution-API calls, statement attempts/batch boundaries, durable budget
  effects and bind payloads) is **UNPROVEN — NOT IMPLEMENTED**, with
  full-poll cloud execution BLOCKED (schedule `proofScope.fullPollHarness`;
  NEW decision rule D9: structural calibration is never promoted into
  full-poll readiness). The S3 control cases (X-SMOKE, X-SETUP-S3, P-C3) now
  genuinely simulate BEFORE migration 0004 is applied (V-10 reports the
  tier-aware order). Local engine metadata is kept DISTINCT from Cloudflare
  billable counters (schedule `accounting.engineMetadataDistinction`; plan
  §9/§10), and the measured 101.2 MB storage is explicitly the storage of
  THIS simulation — full-path storage stays UNKNOWN (§10).

## CR11042-02 — D1 prepare/construction vs terminal execution corrected (R1141-02)

- **Defect:** the R1.10.4.1 plan claimed the S3 missing-column probe is a
  "PREPARE-TIME ERROR on D1 (prepare() is construction, never a submitted
  statement)" — promoting node:sqlite's compile-at-prepare behavior to D1.
  The reviewer's workerd test proved `prepare()` SUCCEEDS on S3 and the
  SAME statement rejects at TERMINAL execution (`.all()`): 1F/2P.
- **Fix:** the mechanism is corrected everywhere (plan §6, schedule
  `accounting.attemptedQueryDefinition`). The tier-boundary probe is
  REGISTERED as an ATTEMPTED QUERY in X-SETUP-S3 (+1 API call, +1 attempted
  statement, 0 rows — expected class: terminal rejection) and its positive
  counterpart in X-SETUP-S4 (prepare constructs AND the terminal execution
  succeeds with 0 rows). Counts reconciled everywhere: X-SETUP-S3 = 1/3/4,
  X-SETUP-S4 = 1/5/6; round = **153 API calls, 523 invocation-side attempted
  statements, 602 total incl. 79 CLI** (cap 650; per-invocation maxima
  unchanged 69/52). A **PERMANENT positive workerd control** is added:
  `audit-tools/d1-contract/d1-terminal-contract.test.ts` (+ own vitest
  config; 4 tests, all passing in real workerd D1 — bound log
  `logs/53-d1-terminal-contract-r11042.log`): construction-only prepare on
  S3, terminal rejection with the column name, schema_version = 3, and the
  S4 positive half after the 0004 candidate. The historical negative
  counterexample (`posidon-review/R1.10.4.1/manager-r11041-boundary.test.ts`)
  remains byte-identical and historically red — labeled, never silently
  weakened. X-SMOKE's registered tier is corrected to S3 (it runs while the
  disposable DB is still at schema version 3; its statements are
  tier-agnostic).

## CR11042-03 — raw RSS and canonical fixtures are now round-trip equivalents (R1141-03)

- **Defect:** the R1.10.4.1 raw-RSS size helper used `https://<host>/short-<i>`
  for padded-ASCII rows (F-NORMAL item 0 normalizes to 30 bytes, not the
  registered 2,048 — the reviewer's fixture counterexample 1F/2P), counted
  the 66-byte RSS wrapper once initially and again inside every per-item
  call, and estimated sizes without serializing a complete document.
- **Fix:** ONE deterministic generator now produces complete raw RSS
  documents AND the canonical expected rows from the SAME links (the padded
  ASCII URL IS the raw link; CJK raw paths expand at 9 URL bytes per 3-byte
  character under the accepted WHATWG-URL normalizer). Documents are
  serialized to ACTUAL UTF-8 bytes and round-tripped: re-extract every
  `<link>` → canonicalize → assert EXACT identity with the registered
  canonical rows (validator V-07; every registered delivered slice —
  offsets, heterogeneous segments, F-OVERSIZE — verified). Regenerated raw
  figures (schedule `fixtures[*].rawRss`, byte-verified): **F-NORMAL
  207,582 B per 100-item slice** (was mis-estimated 12,456); **F-HETERO
  1,401,282 B**; **F-CJK 1,505,082 B per 100-item slice**; **F-OVERSIZE
  102,609 B** — all < the 2,097,152-byte feed bound. No new URL cap, no row
  dropped, no truncation, no product-semantics change; canonical rows and
  all payload/bind/storage figures keep their registered values (P_req =
  4,510,238 B; P_208 = 9,383,270 B = 2.080×). The static coverage
  counterexample keeps the reviewer's registered frozen arithmetic exactly
  (1,800,116 B / 5,400,023 B — V-14). Honest label: the round-trip covers
  the accepted URL normalizer and the generator-owned document shape; FULL
  accepted-parser ingestion belongs to the UNPROVEN harness (CR11042-01).

## CR11042-04 — reject-path latch accounting and hard-cap claims made honest (R1141-04)

- **Defect:** the plan claimed "wrong/missing token → zero D1 statements"
  (true — pre-D1) but ALSO implied the latch/kill-switch paths are zero-D1:
  detecting an aborted global row or an exhausted budget REQUIRES one
  submitted UPDATE with zero changed rows (the reviewer's latch control: 1
  submitted UPDATE, 0 changed rows). The "24th request is by construction a
  plan violation" language claimed a global hard request ceiling with no
  enforcement mechanism; V-17 only inspected seeded/final state; the latch
  SQL recorded but did not enforce the statement budget.
- **Fix (plan §5, schedule `caps`):** three distinct claims are now always
  separated — zero probe work, zero durable changes, zero submitted D1 calls
  (only the token path achieves the third). Every authorized-but-rejected
  latch observation (duplicate delivery, kill-switch observation/activation,
  closed case, exhausted statement budget) is a COUNTED D1 attempt covered
  by a RESERVED bounded overhead: **8 D1 attempts / 8 API calls / ≤16 rows
  written / ≤64 rows read** — reconciled in §10 and validator V-11/V-12/V-13;
  beyond the reserve, any additional refusal is an abort-criterion event.
  Enforcement classes are registered (`caps.accessControlClasses`): DURABLY
  enforced (per-case invocation budget, per-case statement budget at
  invocation granularity, status gating, kill switch — now including a
  `statements_used < statements_registered` guard in the latch SQL, added
  WITHOUT changing the reviewer-harness bind arity of 4); OPERATOR
  SUBMISSION limits (the aggregate 23 = accounting identity, no separate
  durable counter; single execution per case; the 3-retry allowance);
  NOT enforced (unauthenticated public traffic volume). **BEHAVIORAL
  controls added (validator V-18, executed locally):** admission consumes
  conservatively; duplicate delivery, kill-switch observation, closed case
  and statement-budget exhaustion each cost exactly ONE submitted UPDATE
  with ZERO durable changes. No retry storm: retries remain gated on the
  no-D1-statement precondition, a consumed-but-unanswered latch slot stays
  consumed (conservative before-work admission preserved), and the
  emergency-teardown overhead is counted. G0→G5 stays acyclic with the
  publication gate added (P0-10).

## CR11042-05 — truthful publication-safety note; push HELD (R1141-05)

- **Defect:** the R1.10.4.1 report stated the narrow truth ("no direct
  Cloudflare API call by this round") without the operational gate: public
  GitHub check-runs show **"Workers Builds: pixel-preview" (app
  cloudflare-workers-and-pages), conclusion FAILURE, with distinct
  Cloudflare Build IDs on 761f176, 06caee0 and fc679f1** — account-side
  BUILD ATTEMPTS were associated with pushes to this branch. "Pre-existing"
  does not imply harmless; a red build is not a safety mechanism.
- **Fix:** plan §19 (NEW) states the known build attempts, the UNKNOWNs
  (deployment outcome, failure stage/cause, side effects, charges, future
  triggerability), and the rule: **no push, no PR update, no remote write
  until a SEPARATE publication-safety authorization verifies safe
  integration/branch behavior** (owner-side investigation or an explicitly
  granted minimal read/configuration authorization; this round grants and
  performs none — zero Cloudflare/account operations including reads). The
  schedule carries `publicationSafety` with the evidence list; this round's
  commits are LOCAL and unpushed; the deliverable ZIP marks the unpushed
  status and includes the round's patch (plain text) for review without
  publication.

## Verification matrix (this round, all LOCAL)

| Gate                                                                       | Result                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reviewer evidence reproduced BEFORE edits (at fc679f1)                     | validator 19/19 exit 0; D1 counterexample 1F/2P; fixture counterexample 1F/2P; latch control 1P (exit pattern 0/1/0/1 — matches the review) (`logs/51-reviewer-evidence-repro-r11042.log`) |
| Revised LOCAL probe-plan validator                                         | **21 checks / 0 failures / exit 0** (`logs/52-plan-validator-r11042.log`)                                                                                                                  |
| Permanent workerd D1-contract control (NEW)                                | **4 tests / 4 passed / exit 0** (`logs/53-d1-terminal-contract-r11042.log`)                                                                                                                |
| Reviewer latch harness compatibility (bind arity 4 preserved)              | 1P — passes unmodified against the revised latch SQL                                                                                                                                       |
| Latch/sources seed drift fences                                            | Regenerated == committed, byte-identical (V-05; latch budgets updated 4/6 for the setup cases)                                                                                             |
| Same-link fixture round-trip (6 delivered slices)                          | identity=true for every link; byte-exact vs registered (V-07)                                                                                                                              |
| Product files vs `f7020564…`                                               | 297/297 byte-identical, 0 modified/deleted (re-verified post-commit)                                                                                                                       |
| `npm run check` (lint+format+typecheck+1142+secret scans+versions+dry-run) | exit 0 GREEN; product suite 1142/1142 unchanged                                                                                                                                            |
| DB 301 / trace 50 / lab 30 + ledger parity                                 | 301/301; 50/50; 30/30 with byte-identical regenerated ledger                                                                                                                               |
| Frozen historical evidence (incl. CE2 intentionally-red probe)             | Untouched; frozen manager probes exit 1 = 1F/3P (CE2 intentionally historical red)                                                                                                         |
| Cloudflare/account operations                                              | **0** (including reads)                                                                                                                                                                    |
| GitHub remote writes                                                       | **0** — publication HELD (§19); LOCAL unpushed commits only                                                                                                                                |
| Secret scan                                                                | 0 findings over all tracked files (true count bound in the round report)                                                                                                                   |

## Deliverables

- `audit/PREVIEW_RESOURCE_PROBE_PLAN.md` — revised in place (R1.10.4.2; new
  §18 closing record + §19 publication-safety note).
- `audit/PROBE_CASE_SCHEDULE.json` — schemaVersion 2: terminal-probe
  registrations and reconciled counts, per-fixture raw-RSS deliveries,
  `proofScope` (structural simulation vs UNPROVEN harness),
  `publicationSafety`, `accessControlClasses`, reserved refusal/emergency
  overhead, attempted-query definition, engine-metadata distinction.
- `audit-tools/probe-plan/validate-probe-plan.mjs` — 21 checks: same-link
  round-trip (V-07), tier-aware structural simulation (V-10), behavioral
  latch controls (V-18), proof-scope register (V-19), reserved overhead in
  reconciliation (V-11/V-12/V-13), D1-contract labeling (V-04a/V-04b).
- `audit-tools/probe-plan/latch-seed.sql` — regenerated (statement budgets
  4/6); `sources-seed.sql` — unchanged content, regenerated header;
  `probe-ddl.sql` — accounting-honest comments; `README.md` — relabeled.
- `audit-tools/d1-contract/` — NEW permanent workerd D1 prepare/terminal
  contract control (4 tests) with its own vitest config.
- `logs/51-reviewer-evidence-repro-r11042.log`,
  `logs/52-plan-validator-r11042.log`,
  `logs/53-d1-terminal-contract-r11042.log` — NEW bound logs.
- `REVIEW_README.md`, `VERSION.json` — round metadata (publication HELD).

**STOP — awaiting independent review (G0) of the revised plan. No G0/G1
cloud authorization is claimed; no READY verdict is asserted; nothing is
pushed (publication HELD, §19).**
