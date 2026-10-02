# Architecture Decision Records — index

ADRs record decisions **actually made** during this project. Phase 0 ADRs are
listed below. Statuses: Accepted / Superseded.

| ADR                                                     | Title                                                               | Status   |
| ------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| [ADR-0001](adr-0001-toolchain.md)                       | Toolchain: npm, Node 22, TypeScript strict, ESLint flat + Prettier  | Accepted |
| [ADR-0002](adr-0002-repository-layout.md)               | Modular-monolith repository layout and blueprint mapping            | Accepted |
| [ADR-0003](adr-0003-zero-runtime-dependencies.md)       | Zero runtime dependencies in Phase 0; hand-rolled config validation | Accepted |
| [ADR-0004](adr-0004-structured-logging.md)              | Structured JSON-line logging with mandatory key redaction           | Accepted |
| [ADR-0005](adr-0005-environment-contract.md)            | Two-tier environment contract; commented binding placeholders       | Accepted |
| [ADR-0006](adr-0006-phase0-http-surface.md)             | Phase 0 HTTP surface: strict allowlist routing                      | Accepted |
| [ADR-0007](adr-0007-cron-queue-noop.md)                 | Phase 0 cron/queue handlers are typed no-ops that ack-all           | Accepted |
| [ADR-0008](adr-0008-secret-classification-readiness.md) | Secret classification and phase-scoped fail-closed readiness        | Accepted |

Unresolved questions are tracked in [`../OPEN_DECISIONS.md`](../OPEN_DECISIONS.md),
not here. An ADR is written only when a decision is actually made.
