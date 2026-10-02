# tests/fixtures/ — reserved

This directory will hold contract-test fixtures in later phases:

- saved source payloads per connector (RSS, Steam, YouTube, Reddit, GitHub…)
- Golden editorial cases G01–G50 (blueprint persona document §14)
- malformed/hostile inputs for security tests (SSRF, XML entities, prompt
  injection, oversized content)

Fixtures must contain NO real credentials and NO token-shaped values. Tests
never perform live network calls; connectors are tested against these saved
fixtures only.
