-- PIXEL — D1 migration 0002: telegram_updates lifecycle (Phase 2A second
-- correction round, v1.2.2 — ADR-0030/0031).
--
-- Adds the minimum lifecycle fields the durable Telegram update state machine
-- needs to RECOVER abandoned claims:
--   - claim_expires_at   — the claim lease deadline. Every `claimed` row now
--                          carries a lease (now + TELEGRAM_UPDATE_CLAIM_LEASE_MS,
--                          5 minutes, centralized in
--                          src/adapters/telegram/update-claims.ts). A claimed
--                          row whose lease has expired is stale and is
--                          atomically reclaimable by the next delivery
--                          (exactly one winner) — a Worker that dies after
--                          claiming but before completing can no longer strand
--                          the update forever.
--   - failure_class      — persists the retryable/permanent classification
--                          (ADR-0031): `retryable` failed rows remain
--                          reclaimable through Telegram redelivery;
--                          `permanent` failed rows are TERMINAL and are never
--                          re-executed (every later delivery observes
--                          permanently_failed and answers 200 without
--                          executing the action again).
--   - attempt_count      — the number of durable claim attempts for this
--                          update (1 on the first claim, incremented on every
--                          reclaim). Observability + audit anchor; >= 0.
--
-- Index idx_tg_updates_lifecycle(status, claim_expires_at) serves lifecycle
-- recovery: lease-expiry scans (abandoned-claim audits and future operator
-- tooling) select claimed rows whose lease has expired and failed rows that
-- remain reclaimable. Without it every such scan is a full-table scan; the
-- per-update_id hot path keeps using the primary key.
--
-- LEGACY BACKFILL (honest, fail-safe — ADR-0031): rows written before this
-- migration carry no failure_class. Under the pre-0002 semantics a `failed`
-- row could be either a retryable or a permanent failure, and the old
-- reclaim path treated every failed row as reclaimable. The fail-safe
-- principle of ADR-0027 (a wrong retryable guess is bounded — durable claims
-- prevent double processing — while a wrong permanent guess permanently
-- loses the update) therefore backfills every legacy failed row as
-- `retryable`: no existing row can become unrecoverable, and the bounded
-- worst case is one extra redelivery attempt of a permanent failure.
--
-- Applied migrations are append-only: 0001 is NEVER modified (AGENTS.md §6).
-- This migration advances the APPLICATION schema metadata (schema_metadata —
-- ADR-0019) to version 2 inside the same atomic batch; Wrangler's own
-- `d1_migrations` bookkeeping is untouched by application code. Remote
-- application is performed exclusively by `wrangler d1 migrations apply`
-- with explicit owner approval (NOT part of this correction).

ALTER TABLE telegram_updates ADD COLUMN claim_expires_at INTEGER;
ALTER TABLE telegram_updates ADD COLUMN failure_class TEXT CHECK (failure_class IS NULL OR failure_class IN ('retryable','permanent'));
ALTER TABLE telegram_updates ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

CREATE INDEX IF NOT EXISTS idx_tg_updates_lifecycle
  ON telegram_updates(status, claim_expires_at);

UPDATE telegram_updates
   SET failure_class = 'retryable'
 WHERE status = 'failed'
   AND failure_class IS NULL;

UPDATE schema_metadata
   SET value = '2',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'schema_version';

UPDATE schema_metadata
   SET value = '0002_telegram_update_lifecycle',
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'migration_id';

UPDATE schema_metadata
   SET value = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at_ms = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE key = 'applied_at';
