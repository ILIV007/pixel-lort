# Round 1.9 — fixture adaptations ledger (complete, exact hunks)

Rule honored: NO assertion was removed, weakened, skipped, renamed or
rewritten anywhere. The original R09 and R10 acceptance assertions are
byte-unchanged. Every adaptation below is SETUP ONLY and exists because the
R09 ownership capability is a schema-4 feature (migration candidate 0004),
which must be applied to this file's DISPOSABLE test database for the
original acceptance to exercise the REAL product path.

## A. `tests/integration/extended-review.test.ts` (the ONLY existing test file changed)

### A1 — `beforeEach` migration plan (file-wide)

- BEFORE: `await applyMigrations(env.DB);` (default plan 0001–0003).
- AFTER: `await applyMigrations(env.DB, ROUND19_MIGRATION_PLAN);` (0001–0003
  - the 0004 candidate — disposable workerd D1 ONLY) plus an explanatory
    comment. Effect: this file's isolated test database is at schema 4, so the
    original R09 test exercises the REAL owned scheduling path and the R10
    handler test exercises the REAL A1 + ownership-fenced commit. All other
    tests in the file (R03a/b, R04–R08, D01) are behavior-neutral w.r.t. the
    added column/index (verified green unchanged).

### A2 — R10 test fixture rows (SETUP ONLY)

- BEFORE: `source_state.next_poll_at` seeded to `NOW + 120000` (the legacy
  marker+hold reservation shape); no jobs row existed (the legacy commit
  fence needed none).
- AFTER: (1) `next_poll_at` seeded to `NOW` — the payload's scheduledForMs —
  because under ownership the hold is written BY the claim-time acquisition
  (A1) itself, and branch (i) requires the marker to equal the payload
  marker; (2) ONE `INSERT INTO jobs` creating the row the handler context
  references (`id='fixture-job'`, `sources.fetch_poll`, aggregate
  `playstation_blog`, `status='claimed'`, `attempts=1`, canonical payload)
  because the ownership fence requires the claimed job row with the exact
  generation. The scripted 302→200 fetch, the handler invocation, and BOTH
  assertion lines (`networkCalls: 1`, `usage: 1`) are byte-unchanged. The
  Round 1.8 R10 adaptation comment (fetchFn setup) is retained verbatim.

## B. Files deliberately NOT changed (checked, green unchanged)

- `tests/design/round15-*.ts` + the 4 design proof suites (61 accepted
  proofs) — byte-identical.
- `tests/fixtures/proposed-0004-source-poll-ownership.sql` — byte-identical
  (the reviewed design fixture stays the design-lab material).
- `tests/integration/design-characterization.test.ts` — byte-identical; the
  schema-3 R09 characterization stays green and truthful (see the
  implementation report §5 for the before/after contract).
- Every D01/R04/R05/R06/R07/R08/R10 suite (including the 8 frozen Posidon
  evidence tests and the 15 Round 1.8.1 boundary tests) — byte-identical.
- All unit tests, seed-rollback suites, migration suites — byte-identical.

## C. New permanent suite

- `tests/integration/round19-r09-ownership.test.ts` — 17 production-path
  tests (R09-P1…P17), ADDED; not a member of the `test:db` script (the DB
  subset composition is unchanged).
