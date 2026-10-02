# ADR-0022: D1 observability and error-mapping rules

- **Status:** Accepted
- **Date:** 2026-10-02 (Phase 1A)
- **Decides:** what may be logged around database operations and how D1
  driver errors cross boundaries.

## Context

D1 operations involve SQL text and bind parameters. Bind parameters may carry
user or source content (source titles, excerpts, provider payloads in later
phases), and raw driver messages may contain schema details. Key-based
redaction alone cannot catch secrets embedded inside such strings (ADR-0017
lesson), so the database boundary needs explicit rules.

## Decision

1. **The typed executor (`src/adapters/db/db-executor.ts`) is the only D1
   access surface.** All D1 calls go through it (or the schema-health query
   built on it).
2. **Logging contract.** Database operations log ONLY: stable operation
   names (`db.query.ok|failed`, `db.run.ok|failed`, `db.batch.ok|failed`),
   durations, result/row counts, and stable error codes. SQL text and bind
   parameters are NEVER logged. Full rows are NEVER logged.
3. **Error mapping.** Driver errors are classified into stable codes:
   `db_constraint_violation` (409), `db_schema_invalid` (503),
   `db_query_failed` (500). The raw message is used for classification only;
   the resulting AppError carries author-constant messages, and the original
   error is preserved as `cause` for INTERNAL fail-safe logging (collapsed
   by `src/observability/safe-error.ts` — never emitted raw).
4. **Batch semantics.** Batches are atomic (implicit transaction): any
   failing statement rolls back the whole batch. Callers must rely on this
   for idempotency-sensitive multi-write flows.

## Consequences

- Even hostile or secret-shaped values flowing through parameters can never
  reach logs via the database boundary.
- Tests in `tests/integration/db-boundary.test.ts` pin this contract,
  including the parameter-leak checks.
