# PIXEL — Round 1.9.1 corrections implementation report (R19-01 / R19-02 / R19-03)

**Status:** LOCAL CORRECTIVE CANDIDATE for independent review. NOT ACCEPTED,
NOT RELEASED, NOT DEPLOYED, NOT ACTIVATED, NOT MERGED. `candidateCommit=null`.
No Cloudflare operation, no real database migration, no commit, no push, no
delivery-page edit. The accepted runtime remains **app1.4.0 / APPLIED schema
3**; migration candidate 0004 was applied ONLY to disposable workerd D1 test
databases through the explicit test-only plan (`tests/helpers/migrations.ts`
`ROUND19_MIGRATION_PLAN`).

**Input:** the UNCHANGED 292-file Round 1.9 candidate
(`pixel-phase04-v1.4.0-round1.9-review-candidate.zip`, SHA-256
`e1b9bb49733541bd331d45da17c81e7aca1f490f4009f3e4745cc6052487ffde`,
reproduced through the Posidon review package `SHA256SUMS.txt`: 343/343 OK).

**Authorization:** `NEXT_ROUND_1_9_1_GLM_PROMPT.md` — exactly three required
corrections. This document records what was implemented, what was verified,
every assertion change (with the verbatim superseded behavior), and the exact
provenance of every diff base used for R19-03.

---

## §1. R19-01 — fail closed on unknown capability (P1 blocker)

### 1.1 The defect (Posidon R19-01, counterexamples CE1–CE4)

Round 1.9's `readAppliedSchemaVersion` collapsed every unreadable state
(failed read, missing row, corrupt value, unsafe integer) into `null`, and
`resolveOwnershipCapability` exposed only `ownershipEnabled = (v === 4)`.
Both ingestion entrypoints interpreted `false` as permission to run the
LEGACY ingestion path. Consequences on an actual schema-4 database:

- CE1 — corrupt metadata: the scheduler created an unfenced legacy job and
  moved the hold to `scheduledForMs + 120000` (the "1970-class" marker
  defect) instead of doing nothing.
- CE2 — corrupt metadata + stale generation: the handler fetched and
  inserted items through the legacy commit path.
- CE3 — a transient metadata read failure downgraded a stale worker to
  legacy authority.
- CE4 — unsupported version 5 also selected legacy.

Readiness (`checkSchemaHealth`) failing separately did NOT protect the
cron/queue execution paths, which never require a successful readiness check.

### 1.2 The correction

`src/adapters/db/schema-health.ts` — the ambiguous boolean contract is
REPLACED by exactly three distinct typed states (no invented versions):

```ts
type SchemaCapability =
  | { kind: 'known_v3_legacy'; appliedSchemaVersion: 3 }
  | { kind: 'known_v4_ownership'; appliedSchemaVersion: 4 }
  | {
      kind: 'unresolved';
      reason:
        | 'schema_capability_metadata_read_failed'
        | 'schema_capability_metadata_missing'
        | 'schema_capability_metadata_invalid'
        | 'schema_capability_version_unsupported';
    };
```

- ONLY a readable exact integer **3** resolves `known_v3_legacy` and may
  select the documented legacy paths (accepted compatibility, byte-identical).
- ONLY a readable exact integer **4** resolves `known_v4_ownership`; ALL
  owner/generation fences are retained unchanged.
- EVERYTHING ELSE is `unresolved` with a stable reason: failed read, missing
  or empty row, non-integer / zero / negative / unsafe-oversized integer
  (`invalid`), or a well-formed integer other than exactly 3 or 4
  (`unsupported`). Unresolved is NEVER legacy, NEVER ownership.
- `checkSchemaHealth` is byte-identical (exact-equality readiness gate —
  untouched, per the prompt's "do not loosen checkSchemaHealth equality").
- The removed functions `readAppliedSchemaVersion` /
  `resolveOwnershipCapability` / `OwnershipCapability` no longer exist, so
  the ambiguous contract cannot be re-imported. (The migration-candidate
  constant `OWNERSHIP_SCHEMA_VERSION` is retained as the version-4 marker.)

`src/application/ingestion/scheduler.ts` — the pass resolves the capability
once, at the SAME position as Round 1.9 (before the completeness probe):
`unresolved` returns a NEW stable, recoverable outcome
`{ kind: 'capability_unresolved', reason }` and the pass stops BEFORE the
R08 completeness probe, any seed/repair, the due scan, and every
job/source-state effect — zero effects. `src/entrypoints/cron.ts` logs it
(`cron.ingestion_capability_unresolved`, warn).

`src/application/ingestion/poll-handler.ts` — after the engine's atomic
claim and BEFORE preflight/budget/network/items/source-state effects, an
`unresolved` capability returns the stable typed RECOVERABLE outcome
`{ kind: 'retry', reasonCode: 'ingestion_capability_unresolved' }` (the new
code is registered in `JOB_ERROR_CODES`,
`src/domain/jobs/job-types.ts`). The work is neither silently completed nor
poisoned as an unknown job type; the SAME window re-executes once the
capability resolves, bounded by the job's `max_attempts` (a persistent
outage dead-letters observably — visible, requeueable, honest).

`src/adapters/db/source-ingest-store.ts` — unchanged for R19-01 (see §2).

### 1.3 Engine retry bookkeeping vs ingestion effects (deliberate separation)

When the handler returns `retry`, the ENGINE persists its own fenced
bookkeeping on the `jobs` row (`status='retry_wait'`, `last_error` =
`ingestion_capability_unresolved`, a bounded backoff, attempts unchanged by
the handler) — exactly as for any other retryable outcome. That is engine
retry accounting, unavoidable by construction (the engine claimed the job
before `execute()` ran) and deliberately DISTINCT from ingestion effects, of
which there are ZERO: no budget read/charge, no network request, no
`source_items` insert, no `source_state` write. The new tests assert this
separation directly (the claimed row's `status`/`attempts`/`lease_until` are
byte-preserved by the handler in the unresolved state, and the state row is
`toEqual`-identical).

### 1.4 Tests added (permanent)

`tests/integration/round191-capability-failclosed.test.ts` (16 tests) —
scheduler: missing row (incl. proof the pass stops BEFORE the seed/repair —
a deleted catalog row stays deleted), corrupt value, invalid syntax
(`v4`, `4.0`, `0`, `-3`; empty value → `missing`), oversized integer beyond
`MAX_SAFE_INTEGER`, unsupported version 5, transient metadata read throw,
recovery once exact v4 returns (next pass schedules the owned window),
known-v3 legacy control (owner column untouched, documented marker+hold
defect honestly preserved), known-v4 owned control. Handler: stale
generation × {corrupt, missing, oversized, unsupported, read-throw} — all
with `raw=0`, `items=0`, state row `toEqual`-identical (cursor/etag/owner/
marker preserved) and engine bookkeeping untouched; recovery at exact v4
(stale generation still fenced; current generation polls normally);
known-v3 legacy handler control (documented legacy behavior ONLY under an
explicitly readable v3).

The supplied independent probes
(`tests/integration/posidon-round19-counterexamples.test.ts`, SHA-256
`f84d28b8dfb5544abcba62e4e6e38dc30483282e6c47d2240c91abff119e6664`) are
UNMODIFIED and ship as permanent regression tests: **7/7 green**.

---

## §2. R19-02 — complete durable foreign identity (P2)

### 2.1 The defect (Posidon R19-02, counterexample CE5)

The post-conflict classification read in `schedulePollWindowOwned`
(`src/adapters/db/source-ingest-store.ts:588` in Round 1.9) selected
`id, type, payload_json, status` — omitting `aggregate_type` /
`aggregate_id`. A same-key row with a matching type and canonical payload
but a FOREIGN aggregate was classified `outstanding_job_owns_window`
(nonterminal) or `marker_moved` (terminal) even though the SQL correctly
denied the actual reservation: the reported result/observability was false.

### 2.2 The correction

The bounded existing-row lookup now reads the COMPLETE durable identity
(`id, type, aggregate_type, aggregate_id, payload_json, status`), and the
window is classified `foreign_window_job` unless job type AND
`aggregate_type='source'` AND the source aggregate id AND the canonical
payload ALL match — checked BEFORE any terminal/nonterminal classification.
No automatic deletion, cancellation, cleanup or transfer exists in any
branch (unchanged); the foreign row and the window are left untouched for
operator action, and the anomaly is reported
(`ingestion.schedule.foreign_window_job`, warn — existing observability).

### 2.3 Tests added (permanent)

`tests/integration/round191-foreign-window-identity.test.ts` (7 tests):
wrong aggregate id and wrong aggregate type, in BOTH nonterminal and
terminal states → `foreign_window_job` (the terminal cases catch the old
silent `marker_moved`); the foreign row verified untouched (status /
aggregate columns unchanged — no auto-cancel/delete/transfer) and the
window/ownership state verified `toEqual`-identical. Matching legitimate
states unchanged: same-identity nonterminal → `outstanding_job_owns_window`;
same-identity terminal at the scanned marker, unowned →
`window_terminal_skipped` (S3 remediation intact); same-identity terminal
with a moved marker → `marker_moved`.

---

## §3. Assertion-change ledger (honest, narrow, authorized)

The prompt authorizes EXACTLY ONE assertion change: the unsafe R09-P16
expectation. Everything else in the original R09/R10 acceptance suites kept
its assertions; the supplied counterexamples are byte-identical
(SHA-256 above) and now pass 7/7. NO skip/weaken/relabel was used anywhere.

### 3.1 R09-P16 (`tests/integration/round19-r09-ownership.test.ts`)

- KEPT byte-identical: the exact-equality health assertions
  (`checkSchemaHealth(db, 4)` → ok, and the v3-configured mismatch with
  `observedSchemaVersion: 4`).
- REPLACED (authorized): the middle block that codified
  corrupt-metadata → legacy scheduling. The SUPERSEDED behavior is
  preserved VERBATIM as a commented reference inside the test and
  reproduced here:

```ts
// Corrupt metadata → the capability fails safe to OFF (never guesses).
await db.run({
  sql: "UPDATE schema_metadata SET value='bogus' WHERE key='schema_version'",
});
expect(await resolveOwnershipCapability(db)).toEqual({
  appliedSchemaVersion: null,
  ownershipEnabled: false,
});

// The scheduler then takes the LEGACY path (accepted schema-3 behavior):
// a durable job via the engine + the marker CAS — and it NEVER writes
// the ownership column (fail-safe degradation, not a fabricated green).
await enableSource(0);
await db.run({ sql: 'DELETE FROM jobs' });
const outcome = await scheduleDueSources({
  executor: db,
  engine: resolution().engine,
  connectors: createConnectorRegistry(),
  secrets: () => undefined,
  nowMs: NOW,
});
if (outcome.kind === 'scheduled') {
  expect(outcome.jobsCreated).toBe(1);
}
const legacy = await stateRow();
expect(legacy!.poll_owner_job_id).toBeNull(); // the legacy path never touches the owner column
expect(legacy!.next_poll_at).toBe(HOLD); // legacy marker+hold (the known schema-3 defect, honestly preserved)
```

WHY UNSAFE: this is exactly counterexample CE1. On an actual schema-4
database with corrupt metadata, `ownershipEnabled=false` was derived from
an UNREADABLE state and used as permission to create an unfenced legacy
job and move the hold — real ingestion authority granted by corrupted
data. "Unknown" and "explicitly readable v3" are different states and must
not share a path (R19-01 requirement). The replacement asserts the typed
`unresolved` capability, the `capability_unresolved` scheduler outcome,
zero jobs, a `toEqual`-identical state row, and the owner column still
NULL — plus recovery to `known_v4_ownership` once exact metadata returns.

- The test title now says "unknown states FAIL CLOSED (R19-01), never
  legacy" (title-only change, reported honestly).

### 3.2 Mechanical call-site adaptations (not semantic changes)

- `resolveOwnershipCapability` shape assertions existed ONLY inside R09-P16
  (§3.1) — no other acceptance assertion referenced the removed API.
- The Round 1.9 docs describing the old contract were not edited away: the
  R09 implementation report carries a Round 1.9.1 amendment banner at the
  top (history preserved verbatim below it).

---

## §4. R19-03 — packaging, counts, and the three diff proofs

### 4.1 What was wrong (Posidon R19-03)

1. The cumulative patch omitted `docs/reviews/ROUND1_8_1_INDEPENDENT_ACCEPTANCE.md`
   (the Round 1.9 session verified its diffs against a reverse-derived
   CIRCULAR baseline — its own `review/logs/METHODOLOGY.md` §5 admits the
   48e0f28 tree was "RECONSTRUCTED by reverse-applying …"). Applied to the
   REAL Git archive of 48e0f28 the reconstruction missed exactly that file.
2. Reported counts were wrong (10/3 modified/added vs the actual 8/5/0; a
   283-file scan vs the actual 292-file source).

### 4.2 What this round did

- The acceptance document is PRESENT and PRESERVED in the corrected source
  (`docs/reviews/ROUND1_8_1_INDEPENDENT_ACCEPTANCE.md` — verified against
  the Round 1.9 candidate and the manager-shipped Round 1.8.1 tree).
- Counts are published from actual measurement (see
  `CHANGED_FILES_MANIFEST.md` in the delivery root): the Round
  1.9.1 correction scope against the Round 1.9 candidate, and the exact
  staged file count of the corrected tree (295 source files = 292 + 1
  supplied probe suite + 2 new correction suites; the complete staged scan
  covers all of them — see §5).
- All three required diff paths were generated AND apply-verified fresh
  (complete file-set + per-file SHA-256 comparison, including dotfiles and
  manager acceptance documents). See the delivery's `review/diff/` and
  `review/logs/diff-verification.json` for the machine-readable results.

### 4.3 Diff-base provenance — FULL DISCLOSURE (read before trusting)

**The authoritative Git archives (commit object data) of 6e4851c and 48e0f28
are NOT accessible in this environment.** Searched: every shipped handoff
ZIP (no `.git/`, no packs/bundles), the local filesystem (only an unrelated
Phase-2A repository), and the documented remote
(`https://i/ILIV007/pixel-lort.git`) is redacted in all shipped docs and was
never reachable from this sandbox. Per the prompt, this is disclosed rather
than papered over, and NO substitute is asserted to be a Git archive. What
WAS used, with exact provenance:

1. **Correction diff (Round 1.9 candidate → corrected tree).** Base = the
   verified 292-file candidate itself (343/343 checksums; input ZIP SHA
   matches the findings document). No Git base needed. Fully verified
   locally: fresh apply → byte-identical reconstruction of the corrected
   tree.
2. **Incremental diff (6e4851c content → corrected tree).** Base = the
   287-file accepted Round 1.8.1 tree, cross-validated from TWO independent
   artifacts: (a) the manager-shipped tree inside the Round 1.9 authorized
   handoff (verified 387/387 against its own SHA256SUMS), and (b) the
   reverse application of Posidon's verified incremental patch
   (`01-incremental-6e4851ca-to-round1.9.diff`) onto the Round 1.9
   candidate — the patch Posidon proved applies to the REAL Git archive and
   reconstructs the candidate byte-identically (292/292). The two agree
   byte-for-byte (287/287 files). Reverse-applying a forward-verified patch
   is deterministic, so this base content is anchored to the real archive
   through Posidon's own verification — but it is NOT a Git archive and is
   not claimed to be one.
3. **Cumulative diff (48e0f28 content → corrected tree).** Base = 249 files
   (= Posidon's measured `baseFiles: 249`), derived by reverse-applying
   Posidon's cumulative patch (`02-cumulative-48e0f28-to-round1.9.diff`)
   onto the Round 1.9 candidate and REMOVING the one file Posidon proved
   the real archive does not contain
   (`docs/reviews/ROUND1_8_1_INDEPENDENT_ACCEPTANCE.md`). Cross-checked
   against the independent manager-artifact chain (manager-shipped 1.8.1
   tree ← reverse `HISTORICAL-INPUT-01-correction-round1.8-to-round1.8.1.diff`
   ← reverse `HISTORICAL-INPUT-00-cumulative-48e0f28-to-round1.8.diff`):
   byte-identical on ALL 249 shared files. NOTE disclosed: the historical
   chain ALSO carries the acceptance document in its reverse-derived base
   (250 files) — the same compounding packaging artifact Posidon flagged in
   the Round 1.9 cumulative patch; the two chains agree everywhere except
   that document, which the real archive demonstrably lacks (Posidon's
   apply-vs-real-archive result).

**Verification claim, stated exactly:** the correction diff is verified
end-to-end locally. The incremental and cumulative diffs are verified
against the CONTENT anchors above (fresh apply → complete file-set +
per-file SHA-256 equality, including dotfiles and manager acceptance
documents). They have NOT been verified against real `git archive` object
data, because none exists in this environment. Posidon's independent review
should treat archive-level verification of paths 2 and 3 as OPEN until
re-run against the real Git bases (both patches apply cleanly to the
content anchors and reproduce the corrected tree byte-for-byte).

### 4.4 Scope guardrails honored

Default/applied runtime schema stays 3. Migration 0004 remains a candidate
tested only in disposable workerd D1. No observation migration/D02, no
unrelated refactor, no feature expansion, no version bump (check:versions
still passes at app 1.4.0 / schema 3 — the APPLIED runtime, honestly).

---

## §5. Verification results (exact, uncombined)

Environment: disposable local workerd D1 (`@cloudflare/vitest-pool-workers`),
network responses simulated; no Cloudflare account/remote operation; no
provider network calls. Logs in the delivery's `review/logs/` are the EXACT
captured stdout/stderr.

| Gate                                                     | Result                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Input verification                                       | 343/343 checksums OK, exit 0                                                                        |
| Pristine reproduction: full original suite               | 88 files, **1112/1112 PASS**, exit 0                                                                |
| Pristine reproduction: supplied probes                   | **5 FAILED / 2 PASSED** (7), exit 1                                                                 |
| Corrected: supplied probes (UNMODIFIED)                  | **7/7 PASS**, exit 0                                                                                |
| Corrected: full suite (single command, maxWorkers=1)     | 91 files, **1142/1142 PASS**, exit 0 (= 1112 original + 7 supplied probes + 23 new permanent tests) |
| Corrected: `npm run test:db`                             | 22 files, **301/301 PASS**, exit 0 (subset — NOT added to the 1142)                                 |
| Corrected: `npm run lint`                                | exit 0                                                                                              |
| Corrected: `npm run format:check`                        | exit 0                                                                                              |
| Corrected: `npm run typecheck`                           | exit 0                                                                                              |
| Corrected: `npm run check:versions`                      | exit 0 (app 1.4.0 / applied schema 3)                                                               |
| Corrected: `npm run test:telegram-setup`                 | exit 0                                                                                              |
| Corrected: `npm run test:secrets`                        | 10/10, exit 0                                                                                       |
| Corrected: `npm run scan:secrets` (complete staged tree) | **295 files, 0 findings**, exit 0                                                                   |
| Corrected: `npm run build` (dry-run)                     | exit 0                                                                                              |
| Corrected: `npm run build:preview` (dry-run)             | exit 0                                                                                              |

Reproduction paths shipped in the delivery (all freshly verified):
correction diff, incremental diff (6e4851c content), cumulative diff
(48e0f28 content) — see §4.3 for the exact provenance and claim scope.

---

## §6. Changed files (product + tests + docs)

Product code (7 files modified):
`src/adapters/db/schema-health.ts`,
`src/adapters/db/index.ts`,
`src/adapters/db/source-ingest-store.ts`,
`src/application/ingestion/scheduler.ts`,
`src/application/ingestion/poll-handler.ts`,
`src/entrypoints/cron.ts`,
`src/domain/jobs/job-types.ts`.

Tests (3 files added, 1 modified): added
`tests/integration/round191-capability-failclosed.test.ts`,
`tests/integration/round191-foreign-window-identity.test.ts`, and the
UNMODIFIED supplied `tests/integration/posidon-round19-counterexamples.test.ts`;
modified `tests/integration/round19-r09-ownership.test.ts` (R09-P16 only, §3).

Docs (2 files added/modified): added
`docs/reviews/ROUND1_9_1_CORRECTIONS.md` (this file); modified
`docs/reviews/PIXEL_ROUND1_9_R09_OWNERSHIP_IMPLEMENTATION.md` (top amendment
banner only; historical prose preserved verbatim).

The delivery root carries `CHANGED_FILES_MANIFEST.md` with the full
per-file accounting (modified/added/deleted, exact counts).
