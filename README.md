# Pixel

**Pixel** is a Persian-language autonomous Telegram gaming editorial system for the
**PIXEL LORT** channel (`@pixellort`). It collects gaming signals from registered
sources, builds verified stories with evidence, drafts Persian-language posts with an
editorial persona, and publishes to Telegram under explicit trust, budget, and
scheduling policies.

- **Platform:** Cloudflare Workers (Free tier) + D1 + Queues + KV + R2 + Workers AI
- **Primary interface:** Telegram private admin chat (the only admin UI in v1)
- **Timezone:** `Asia/Tehran`
- **Authoritative specification:** [`docs/blueprint/v1/`](docs/blueprint/README.md)

## Current implementation status — Phase 0 (foundation only)

Phase 0 delivers the repository and Worker foundation. **It implements no business
behavior.**

Implemented in Phase 0:

- Typed Worker entrypoint skeleton (`fetch`, `scheduled`, `queue`) with strict-mode
  TypeScript, ESLint (flat config), Prettier, and Cloudflare-supported Vitest tooling.
- `GET /health`, `GET /health/live`, `GET /health/ready` and a safe JSON 404 for all
  other routes (allowlist routing).
- Typed environment/binding contracts (D1, KV, R2, Queues, Workers AI) — declared as
  types and documented placeholders; **no Cloudflare resources exist or are created**.
- Small Worker-compatible configuration validation with secret-safe failures.
- Structured logging with mandatory sensitive-key redaction, fail-safe error
  serialization (raw messages/stacks/causes are never emitted — ADR-0017),
  correlation IDs, clock abstraction, and deterministic idempotency-key
  primitives (interfaces only).
- Quality gates: `npm run check` (lint, format, typecheck, tests, secret
  scanner self-test, secret scan, offline build) and a non-deploying GitHub
  Actions CI workflow.
- Full documentation set and preserved blueprint under `docs/blueprint/v1/`.

NOT implemented (by design — later phases):

- No Telegram webhook, publishing, or admin panel. No source connectors or feeds.
- No AI provider calls. No D1 schema/migrations. No business workflows.
- No deployment, no Cloudflare resource creation, no webhook registration.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the phase plan.

## Requirements

- Node.js 22+ and npm (the package manager for this repository)
- No Cloudflare account, credentials, or network access are needed for any command.

## Setup

```bash
npm ci        # install exactly the locked dependency tree
npm run check # full Phase 0 quality gate
```

For local Workers development later, copy `.dev.vars.example` to `.dev.vars`
(git-ignored) and never commit real values. See `docs/SECURITY_MODEL.md`.

## Commands

| Command                | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `npm run lint`         | ESLint over the repository                                     |
| `npm run format:check` | Prettier formatting check                                      |
| `npm run format`       | Prettier auto-format                                           |
| `npm run typecheck`    | `tsc --noEmit` (strict mode)                                   |
| `npm test`             | Vitest suite executed inside the Workers runtime (workerd)     |
| `npm run test:secrets` | Secret-scanner self-test (detection, placeholders, exit codes) |
| `npm run build`        | `wrangler deploy --dry-run --outdir dist` — offline build only |
| `npm run scan:secrets` | Secret-shape scan over git-tracked files                       |
| `npm run check`        | Complete Phase 0 quality gate (all of the above)               |

`npm run build` never deploys: it is a dry-run bundle. There is no deployment
workflow in this repository.

## Repository layout

```
src/
  entrypoints/    Worker entrypoints: fetch/HTTP, scheduled, queue
  domain/         (planned) pure domain models — no platform types
  application/    (planned) use cases and workflows
  adapters/       (planned) D1/KV/R2/Queue/Telegram/AI/HTTP adapters
  editorial/      (planned) deterministic renderer, Persian normalization, prompts
  admin/          (planned) private Telegram admin screens and RBAC
  observability/  structured logging, redaction (implemented in Phase 0)
  shared/         errors, config validation, ids, clock (implemented in Phase 0)
tests/
  unit/           unit tests (workerd runtime)
  integration/    entrypoint tests via cloudflare:test SELF
  fixtures/       (reserved) connector/Golden fixtures
migrations/       (planned) D1 migrations — blueprint SQL preserved, not applied
docs/             architecture, roadmap, decisions, security model, blueprint
scripts/          maintenance scripts (secret scan)
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — approved architecture, implemented vs planned
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phase plan with completion status
- [`docs/OPEN_DECISIONS.md`](docs/OPEN_DECISIONS.md) — decision log (Phase-0
  items OD-001..OD-008 closed; history preserved)
- [`docs/DECISIONS/`](docs/DECISIONS/index.md) — architecture decision records (ADRs)
- [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md) — secret boundaries and logging rules
- [`AGENTS.md`](AGENTS.md) — standing instructions for coding agents
- [`SECURITY.md`](SECURITY.md) — vulnerability reporting policy
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — branch, commit, and review rules

## Phase 0 boundary statement

Phase 0 does **not** publish, deploy, register webhooks, call third-party services,
or create Cloudflare/Telegram resources. Tests make no real network requests and
require no credentials. The blueprint is preserved verbatim under
[`docs/blueprint/v1/`](docs/blueprint/README.md) and remains authoritative.

## License

Released under the [MIT License](LICENSE).
