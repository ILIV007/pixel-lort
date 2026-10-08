# Roadmap

Phase order follows blueprint §26 ("Roadmap implementation order"). Phases
**0**, **1A**, **1B**, **2A**, and **2B** are marked complete; **Phase 3** is
implemented OFFLINE (code + tests + docs on
`phase/03-job-queue-engine`, application version 1.3.1 after the v1.3.1
review-correction release) with live queue
activation gated on the operator runbook; everything else is pending and
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

_(The Phase 2B live wiring below completed the deferred items: real secrets
in Cloudflare, webhook registration, and live Telegram traffic on the
preview Worker. `degraded` readiness semantics remain open under the Phase 2
umbrella.)_

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

## Phase 3 — job/queue framework and idempotency ◑ (implemented offline; activation gated)

Implemented on `phase/03-job-queue-engine` (application version **1.3.1**,
schema **3** via incremental migration 0003; ADR-0036 with review
corrections ADR-0037). No resources were
provisioned and nothing was deployed by this pass — activation follows
`docs/RUNBOOK_PHASE3_QUEUE_SETUP.md` after independent review.

- [x] v1.3.1 review corrections (ADR-0037, six reviewer regression tests
      pinned): (1) ONE canonical wire transfer contract — producers send the
      Zod-validated envelope OBJECT, consumers normalize JSON-encoded
      strings defensively through the same validation; the real
      producer → delivered body → consumer path executes with NO manual
      JSON round trip. (2) The attempt budget is enforced AT the atomic
      claim/recovery boundary — a spent-budget row (including a crashed
      final generation with an expired lease) dead-letters WITHOUT
      re-execution, fenced and persisted before any ack. (3) Strict
      activation gating — validation runs before the flag is read, an
      enabled engine requires DB + JOBS + DLQ bindings, and `/health/ready`
      returns 503 for invalid or incomplete activation.

- [x] Envelope schema validation with Zod (ADR-0010; strict `{version, jobId,
type, attempt, traceId}` reference-only envelope) and per-type Zod
      payload schemas; canonical (key-sorted) payload storage with size
      bounds at creation and re-validation before execution.
- [x] Durable lifecycle on the EXISTING `jobs` table: idempotent creation
      (UNIQUE `idempotency_key`; conflicting same-key type/payload is a
      reported conflict, never an overwrite), atomic claim awarding one
      execution generation (`attempts + 1`) with a 2-minute lease,
      generation-fenced terminal transitions (succeeded / retry_wait /
      dead_letter), stale-owner rejection, terminal immutability, and
      atomic reclaim of expired-lease claims by delivery or by the bounded
      cron recovery scan. Migration 0003 adds `dlq_delivered_at` +
      `idx_jobs_dlq_pending` for DLQ-delivery reconciliation (schema 3).
- [x] Reliable dispatch (blueprint §6 order): durable-create-FIRST, then
      reference-only enqueue; both uncertainty windows solved (failed/unknown
      enqueue → recoverable row; lost queued marker → grace-window re-kick);
      bounded, indexed, deterministic cron scans (`run_after ASC, priority
DESC, id ASC LIMIT 25`); overlapping crons produce duplicate REFERENCES
      that claim fencing absorbs — no duplicate durable effects; cron never
      executes handlers.
- [x] Consumer replacing the Phase-0 ack-all skeleton (ADR-0011): validated
      dispatch → D1 claim → registered handler → fenced persistence →
      persist-before-ack. Full decision table for duplicate/not-due/
      active-lease/expired-lease/missing/poison/cancelled/storage-failure/
      lost-fence deliveries; retry NEVER acknowledged before its D1 schedule
      (`run_after`) is durably persisted. Bounded exponential backoff with
      full jitter (injected clock/random, 2s base / 1h cap), `retry_after`
      floor support, `max_attempts` 3 default (5-attempt P0 publication
      policy documented, not built), no sleeps, no blind retries of
      permanent/semantic errors.
- [x] Poison handling and DLQ: unregistered types and corrupt payloads
      dead-letter fail-safe (no fake handlers, no hot loops); malformed
      envelopes/unsupported versions acknowledged without durable mutation;
      exhaustion → durable `dead_letter` then bounded SAFE reference to the
      DLQ (no payload/credentials/provider text) reconciled from
      `dlq_delivered_at`; platform (`max_retries`) DLQ path needs no D1
      mutation (cron reclaim + re-dispatch converge on D1). Controlled
      offline-documented operator replay procedure (no replay UI/endpoint).
- [x] Fail-closed activation: `JOBS_ENABLED` flag (default false) preserves
      the exact Telegram-only deployment when off; enabled-but-misconfigured
      paths (missing DB/JOBS/DLQ bindings) never dispatch and never
      acknowledge uncertain work. Preview wrangler bindings DECLARED
      (`JOBS`→`pixel-jobs-preview`, `DLQ`→`pixel-dlq-preview`, consumer with
      `dead_letter_queue`, `max_retries` 3, batch 10/5s) — resources are
      provisioned by the operator runbook ONLY. Production bindings remain
      future-only.
- [x] One harmless registered handler proves the engine end-to-end:
      `jobs.maintenance_heartbeat` (idempotent D1-only settings upsert in
      the dedicated `jobs_maintenance:` namespace). No public smoke
      endpoint; working Telegram commands remain synchronous.
- [x] Real-workerd D1 acceptance suites (store lifecycle, engine, consumer
      decision table, DLQ reconciliation, entrypoint activation matrix) +
      unit contract/config suites; full baseline remains green (see the
      Phase 3 handoff for recorded numbers).

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

### Phase 2B — Preview live wiring and admin UI language ✅ (delivered v1.2.5; review corrections v1.2.6; merged to main `d7872db`)

- [x] Owner-authorized preview live wiring: BOT_TOKEN / WEBHOOK_SECRET /
      OWNER_TELEGRAM_ID configured as Cloudflare secrets (never in the
      repository), `TELEGRAM_INGRESS_ENABLED=true` on the preview
      environment only, webhook registered, live Telegram traffic verified
      (operator runbook: `handoff/PHASE_02B_PREVIEW_TELEGRAM_WIRING.md`).
- [x] Admin UI language feature (ADR-0034; v1.2.5): English default,
      per-admin `/language en|fa` preference persisted in the dedicated
      `admin_ui_language:` settings namespace with owner bootstrap,
      authorization, private-chat and non-edited-message guards, honest
      persist-first acknowledgements, and STRICT separation from
      editorial/channel language.
- [x] Independent review corrections (v1.2.6 — CHANGES REQUIRED verdict
      resolved): preference ordering re-fenced by VALIDATED Telegram
      message-order metadata `(date, message_id)` after Telegram's documented
      update_id randomization following one idle week (update_id retained as
      the durable deduplication boundary; ADR-0035); safe atomic corrupt-row
      recovery (`json_valid` guard BEFORE `json_extract`; malformed JSON and
      valid-JSON-invalid-types rows repaired by the next legitimate write
      inside the same namespace); delivery integrity normalized (executable
      bits verified against the index with `core.filemode=true`, handoff
      file counts corrected) plus the final lockfile fix restoring
      `word-wrap@1.2.5` inside an internally consistent lock (application
      versions stayed 1.2.6).
- [x] Reviewer regression suites added and green (message-order fencing,
      corrupt-row recovery); full gate re-run on clean installs at every
      round.
