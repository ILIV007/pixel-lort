# src/adapters — planned (not implemented in Phase 0)

Infrastructure adapters implementing domain/application ports:

- `d1/` — D1 repositories and migrations access (phase 1)
- `queue/` — queue producer/consumer adapters (phase 3)
- `kv/` — cache/lock adapters (phase 1+)
- `r2/` — media artifact storage (phase 7)
- `telegram/` — Bot API client (phase 2)
- `ai/` — model provider adapters and routing (phase 6)
- `http/` — outbound HTTP with SSRF guards, caps, and timeouts (phase 4)

No adapter code exists in Phase 0. All external I/O will go through this
layer with timeouts, byte caps, redirect caps, and idempotency rules from the
blueprint.
