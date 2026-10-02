# tests/fixtures/ — reserved

This directory will hold contract-test fixtures in later phases:

- saved source payloads per connector (RSS, Steam, YouTube, Reddit, GitHub…)
- Golden editorial cases G01–G50 (blueprint persona document §14)
- malformed/hostile inputs for security tests (SSRF, XML entities, prompt
  injection, oversized content)

Currently it holds `migration-0002-synthetic.sql`: a TEST-ONLY synthetic
version-2 migration descriptor used by `tests/integration/migration-plan.test.ts`
to prove the future-safe incremental behavior of the test migration helper.
It is NEVER shipped as a real `migrations/` file and never applied outside
injected test plans.

Fixtures must contain NO real credentials and NO token-shaped values. Tests
never perform live network calls; connectors are tested against these saved
fixtures only.
