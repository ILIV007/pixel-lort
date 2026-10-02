# src/adapters

Platform adapters that isolate the Worker from external systems. Each adapter
is introduced only in the phase that owns it (docs/ROADMAP.md).

## Implemented — Phase 1A

- `db/` — smallest useful D1 access boundary (ADR-0019):
  - typed execution surface (`DbExecutor`: query / first / run / atomic batch),
  - safe D1 error mapping into stable AppError codes (`d1-errors.ts`),
  - application schema health query against `schema_metadata`
    (`schema-health.ts`).
    No repositories and no business queries yet — those arrive with their owning
    phases. Observability rules (ADR-0022): stable operation names, durations,
    result counts and stable error codes only; SQL text and bind parameters are
    never logged.

## Planned

- `d1/` repositories — idempotent writers per aggregate (phase 2+)
- `queue/` — queue producer/consumer adapters (phase 3)
- `kv/` — cache/lock adapters (phase 1B+)
- `r2/` — media artifact storage (phase 7)
- `telegram/` — Bot API client (phase 2)
- `ai/` — model provider adapters and routing (phase 6)
- `http/` — outbound HTTP with SSRF guards, caps, and timeouts (phase 4)

All external I/O goes through this layer with timeouts, byte caps, redirect
caps, and idempotency rules from the blueprint.
