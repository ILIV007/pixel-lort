# Roadmap

Phase order follows blueprint §26 ("Roadmap implementation order"). Phases
**0**, **1A**, **2A**, and **2B** are marked complete; **Phase 1B is
PARTIAL in a specific way**: the PREVIEW infrastructure is provisioned and
deployed (owner-executed; see the "Phase 1B — Preview infrastructure
provisioning" section at the end of this document), while PRODUCTION
infrastructure stays intentionally unprovisioned until its release gate.
**Phase 3** is implemented and REVIEWED (code + tests + docs, application
version 1.3.1 at the v1.3.1 review-correction release) and its engine was
subsequently ACTIVATED on the provisioned Preview environment by the
owner-authorized operational commit `57d6bd1` ("enable reviewed Phase 3
engine on provisioned Preview" — JOBS_ENABLED=true with both queue
producers and the consumer, after migration 0003 was applied remotely; see
the published Phase 3 handoff and `docs/RUNBOOK_PHASE3_QUEUE_SETUP.md`).
Local development defaults and production remain disabled/separate.
**Phase 4** is implemented on `phase/04-source-ingestion` (application
version 1.4.0, schema stays 3, ADR-0038/0039) with the new ingestion gate
shipped disabled everywhere. **Phase 6 is PARTIAL**: the Workers-AI-first
ADAPTER FOUNDATION is implemented on the review branch, UNDER INDEPENDENT
REVIEW (draft PR #11), and ships OFF everywhere with zero live inference —
see the Phase 6 section. Everything else is pending and intentionally not
started. Provisioned/deployed, implemented, reviewed, and activated are
DISTINCT statuses; they are never conflated in this document.

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

## Phase 1B — resource provisioning (owner-executed) ◐ (PARTIAL — preview provisioned, production intentionally unprovisioned)

PREVIEW-side provisioning is DONE (owner-executed; the itemized record is
the "Phase 1B — Preview infrastructure provisioning" section at the end of
this document): isolated preview D1 (`pixel-db-preview`), the real preview
binding, migration 0001 applied to remote preview, `pixel-preview`
deployed and verified, and the GitHub repository connected through
Cloudflare Workers Builds. Provisioned/deployed describes CLOUD RESOURCES,
not product readiness. Production remains intentionally unprovisioned:

- [ ] Owner-approved PRODUCTION Cloudflare resource provisioning per
      ADR-0016 naming (`pixel-db-production`; KV/Queues/R2 in their owning
      phases) — held until the production release gate.
- [ ] Production environment bindings and first PRODUCTION remote
      migration application (`wrangler d1 migrations apply DB --remote`),
      by or with explicit approval of the project owner.
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
- [x] v1.3.1 final review correction (ADR-0037 appendix): the claimed
      execution and its fenced terminal persistence run AWAITED inside the
      engine's no-try-escape boundary — a storage exception on any terminal
      write resolves the safe retry action (never a rejected promise);
      reviewer's 10-test persistence false/throw fault suite delivered
      verbatim (10/10); worker.queue-level producer→consumer round trip,
      entrypoint terminal-write fault retry/no-ack, and per-binding
      configuration checks added; maintenance settings SQL moved to the
      typed DB adapter; runbook schema-2 window and queue-attachment-vs-flag
      wording corrected.

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

## Phase 4 — source registry and initial connectors ◑ (implemented on `phase/04-source-ingestion`; ingestion gate ships disabled, post-review activation only)

Implemented per ADR-0038/0039 (application version **1.4.0**, schema **3** —
no migration 0004 required). No push, no deploy, no remote migration, no
source activation by this pass. The FREE-ingestion limitation and the
full-poll gating remain OPEN (`NOT_READY_FOR_INGESTION_ON_FREE`, see
`free-plan/`): no later round — including the AI deadline corrections of
1.10.6.1 — lifts these gates; lifting them requires the accepted Free-safe
design (`free-plan/FREE_SAFE_EXECUTION_DESIGN.md`) and an explicit owner
decision.

- [x] Source registry validation: the blueprint
      `pixel_source_registry_v1.json` is imported VERBATIM and Zod-validated
      at runtime (fail-safe — any invalid record disables the whole pass);
      implemented / configured / enabled / blocked are tracked as separate
      explicit statuses; Bluesky and IGDB remain recognized catalog entries
      without runnable handlers.
- [x] Idempotent seeding of `sources` + `source_state` (typed DB adapter):
      new rows insert fully with `enabled = 0`; repeated imports refresh
      ONLY registry-descriptor facts and NEVER owner-managed `enabled`/
      `priority` or existing runtime state.
- [x] Connector contract + five families with offline fixtures and
      documented real request contracts (ADR-0039 §1): RSS/Atom (generic,
      covers all seven registry RSS entries incl. bounded template lists,
      conditional GET with both validators), Steam News (GetNewsForApp v2,
      keyless, configured app watchlist, per-app limits), YouTube
      (playlistItems + videos details ONLY — search endpoint and video
      downloads schema-forbidden; API key via `X-Goog-Api-Key` HEADER),
      Reddit (approved OAuth API — client_credentials token POST + Bearer
      listings; NO unauthenticated scraping), GitHub releases (configured
      repositories, prerelease policy, bounded pagination, conditional GET,
      optional Bearer token).
- [x] Safe HTTP shared layer (ADR-0039 §2): HTTPS only; 10 s deadline
      covering HEADERS AND BODY; 2 MiB streamed byte cap (dishonest
      Content-Length never trusted); ≤ 2 manually validated redirects with
      per-hop re-validation and cross-origin credential stripping; positive
      host allowlists (the real SSRF boundary) + literal-layer rejection of
      IP literals incl. decimal/octal/hex encodings; honest Workers DNS
      limitation documented (no pretend DNS safety).
- [x] Safe XML (ADR-0039 §3): hand-rolled bounded scanner — DOCTYPE/ENTITY
      rejected outright, only predefined + numeric entities decoded, hard
      depth/element/text/attribute bounds, CDATA literal; zero new runtime
      dependencies (Zod remains the only runtime dependency).
- [x] Normalization (ADR-0039 §5): deterministic conservative canonical
      URLs (reviewed tracking denylist only — distinct items never
      collapse), HTML-as-data plain-text excerpts, deterministic content
      hashes, bounded raw provenance, validated timestamps, synthesized
      external ids for id-less feeds, stripDownloadLinks policy honored.
- [x] Scheduling + poll ownership (ADR-0038 §3/§4): bounded indexed due
      scan (EXPLAIN-verified index seeks); deterministic window idempotency
      keys; atomic reservation hold (crash-self-healing); blocked sources
      skipped with stable health reasons (no job, no network, no hot loop);
      one poll attempt per job with retry ownership split by failure class.
- [x] D1 safety (ADR-0038 §5/§6): atomic guarded commit (items
      `INSERT OR IGNORE` + fenced terminal state write — stale workers
      never overwrite newer polls); honest inserted/duplicate classification
      including two-row conflicts; atomic budget reservation BEFORE network
      (shared across overlapping polls, Asia/Tehran budget day, Retry-After
      as a TRUE lower bound).
- [x] Ingestion activation gate `SOURCE_INGESTION_ENABLED` (non-secret,
      default 'false', ships 'false' in local AND preview): gates due-source
      scheduling + poll-handler registration ONLY, never the jobs engine;
      ingestion-without-jobs and invalid-registry states fail closed
      (readiness 503).
- [x] Acceptance suites on real workerd D1: full pipeline (due → durable
      job → producer body → consumer → mocked HTTP → normalized items +
      fenced state), duplicate/304/replay dedup, stale-owner fencing,
      crash windows, budget races + Tehran day rollover, Retry-After floor,
      auth circuit, blocked-source isolation, gate matrix, query-plan
      proof; connector contract suites for all five families; SSRF/XML/
      normalization/security suites. Measured final-tree totals in the
      Phase 4 handoff.

## Phase 5 — story/claim/evidence engine ⬜

- [ ] Fingerprints, entity aliases, deterministic matching + thresholds.
- [ ] AI adjudication path (compact claim sets) and decision persistence.

_(The round 1.10.6 / 1.10.6.1 AI ADAPTER foundation does NOT complete any
part of this phase: the story/claim/evidence engine, the editorial fact
guard, and the durable AI caller remain future work — see the unchecked
items in Phase 6.)_

## Phase 6 — AI adapters, prompt contracts and Persian editorial ◒ (PARTIAL — adapter foundation implemented, UNDER INDEPENDENT REVIEW, OFF)

Status of this phase in one sentence: the adapter FOUNDATION is
implemented on the review branch, UNDER INDEPENDENT REVIEW (draft PR
#11), and OFF everywhere (`AI_ENABLED="false"` in every environment, zero
live inference). Green CI — or any correction round on top of the
foundation, including 1.10.6.1 — is NOT full independent acceptance.

- [x] Provider routing with fallbacks; Zod-validated semantic outputs.
      (Round 1.10.6: Workers-AI-first adapter foundation — versioned
      ai-policy-v1 allowlist, fail-closed draft service, per-provider
      budget authority on the existing `budgets` table (scope 'ai'),
      bounded Gemini HTTP adapter, terminal typed refusals, typed
      deferred outcomes. AI_ENABLED ships "false" everywhere; the Gemini
      fallback additionally stays OFF behind the unverified-eligibility
      gate; NO live inference has been performed or authorized.)
- [x] Immutable prompt versions; Persian editorial drafts. (Round 1.10.6:
      pixel-news-draft-v1 contract with untrusted-data framing.)
- [x] Bounded wall-deadline contract over the whole service path. (Round
      1.10.6.1: the budget-authorization wait, the provider call, and the
      post-success usage recording are ALL bounded by the same total wall
      deadline via a small injectable primitive; a late authorization —
      or one whose processing crosses the deadline — starts NO provider
      work; late rejections are absorbed (never unhandled, never
      resurrected); the Gemini adapter deadline covers HEADERS AND BODY
      with real abort attempts and a race that cannot be bypassed by a
      non-cooperating transport; non-cancellable D1 charges stay recorded
      conservatively (no refunds, documented); usage recording stays
      best-effort and never holds a successful draft hostage. Pinned by
      permanent red-first tests A1–A5/B1–B5/U1–U3.)
- [ ] Fact guard (evidence-id references alone do NOT prove a generated
      claim is true) — still FUTURE work.
- [ ] Durable caller wiring (job types, cron/queue, admin surfaces) —
      deliberately NOT in the adapter rounds.
- [ ] Story engine / Phase 5 adjudication consumption — NOT complete and
      not claimed by rounds 1.10.6 or 1.10.6.1.

Next path AFTER the 1.10.6.1 corrections close: return to the
news/claim/evidence engine plan (Phase 5) and the real product path,
with an INDEPENDENT owner decision on the Free-ingestion limitation (see
the Phase 4 note and `free-plan/FREE_SAFE_EXECUTION_DESIGN.md`). Executing
those phases is NOT part of the adapter correction rounds.

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

_(PREVIEW-ONLY record: "provisioned/deployed" below describes CLOUD
RESOURCES, not product readiness. It does NOT mean any product phase is
implemented, reviewed, or activated — for example Phase 4 ingestion and
the AI path ship disabled everywhere. Production stays unprovisioned by
design; see the Phase 1B section above.)_

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
