# ADR-0033 — Live-compatible Telegram redirect rejection

Status: Accepted for owner-authorized Preview live wiring.

## Evidence

During server-side bootstrap with the existing Cloudflare Secret binding,
`redirect: error` failed at the live fetch stage with a sanitized TypeError,
before any Telegram HTTP status was observable. Offline mocked requests had
not exercised that path. Using `redirect: manual` with explicit 3xx rejection
subsequently verified getMe, getWebhookInfo, setWebhook, and the resulting
webhook URL/update allowlist. This records the observed deployment behavior;
it does not claim that all Cloudflare runtimes lack error redirect mode.

## Decision

Use `redirect: manual` for Telegram requests. Never follow redirects. Treat
any 3xx as retryable telegram_network_error; do not inspect, log or expose
Location. Maintain bounded response reads, timeouts, single-attempt calls,
secret redaction and existing generation-fenced durable transitions.

The operator helper is a one-time server-side tool with no public management
route. Its temporary schedule and deployed wrapper must be removed after
registration. Application v1.2.4 includes the live-client correction; schema
remains 2. Admin management from inside the bot is a separate required feature.

## Verification

Offline tests assert manual redirect mode, a single request on 3xx,
retryability, and no token or redirect-target leakage. Bootstrap tests run in
Node and workerd; all network calls in tests are injected fixtures.
