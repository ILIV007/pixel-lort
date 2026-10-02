# src/application — planned (not implemented in Phase 0)

Application use cases that orchestrate domain ports:

- `commands/` — mutating use cases
- `queries/` — read-only use cases for admin screens
- `workflows/` — orchestration across domain ports

Nothing lives here yet. Do not add use cases before their phase; do not
import Cloudflare-specific types from this layer — depend on ports and inject
adapters instead (blueprint §3).
