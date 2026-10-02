# Roadmap

Phase order follows blueprint §26 ("Roadmap implementation order"). Phases
**0** and **1A** are marked complete; everything else is pending and
intentionally not started.

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

## Phase 2 — Telegram webhook, auth, RBAC and renderer ⬜

- [ ] `POST /telegram/webhook`: constant-time secret validation, POST/JSON
      enforcement, body caps, minimal envelope parsing.
- [ ] Update claim + duplicate handling in D1 (200 on duplicates, no side effects).
- [ ] Admin identity, atomic permissions, fail-closed authorization.
- [ ] Deterministic Telegram HTML renderer: escaping, allowlist, length
      enforcement, safe splitting, RTL/bidi, deterministic footer.
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
