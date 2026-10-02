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

## Current implementation status — Phase 1A (data foundation)

Phase 0 delivered the repository and Worker foundation (no business behavior).
Phase 1A adds the offline, testable D1 data foundation and the approved
`/version` contract. **It still implements no business behavior.**

Implemented in Phase 1A:

- Versioned D1 migration `migrations/0001_initial_schema.sql` converted from
  the authoritative blueprint schema (27 approved tables, 29 approved
  indexes, all constraints; plus the application `schema_metadata` table —
  ADR-0019). The blueprint remains the immutable design reference.
- Application schema metadata (`schema_metadata`): schema version, migration
  identifier, application timestamp — distinct from Wrangler's migration
  bookkeeping (`d1_migrations`).
- Smallest useful D1 access boundary (`src/adapters/db/`): typed execution
  surface with atomic batches, safe D1 error mapping into stable AppError
  codes, and a schema health query (ADR-0022). No repositories yet.
- `GET /version`: application version, commit identifier, schema version,
  deployment environment (ADR-0020). No secrets, no timestamps,
  `cache-control: no-store`; fail-closed on invalid metadata.
- `GET /health/ready` extension (ADR-0021): `not_ready` on invalid
  build/schema metadata or failed schema health when a D1 binding is present;
  ordinary offline development without a D1 resource stays ready.
- Local D1 placeholder binding in wrangler.jsonc (ADR-0019) enabling offline
  migration commands and the vitest/workerd D1 test environment. **No
  Cloudflare resource exists or is created**; provisioning is Phase 1B.

Implemented in Phase 0 (unchanged):

- Typed Worker entrypoint skeleton (`fetch`, `scheduled`, `queue`) with strict-mode
  TypeScript, ESLint (flat config), Prettier, and Cloudflare-supported Vitest tooling.
- `GET /health`, `GET /health/live`, `GET /health/ready` and a safe JSON 404 for all
  other routes (allowlist routing).
- Typed environment/binding contracts (D1, KV, R2, Queues, Workers AI) — declared as
  types and documented placeholders.
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
- No AI provider calls. No D1 repositories or business workflows.
- No deployment, no Cloudflare resource creation, no webhook registration.
- No remote D1 migration has ever been executed (Phase 1B, with provisioning).

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the phase plan.

## Requirements

- Node.js 22+ and npm (the package manager for this repository)
- No Cloudflare account, credentials, or network access are needed for any command.

## Setup

```bash
npm ci        # install exactly the locked dependency tree
npm run check # full Phase 1A quality gate
```

For local Workers development later, copy `.dev.vars.example` to `.dev.vars`
(git-ignored) and never commit real values. See `docs/SECURITY_MODEL.md`.

## D1 migrations (Phase 1A)

Migrations are append-only files in `migrations/` (never edit or reorder an
applied file). Local commands operate on local SQLite state only — no account
and no network access:

| Command                       | Purpose                                            |
| ----------------------------- | -------------------------------------------------- |
| `npm run db:migrations:list`  | List migrations and their local application status |
| `npm run db:migrations:apply` | Apply pending migrations to the local D1 database  |
| `npm run test:db`             | Schema-contract and DB-boundary tests (workerd D1) |

Remote migration commands are **documentation-only during Phase 1A**:
`npx wrangler d1 migrations apply DB --remote` may only be run after Phase 1B
resource provisioning is approved and completed by the project owner. No
remote migration has ever been executed from this repository.

## Commands

| Command                       | Purpose                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `npm run lint`                | ESLint over the repository                                                 |
| `npm run format:check`        | Prettier formatting check                                                  |
| `npm run format`              | Prettier auto-format                                                       |
| `npm run typecheck`           | `tsc --noEmit` (strict mode)                                               |
| `npm test`                    | Vitest suite executed inside the Workers runtime (workerd)                 |
| `npm run test:db`             | D1 schema-contract + DB-boundary tests only                                |
| `npm run test:secrets`        | Secret-scanner self-test (detection, placeholders, exit codes)             |
| `npm run build`               | `wrangler deploy --dry-run --outdir dist` — offline build only             |
| `npm run scan:secrets`        | Secret-shape scan over git-tracked files                                   |
| `npm run db:migrations:list`  | List local D1 migration status (offline)                                   |
| `npm run db:migrations:apply` | Apply pending migrations to the LOCAL D1 database (offline)                |
| `npm run check`               | Complete quality gate (lint/format/typecheck/test/test:secrets/scan/build) |

`npm run build` never deploys: it is a dry-run bundle. There is no deployment
workflow in this repository.

## Repository layout

```
src/
  entrypoints/    Worker entrypoints: fetch/HTTP, scheduled, queue
  domain/         (planned) pure domain models — no platform types
  application/    (planned) use cases and workflows
  adapters/       db/ D1 boundary (Phase 1A); queue/kv/r2/telegram/ai/http planned
  editorial/      (planned) deterministic renderer, Persian normalization, prompts
  admin/          (planned) private Telegram admin screens and RBAC
  observability/  structured logging, redaction (implemented in Phase 0)
  shared/         errors, config validation, ids, clock (implemented in Phase 0)
tests/
  unit/           unit tests (workerd runtime)
  integration/    entrypoint + D1 tests via cloudflare:test SELF / bindings
  types/          ambient test-environment declarations
  fixtures/       (reserved) connector/Golden fixtures
migrations/       versioned D1 migrations (0001_initial_schema.sql — Phase 1A)
docs/             architecture, roadmap, decisions, security model, blueprint
handoff/          per-phase handoff reports
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

## Phase 0/1A boundary statement

Phase 0 and Phase 1A do **not** publish, deploy, register webhooks, call
third-party services, or create Cloudflare/Telegram resources. Tests make no
real network requests and require no credentials. The blueprint is preserved
verbatim under [`docs/blueprint/v1/`](docs/blueprint/README.md) and remains
authoritative.

## License

Released under the [MIT License](LICENSE).
