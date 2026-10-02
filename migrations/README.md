# migrations/ — versioned D1 migration files (Phase 1A)

This directory holds the executable D1 schema. The authoritative design
reference remains the blueprint schema, preserved verbatim at
`docs/blueprint/v1/pixel_schema_v1.sql` — it must never be edited.

## Files

- `0001_initial_schema.sql` — the full approved Phase 1A schema: 27 blueprint
  tables, 29 indexes, all CHECK/FK/UNIQUE constraints, plus the application
  `schema_metadata` table (ADR-0019). Seeds `schema_version = 1`.

## Rules (ADR-0019, AGENTS.md §6)

1. **Append-only.** Applied migration files are never edited or reordered.
   Schema changes append a new file (`0002_*.sql` and newer) whose SQL also
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
   future migration is appended. Remote/production application is performed
   exclusively by `wrangler d1 migrations` commands.

## Commands

```bash
# List migration status against the LOCAL SQLite database (safe, offline).
npm run db:migrations:list

# Apply pending migrations to the LOCAL SQLite database (safe, offline).
npm run db:migrations:apply

# Remote application (Phase 1B+, documentation-only in Phase 1A — NEVER run
# from this repository until the owner has provisioned real resources and
# explicitly approved the first remote application):
#   wrangler d1 migrations apply DB --remote
```

`npm run test:db` runs the migration/schema and database-boundary test suites
on an isolated local D1 instance (no Cloudflare account or credentials).
