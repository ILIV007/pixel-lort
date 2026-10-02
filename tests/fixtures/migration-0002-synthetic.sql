-- TEST-ONLY synthetic migration — NEVER ship this as a real migration file.
--
-- This fixture exists to prove the FUTURE-SAFE behavior of the test migration
-- helper (tests/helpers/migrations.ts): a version-2 descriptor applied on top
-- of a version-1 database advances the application schema metadata
-- incrementally. It mirrors the convention every real future migration must
-- follow: the migration itself advances `schema_metadata` inside the same
-- atomic batch, keeping application metadata distinct from wrangler's
-- `d1_migrations` bookkeeping (ADR-0019).

CREATE TABLE migration_v2_probe (
  id TEXT PRIMARY KEY,
  note TEXT NOT NULL
);

INSERT INTO migration_v2_probe (id, note) VALUES ('probe', 'applied by synthetic version 2');

UPDATE schema_metadata
   SET value = '2',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = 'test_0002_synthetic',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';
