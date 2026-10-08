# Roadmap

Phase order follows blueprint §26 ("Roadmap implementation order"). Phases
**0**, **1A**, **1B**, and **2A** are marked complete; everything else is
pending and intentionally not started.

## Phase 0 — product/config freeze + repository foundation ✅

- [x] Extract and preserve the blueprint under `docs/blueprint/v1/` (verbatim).
- [x] Repository foundation: `package.json`, lockfile, strict `tsconfig.json`,
      `wrangler.jsonc`, `.gitignore`, `.editorconfig`, `.env.example`,
      `.dev.vars.example`, lint/format/test configuration.
- [x] Modular-monolith source layout (`src/{entrypoints,domain,application,adapters,editorial,admin,observability,shared}`).
- [x] Worker entrypoint skeleton: typed `fetch` / `scheduled` / `queue` handlers.
- [x] `GET /health`, `/health/live`, `/health/ready`; safe JSON 404 for all other routes.
- [x] Typed environment/binding contracts (D1, KV, R2, Queues, Workers AI) with
      documented binding names; no real resources required.
- [x] Worker-compatible configuration validation (secrets separated; fail-safe;
      no values in errors).
- [x] Shared foundations: typed errors, safe serialization, structured logging
      with redaction, correlation IDs, clock abstraction, idempotency-key
      primitives (interfaces only).
- [x] Quality tooling: `lint`, `format:check`, `typecheck`, `test`, `build`
      (dry-run), `scan:secrets`, and the combined `check` gate.
- [x] Tests: health, 404, safe errors, secret-safe config failures, cron smoke,
      queue smoke, logger redaction — all offline.
- [x] GitHub Actions CI: pinned Node major version, `npm ci`, full gate,
      least-privilege permissions, dependency caching, no deploy.
- [x] Documentation: README, AGENTS, ARCHITECTURE, ROADMAP, OPEN_DECISIONS,
      ADRs, SECURITY_MODEL, SECURITY, CONTRIBUTING.

## Phase 1A — D1 data foundation and version contract ✅ (current)

- [x] Versioned D1 migration `migrations/0001_initial_schema.sql` converted
      from the preserved blueprint schema: 27 approved tables, 29 approved
      indexes, all constraints; application `schema_metadata` table added
      (ADR-0019). Blueprint SQL remains the immutable design reference.
- [x] Application schema metadata mechanism: schema version, migration
      identifier, application timestamp — clearly distinct from Wrangler's
      `d1_migrations` bookkeeping (ADR-0019).
- [x] Migration tests on the Cloudflare vitest/workerd D1 test environment:
      isolated local D1, migrations applied atomically, table/index sets,
      foreign keys, uniqueness rules, representative flows (append-only test
      files; no Cloudflare account or credentials).
- [x] Smallest useful D1 access boundary (`src/adapters/db/`): typed
      execution, atomic batches, schema health query, safe D1 error mapping
      (ADR-0022). No repositories, no ORM-style framework.
- [x] `GET /version` with safe build metadata: application version, commit
      identifier, schema version, deployment environment (ADR-0012/0020);
      development-safe defaults locally; fail-closed on invalid metadata.
- [x] `APP_COMMIT` / `SCHEMA_VERSION` typed non-secret configuration with
      strict validation (no silent coercion) and `.env.example` / wrangler
      vars / environment types updated (ADR-0020).
- [x] `GET /health/ready` Phase 1A extension: `not_ready` on invalid
      metadata or failed schema health when a D1 binding is present; offline
      development without a D1 resource stays ready (ADR-0021).
- [x] Local D1 placeholder binding declaration + documented local migration
      commands (`db:migrations:list`, `db:migrations:apply`); remote
      migration commands are documentation-only in Phase 1A. **No Cloudflare
      resource was created and no remote migration was executed.**
- [x] Phase 1A review corrections: application version aligned to the
      approved `1.1.0` everywhere (package/wrangler//version/docs);
      future-safe INCREMENTAL test-migration helper (version-aware, plan
      validation, synthetic version-2 fixture — still test infrastructure
      only); closure-based `DbExecutor` (destructure-safe `first`, safe
      empty-batch no-op); APP_COMMIT trust rules extended to preview
      (placeholder rejected, hexadecimal Git commit ID 7–64 required outside
      development) per ADR-0020.

## Phase 1B — resource provisioning (owner-executed) ⬜

- [ ] Owner-approved Cloudflare resource provisioning per ADR-0016 naming:
      `pixel-db-production` / `pixel-db-preview` (and later KV/Queues/R2 in
      their owning phases).
- [ ] Replace the local D1 placeholder binding with real environment
      bindings (preview/production configurations).
- [ ] First remote migration application (`wrangler d1 migrations apply
DB --remote`) after provisioning, by or with explicit approval of the
      project owner.
- [ ] Repository layer for D1 access with idempotent writers (Phase 2+ work
      follows the schema boundary fixed in Phase 1A).
- [ ] CI extension for migration dry-run checks, if still appropriate after
      provisioning.

## Phase 2 — Telegram webhook, auth, RBAC and renderer ◑

### Phase 2A — Telegram secure ingress and admin foundation ✅ (correction rounds v1.2.1, v1.2.2, and v1.2.3 applied)

Implemented OFFLINE (no Telegram credentials, no webhook registration, no
Cloudflare secret configuration; the ingress flag ships `false` everywhere):

- [x] `POST /telegram/webhook` behind a fail-closed ingress flag (disabled /
      misconfigured ingress = uniform unknown route; ADR-0024): timing-safe
      secret verification (fresh-key HMAC-SHA256 via Web Crypto), JSON
      content-type enforcement, TRUE bounded 64 KiB body reading (streamed
      byte cap with strict Content-Length pre-checks and strict UTF-8 —
      ADR-0028), strict JSON parsing, stable rejection reason codes,
      correlation IDs and security headers retained, and NO payload/secret
      logging.
- [x] Bounded Update parser (message / edited_message / callback_query):
      safe-integer numerics only, bounded strings by omission, 64-byte
      callback data limit, unknown kinds classified unsupported (ADR-0026;
      no Zod — ADR-0010 boundary respected), bot-command target extraction
      (`/cmd@bot`) preserved in the parsed contract.
- [x] Durable update claims on `telegram_updates` (ADR-0025/0027, lifecycle
      completed by ADR-0030/0031 — schema v2, migration 0002; FENCED by the
      final correction round v1.2.3): update_id as the idempotency boundary
      with SIX claim outcomes (claimed / reclaimed_retryable /
      reclaimed_stale / already_processed / permanently_failed /
      in_flight), claimed -> processed | failed GENERATION-FENCED
      transitions with a PERSISTED failure_class, atomic RECLAIMS for
      failed-retryable rows AND expired-lease claimed rows (exactly one
      concurrent winner; processed and permanent failures stay terminal),
      a conservative 5-minute claim lease (centralized constant,
      boundary-tested at lease − 1 ms / exact expiry / after expiry) so a
      Worker that dies after claiming is recovered by the next delivery,
      attempt_count as the claim GENERATION (fencing token: every
      execution-owning outcome carries it, every terminal transition is
      guarded by it, and a stale owner can never mutate a newer claim),
      HTTP 200 emitted only after a terminal state is durably persisted
      (transition uncertainty answers safe 503), in-flight deliveries
      answered with safe 503 (never a false-success 200), retryable
      failures propagated as HTTP 503 so Telegram redelivery retries them,
      permanent failures acknowledged with 200 and never re-executed,
      missing-client outbound actions never falsely processed, and honest
      at-least-once delivery wording (ADR-0032).
- [x] Phase 2 configuration contracts (ADR-0024): TELEGRAM_INGRESS_ENABLED
      flag; BOT_TOKEN / WEBHOOK_SECRET / OWNER_TELEGRAM_ID validated formats
      (values never echoed); TARGET_CHANNEL non-secret username validation;
      readiness fails closed on invalid values and while ingress is enabled
      without its required secrets; offline mode without BOT_TOKEN.
- [x] Authorization foundation (ADR-0026): owner bootstrap identity + active
      D1 admins; six approved roles with the verbatim permission map;
      disabled admins and unknown users unauthorized; numeric IDs only.
- [x] Command routing contracts (ADR-0026): allowlist /start /help /status
      /version; typed actions (send_message / answer_callback / noop /
      denied) separate from HTTP routing; minimal Persian denial for
      unauthorized senders; no role-mutation endpoints; bot-target safety —
      commands addressed to another bot ignored (`command_for_other_bot`,
      case-insensitive matching when an expected username is configured).
- [x] Telegram Bot API client boundary (ADR-0026): getMe / sendMessage /
      editMessageText / answerCallbackQuery; injectable fetch; strict
      timeout; single attempt (no retry storm); `redirect: "error"`; bounded
      1 MiB response streaming on success and error paths (ADR-0028);
      retryable/permanent error classification; safe retry_after parsing;
      HTML parse mode only; runtime Telegram-safe HTML gate.
- [x] Callback data contract `a:<base64url_token>` (≤ 64 bytes) with the
      `admin_action_tokens` repository boundary (single-use, user-bound,
      expiring) and pre-database input validation (ids, timestamps, token
      shape, approved permissions, bounded action/payload, JSON-object
      payload); full admin menu deferred to Phase 9.
- [x] Telegram-safe HTML escaper/builder/validator: `&<>` escaping,
      allowlisted tags, URL-parsed https-only link canonicalization with
      attribute escaping (ADR-0029), validator accepts exactly builder
      output, Persian/RTL/emoji intact, hostile markup rejected.
- [x] Test suite for every Phase-2A test category plus the correction
      categories (reclaim/retry, bounded reading, adversarial links,
      redirect safety, target safety, token validation), all offline;
      Phase 1A suites remain green.

DEFERRED to Phase 2B (live wiring): real BOT_TOKEN / WEBHOOK_SECRET /
OWNER_TELEGRAM_ID / TARGET_CHANNEL configuration in Cloudflare, webhook
registration, live Telegram traffic, degraded-readiness semantics.

### Phase 2 (umbrella) — remaining after 2A/2B

- [x] Update claim + duplicate handling in D1 (200 on duplicates of PROCESSED
      updates, no side effects). _(Phase 2A; reclaim and lease semantics per
      ADR-0027/0030 — failed-retryable rows and expired-lease claims are
      retried through Telegram redelivery, processed and permanent failures
      stay terminal, in-flight deliveries answer 503)_
- [x] Admin identity, atomic permissions, fail-closed authorization.
      _(Phase 2A)_
- [x] Deterministic Telegram HTML renderer: escaping, allowlist, length
      enforcement, safe splitting, RTL/bidi, deterministic footer. _(admin
      subset in Phase 2A; full editorial renderer later)_
- [ ] `degraded` readiness semantics per ADR-0015 (ready/degraded/not_ready).

## Phase 3 — job/queue framework and idempotency ⬜

- [ ] `pixel-jobs`/`pixel-dlq` queue bindings (planned resource names per
      ADR-0016) and envelope schema validation — Zod introduced here
      (ADR-0010), replacing the Phase-0 ack-all skeleton per ADR-0011.
- [ ] D1-backed job claim queries with leases; retry policy with full jitter.
- [ ] Deterministic idempotency keys wired to all externally visible actions.
- [ ] Cron dispatch of due work (no inline fetching/publishing).

## Phase 4 — source registry and initial connectors ⬜

- [ ] Source registry validation (`pixel_source_registry_v1.json` schema).
- [ ] Connector contract + fixtures; RSS/Steam/YouTube/Reddit/GitHub first.
- [ ] Conditional GET, budgets, adaptive intervals, SSRF guards, caps.

## Phase 5 — story/claim/evidence engine ⬜

- [ ] Fingerprints, entity aliases, deterministic matching + thresholds.
- [ ] AI adjudication path (compact claim sets) and decision persistence.

## Phase 6 — AI adapters, prompt contracts and Persian editorial ⬜

- [ ] Provider routing with fallbacks; Zod-validated semantic outputs.
- [ ] Immutable prompt versions; Persian editorial drafts; fact guard.

## Phase 7 — media engine and album publisher ⬜

- [ ] Media candidates, rights policy, R2 temporary storage, album planning.
- [ ] Telegram upload with `file_id` reuse and R2 retention cleanup.

## Phase 8 — publication scheduler, edit and correction ⬜

- [ ] Tehran-window scheduling, anti-robot rules, priority classes.
- [ ] Edit/correction workflows; failed-publication idempotency.
- [ ] GATE (ADR-0032): publishing-side duplicate mitigation and
      reconciliation (outbox-style per-publication/per-message
      reconciliation over `publications` / `publication_messages`) MUST be
      designed, implemented, and tested BEFORE autonomous channel publishing
      is enabled — exactly-once database claim ownership does not imply
      exactly-once Telegram message delivery, and channel-facing posts need
      stronger at-most-once protection than the webhook ingress provides.

## Phase 9 — admin Telegram screens ⬜

- [ ] Command map, screens, opaque action tokens, multi-step sessions.

## Phase 10 — security hardening and budget controls ⬜

- [ ] Security test suite (webhook spoofing, replay, SSRF, injection).
- [ ] Budget counters and soft-limit enforcement.

## Phase 11 — shadow mode ⬜

- [ ] 7–14 day shadow run instrumentation and blueprint §25 metrics gates.

## Phase 12 — private test channel ⬜

- [ ] Test-channel publication verification on real clients.

## Phase 13 — production rollout ⬜

- [ ] `safe_auto` → `auto` staged rollout with final default `AUTO`.

## Tooling maintenance backlog ⬜

- [ ] ESLint major evaluation: the pinned ESLint 9.x release used by the
      quality gate prints an end-of-support warning during `npm ci`. Evaluate
      and, if fully compatible, adopt the supported ESLint major in a
      dedicated tooling-maintenance slice — NOT inside a feature/correction
      phase (recorded during the Phase 1A correction pass).

### Phase 1B — Preview infrastructure provisioning

- [x] Provision isolated D1 database `pixel-db-preview`.
- [x] Add Wrangler `preview` environment and real D1 binding.
- [x] Apply migration 0001 to remote preview D1.
- [x] Deploy and verify `pixel-preview`.
- [x] Connect the GitHub repository through Cloudflare Workers Builds.
- [ ] Keep production infrastructure unprovisioned until its release gate.
