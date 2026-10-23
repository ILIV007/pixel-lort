-- PIXEL — PROBE-ONLY latch seeding (R1.10.4.1). GENERATED from
-- audit/PROBE_CASE_SCHEDULE.json by audit-tools/probe-plan/validate-probe-plan.mjs.
-- Applied ONLY to the disposable probe database at G1 (CLI, literal VALUES,
-- no binds). The __global__ row is the kill switch: status = 'aborted'
-- hard-stops every case.

INSERT INTO probe_run_state
  (case_id, invocations_registered, invocations_used, statements_registered, statements_used, status, last_invocation_at_ms, updated_at_ms)
VALUES
  ('__global__', 0, 0, 0, 0, 'open', NULL, 0),
  ('X-SMOKE', 1, 0, 2, 0, 'open', NULL, 0),
  ('X-SETUP-S3', 1, 0, 3, 0, 'open', NULL, 0),
  ('P-C3', 1, 0, 31, 0, 'open', NULL, 0),
  ('X-SETUP-S4', 1, 0, 5, 0, 'open', NULL, 0),
  ('P-01a', 1, 0, 7, 0, 'open', NULL, 0),
  ('P-01b-r1', 1, 0, 16, 0, 'open', NULL, 0),
  ('P-01b-r2', 1, 0, 27, 0, 'open', NULL, 0),
  ('P-01b-r3', 1, 0, 27, 0, 'open', NULL, 0),
  ('P-02', 1, 0, 32, 0, 'open', NULL, 0),
  ('P-03', 1, 0, 69, 0, 'open', NULL, 0),
  ('P-04', 1, 0, 66, 0, 'open', NULL, 0),
  ('P-05', 1, 0, 32, 0, 'open', NULL, 0),
  ('P-06', 1, 0, 2, 0, 'open', NULL, 0),
  ('P-06b', 1, 0, 5, 0, 'open', NULL, 0),
  ('P-QU-A', 1, 0, 52, 0, 'open', NULL, 0),
  ('P-QU-B', 1, 0, 52, 0, 'open', NULL, 0),
  ('P-07a-1', 1, 0, 17, 0, 'open', NULL, 0),
  ('P-07a-2', 1, 0, 54, 0, 'open', NULL, 0),
  ('P-07a-3', 1, 0, 17, 0, 'open', NULL, 0),
  ('X-VERIFY-FINAL', 1, 0, 5, 0, 'open', NULL, 0);
