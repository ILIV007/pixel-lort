-- PIXEL — D1 migration 0004 (Round 1.9 PRODUCT CANDIDATE — LOCAL ONLY).
--
-- ██ PROPOSED — APPLIED ONLY TO DISPOSABLE TEST DATABASES ██
--
-- Authorization status (Round 1.9, Zeus-approved LOCAL scope): this file is
-- the product migration CANDIDATE for the R09 source-poll ownership
-- implementation. It is applied ONLY to disposable workerd D1 test
-- databases through the explicit test-only plan
-- (`tests/helpers/migrations.ts` → `ROUND19_MIGRATION_PLAN`). It is NOT
-- applied to any real database, NOT deployed, NOT activated, and no
-- Cloudflare/wrangler migration command has been or may be run by GLM.
-- The accepted runtime at the Round 1.9 handoff remains app1.4.0 / APPLIED
-- schema 3 (migrations 0001–0003 are the ONLY applied files and are never
-- edited — append-only policy, AGENTS.md §6). Execution on any real
-- database requires separate owner approval AND the C.3 duplicate
-- preflight to be EMPTY first — see
-- docs/reviews/PIXEL_ROUND1_9_MIGRATION_0004_TRANSITION.md (§Preflight,
-- §Rollback) and the capability/readiness matrix in
-- docs/reviews/PIXEL_ROUND1_9_R09_OWNERSHIP_IMPLEMENTATION.md.
--
-- Provenance: the three DDL statements below are byte-identical to the
-- independently reviewed Round 1.5 design fixture
-- `tests/fixtures/proposed-0004-source-poll-ownership.sql` (design authority:
-- docs/reviews/PIXEL_ROUND1_5_1_OWNERSHIP_PAUSE_DESIGN.md §1/§2; proofs
-- P-O1…P-O19, P-R1…P-R7, P-M1…P-M5 on real workerd D1). Only this header
-- comment differs; the executable statements are the reviewed verbatim DDL.
--
-- Purpose (closes the R09 family and A.3/A.4 on the REAL product path):
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
--       outstanding duplicates the CREATE fails (proven by the design lab,
--       P-M1/P-M2).
--   (3) schema_metadata 3 → 4. Per C.1 the readiness contract is
--       EXACT-EQUALITY per configured expectation (the health check is
--       untouched and never accepts arbitrary versions); ownership
--       features are resolved by feature-detecting the APPLIED version via
--       schema_metadata at resolution time — ownership OFF under schema 3,
--       ON under schema 4 (capability matrix in the implementation report).
--
-- Migration discipline (C.1/C.2, honored): ONE immutable file serving ONE
-- capability (ownership); applied ONCE, whole, as a single atomic batch
-- (an applied migration file is never executed as halves). Roll-forward
-- only; rollback = previous bundle + D1 point-in-time restore to the
-- pre-migration Time Travel bookmark (runbook step; see the transition
-- document). Rollback is an owner operation — never an automated one.

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
