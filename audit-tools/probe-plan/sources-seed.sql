-- PIXEL — PROBE-ONLY sources seeding (R1.10.4.1). GENERATED from
-- audit/PROBE_CASE_SCHEDULE.json by audit-tools/probe-plan/validate-probe-plan.mjs.
-- Applied ONLY to the disposable probe database at G1 (CLI, literal VALUES,
-- no binds). One sources row per probe case that needs one; sources is
-- unchanged by migration 0004 (S3-compatible).

INSERT INTO sources
  (id, name, connector, lane, trust_tier, interval_seconds, priority, daily_request_budget, approval_policy, created_at, updated_at)
VALUES
  ('probe-p-c3', 'probe probe-p-c3', 'probe', 'official', 50, 60, 50, 100, 'auto', 4102444800000, 4102444800000),
  ('probe-p-01a', 'probe probe-p-01a', 'probe', 'official', 50, 60, 50, 100, 'auto', 4102444800000, 4102444800000),
  ('probe-p-01b', 'probe probe-p-01b', 'probe', 'official', 50, 60, 50, 100, 'auto', 4102444800000, 4102444800000),
  ('probe-p-02', 'probe probe-p-02', 'probe', 'official', 50, 60, 50, 100, 'auto', 4102444800000, 4102444800000),
  ('probe-p-03', 'probe probe-p-03', 'probe', 'official', 50, 60, 50, 100, 'auto', 4102444800000, 4102444800000),
  ('probe-p-04', 'probe probe-p-04', 'probe', 'official', 50, 60, 50, 100, 'auto', 4102444800000, 4102444800000),
  ('probe-p-05', 'probe probe-p-05', 'probe', 'official', 50, 60, 50, 100, 'auto', 4102444800000, 4102444800000),
  ('probe-p-06b', 'probe probe-p-06b', 'probe', 'official', 50, 60, 50, 100, 'auto', 4102444800000, 4102444800000),
  ('probe-p-07a-1', 'probe probe-p-07a-1', 'probe', 'official', 50, 60, 50, 100, 'auto', 4102444800000, 4102444800000),
  ('probe-p-07a-2', 'probe probe-p-07a-2', 'probe', 'official', 50, 60, 50, 100, 'auto', 4102444800000, 4102444800000),
  ('probe-p-07a-3', 'probe probe-p-07a-3', 'probe', 'official', 50, 60, 50, 100, 'auto', 4102444800000, 4102444800000);
