# Architecture

This document describes the **approved architecture from the blueprint**
(`docs/blueprint/v1/`). Components are explicitly marked **implemented** or
**planned** — nothing in a later phase may be implied as existing.

## 1. System overview (planned — blueprint §1–§2)

Pixel is an event-driven modular monolith on Cloudflare Workers:

- **D1** is the source of truth for all durable state (updates, jobs, sources,
  stories, claims, evidence, drafts, publications, audit).
- **Queues** (`pixel-jobs`, DLQ `pixel-dlq`) carry only durable job references
  (`{version, jobId, type, attempt, traceId}`), never business records.
- **KV** (`CACHE`) is cache/lock optimization only — never queues, approval
  stores, or audit history.
- **R2** (`MEDIA`) stores temporary, rights-cleared media only; YouTube
  audiovisual content is never downloaded.
- **Workers AI** participates in a routed model chain with deterministic
  fallbacks; AI emits validated semantic JSON, never final Telegram HTML.
- Queues are at-least-once: every consumer is idempotent; every externally
  visible action carries a deterministic idempotency key.

Runtime topology (planned):

```text
Telegram webhook ──► update claim (D1) ──► durable job (D1) ──► pixel-jobs
Cron */5 ──────────► due source/publication scan ─────────────► pixel-jobs
pixel-jobs ────────► use case handlers ──► D1/R2/KV/external APIs
Publisher ─────────► Telegram API ───────► @pixellort
Failures ──────────► retry_wait/D1 ──────► pixel-dlq after max attempts
```

## 2. Repository layout vs blueprint boundaries

The Phase Packet fixed the repository source layout; the blueprint module
boundaries map onto it as follows:

| Repository layout   | Blueprint boundary                                                  | Status                       |
| ------------------- | ------------------------------------------------------------------- | ---------------------------- |
| `src/entrypoints`   | `interfaces/*` (webhook, queue, cron)                               | **implemented (skeleton)**   |
| `src/domain`        | `domain/*` (story, editorial, publication, source, media, identity) | planned                      |
| `src/application`   | `application/*` (commands, queries, workflows)                      | planned                      |
| `src/adapters`      | `infrastructure/*` + `connectors/*`                                 | **db boundary (Phase 1A)**   |
| `src/editorial`     | rendering, Persian normalization, prompt contracts                  | planned                      |
| `src/admin`         | private Telegram screens, RBAC, sessions                            | planned                      |
| `src/observability` | logging, redaction, correlation                                     | **implemented (foundation)** |
| `src/shared`        | cross-cutting primitives (errors, config, ids, clock)               | **implemented (foundation)** |

Standing boundary rule (blueprint §3): domain code imports no Cloudflare,
Telegram, provider SDK, or HTTP client types.

## 3. Implemented in Phase 0

### 3.1 Worker entrypoint (`src/entrypoints/worker.ts`)

One default export with three typed handlers:

- `fetch` — correlation-ID resolution, config validation with safe fallbacks,
  allowlist routing, structured request logs (method + path only; never
  query strings, headers, cookies, or bodies), safe error mapping.
- `scheduled` — typed no-op foundation that logs the trigger (cron
  expression + scheduled time). Real due-work dispatch arrives with the
  job/queue framework phase.
- `queue` — typed no-op foundation that logs queue name + message count and
  acknowledges messages. Claim/lease/idempotent processing arrives later.

### 3.2 HTTP surface (allowlist)

| Route               | Behavior                                                              | Status      |
| ------------------- | --------------------------------------------------------------------- | ----------- |
| `GET /health`       | Small JSON health summary (no secret inventory)                       | implemented |
| `GET /health/live`  | Static liveness                                                       | implemented |
| `GET /health/ready` | `ready`/`not_ready` only; reasons to logs; Phase 1A schema health     | implemented |
| `GET /version`      | Four safe build/schema fields (ADR-0020); fail-closed on bad metadata | implemented |
| everything else     | Uniform safe JSON 404 (paths and methods)                             | implemented |

Planned additions per blueprint §5 (not implemented): `POST /telegram/webhook`
with constant-time secret validation and body caps; `degraded` readiness
semantics. Tracked in `docs/ROADMAP.md`.

### 3.3 Environment contract (`src/shared/types/env.ts`)

- `WorkerEnv` — what the Worker consumes today: wrangler.jsonc vars plus the
  optional Phase 1A local D1 placeholder binding `DB` (ADR-0019; no resource
  exists — optional so bare runtimes and unit tests boot without D1).
- `PixelBindings` — future binding contract with blueprint names:
  `DB` (D1), `CACHE` (KV), `JOBS` (Queue producer), `MEDIA` (R2), `AI`
  (Workers AI). Only the local D1 placeholder is declared; everything else
  is documented as comments in wrangler.jsonc.
- `PixelSecrets` — secret names per blueprint §4. Values exist only in
  Cloudflare secrets / local `.dev.vars`.
- `QueueEnvelope` — type-only contract for future queue messages.

### 3.4 Configuration validation (`src/shared/config/`)

Small, dependency-free validator (ADR-0003): typed field specs, enum/string
types, required/optional with defaults, secret classification. Failures
identify field names and reasons only — never values — so misconfiguration
cannot leak secrets. Phase 0 validates only the health-foundation subset;
the full secret catalog is documented with owning phases
(`FUTURE_SECRET_CATALOG`, from which TARGET_CHANNEL is intentionally absent
per ADR-0009) and gates readiness from its owning phase (ADR-0008, approved
by ADR-0014).

### 3.5 Observability (`src/observability/`)

- JSON-line structured logger with level filtering, child loggers, injected
  clock/sink for deterministic tests. The only sanctioned `console` writer.
- Key-based redaction before serialization (sensitive names include:
  `authorization`, `cookie`, `token`, `apiKey`, `api_key`, `secret`,
  `password`, `telegramBotToken` and variants), depth/size bounded.
- Fail-safe error logging (ADR-0017): Error instances at any depth collapse
  to safe fields (name, stable code, HTTP status) via
  `src/observability/safe-error.ts`; raw messages, stacks, and causes are
  never emitted. Expected 4xx requests log one concise warn event; only
  unexpected 5xx log at error level.

### 3.6 Shared primitives (`src/shared/`)

- `AppError` with stable codes → HTTP statuses and safe default messages
  (extended in Phase 1A with D1 boundary codes: `db_constraint_violation`,
  `db_schema_invalid`, `db_query_failed`).
- Safe error serialization (`toPublicErrorBody`) — the only path from a
  thrown value to an HTTP error body.
- Correlation/request IDs with strict input validation.
- Deterministic idempotency-key primitives (`formatIdempotencyKey`,
  `sha256Hex`) — interfaces only; business idempotency arrives with the job
  framework phase.
- Clock abstraction (`systemClock`, `fixedClock`) for deterministic tests.

### 3.7 Data foundation (Phase 1A — ADR-0019/0020/0021/0022)

- **Migration:** `migrations/0001_initial_schema.sql` — verbatim port of the
  blueprint schema (27 tables, 29 indexes, all CHECK/FK/UNIQUE constraints)
  plus the application `schema_metadata` table. The blueprint's
  `PRAGMA foreign_keys = ON` is not ported (D1 enforces foreign keys by
  default; proven by tests). Migrations are append-only.
- **Schema metadata:** `schema_metadata` (key/value/updated_at_ms) records
  `schema_version` (= 1), `migration_id`, `applied_at` — the runtime contract
  used by readiness; distinct from Wrangler's `d1_migrations` bookkeeping.
- **D1 boundary (`src/adapters/db/`):** typed `DbExecutor`
  (query/first/run/atomic batch), safe D1 error classification into stable
  AppError codes, and the schema health query. Logs only stable operation
  names, durations, result counts, and error codes — never SQL text,
  parameters, or rows (ADR-0022). No repositories, no ORM.
- **Version contract:** `GET /version` (ADR-0020) backed by `APP_COMMIT` and
  `SCHEMA_VERSION` config (strict positive-integer validation, no silent
  coercion, production placeholder guard).
- **Readiness:** `/health/ready` verifies schema health whenever a D1
  binding is present; offline development without a binding stays ready
  (ADR-0021).

## 4. Testing approach

- Vitest with the Cloudflare-supported Workers pool: tests execute inside
  workerd via wrangler.jsonc. The local D1 placeholder binding gives tests an
  isolated local D1 database — no resources, no credentials, no network.
- Entry-integration tests use `cloudflare:test` `SELF`; D1 tests apply
  migrations atomically through `tests/helpers/migrations.ts` (statement
  split + `db.batch`, since D1 `exec` cannot run multi-line statements);
  unit tests call handlers directly with typed mocks.
- No test performs a real network request.

## 5. Non-goals in Phase 1A

Source connectors, story/evidence engine, AI adapters, renderer, media
pipeline, publisher, Telegram admin panel, D1 repositories/business queries,
deployments, Cloudflare resource creation, webhook registration, remote
migrations — all planned, none implemented.
