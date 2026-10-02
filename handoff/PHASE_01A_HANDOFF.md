# PIXEL — Phase 1A Handoff: D1 Data Foundation and Version Contract

- **Date:** 2026-10-02 (Asia/Tehran)
- **Branch:** `phase/01a-data-foundation` (clean working tree)
- **Artifact:** `pixel-lort-phase01a-v1.1.0.zip` — the ONLY handoff artifact
  (complete working tree + complete `.git` history; `handoff/PHASE_01A_HANDOFF.md` included).

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

| Commit    | Subject                                       |
| --------- | --------------------------------------------- |
| `5de51f0` | feat: add initial D1 schema migration         |
| `027a61d` | test: validate D1 schema contracts            |
| `b9e9a9a` | feat: add version and schema health contracts |
| (HEAD)    | docs: document Phase 1A data foundation       |

(The exact HEAD hash is reported in the delivery message; `git log` in the ZIP
is authoritative.)

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
or altered.

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
- `tests/integration/db-boundary.test.ts` — typed execution, `first`, `run`
  change counts, atomic batch success AND full-rollback on failure, safe
  error mapping (constraint/schema/query), and the observability contract:
  bind-parameter markers and SQL text never appear in logs; failures log
  stable codes only.
- `tests/integration/version.test.ts` — `/version` contract via SELF (exact
  four fields, types, `no-store`, correlation ID, no timestamps/secrets);
  fail-closed behavior for invalid metadata (direct handler + worker error
  path 503 `config_invalid`); production placeholder guard; `/health/ready`
  not_ready when schema metadata is deleted or version-mismatched.
- `tests/unit/d1-errors.test.ts` — classification table and safe
  serialization of mapped D1 errors (no raw internals).
- `tests/unit/phase1a-config.test.ts` — strict `SCHEMA_VERSION` validation
  (no silent coercion), development defaults, production guard, issues
  without values.

Changed: `tests/integration/http.test.ts` (applies migrations so readiness
exercises the DB-present path).

Totals: **160 tests / 16 files** (Phase 0 baseline: 105 / 11).

## 7. Quality gate (clean environment — actually executed)

```bash
rm -rf node_modules dist .wrangler
npm ci
npm run check
```

Result: **exit 0 — all gates green** (exact numbers in the delivery message):
ESLint clean, Prettier clean, `tsc --noEmit` strict clean, Vitest 160/160 in
16 files, secret-scanner self-test 10/10, secret scan 114 tracked files with
0 findings, `wrangler deploy --dry-run` OK (offline). Local migration
commands verified: `db:migrations:list` and `db:migrations:apply` succeeded
against local SQLite state (59 statements applied).

## 8. Dependencies

**None added.** Zero runtime dependencies remain; the dev dependency set is
unchanged from the accepted Phase 0 state.

## 9. Security review

- No credentials used, requested, or committed. The D1 binding is a LOCAL
  placeholder (nil-UUID `database_id`, `pixel-db-local`); no Cloudflare
  resource exists.
- `/version` exposes exactly four non-secret fields — no environment dump,
  no timestamps — with `cache-control: no-store`; invalid metadata fails
  closed to the standard safe error body.
- Readiness reports only `ready|not_ready` status fields; reasons are logged
  as stable codes only.
- D1 boundary logging (ADR-0022): stable operation names, durations, result
  counts, error codes only. SQL text, bind parameters, and full rows are
  never logged; mapped D1 errors carry author-constant messages with the raw
  value preserved only as internal `cause` (collapsed fail-safe by the
  logger). Tests pin these guarantees with marker strings.
- Configuration issues continue to carry field names and reason codes only;
  the strict `SCHEMA_VERSION` pattern never echoes the offending value.
- All Phase 0 logging/redaction guarantees remain intact and green.

## 10. Open decisions

None new. Phase 1B notes (not decisions yet): real D1 resources per
ADR-0016 naming, replacing the local placeholder binding, the first remote
migration application (owner-approved), and the repository layer with
idempotent writers remain open items for Phase 1B and later phases.

## 11. Confirmations

- **No remote resource was created** (no D1/KV/R2/Queue/Worker resource; the
  binding in wrangler.jsonc is a local declaration only).
- **No remote migration was executed** (local SQLite state only).
- **Nothing was pushed, deployed, or opened as a pull request.**
- **No credential was used** — no GitHub token, no Cloudflare token.
- Quality gates were executed from a clean environment before handoff.

## 12. Boundary

Work stops at the end of Phase 1A. Phase 1B (resource provisioning) and all
later phases have not been started.
