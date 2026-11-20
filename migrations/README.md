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
  NULL), `attempt_count` (NOT NULL DEFAULT 0, CHECK >= 0 — the claim
  GENERATION / fencing token for update ownership, not merely an audit
  counter: every execution-owning claim outcome carries it and every
  terminal transition is guarded by it; final correction round v1.2.3), the
  `idx_tg_updates_lifecycle (status, claim_expires_at)` recovery index, and
  the documented fail-safe backfill of legacy failed rows to
  `failure_class = 'retryable'`. Advances `schema_metadata` to
  `schema_version = 2` with `migration_id = 0002_telegram_update_lifecycle`
  inside the same atomic batch.
- `0004_source_poll_ownership.sql` — **Round 1.9 PRODUCT CANDIDATE (LOCAL
  ONLY — proposed, NOT applied to any real database)**: the R09 source-poll
  ownership capability (`source_state.poll_owner_job_id` durable
  winner-owned data + the partial unique outstanding-poll index
  `idx_jobs_source_outstanding_poll` + `schema_metadata` 3 → 4). The DDL
  statements are byte-identical to the independently reviewed Round 1.5
  design fixture (`tests/fixtures/proposed-0004-source-poll-ownership.sql`).
  A real database receives it exclusively through `wrangler d1 migrations
apply` with explicit owner approval (NONE requested or executed); in
  tests it reaches disposable workerd D1 databases as step 4 of the LINEAR
  default plan, or through the explicit `ROUND19_MIGRATION_PLAN`
  (tests/helpers/migrations.ts) for suites that exercise the schema-4
  intermediate state. Creating the index REQUIRES the C.3 duplicate
  preflight to be empty first (the migration batch rolls back completely
  otherwise — proven by test); execution on any real database requires
  separate owner approval and the transition/preflight/rollback runbook
  (`docs/reviews/PIXEL_ROUND1_9_MIGRATION_0004_TRANSITION.md`).
- `0005_admin_post_pipeline.sql` — **R1.20-R PRODUCT CANDIDATE (LOCAL ONLY —
  proposed, NOT applied to any real database)**: the admin post pipeline
  (five tables: drafts, versions, preview_sessions, approvals, publications
  - 5 indexes incl. the partial UNIQUE `idx_admin_post_pub_primary`
    admitting ONE primary publication per (draft, version)) +
    `schema_metadata` 4 → 5. R1.20-R1 LINEAR PATH: this candidate stands ON
    TOP of `0004_source_poll_ownership` — real Wrangler applies the files in
    lexical filename order, so a database that walked the whole chain
    reports schema 5 with BOTH capabilities present (the version number and
    the recorded `migration_id` distinguish every state honestly; see
    `resolveSchemaCapability`). The retired non-linear shape (0005 writing
    version 4 over the 0004-less chain) is detectable and documented but no
    longer producible. NO Cloudflare/wrangler migration command has been or
    may be run for it.
- `0007_inbound_pipeline.sql` — **Slice 4 PRODUCT CANDIDATE (LOCAL ONLY —
  proposed, NOT applied to any real database)**: the inbound AI-admin
  pipeline (`published_posts` — the source-message edit anchor + channel
  message ids + media file id + category + presentation — and
  `inbound_approvals` — the 24-hour approval preview with its guarded
  pending/approved/rejected/expired/published state machine) +
  `schema_metadata` 6 → 7. Stands ON TOP of
  `0006_admin_post_editorial_source` in the linear chain. A real database
  receives it exclusively through `wrangler d1 migrations apply` with
  explicit owner approval (NONE requested or executed); in tests it reaches
  disposable workerd D1 databases as step 7 of the LINEAR default plan.
- `0008_live_watchlists.sql` — **Slice 5 PRODUCT CANDIDATE (LOCAL ONLY —
  proposed, NOT applied to any real database)**: the live watchlists
  (`watchlist_entries` — the live core + manual exceptions, staged
  active → cooling → dormant → expired, manual/pinned entries never
  auto-prune — `chart_snapshots` + `chart_snapshot_rows` — the weekly
  Steam Top-100 snapshot, one snapshot per date+source — `watchlist_signals`
  — one signal per mover — `watchlist_aliases` and `watchlist_exclusions`)
  - `schema_metadata` 7 → 8. Stands ON TOP of `0007_inbound_pipeline` in
    the linear chain. A real database receives it exclusively through
    `wrangler d1 migrations apply` with explicit owner approval (NONE
    requested or executed); in tests it reaches disposable workerd D1
    databases as step 8 of the LINEAR default plan.
- `0009_post_management_near_dup.sql` — **Slice 6 PRODUCT CANDIDATE (LOCAL
  ONLY — proposed, NOT applied to any real database)**: the post
  management + near-dup detection (`channel_pins` — the max-one-active-pin
  ledger — `story_merges` — the near-dup adjudication ledger —
  `quality_rejections` — the 30-day negative cache — `channel_post_deletes`
  — the soft-delete ledger) + `schema_metadata` 8 → 9. Stands ON TOP of
  `0008_live_watchlists` in the linear chain. A real database receives it
  exclusively through `wrangler d1 migrations apply` with explicit owner
  approval (NONE requested or executed); in tests it reaches disposable
  workerd D1 databases as step 9 of the LINEAR default plan.
- `0010_soul_versioning.sql` — **Slice 8 PRODUCT CANDIDATE (LOCAL ONLY —
  proposed, NOT applied to any real database)**: the Soul v1 versioning
  (`souls` — one row per Soul version: full text + SHA-256 + creator +
  timestamp, append-only — `published_posts.soul_version` — the Soul
  version each post was published under, NULL for legacy rows) +
  `schema_metadata` 9 → 10. Stands ON TOP of
  `0009_post_management_near_dup` in the linear chain. A real database
  receives it exclusively through `wrangler d1 migrations apply` with
  explicit owner approval (NONE requested or executed); in tests it reaches
  disposable workerd D1 databases as step 10 of the LINEAR default plan.

## Rules (ADR-0019, AGENTS.md §6)

1. **Append-only.** Applied migration files are never edited or reordered.
   Schema changes append a new file (`0003_*.sql` and newer) whose SQL also
   advances `schema_metadata.schema_version` inside the same atomic unit.
   0001–0003 remain the ONLY APPLIED files; `0004_source_poll_ownership.sql`
   (Round 1.9 R09), `0005_admin_post_pipeline.sql` (R1.20-R admin post
   pipeline), `0006_admin_post_editorial_source.sql` (R1.22 editorial→post
   provenance), `0007_inbound_pipeline.sql` (slice 4 inbound pipeline),
   `0008_live_watchlists.sql` (slice 5 live watchlists),
   `0009_post_management_near_dup.sql` (slice 6 post management + near-dup)
   and `0010_soul_versioning.sql` (slice 8 Soul versioning)
   are LOCAL candidates with zero real-database applications.
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
