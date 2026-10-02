# migrations/ — planned (not implemented in Phase 0)

D1 migration files will be introduced in roadmap phase 1 ("repository, CI,
bindings and migrations"). The authoritative source schema is preserved
verbatim at `docs/blueprint/v1/pixel_schema_v1.sql` and must not be edited.

When the database phase starts:

1. Split/copy the blueprint schema into ordered, append-only migration files
   in this directory (e.g. `0001_init.sql`).
2. Apply them with `wrangler d1 migrations apply` against local/remote D1.
3. Never modify an applied migration; add a new one instead.
