# Architecture Decision Records — index

ADRs record decisions **actually made** during this project. Phase 0 ADRs
(including the correction pass of 2026-10-02) are listed below. Statuses:
Accepted / Amended / Superseded. Resolved open questions keep their history
in [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md).

| ADR                                                          | Title                                                                              | Status                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [ADR-0001](adr-0001-toolchain.md)                            | Toolchain: npm, Node 22, TypeScript strict, ESLint flat + Prettier                 | Accepted                                                      |
| [ADR-0002](adr-0002-repository-layout.md)                    | Modular-monolith repository layout and blueprint mapping                           | Accepted                                                      |
| [ADR-0003](adr-0003-zero-runtime-dependencies.md)            | Zero runtime dependencies in Phase 0; hand-rolled config validation                | Accepted                                                      |
| [ADR-0004](adr-0004-structured-logging.md)                   | Structured JSON-line logging with mandatory key redaction                          | Accepted (amended by ADR-0017)                                |
| [ADR-0005](adr-0005-environment-contract.md)                 | Two-tier environment contract; commented binding placeholders                      | Accepted                                                      |
| [ADR-0006](adr-0006-phase0-http-surface.md)                  | Phase 0 HTTP surface: strict allowlist routing                                     | Accepted                                                      |
| [ADR-0007](adr-0007-cron-queue-noop.md)                      | Phase 0 cron/queue handlers are typed no-ops that ack-all                          | Accepted (amended by ADR-0011)                                |
| [ADR-0008](adr-0008-secret-classification-readiness.md)      | Secret classification and phase-scoped fail-closed readiness                       | Accepted (confirmed by ADR-0014)                              |
| [ADR-0009](adr-0009-target-channel-non-secret.md)            | TARGET_CHANNEL is non-secret configuration (closes OD-001)                         | Accepted                                                      |
| [ADR-0010](adr-0010-zod-phase-3.md)                          | Zod introduced in Phase 3 for envelope contracts (closes OD-002)                   | Accepted                                                      |
| [ADR-0011](adr-0011-queue-ack-all-phase0-only.md)            | Queue ack-all approved ONLY for the non-deployed Phase 0 skeleton (closes OD-003)  | Accepted                                                      |
| [ADR-0012](adr-0012-version-endpoint-phase-1.md)             | /version endpoint lands in Phase 1 with safe build metadata (closes OD-004)        | Accepted                                                      |
| [ADR-0013](adr-0013-nodejs-compat-deferred.md)               | nodejs_compat stays disabled for now (closes OD-005)                               | Accepted                                                      |
| [ADR-0014](adr-0014-phase-scoped-readiness-approved.md)      | Phase-scoped fail-closed readiness is approved (closes OD-006)                     | Accepted                                                      |
| [ADR-0015](adr-0015-readiness-semantics.md)                  | Readiness semantics: ready / degraded / not_ready (closes OD-007)                  | Accepted                                                      |
| [ADR-0016](adr-0016-environment-naming.md)                   | Environment naming: separate preview and production resources (closes OD-008)      | Accepted                                                      |
| [ADR-0017](adr-0017-failsafe-error-logging.md)               | Fail-safe error logging and 4xx/5xx observability policy                           | Accepted (amends ADR-0004)                                    |
| [ADR-0018](adr-0018-secret-scanner-coverage.md)              | Secret scanner coverage and automated self-test in the gate                        | Accepted                                                      |
| [ADR-0019](adr-0019-d1-schema-migration.md)                  | D1 schema migration 0001 and application schema metadata                           | Accepted                                                      |
| [ADR-0020](adr-0020-version-contract.md)                     | /version contract and build/schema metadata configuration                          | Accepted                                                      |
| [ADR-0021](adr-0021-phase1a-readiness.md)                    | Phase 1A readiness behavior for schema health                                      | Accepted                                                      |
| [ADR-0022](adr-0022-d1-observability.md)                     | D1 observability and error-mapping rules                                           | Accepted                                                      |
| [ADR-0023](adr-0023-preview-cloudflare-infrastructure.md)    | Provision isolated Cloudflare preview infrastructure                               | Accepted                                                      |
| [ADR-0024](adr-0024-telegram-webhook-ingress.md)             | Secure Telegram webhook ingress and Phase 2 configuration gating                   | Accepted                                                      |
| [ADR-0025](adr-0025-telegram-update-idempotency.md)          | Durable Telegram update idempotency on telegram_updates                            | Accepted (amended by ADR-0027/0030/0032)                      |
| [ADR-0026](adr-0026-telegram-admin-interaction-contracts.md) | Telegram admin interaction contracts (roles, commands, HTML, callback tokens)      | Accepted (amended by ADR-0029)                                |
| [ADR-0027](adr-0027-retryable-update-reclaim.md)             | Retryable update reclaim semantics (failed rows are reclaimable, 503 propagation)  | Accepted (completed by ADR-0030/0031)                         |
| [ADR-0028](adr-0028-bounded-stream-reading.md)               | Bounded request/response stream reading (webhook + Bot API client)                 | Accepted                                                      |
| [ADR-0029](adr-0029-html-url-safety-boundary.md)             | Telegram-safe HTML link boundary (URL-parsed, canonical hrefs + runtime gate)      | Accepted                                                      |
| [ADR-0030](adr-0030-claim-lease-stale-reclaim.md)            | Claimed-update lease and stale-claim recovery (schema v2, migration 0002)          | Accepted (amended v1.2.3: generation fencing)                 |
| [ADR-0031](adr-0031-failure-class-persistence.md)            | Persisted failure classes: permanent failures are terminal, retryable reclaimable  | Accepted (amended v1.2.3: fenced transitions)                 |
| [ADR-0032](adr-0032-at-least-once-side-effects.md)           | Honest at-least-once side-effect semantics (bounded duplicate risk, no outbox yet) | Accepted (amended v1.2.3: 200 only after durable persistence) |

All Phase-0 open decisions (OD-001..OD-008) are now **closed**; see
[`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md) for the preserved history. An
ADR is written only when a decision is actually made.

- [ADR-0023: Provision isolated Cloudflare preview infrastructure](adr-0023-preview-cloudflare-infrastructure.md)
- [ADR-0024: Secure Telegram webhook ingress and Phase 2 configuration gating](adr-0024-telegram-webhook-ingress.md)
- [ADR-0025: Durable Telegram update idempotency on telegram_updates](adr-0025-telegram-update-idempotency.md)
- [ADR-0026: Telegram admin interaction contracts (roles, commands, HTML, callback tokens)](adr-0026-telegram-admin-interaction-contracts.md)
- [ADR-0027: Retryable update reclaim semantics](adr-0027-retryable-update-reclaim.md)
- [ADR-0028: Bounded request and response stream reading](adr-0028-bounded-stream-reading.md)
- [ADR-0029: Telegram-safe HTML link boundary (URL-parsed hrefs)](adr-0029-html-url-safety-boundary.md)
- [ADR-0030: Claimed-update lease and stale-claim recovery](adr-0030-claim-lease-stale-reclaim.md)
- [ADR-0031: Permanent versus retryable failure persistence](adr-0031-failure-class-persistence.md)
- [ADR-0032: Honest at-least-once side-effect semantics](adr-0032-at-least-once-side-effects.md)
