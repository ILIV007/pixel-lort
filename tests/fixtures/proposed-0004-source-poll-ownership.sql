-- PIXEL — D1 migration 0004 (PROPOSED — Round 1.5 design artifact).
--
-- ██ PROPOSED, NOT AUTHORIZED ██ This file is DESIGN MATERIAL delivered for
-- independent review. It is NOT part of the applied production migration set
-- (migrations 0001–0003 remain the ONLY applied files; application schema
-- metadata stays at version 3 in any real deployment). No wrangler command,
-- test helper default, or product code path references this file; the ONLY
-- consumer is the Round 1.5 disposable design lab, which applies it to a
-- DISPOSABLE workerd D1 database via an explicit synthetic migration plan
-- (tests/design/round15-ownership.ts, LAB_MIGRATION_PLAN). Execution on any
-- real database remains UNAUTHORIZED (owner approval required; C.3 preflight
-- must pass first — see review/design/PIXEL_ROUND1_5_OWNERSHIP_PAUSE_DESIGN.md
-- §7).
--
-- Purpose (Round 1.5 design — closes the R09 family and A.3/A.4):
--   (1) source_state.poll_owner_job_id — DURABLE WINNER-OWNED DATA. The
--       poll hold is anchored in the SAME row that names the ONE job that
--       owns the window. The current-time hold (next_poll_at = now + hold)
--       and the owner become visible atomically; every owner-dependent
--       mutation fences on BOTH. NULL = unowned.
--   (2) idx_jobs_source_outstanding_poll — PARTIAL UNIQUE INDEX: at most
--       ONE non-terminal `sources.fetch_poll` job per source aggregate.
--       Prevents duplicate outstanding windows (the R09 family race:
--       crash-after-commit re-drive creating a second window while the
--       first job is still non-terminal). C.3: creating this index REQUIRES
--       the duplicate preflight to be empty first — on a database with
--       outstanding duplicates the CREATE fails (proven by the design lab).
--   (3) schema_metadata 3 → 4. Per C.1 the readiness contract is
--       EXACT-EQUALITY per deployed bundle: an application bundle built for
--       schema 3 is NOT healthy on a schema 4 database for ownership
--       features. The capability matrix in the design document defines the
--       accepted-versions contract per feature set.
--
-- Append-only policy (AGENTS.md §6): 0001–0003 are never edited or
-- reordered; this file, if ever authorized, is applied ONCE, whole, as a
-- single atomic batch (C.2: an applied migration file is never executed as
-- halves). Roll-forward only; rollback = previous bundle + D1 point-in-time
-- restore to the pre-migration Time Travel bookmark (runbook step).

ALTER TABLE source_state ADD COLUMN poll_owner_job_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_outstanding_poll
  ON jobs(aggregate_id)
 WHERE type = 'sources.fetch_poll'
   AND aggregate_type = 'source'
   AND aggregate_id IS NOT NULL
   AND status IN ('pending', 'queued', 'claimed', 'retry_wait');

UPDATE schema_metadata
   SET value = '4',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0004_source_poll_ownership',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
