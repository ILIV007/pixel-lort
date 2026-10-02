# PIXEL — Phase 1A Handoff: D1 Data Foundation and Version Contract

- **Date:** 2026-10-02 (Asia/Tehran)
- **Branch:** `phase/01a-data-foundation` (clean working tree)
- **Artifact:** `pixel-lort-phase01a-v1.1.1.zip` — the ONLY handoff artifact
  (complete working tree + complete `.git` history; `handoff/PHASE_01A_HANDOFF.md` included).
- **Revision:** supersedes the v1.1.0 artifact — includes the Phase 1A review
  correction commit (see §13). The four original Phase 1A commits were NOT
  rewritten.

## 1. Summary

Phase 1A delivers the offline, testable D1 data foundation and the approved
`/version` contract, preparing the repository for Cloudflare resource
provisioning performed separately by the project owner in Phase 1B:

1. Versioned D1 migration of the authoritative blueprint schema.
2. Durable application schema metadata (version / migration id / applied-at),
   clearly distinct from Wrangler's migration bookkeeping.
3. Migration and database-boundary tests on the Cloudflare vitest/workerd D1
   test environment (isolated local D1, no account, no credentials).
4. The smallest useful typed D1 access boundary (no repositories, no ORM).
5. `GET /version` with safe build/schema metadata and fail-closed validation.
6. `/health/ready` Phase 1A extension for metadata and schema health.
7. Documented local migration commands; remote commands documentation-only.

No business behavior (Story, Publication, Source, AI services) was
implemented. Phase 1B was not started.

## 2. Starting point

- Authoritative main commit: `fe0c20fec8ee2e103761596d35f420b4005393d8`
  (verified: `origin/main` was exactly at this commit before branching).
- New branch created directly from `origin/main`; the Phase 0 branch and all
  prior history were not touched.

## 3. Final branch and commit hashes

Branch `phase/01a-data-foundation`, conventional commits in order:

| Commit    | Subject                                              |
| --------- | ---------------------------------------------------- |
| `5de51f0` | feat: add initial D1 schema migration                |
| `027a61d` | test: validate D1 schema contracts                   |
| `b9e9a9a` | feat: add version and schema health contracts        |
| `322d162` | docs: document Phase 1A data foundation              |
| (HEAD)    | fix: harden phase 1a migration and version contracts |

(The exact correction HEAD hash is reported in the delivery message and in
`git log` inside the ZIP — `git log` in the ZIP is authoritative.)

## 4. Migration and schema counts

- Migration files: **1** — `migrations/0001_initial_schema.sql` (append-only).
- Tables created: **28** = the **27 approved blueprint tables** + the
  application `schema_metadata` table (ADR-0019).
- Indexes created: **29** named approved indexes (`idx_*`); SQLite auto-indexes
  from UNIQUE constraints are internal.
- Schema version: **1** (approved Phase 1A value; seeded in `schema_metadata`
  together with `migration_id = 0001_initial_schema` and `applied_at`).
- Blueprint SQL (`docs/blueprint/v1/pixel_schema_v1.sql`) preserved verbatim —
  the blueprint remains the immutable design reference; the migration is the
  executable schema.

## 5. Schema deviations from the blueprint (ADR-0019)

1. `PRAGMA foreign_keys = ON;` is NOT ported into the migration: it is a
   client-session directive, not schema content; D1 enforces foreign keys by
   default. Enforcement is proven behaviorally by tests (FK-violating inserts
   rejected, `PRAGMA foreign_key_check` clean, `ON DELETE CASCADE` verified).
2. The `schema_metadata` table (application metadata) is ADDED beyond the 27
   approved tables. It is required by the Phase 1A schema-metadata
   requirement and is not a product field.

No entity was renamed; no approved field, constraint, or index was removed
or altered. **No real `0002_*` migration exists** — the synthetic version-2
descriptor used by tests lives in `tests/fixtures/` only.

## 6. Tests added / changed

New:

- `tests/integration/d1-schema.test.ts` — applies all migrations atomically
  (isolated D1 per storage scope); pins the exact 28-table and 29-index sets;
  verifies metadata rows; `PRAGMA foreign_key_check`; FK violations rejected;
  `ON DELETE CASCADE`; duplicate idempotency-sensitive records rejected
  (`jobs.idempotency_key`, `publications.idempotency_key`,
  `source_items(source_id, external_id)`, `entities(type, slug)`);
  CHECK violations rejected; representative insert/read/update flow across
  the FK graph; migration helper statement-split sanity.
- `tests/integration/db-boundary.test.ts` — typed execution, `first`,
  destructure-safe `first` (closure contract), run change counts, atomic
  batch success AND full-rollback on failure, EMPTY-batch no-op (resolves to
  `[]` without calling D1), safe error mapping (constraint/schema/query),
  and the observability contract: bind-parameter markers and SQL text never
  appear in logs; failures log stable codes only.
- `tests/integration/version.test.ts` — `/version` contract via SELF (exact
  four fields, types, `no-store`, correlation ID, no timestamps/secrets);
  fail-closed behavior for invalid metadata (direct handler + worker error
  path 503 `config_invalid`); production AND preview placeholder guards;
  uncontrolled commit-string rejection; `/health/ready` not_ready when
  schema metadata is deleted or version-mismatched.
- `tests/integration/migration-plan.test.ts` — future-safe migration-plan
  contracts (review item 2): plan validation (empty/duplicate/non-ascending/
  invalid-version/gapped plans rejected with stable codes, real MIGRATIONS
  list guarded) and the incremental upgrade path — version 1 on empty DB,
  synthetic version 2 on a version-1 DB, version 1 not reapplied,
  re-run at latest version a no-op, metadata advancing to version 2.
- `tests/integration/migration-plan-failures.test.ts` — failure atomicity
  and no-alteration proofs: a failed pending migration rolls back atomically
  (no partial state, previous version intact, recovery possible) and invalid
  plans fail BEFORE altering the database.
- `tests/unit/d1-errors.test.ts` — classification table and safe
  serialization of mapped D1 errors (no raw internals).
- `tests/unit/phase1a-config.test.ts` — strict `SCHEMA_VERSION` validation
  (no silent coercion), development defaults, APP_COMMIT trust rules across
  development/preview/production (placeholder rejected outside development;
  hexadecimal Git commit ID 7–64 enforced; boundary cases; issues without
  values).

Changed: `tests/integration/http.test.ts` (applies migrations so readiness
exercises the DB-present path); `tests/unit/config.test.ts` and
`tests/helpers/test-env.ts` (version 1.1.0 alignment).

Totals: **193 tests / 18 files**, of which the migration-plan suites
contribute **16 tests / 2 files** (Phase 0 baseline: 105 / 11).

## 7. Quality gate (clean environment — actually executed)

```bash
rm -rf node_modules dist .wrangler
npm ci
npm run check
```

Result: **exit 0 — all gates green** (exact numbers in the delivery message):
ESLint clean, Prettier clean, `tsc --noEmit` strict clean, Vitest 193/193 in
18 files, secret-scanner self-test 10/10, secret scan 117 tracked files with
0 findings, `wrangler deploy --dry-run` OK (offline). The D1-specific suites
were additionally run explicitly via `npm run test:db` (24/24 in 2 files).
Local migration commands verified: `db:migrations:list` and
`db:migrations:apply` succeeded against local SQLite state.

## 8. Dependencies

**None added.** Zero runtime dependencies remain; the dev dependency set is
unchanged from the accepted Phase 0 state.

## 9. Security review

- No credentials used, requested, or committed. The D1 binding is a LOCAL
  placeholder (nil-UUID `database_id`, `pixel-db-local`); no Cloudflare
  resource exists.
- `/version` exposes exactly four non-secret fields — no environment dump,
  no timestamps — with `cache-control: no-store`; invalid metadata fails
  closed to the standard safe error body. Commit identifiers outside
  development are constrained to the safe hexadecimal 7–64 format
  (ADR-0020), so `/version` can never expose an arbitrary uncontrolled
  string; preview and production reject the `local-dev` placeholder.
- Readiness reports only `ready|not_ready` status fields; reasons are logged
  as stable codes only.
- D1 boundary logging (ADR-0022): stable operation names, durations, result
  counts, error codes only. SQL text, bind parameters, and full rows are
  never logged; mapped D1 errors carry author-constant messages with the raw
  value preserved only as internal `cause` (collapsed fail-safe by the
  logger). Tests pin these guarantees with marker strings.
- Migration-plan errors (test infrastructure) carry stable codes and
  index/version numbers only — never SQL content; a corrupt
  `schema_metadata.schema_version` fails loud instead of being guessed.
- Configuration issues continue to carry field names and reason codes only;
  the strict `SCHEMA_VERSION` pattern never echoes the offending value.
- All Phase 0 logging/redaction guarantees remain intact and green.

## 10. Open decisions

None new. Phase 1B notes (not decisions yet): real D1 resources per
ADR-0016 naming, replacing the local placeholder binding, the first remote
migration application (owner-approved), and the repository layer with
idempotent writers remain open items for Phase 1B and later phases.

Tooling maintenance (non-blocking, recorded in docs/ROADMAP.md): evaluate
the supported ESLint major in a dedicated tooling-maintenance slice — the
currently pinned ESLint 9.x release prints an end-of-support warning during
`npm ci`. No unplanned breaking ESLint upgrade was performed in this
correction.

## 11. Confirmations

- **No remote resource was created** (no D1/KV/R2/Queue/Worker resource; the
  binding in wrangler.jsonc is a local declaration only).
- **No remote migration was executed** (local SQLite state only).
- **Nothing was pushed, deployed, or opened as a pull request.**
- **No credential was used** — no GitHub token, no Cloudflare token.
- Quality gates were executed from a clean environment before handoff.

## 12. Boundary

Work stops at the end of the Phase 1A correction. Phase 1B (resource
provisioning) and all later phases have not been started.

## 13. Phase 1A review corrections (this revision)

Alexios reviewed the original v1.1.0 Phase 1A repository (independent
validation passed: clean `npm ci`, lint/format, strict typecheck, 160/160
tests, scanner self-test 10/10, 114 tracked files 0 secret findings,
Wrangler dry-run, blueprint-vs-migration comparison: 27 tables + 29 indexes
preserved exactly, one documented `schema_metadata` table added) and issued
VERDICT: CHANGES REQUIRED. One focused correction commit
(`fix: harden phase 1a migration and version contracts`) addresses all
items; the four existing Phase 1A commits were not rewritten.

1. **Release/version metadata aligned to the approved `1.1.0`.**
   `package.json` and `package-lock.json` (via `npm install
--package-lock-only`), `wrangler.jsonc` APP_VERSION, the Phase 0
   configuration default (`DEFAULT_APP_VERSION`), tests
   (`config.test.ts`, `version.test.ts`, `test-env.ts`), `.env.example`,
   `.dev.vars.example`, ADR-0020 examples, and this handoff now all report
   `1.1.0`. `GET /version` in the local Phase 1A environment reports
   `"applicationVersion": "1.1.0"`.

2. **Future-safe (incremental) test migration helper.**
   `tests/helpers/migrations.ts` no longer stops at any existing metadata
   row. Every `MigrationDescriptor` carries its target schema version; the
   observed application version is read safely (missing table/row → 0;
   corrupt value → fail loud); only migrations with a version GREATER than
   the observed version are applied, in strict ascending order; re-running
   at the latest version is a no-op; `validateMigrationPlan` rejects empty
   plans, duplicate versions, non-ascending versions, non-positive
   versions, and version gaps BEFORE any database access; each pending
   migration is one atomic D1 batch (failed migration rolls back
   completely). `MIGRATIONS` stays append-only and ordered; NO real
   production `0002` migration was created; tests inject a synthetic plan
   (`tests/fixtures/migration-0002-synthetic.sql`, TEST-ONLY). All seven
   required proofs are pinned (see §6). Documented as test infrastructure
   only — Wrangler remains responsible for remote migration bookkeeping
   (ADR-0019 §6, migrations/README.md).

3. **Closure-based `DbExecutor`.** `first()` no longer calls
   `this.query(...)`; all operations are closures over the D1 binding, so
   destructuring any method (`const { first } = executor`) preserves
   behavior — proven by a dedicated test. Safe logging and error mapping
   unchanged. EMPTY batches are now a documented safe no-op: `batch([])`
   resolves to `[]` without calling D1 and without throwing — proven by a
   test that uses a D1 stub which fails the test if `prepare`/`batch` were
   touched.

4. **APP_COMMIT trustworthiness across environments.** `development` may use
   `local-dev`; `preview` and `production` reject `local-dev`
   (`invalid_value`) and require the actual source commit matching a safe
   hexadecimal Git commit-identifier format of 7–64 characters
   (`GIT_COMMIT_ID_PATTERN = /^[0-9a-f]{7,64}$/i`, `invalid_format`
   otherwise); the same format is enforced for every explicit
   non-placeholder value in ALL environments so `/version` can never expose
   an arbitrary uncontrolled string. Tests cover development, preview, and
   production (including placeholder, format, and length-boundary cases);
   no real GitHub token or live repository is required — Phase 1B injects
   the real commit identifier.

5. **Non-blocking maintenance note recorded.** The ESLint 9.x
   end-of-support warning is documented as a tooling-maintenance backlog
   item (docs/ROADMAP.md §Tooling maintenance backlog, §10 above); no
   unplanned breaking ESLint major upgrade was performed.

**Verification (actually executed from a clean environment):**
`rm -rf node_modules dist .wrangler && npm ci && npm run check` → exit 0
(193/193 tests in 18 files; 16 migration-plan tests in 2 files; scanner
self-test 10/10; 117 tracked files scanned, 0 findings; wrangler dry-run
OK) plus explicit `npm run test:db` → 24/24. Exact figures, the correction
commit hash, and the `git diff --stat 322d162..HEAD` summary are reported in
the delivery message.
