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

### 3.8 Telegram ingress and admin foundation (Phase 2A — ADR-0024/0025/0026/0027/0028/0029)

**HTTP edge** (`src/entrypoints/http/handlers/telegram-webhook.ts`):
`POST /telegram/webhook` exists only behind the fail-closed
`TELEGRAM_INGRESS_ENABLED` flag with a fully valid Phase 2 configuration; a
disabled or misconfigured ingress is a uniform unknown route. Request
lifecycle: timing-safe secret verification (fresh-key HMAC-SHA256 via Web
Crypto) -> JSON content type -> TRUE bounded body reading (ADR-0028: strict
Content-Length pre-check, then a streamed byte cap at 64 KiB that stops and
cancels after the first chunk crossing the limit; strict UTF-8 decode) ->
strict JSON parse -> bounded Update parse. Rejections carry stable reason
codes and never echo values.

**Update parsing** (`src/adapters/telegram/update-parser.ts`): small explicit
parser for `message` / `edited_message` / `callback_query` (no Zod — ADR-0010
boundary). Safe-integer numerics only; strings bounded by omission; 64-byte
callback data limit; unknown kinds classified `unsupported`; bot commands
carry their optional lowercased target username (`/cmd@bot`) in
`commandTarget`.

**Durable idempotency** (`src/application/telegram-ingress.ts` +
`src/adapters/telegram/update-claims.ts`): update_id is the claim boundary
with FOUR outcomes (ADR-0027): `claimed` (new), `reclaimed` (atomic
`failed -> claimed`, exactly one concurrent winner), `already_processed`
(terminal, ack), `in_flight` (owned elsewhere, ack). Retryable processing
failures mark the row `failed` and propagate HTTP 503 semantics so Telegram
redelivery reclaims them; permanent failures mark `failed` and answer 200.
`claimed -> processed | failed` transitions stay guarded; `processed` is
never reclaimable; D1 is the only dedup authority (ADR-0025/0027).

**Authorization** (`src/admin/roles.ts`, `src/admin/authorization.ts`,
`src/adapters/telegram/admin-lookup.ts`): owner bootstrap via
`OWNER_TELEGRAM_ID` plus active D1 admins; six approved roles with the
verbatim `pixel_admin_map_v1.json` permission map; numeric user IDs only;
fail closed everywhere. A denial is a handled action, not a failure.

**Command routing** (`src/admin/command-router.ts`): allowlist /start /help
/status /version; output is a TYPED action (`send_message` / `answer_callback`
/ `noop` / `denied`) — never an immediate fetch; unauthorized senders get a
minimal fixed Persian denial; outside-allowlist commands are ignored;
explicitly-targeted commands (`/cmd@bot`) execute only for the configured
expected username (case-insensitive) and are otherwise ignored with the
stable `command_for_other_bot` reason (no expected username is wired in
Phase 2A — every explicit target is ignored, fail closed).

**Bot API boundary** (`src/adapters/telegram/bot-api-client.ts`): typed
getMe / sendMessage / editMessageText / answerCallbackQuery; injectable
fetch; strict timeout; single attempt (no retries); `redirect: "error"`;
bounded 1 MiB response streaming on success and error/429 paths (ADR-0028);
retryable/permanent error classification with safe `retry_after` parsing;
runtime Telegram-safe HTML gate before every text-bearing call (a forged
cast cannot bypass it); token and bodies never logged. Without `BOT_TOKEN`
the pipeline runs in documented OFFLINE mode: noop actions complete, OUTBOUND
actions fail retryably as `service_unavailable` (never silently skipped and
acked — ADR-0027).

**Admin contracts** (`src/admin/telegram-html.ts`,
`src/admin/callback-tokens.ts`, `src/adapters/telegram/action-tokens.ts`):
Telegram-safe HTML escaper/builder; link targets validated by URL parsing
(https only, no credentials, no hazard characters), canonicalized, and
attribute-escaped before interpolation, with the validator accepting exactly
builder-shaped hrefs (ADR-0029); `a:<base64url_token>` callback contract
(≤ 64 bytes) with the `admin_action_tokens` single-use, user-bound
repository boundary; issue/consume inputs validated BEFORE any database
access (positive safe-integer user ids and timestamps, future expiry, token
shape, approved permissions only, bounded action descriptors, JSON-object
payload) and never echo rejected values.

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

## 6. Non-goals in Phase 2A

No Telegram credentials exist and none are configured in Cloudflare; the
ingress flag ships `false` everywhere. No webhook registration, no live
Telegram traffic, no `getMe`/`sendMessage` calls against the real API, no
admin menus/screens or multi-step sessions (`admin_sessions` untouched), no
role-mutation endpoints, no publishing controls, no source connectors, no AI
adapters, no queues, no schema changes (migration set stays at 0001). Live
preview wiring is explicitly Phase 2B.
