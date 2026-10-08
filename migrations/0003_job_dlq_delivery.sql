-- PIXEL — D1 migration 0003: jobs DLQ-delivery reconciliation (Phase 3,
-- ADR-0036).
--
-- Adds the ONE field the Phase 3 job engine genuinely needs beyond the
-- existing `jobs` lifecycle columns (migration 0001): DLQ-delivery tracking.
--
--   - dlq_delivered_at — epoch milliseconds when the bounded, SAFE DLQ
--                        reference (jobId/type/attempts/errorCode/failedAtMs —
--                        never payload, provider text, or credentials) was
--                        CONFIRMED enqueued to the DLQ queue for this job.
--                        NULL = not yet delivered; the bounded reconciliation
--                        scan (`status='dead_letter' AND dlq_delivered_at IS
--                        NULL`) re-sends until confirmed. A crash BETWEEN the
--                        send and the mark produces one duplicate DLQ
--                        reference later (at-least-once, safe by design) —
--                        the DLQ record is never silently lost (ADR-0036).
--
-- Index idx_jobs_dlq_pending(status, dlq_delivered_at) serves the
-- reconciliation scan: dead_letter rows are located through the status seek
-- and the NULL predicate matches the index (SQLite indexes NULLs), so the
-- scan is bounded and indexed — never a full-table scan. The dispatch scan
-- (due pending/retry_wait rows) keeps using idx_jobs_due; the
-- claimed/queued populations are bounded by the claim lease and dispatch
-- grace mechanics respectively, so no further lifecycle index is required
-- (ADR-0036 §6).
--
-- Applied migrations are append-only: 0001 and 0002 are NEVER modified
-- (AGENTS.md §6). This migration advances the APPLICATION schema metadata
-- (schema_metadata — ADR-0019) to version 3 inside the same atomic batch;
-- Wrangler's own `d1_migrations` bookkeeping is untouched by application
-- code. Remote application is performed exclusively by
-- `wrangler d1 migrations apply` with explicit owner approval.

ALTER TABLE jobs ADD COLUMN dlq_delivered_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_jobs_dlq_pending
  ON jobs(status, dlq_delivered_at);

UPDATE schema_metadata
   SET value = '3',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0003_job_dlq_delivery',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
