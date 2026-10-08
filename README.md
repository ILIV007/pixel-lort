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

## Current implementation status — Phase 2A (Telegram secure ingress + admin foundation)

Phase 0 delivered the repository and Worker foundation. Phase 1A delivered
the offline D1 data foundation and the approved `/version` contract. Phase 1B
provisioned the isolated Cloudflare preview environment. **Phase 2A adds the
secure, fully OFFLINE Telegram ingress and the initial admin
foundation — no Telegram credentials exist, no webhook is registered, and no
live Telegram call can occur.**

Implemented in Phase 2A (as corrected in v1.2.1; lifecycle completed in the
correction rounds v1.2.2–v1.2.3 — schema v2):

- `POST /telegram/webhook` behind a fail-closed ingress flag
  (`TELEGRAM_INGRESS_ENABLED`, ships `false` everywhere): timing-safe shared
  secret verification (fresh-key HMAC-SHA256 via Web Crypto), JSON
  content-type enforcement, TRUE bounded 64 KiB body reading (streamed byte
  cap with early Content-Length checks — ADR-0028), strict UTF-8 and JSON
  parsing, stable rejection reason codes; correlation IDs and security
  headers retained (ADR-0024). A disabled or misconfigured ingress behaves
  like an unknown route.
- Bounded Telegram Update parser (message / edited_message / callback_query)
  with safe-integer numerics, bounded strings, the 64-byte callback data
  limit, bot-command target extraction (`/cmd@bot`), known chat-type
  extraction (`chatType`, v1.2.5), and crash-free classification of unknown
  update kinds.
- Admin UI language selection (v1.2.5, ADR-0034): ENGLISH default admin bot
  UI; per-admin `/language` (bare | `en` | `fa`) with durable per-admin
  persistence in the existing `settings` table under the dedicated
  `admin_ui_language:<user_id>` namespace (schema stays 2); update_id-fenced
  writes so older retried messages never overwrite newer choices; honest
  confirmations only after the fenced write applies (storage failures are
  retryable 503, never false success); private-chat + fresh-message guards;
  strict separation from the Persian/RTL editorial and channel language.
- Durable update idempotency in D1 (`telegram_updates`, ADR-0025/0027,
  lifecycle completed by ADR-0030/0031, fenced by the final correction
  round v1.2.3): update_id claim boundary with SIX explicit outcomes
  (claimed / reclaimed_retryable / reclaimed_stale / already_processed /
  permanently_failed / in_flight), GENERATION-FENCED
  `claimed -> processed | failed` transitions with a PERSISTED failure
  class, atomic reclaims (failed-retryable rows and EXPIRED-LEASE claimed
  rows) where exactly one concurrent caller wins. Every claim carries a
  conservative 5-minute lease (centralized constant, boundary-tested), so
  an update whose Worker died after claiming is recovered by the next
  delivery after lease expiry instead of being lost forever. `attempt_count`
  is the claim GENERATION (fencing token): every execution-owning claim
  outcome carries it and every terminal transition is guarded by it, so a
  stale Worker can never mutate a newer owner's claim. HTTP 200 is emitted
  only after a terminal state is durably persisted; terminal-transition
  uncertainty (rejected by the fence, or a storage error) answers safe 503.
  Retryable failures propagate safe HTTP 503 semantics (an in-flight update
  answers 503 too — never a false-success 200); permanent failures are
  TERMINAL: acknowledged 200 and never re-executed. Processing is durable
  at-least-once with duplicate suppression before execution plus bounded
  duplicate risk for ambiguous external side effects (ADR-0032) — exactly-once
  claim ownership does not imply exactly-once Telegram delivery.
- Phase 2 configuration contracts: `TELEGRAM_INGRESS_ENABLED`,
  `BOT_TOKEN`, `WEBHOOK_SECRET`, `OWNER_TELEGRAM_ID` (validated formats;
  values never echoed) and non-secret `TARGET_CHANNEL`; fail-closed
  readiness while ingress is enabled; documented OFFLINE mode without
  `BOT_TOKEN` where noop actions complete but outbound actions fail
  retryably (never falsely processed).
- Authorization foundation: owner bootstrap identity + active D1 admins
  across the six approved roles (verbatim permission map); fail closed for
  disabled admins, unknown users, and identity-less updates.
- Command routing contracts: `/start` `/help` `/status` `/version` `/language`
  for authorized senders (rendered in the sender's persisted admin UI
  language — English DEFAULT, per-admin Persian selectable via `/language`,
  ADR-0034), minimal English denial for unauthorized senders, ignore-list
  for everything else, and bot-target safety — a command addressed to
  another bot (`/cmd@other_bot`) is ignored (stable `command_for_other_bot`
  reason), matched case-insensitively when an expected username is
  configured. Typed Telegram actions decoupled from HTTP routing.
- Telegram Bot API client boundary (getMe / sendMessage / editMessageText /
  answerCallbackQuery): injectable fetch, strict timeout, single attempt,
  `redirect: "error"`, bounded 1 MiB response streaming on success and
  error paths (ADR-0028), retryable/permanent error classification, safe
  `retry_after` parsing, HTML parse mode only, token/bodies never logged.
- Callback data contract `a:<base64url_token>` (≤ 64 bytes) with the
  single-use, user-bound, expiring `admin_action_tokens` repository
  boundary; all inputs (user id, timestamps, token shape, approved
  permissions, action/payload bounds, JSON-object payload) validated BEFORE
  any database access.
- Telegram-safe HTML: `&<>` escaping, allowlisted tag builders,
  URL-parsed https-only link canonicalization with attribute escaping
  (ADR-0029), bounded structural validator accepting exactly builder output,
  and a runtime HTML gate inside the Bot API client that a forged cast
  cannot bypass; Persian/RTL/emoji intact.

Implemented in Phase 1A (unchanged):

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
  scanner self-test, secret scan, version-consistency gate, offline build)
  and a non-deploying GitHub Actions CI workflow.
- Full documentation set and preserved blueprint under `docs/blueprint/v1/`.

NOT implemented (by design — later phases):

- No live Telegram connection: no credentials, no Cloudflare secrets, no
  webhook registration, no real Bot API calls. Live preview wiring is
  Phase 2B.
- No admin menus/screens or sessions, no role mutation, no publishing
  controls, no editorial renderer.
- No source connectors or feeds. No AI provider calls. No queues.
- No further schema changes: the migration set is 0001 + 0002 (schema v2);
  0002 adds ONLY the telegram_updates lifecycle columns needed for claim
  lease and failure-class recovery (ADR-0030/0031).

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the phase plan.

## Requirements

- Node.js 22+ and npm (the package manager for this repository)
- No Cloudflare account, credentials, or network access are needed for any command.

## Setup

```bash
npm ci        # install exactly the locked dependency tree
npm run check # full quality gate (lint/format/types/tests/secrets/build)
```

For local Workers development later, copy `.dev.vars.example` to `.dev.vars`
(git-ignored) and never commit real values. See `docs/SECURITY_MODEL.md`.

## D1 migrations (schema v2 — 0001 + 0002)

Migrations are append-only files in `migrations/` (never edit or reorder an
applied file). Local commands operate on local SQLite state only — no account
and no network access:

| Command                       | Purpose                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `npm run db:migrations:list`  | List migrations and their local application status            |
| `npm run db:migrations:apply` | Apply pending migrations to the local D1 database             |
| `npm run test:db`             | Schema-contract, DB-boundary and migration tests (workerd D1) |

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
| `npm run test:db`             | D1 schema-contract + DB-boundary + migration tests only                    |
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
  entrypoints/    Worker entrypoints: fetch/HTTP (incl. Telegram webhook), scheduled, queue
  domain/         (planned) pure domain models — no platform types
  application/    telegram-ingress.ts — durable update lifecycle (Phase 2A)
  adapters/       db/ D1 boundary + admin UI language store (settings table,
                  ADR-0034); telegram/ parser, claims, lookup, action tokens,
                  Bot API client (Phase 2A); queue/kv/r2/ai planned
  editorial/      (planned) deterministic renderer, Persian normalization, prompts
  admin/          roles, authorization, command router, admin UI language
                  (ADR-0034), Telegram-safe HTML, callback token contract
  observability/  structured logging, redaction (implemented in Phase 0)
  shared/         errors, config validation, ids, clock, timing-safe compare
tests/
  unit/           unit tests (workerd runtime)
  integration/    entrypoint + D1 + Telegram pipeline tests via cloudflare:test
  types/          ambient test-environment declarations
  fixtures/       (reserved) connector/Golden fixtures
migrations/       versioned D1 migrations (0001_initial_schema.sql — Phase 1A;
                  0002_telegram_update_lifecycle.sql — Phase 2A schema v2)
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

## Phase boundary statement

Phase 0, 1A, and 2A do **not** publish, deploy, register webhooks, call
third-party services, or create Cloudflare/Telegram resources. Phase 2A's
Telegram surface is fully offline: the ingress flag ships `false`, no secrets
are configured anywhere, and every test runs without a real network request.
The blueprint is preserved verbatim under
[`docs/blueprint/v1/`](docs/blueprint/README.md) and remains authoritative.

## License

Released under the [MIT License](LICENSE).

## Preview infrastructure

Phase 1B provisions an isolated Cloudflare preview environment:

- Worker: `pixel-preview`
- D1: `pixel-db-preview`
- Wrangler environment: `preview`

Authenticated operator commands:

```bash
npm run db:migrations:list:preview
npm run db:migrations:apply:preview
npm run deploy:preview
```

`deploy:preview` injects the exact Git commit into `APP_COMMIT`. Cloudflare credentials must exist only in the operator environment and must never be committed.

Preview health endpoint: `https://pixel-preview.pixellort.workers.dev/health/ready`
