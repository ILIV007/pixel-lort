# migrations/ — versioned D1 migration files (schema v2)

This directory holds the executable D1 schema. The authoritative design
reference for the 27 blueprint tables remains the blueprint schema,
preserved verbatim at `docs/blueprint/v1/pixel_schema_v1.sql` — it must
never be edited. Application-level schema changes (e.g. the Phase 2A
telegram_updates lifecycle columns) extend the schema through the append-only
migration list below.

## Files

- `0001_initial_schema.sql` — the full approved Phase 1A schema: 27 blueprint
  tables, 29 indexes, all CHECK/FK/UNIQUE constraints, plus the application
  `schema_metadata` table (ADR-0019). Seeds `schema_version = 1`. NEVER
  edited or reordered.
- `0002_telegram_update_lifecycle.sql` — the Phase 2A second-correction
  lifecycle migration (ADR-0030/0031): adds `telegram_updates.claim_expires_at`
  (the claim lease), `failure_class` (CHECK: `retryable` | `permanent` |
  NULL), `attempt_count` (NOT NULL DEFAULT 0, CHECK >= 0), the
  `idx_tg_updates_lifecycle (status, claim_expires_at)` recovery index, and
  the documented fail-safe backfill of legacy failed rows to
  `failure_class = 'retryable'`. Advances `schema_metadata` to
  `schema_version = 2` with `migration_id = 0002_telegram_update_lifecycle`
  inside the same atomic batch.

## Rules (ADR-0019, AGENTS.md §6)

1. **Append-only.** Applied migration files are never edited or reordered.
   Schema changes append a new file (`0003_*.sql` and newer) whose SQL also
   advances `schema_metadata.schema_version` inside the same atomic unit.
2. **Application metadata vs. Wrangler bookkeeping.** `schema_metadata`
   describes WHAT the running application expects (read by `/health/ready`
   and `/version`); wrangler's `d1_migrations` table records WHICH FILES
   wrangler applied. The two are intentionally separate; neither is read by
   the other.
3. **The test helper is NOT a migration runner.**
   `tests/helpers/migrations.ts` exists only to materialize/upgrade schemas
   inside the vitest/workerd test environment. It is version-aware and
   incremental (applies only pending migrations, validates plans, applies
   each migration as one atomic batch) so that test databases upgrade when a
   migration is appended. Remote/production application is performed
   exclusively by `wrangler d1 migrations` commands.
4. **No remote application without owner approval.** Migration 0002 has NOT
   been applied to any remote D1 database; remote application remains
   explicitly gated (see `db:migrations:*:preview` scripts — documentation
   only until provisioning and approval).

## Commands

```bash
# List migration status against the LOCAL SQLite database (safe, offline).
npm run db:migrations:list

# Apply pending migrations to the LOCAL SQLite database (safe, offline).
npm run db:migrations:apply

# Remote application (Phase 1B+, documentation-only — NEVER run
# from this repository until the owner has provisioned real resources and
# explicitly approved the first remote application):
#   wrangler d1 migrations apply DB --remote
```

`npm run test:db` runs the migration/schema and database-boundary test suites
— including the migration-0002 populated v1→v2 upgrade proofs, idempotency,
and rollback-atomicity suites — on an isolated local D1 instance (no
Cloudflare account or credentials).
