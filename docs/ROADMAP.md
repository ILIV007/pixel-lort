# Roadmap

Phase order follows blueprint §26 ("Roadmap implementation order"). Only
**Phase 0** items are marked complete; everything else is pending and
intentionally not started.

## Phase 0 — product/config freeze + repository foundation ✅ (current)

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

## Phase 1 — repository, CI, bindings and migrations ⬜

- [ ] D1/KV binding declarations + resource provisioning policy (explicit
      owner approval; planned resource names per ADR-0016).
- [ ] D1 migrations from preserved `pixel_schema_v1.sql` (append-only files).
- [ ] `GET /version` with safe build metadata: application version, commit
      identifier, schema version, deployment environment (ADR-0012);
      development-safe defaults locally.
- [ ] Repository layer for D1 access with idempotent writers.
- [ ] CI extension for migration dry-run checks.

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
