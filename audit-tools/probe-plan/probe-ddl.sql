-- PIXEL — PROBE-ONLY latch DDL (R1.10.4.1 — disposable probe databases ONLY).
--
-- ██ PROBE-ONLY — NEVER A PRODUCT MIGRATION ██
--
-- This DDL is part of the R1.10.4.1 probe PLAN
-- (audit/PREVIEW_RESOURCE_PROBE_PLAN.md §6): it is applied ONLY to the
-- DISPOSABLE probe D1 database during future authorized execution rounds,
-- as durable case/run gating for the protected probe endpoint. It is NOT
-- a product migration, is NOT applied to any product or preview database,
-- and does not modify migrations/ (append-only product files stay
-- byte-identical to the accepted baseline f7020564…).
--
-- Semantics (plan §5 "Protected invocation"):
--   * ONE row per registered case, seeded at setup with the case's
--     REGISTERED invocation and statement budgets from
--     audit/PROBE_CASE_SCHEDULE.json.
--   * invocations_used/statements_used increment conservatively BEFORE
--     probe work (own tiny batch), so a failed or replayed request still
--     consumes its slot.
--   * status 'open' -> the case may run; 'closed' -> registered budget
--     consumed (terminal 410); 'aborted' -> hard-stop (terminal 410).
--   * The row with case_id = '__global__' is the kill switch: when its
--     status is 'aborted', EVERY case refuses all further work.

CREATE TABLE IF NOT EXISTS probe_run_state (
  case_id TEXT PRIMARY KEY,
  invocations_registered INTEGER NOT NULL,
  invocations_used INTEGER NOT NULL DEFAULT 0,
  statements_registered INTEGER NOT NULL,
  statements_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed', 'aborted')),
  last_invocation_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);
