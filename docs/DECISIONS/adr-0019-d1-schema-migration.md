# ADR-0019: D1 schema migration 0001 and application schema metadata

- **Status:** Accepted
- **Date:** 2026-10-02 (Phase 1A)
- **Decides:** how the blueprint schema becomes executable D1 migrations, and
  how the application tracks its own schema version.

## Context

Phase 1A turns the authoritative blueprint schema
(`docs/blueprint/v1/pixel_schema_v1.sql`) into a versioned D1 migration. The
blueprint remains the immutable design reference; the migration file becomes
the executable schema. No Cloudflare resource exists or is created in
Phase 1A — provisioning happens separately in Phase 1B (names per ADR-0016).

## Decision

1. **Verbatim port.** `migrations/0001_initial_schema.sql` contains all
   **27 approved tables**, all **29 approved indexes**, and every CHECK
   constraint, foreign key, and uniqueness rule of the blueprint, unchanged.
   No entity is renamed; no speculative field is added or removed. The only
   content beyond the blueprint is the application metadata table below.
2. **`PRAGMA foreign_keys = ON` is not ported.** It is a client-session
   directive, not schema content. D1 (workerd) enforces foreign keys by
   default. Migration tests prove enforcement behaviorally (rejected
   FK-violating inserts, `PRAGMA foreign_key_check` returns no violations,
   `ON DELETE CASCADE` behavior).
3. **Application schema metadata** lives in a dedicated `schema_metadata`
   table (key/value/updated_at_ms) seeded by the migration with:
   `schema_version` = `1` (the approved Phase 1A schema version),
   `migration_id` = `0001_initial_schema`, and `applied_at`.
   This is **distinct from Wrangler's migration bookkeeping** (the
   `d1_migrations` table managed exclusively by `wrangler d1 migrations`
   commands): wrangler records WHICH FILES it applied; `schema_metadata`
   describes WHAT the running application can expect from the schema. The
   runtime schema-health check reads only `schema_metadata`.
4. **Local placeholder binding.** wrangler.jsonc declares a
   `d1_databases` entry (`binding: DB`, `database_name: pixel-db-local`,
   `database_id` = nil-UUID placeholder, `migrations_dir: migrations`) so
   local commands (`wrangler d1 migrations list/apply DB --local`) and the
   vitest/workerd D1 test environment work offline. This is a declaration
   only — **no Cloudflare resource is created**, and remote migration
   commands remain documentation-only until Phase 1B provisioning.
5. **Append-only migrations.** Applied migration files are never edited or
   reordered (AGENTS.md §6); future changes append `0002_*.sql` and newer.

## Consequences

- Schema contracts are test-enforceable offline (see
  `tests/integration/d1-schema.test.ts`).
- `/health/ready` can verify that the deployed schema matches the configured
  `SCHEMA_VERSION` whenever a D1 binding is present (ADR-0021).
- The typed WorkerEnv marks `DB` optional: bare runtimes and unit tests
  without D1 boot in offline mode; Phase 1B will tighten this per phase.

## Alternatives considered

- *Embedding the schema in TypeScript constants* — rejected: duplicates the
  blueprint and invites drift; the migration file must stay the single
  executable source.
- *Adopting an ORM/query builder* — rejected by the phase packet: D1 access
  stays a thin typed boundary in Phase 1A.
- *Relying on wrangler's `d1_migrations` table as application metadata* —
  rejected: it is tooling bookkeeping (file names), not an application
  contract; coupling readiness to it would break the separation between
  design-time tooling and runtime schema expectations.
