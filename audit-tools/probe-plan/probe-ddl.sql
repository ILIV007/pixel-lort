-- PIXEL — PROBE-ONLY latch DDL (R1.10.4.2 — disposable probe databases ONLY).
--
-- ██ PROBE-ONLY — NEVER A PRODUCT MIGRATION ██
--
-- This DDL is part of the R1.10.4.2 probe PLAN
-- (audit/PREVIEW_RESOURCE_PROBE_PLAN.md §5): it is applied ONLY to the
-- DISPOSABLE probe D1 database during future authorized execution rounds,
-- as durable case/run gating for the protected probe endpoint. It is NOT
-- a product migration, is NOT applied to any product or preview database,
-- and does not modify migrations/ (append-only product files stay
-- byte-identical to the accepted baseline f7020564…).
--
-- Semantics (plan §5 "Protected invocation and honest reject-path accounting"):
--   * ONE row per registered case, seeded at setup with the case's
--     REGISTERED invocation and statement budgets from
--     audit/PROBE_CASE_SCHEDULE.json.
--   * invocations_used/statements_used increment conservatively BEFORE
--     probe work (own tiny batch), so a failed or replayed request still
--     consumes its slot.
--   * status 'open' -> the case may run; 'closed' -> registered budget
--     consumed (terminal 410); 'aborted' -> hard-stop (terminal 410).
--   * The row with case_id = '__global__' is the kill switch: when its
--     status is 'aborted', EVERY case refuses all further probe work.
--   * R1141-04 accounting honesty: DETECTING any refusal (aborted global
--     row, closed case, exhausted budget) costs exactly ONE submitted
--     UPDATE with ZERO durable changes — that observation attempt is
--     itself a counted D1 attempt, covered by the schedule's RESERVED
--     refusal/emergency overhead (caps.reservedRefusalAndEmergencyOverhead).
--     Behavioral proofs: validator checks V-18 (local) and the reviewer's
--     latch-control (1 submitted UPDATE, 0 changed rows on global abort).

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
