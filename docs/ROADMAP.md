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
see the Phase 6 section. **Phase 5 is PARTIAL in a bounded way (Phase 5A
ACCEPTED offline — R1.12 ruling; Phase 5B Evidence Guard v1 — R1.12,
ADR-0042 addendum — implemented, UNDER INDEPENDENT REVIEW; Phase 5C-1
durable fingerprints + candidate discovery — R1.13, ADR-0043 —
implemented, UNDER INDEPENDENT REVIEW; Phase 5C-2 conservative candidate
assessment — R1.14, ADR-0043 addendum — implemented, UNDER INDEPENDENT
REVIEW; Phase 5C-3 exact-content draft reuse with preserved provenance —
R1.15, ADR-0043 addendum — implemented, its R1.15.2 offline exact-content
reuse correction INDEPENDENTLY ACCEPTED; Phase 5D controlled entity
aliases → durable story mentions — R1.16, ADR-0044 — implemented and its
R1.16.1 entity-mentions corrections (Posidon probes C1/U1/R1) INDEPENDENTLY
ACCEPTED offline; and Phase 5E-1 bounded event-relation evaluation →
durable, evidence-referenced decisions — R1.17, ADR-0045 — implemented,
UNDER INDEPENDENT REVIEW)**: the FIRST
integrated local source→draft vertical path (`editorial.prepare_draft`)
ships OFF everywhere behind its own fail-closed `EDITORIAL_ENABLED` gate
with zero live inference, Phase 5B adds the limited Evidence Guard
report on the same path, and Phase 5C-1 adds durable multi-owner story
fingerprints with a bounded, honest candidate-discovery report — NO
merge, NO truth verification — Phase 5C-2 adds the pure, versioned
candidate-ASSESSMENT derived only from those discovery signals, and
Phase 5C-3 adds VERIFIED exact-content draft reuse with preserved
provenance (the copied news costs no second inference; one stable result
per exact content enforced in SQL; the R1.15.2 snapshot-identity +
null-guard correction was independently ACCEPTED for the offline
exact-content reuse capability), and Phase 5D adds CONTROLLED entity
alias mentions: registered Persian/English aliases resolve to ONE entity
id and the connection lands DURABLY in `story_entities` — mention only,
confidence 0, no fuzzy/semantic matching, the news text never adds to
the catalog —
candidate-ASSESSMENT derived only from those discovery signals — NO
merge, NO truth verification, NEVER an unrelatedness conclusion — and
Phase 5E-1 adds the FIRST bounded event-relation slice: shared-entity +
fingerprint candidates from bounded index reads, a bidirectional evidence
bundle, the SEPARATE `event_relation` AI task over the SAME budget/
allowlist/deadline protections, and MODEL-PROPOSED verdicts (`*_proposed`
/ `insufficient_evidence`) recorded as a versioned `eventRelation` ledger
inside the SAME fenced draft INSERT with REAL `event_relation` ai_runs
rows and the SQL candidate-basis gate — proposals, never truth, never a
merge — see
the Phase 5 section. Everything else is
pending and intentionally not
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

## Phase 5 — story/claim/evidence engine ◒ (PARTIAL — Phase 5A ACCEPTED offline; Phase 5B Evidence Guard v1, Phase 5C-1 fingerprints/candidate-discovery, Phase 5C-2 conservative candidate-assessment and Phase 5C-3 exact-content draft reuse with preserved provenance (R1.15.2 correction independently ACCEPTED offline) implemented; Phase 5C-4 deterministic candidate-MATCHING report (V4 Phase 5.2 local slice, version 1.18.0) implemented behind its independent default-OFF gate; Phase 5.3 deterministic candidate-ADJUDICATION report (V4 local slice, version 1.19.0) implemented behind ITS independent default-OFF gate (+ the sibling matching gate); Phase 5D controlled entity aliases → durable story mentions implemented with its R1.16.1 corrections INDEPENDENTLY ACCEPTED offline; Phase 5E-1 bounded event-relation evaluation → durable evidence-referenced decisions implemented; Phase 5E-1 UNDER INDEPENDENT REVIEW, OFF)

- [x] **Phase 5A (R1.11, ADR-0042): the FIRST integrated local source→draft
      path — ACCEPTED OFFLINE by independent review (R1.12 round ruling; the
      offline acceptance covers the implemented surface: code + tests +
      docs; it is NOT a deployment/activation approval and the gate stays
      OFF)** — the `editorial.prepare_draft` durable job type on the
      EXISTING engine with the independent fail-closed `EDITORIAL_ENABLED`
      gate (shipped "false" everywhere; gate off = the ADR-0040 lossless
      policy pause), deterministic versioned identity per item snapshot,
      stored-hash snapshot verification (typed terminal mismatch), ONE
      conservative story (discovered/unknown, confidence 0) per snapshot,
      the single `source_report` claim (unverified, confidence 0,
      traceable object_text), `mentions` evidence, the REAL
      `createAiDraftService` call behind the real budget authority, and
      the fenced atomic commit (story + claim + evidence + ai_runs + READY
      Persian draft + `processed` item status) with job/generation/lease
      ownership predicates inside SQL on schema 3 (no migration). Honest
      at-least-once crash windows; replay after commit is free. Proven by
      the ten-scenario D1 integration suite, unit contracts, and the
      offline demo runner (`npm run demo:editorial`). NOT deployed, NOT
      activated, zero live inference.
- [x] **Phase 5B (R1.12, ADR-0042 addendum): Evidence Guard v1 — a LIMITED
      evidence control, explicitly NOT the full Fact Guard** — a pure,
      deterministic evaluator (no SQL/network/SDK/model call/clock) judges
      every model claim stored in a draft against the SAME verified source
      snapshot and the SAME traceable excerpt that produced it: reference
      validity, non-empty text, evidence-vs-snapshot identity, and direct
      textual match. Typed outcomes stay honest: `direct_text_observed` is
      a text-presence observation (NEVER verified/confirmed);
      paraphrase/translation/truncation are
      `unresolved_requires_further_verification` (NEVER false); invalid
      references/snapshot identities are distinct failures. The versioned
      report (`guardVersion: 1`, snapshot identity, sorted stable
      reasonCodes, fixed limitations, `unassessedFields: [headlineFa, summaryFa]`) rides INSIDE `drafts.document_json` by the
      SAME fenced atomic commit — ZERO new SQL statements, schema stays 3,
      no migration. Replay stays free (no provider call, no charge,
      byte-identical document); pre-5B drafts read honestly as `absent`
      (no backfill); `ready` still means only "a draft is stored" — NO path
      to validated/auto_approved/published was added. All gates stay OFF;
      free ingestion/full-poll stays NOT_READY.
- [x] **Phase 5C-1 (R1.13, ADR-0043): durable story fingerprints + LIMITED
      candidate discovery — explicitly NOT a merge** — pure, versioned,
      collision-safe fingerprints (≤3 signals per stored item: the stored
      `canonical_url` VERBATIM; a `content_hash` digest of the FULL
      title+body composition that is INDEPENDENT of sourceItemId/sourceId;
      a weak `title_key` under the ONE limited normalization NFC +
      whitespace collapse + trim — never case folding, never Persian–Latin
      digit, negation, or unit equivalence). Index rows are story-scoped
      (`sc1:<64-hex digest>:<storyId>` on the EXISTING
      `story_fingerprints(kind,value)` PK — NO new DDL, schema stays 3):
      MANY stories can share one digest while every (story, signal) stays
      one row, and no write ever replaces another owner (plain fenced
      INSERT..SELECT with a NOT EXISTS own-row guard — never INSERT OR
      REPLACE). The `editorial.prepare_draft` handler performs AT MOST 3
      parameterized prefix-range lookups (≤9-row probe each) AFTER
      validation/reuse and BEFORE any provider work; the outcome is a
      versioned `candidateDiscovery` report (typed reader with REAL v1
      invariant validation — `absent`/`unsupported_version`/`malformed`
      stay distinct) riding INSIDE `document_json` next to `evidenceGuard`
      by the SAME fenced atomic batch (≤3 extra INSERT statements, same
      fence AND snapshot predicates — a lost fence or changed snapshot
      writes NO draft AND NO fingerprint). Honest boundaries: candidates
      are a PROPOSAL at the lookup moment — equal URL/text/title NEVER
      proves one event or independent sources; nothing merges, no trust/
      confidence raise, no duplicate marking; overflow is recorded (9-row
      probe, ≤8 candidates reported with an explicit truncation flag);
      nothing found reads `no_candidates_observed` (never "unique story");
      only `sc1`-indexed stories are covered (NO historical backfill);
      concurrent commits may not see each other (exactly-once discovery
      NOT claimed); a lookup DB error maps to the engine's typed bounded
      retry with ZERO provider calls. Replay stays free; all gates stay
      OFF; free ingestion/full-poll stays NOT_READY.
- [x] **Phase 5C-2 (R1.14, ADR-0043 addendum): conservative, durable
      candidate ASSESSMENT — explicitly NOT a merge and NEVER an
      unrelatedness conclusion** — a PURE, deterministic evaluator derives
      a versioned `candidateAssessment` report (`assessmentVersion: 1`)
      from the SAME draft's `candidateDiscovery` signals at the lookup
      moment: per candidate, exactly what was OBSERVED —
      `full_content_equality_observed` ONLY when the versioned
      `content_hash` fingerprint (the FULL title+body composite, NOT the
      snapshot hash) is really shared; `shared_url_observed` (same stored
      URL value only); `shared_title_observed` (the WEAK limited
      normalization; NO fuzzy matching, translation, or digit conversion);
      `multiple_signals_observed` with ALL real reasons kept and
      correlated signals NEVER counted as independent confirmations. The
      report states its basis (discovery signals at the lookup moment,
      candidate data NOT re-fetched/validated), keeps `unassessed:
[same_event, truth, source_independence]`, preserves discovery
      truncation/overflow/coverage limits verbatim, carries
      `unrelatednessConcluded: false` FIXED — no candidate, invalid
      report, or missing information never becomes "definitely
      unrelated" — and adds NO confidence, probability, score, or
      threshold. It rides INSIDE `document_json` next to
      `candidateDiscovery` by the SAME fenced atomic commit with ZERO new
      SQL statements/execution calls (schema stays 3); replay stays free
      and byte-identical; pre-5C-2 drafts read `absent` (no backfill);
      `absent`/`unsupported_version`/`malformed` stay distinct; the typed
      reader validates the REAL v1 invariants INCLUDING cross-validation
      against the sibling discovery (mirrored candidates 1:1, verdicts
      re-derived, limits preserved). Acceptance tests (unit + REAL workerd
      D1: the three observed relations, Persian-vs-Latin digits NOT
      equated, batch statement-shape proof, snapshot/lease races write
      nothing, replay byte-stability, historical absent/foreign handling);
      demo extended to the three required pairs + a solo item. All gates
      stay OFF; free ingestion/full-poll stays NOT_READY.
- [x] **Phase 5C-3 (R1.15, ADR-0043 addendum): EXACT-CONTENT draft reuse
      with preserved provenance — explicitly NOT a merge, NOT truth, NOT
      source independence** — when the FULL title+body composition of a
      second item is exactly identical, the item VERIFIEDLY reuses the
      existing stable draft result: a replay fast-path (one indexed
      attachment read), then reuse from the SAME content_hash lookup the
      discovery already produced (zero extra probes) where every candidate
      must BOTH still own a usable ready draft AND REALLY equal the
      arriving full composed text byte-exact through at least one attached
      reference item (the fingerprint is only the locator; numbers,
      negations, units, Persian/Latin digits and truncation-equal excerpts
      are never equated), then a fenced reuse commit (the item's OWN
      deterministic source_report claim + mentions evidence + processed
      flip under the job fence + snapshot predicate + target-validity
      predicate) that ADDS the second provenance and NEVER rewrites the
      reused draft/story/report documents — confidence/trust untouched, NO
      ai_runs row (no provider call happened). Every normal commit
      additionally writes the group-unique exact-content anchor
      (`sc1:<digest>`, no story suffix): a concurrent second commit of the
      same exact content collides on the PRIMARY KEY, the WHOLE batch
      rolls back with a typed `contentTaken` outcome, the loser's REAL
      provider run stays recorded and charged (never presented as used),
      and its bounded retry resolves into verified reuse — AT MOST ONE
      stable result per exact content, enforced in SQL on schema 3 (no
      migration). Honest limits recorded: the ≤9-row probe page bounds
      reuse visibility (overflow logged); pre-R1.13 (non-sc1) historical
      stories are never consulted (NO backfill); exactly-once provider
      behavior is NOT claimed; replay of first and reused items stays
      free. Sequential identical-content items cost ZERO provider calls.
      Proven by unit contracts, 15 REAL-D1 acceptance tests (registered in
      test:db), and the rewritten demo (`npm run demo:story-candidates`,
      now five artificial items with per-path provider-call and local SQL
      proxy cost tables). All gates stay OFF; free ingestion/full-poll
      stays NOT_READY.
- [x] **Phase 5C-3 CORRECTION (R1.15.1, v1.10.1): exact-content reuse
      correctness — three independent Posidon counterexamples fixed INSIDE
      the existing contract (no new capability, no redesign, schema 3
      untouched)** — recorded 3 failed / 15 skipped RED on the 1.10.0
      baseline, green after: **(P1)** the replay fast-path succeeds ONLY on
      a PROVABLE relation — the story's ready draft must still carry the
      IMMUTABLE document basis (sourceReport + evidenceGuard snapshot
      identity) that byte-verifies the CURRENT full composed text; a NEW
      snapshot of an already-attached item is never acknowledged by the OLD
      attachment and takes its own honest path (old provenance untouched,
      never reattributed); same-snapshot replay stays free and
      side-effect-free, now PROVEN through a REAL re-claimed handler
      execution (enqueue=existing alone never exercised the fast-path
      handler); **(P2)** the reuse equality basis moved from mutable
      source_items rows to the DRAFT RESULT'S OWN immutable record
      (untruncated documents compare against `sourceReport.excerptText`;
      truncated ones through the guard-hash IDENTITY BRIDGE to the original
      reference row), and the compared basis — the exact `document_json`
      bytes AND the original reference-row identity as read — is carried
      INTO the reuse commit's SQL predicate on ALL reuse artifacts (never a
      JS re-read): a reference mutated between verification and commit
      yields ZERO effects with the typed `targetInvalid` retry (the
      reviewer's `claims=1` assertion unweakened), and a reference mutated
      BEFORE verification is refused by the immutable basis (regression
      recorded); **(P3)** the group anchor's owner is resolved by ONE
      parameterized PK point read on `(kind,value)` INDEPENDENT of the ≤9-row
      discovery probe page (no LIMIT growth, no unbounded scan) — a valid
      ready owner outside the probe page reuses with ZERO new provider
      calls; when the anchor exists but NO candidate verifies, the handler
      returns the new typed PERMANENT `editorial_exact_content_blocked`
      BEFORE any provider work — the paid provider→conflict→retry cycle is
      never entered, and no anchor is ever taken over or deleted; real-race
      semantics unchanged (both providers may run, the loser's REAL run
      stays recorded and charged, the anchor PK rollback contract is
      untouched). Documented assertion-basis change (sanctioned): the reuse
      decision verifies the draft's immutable document record, so seeded
      historical reuse-target drafts carry the PRODUCTION document shape;
      `'{}'` foreign shapes are honestly NOT reusable. Suite now 20 REAL-D1
      tests + 19 unit tests; full gate re-run green (110 files / 1489
      tests); version 1.10.1; no Phase-5-completion claim.
- [x] **Phase 5C-3 CORRECTION (R1.15.2, v1.10.2): the remaining
      snapshot-identity boundary of the reuse relation + defensive reader
      null guards — TWO bounded CHANGES_REQUIRED items fixed INSIDE the
      existing contract (no new capability, no phase expansion, schema 3
      untouched, RED on the 1.10.1 baseline recorded, green after)** —
      **(Q1)** the reuse relation now carries a VERSIONED deterministic
      claim identity derived from (target story, item id, CURRENT snapshot
      hash) — `exactContentReuseClaimId` — and the replay fast-path
      additionally requires the stored relation's claim id to EQUAL the
      current snapshot's versioned identity before answering success:
      composed-text equality of the old draft's immutable basis is
      necessary but NEVER sufficient (an edge-space title change under the
      pre-existing trim contract yields a NEW snapshot with byte-equal
      composed text whose relation does NOT exist yet — the old relation
      must never acknowledge it as processed); the new snapshot's own
      relation + processed flip land through the SAME fenced atomic reuse
      commit with ZERO new provider calls; the old relation stays intact;
      same-snapshot replays stay write-free and charge-free; old-format
      relations take the explicit conservative compatibility path (never
      proof of the current snapshot; a verified new identity is added ONE
      time through the fenced path — no backfill, no historical rewrite);
      normal-story identity helpers untouched; **(Q2)**
      `readReuseDocumentBasis` guards every level (document, sourceReport,
      evidenceGuard, snapshot) BEFORE member access: malformed PRESENT
      null/primitive/array data reads as the documented unusable-basis
      `null` instead of throwing, and is never silently reinterpreted as
      the legitimate absent-legacy shape (pre-R1.12 absence preserved; all
      real builder round-trips preserved). Tests: the two Posidon probe
      blocks appended to the EXISTING suites + permanent table-driven
      null/primitive/array mutation cases + four new integration contract
      tests (durable versioned distinction, changed-text independent path,
      write-free same-snapshot replay, verification→commit mutation
      window); integration 20→25, unit 19→37, full gate 110 files / 1512
      tests; version 1.10.2; no Phase-5-completion claim.
      INDEPENDENT ACCEPTANCE (reflected here in the CURRENT text only —
      the historical report above is untouched): the R1.15.2
      snapshot-identity + null-guard correction for the offline
      exact-content reuse capability was independently reviewed and
      ACCEPTED by Posidon; the accepted contract is the one R1.16
      preserves byte-for-byte on the reuse paths.
- [x] **Phase 5C-4 (V4 Phase 5.2 local slice, v1.18.0): DETERMINISTIC
      candidate-MATCHING report — scores + reasons, ambiguity/overflow
      honesty, and the identical-news vs similar-event separation —
      explicitly NOT a merge, NOT a threshold, NOT same-event proof** —
      the owner's V4 directive explicitly lifted the former "wait for the
      5.2 decision" gate FOR LOCAL design/build/test: a PURE, versioned
      (`matchingVersion: 1`) evaluator derives a `candidateMatching`
      report from the SAME draft's `candidateDiscovery` +
      `candidateAssessment` at the lookup moment and rides INSIDE
      `drafts.document_json` of the SAME fenced atomic commit (ZERO new
      SQL statements, ZERO provider calls, ZERO cost; schema 6 untouched).
      Per candidate: a TRANSPARENT score that is a canonical ONE-TO-ONE
      encoding of the observed signal set (fixed weights 1/4/8 make every
      non-empty subset sum unique — equal scores ⇔ identical observed
      sets; correlated signals never compound; NEVER a
      confidence/probability, never compared across reports, never a
      threshold — every candidate stays listed with its assessment
      verdict). Report level: `outcome` separates
      `identical_content_relation_observed` (ONLY the versioned
      content-composite fingerprint really matched — a LOCATOR for the
      verified 5C-3 reuse path, never itself a merge/dedup decision) from
      `similar_signals_only_observed` (any weaker combination — NEVER
      same-news evidence); `resolution` is honest about coverage:
      probe overflow or report truncation ⇒
      `unresolvable_incomplete_coverage` (no best-candidate claim), a tie
      at the top score over the SAME observed set ⇒
      `ambiguous_tie_observed`, otherwise
      `single_top_candidate_observed` — an observation of the list shape,
      never a confirmation; nothing observed stays
      `no_candidates_observed`/`no_candidate_to_resolve`. Fixed
      `unrelatednessConcluded: false`; the same `unassessed` tuple
      (same_event/truth/source_independence) rides verbatim; discovery
      truncation/overflow/coverage limits preserved verbatim; candidate
      data NOT re-fetched or re-validated. Gated by the INDEPENDENT
      fail-closed `EDITORIAL_MATCHING_ENABLED` flag (default 'false'
      everywhere — .env.example, .dev.vars.example, BOTH wrangler
      environments): flag OFF ⇒ the payload is absent and the accepted
      path stays byte-identical; flag ON adds zero statements. Typed
      reader validates the REAL v1 invariants INCLUDING cross-validation
      against BOTH siblings (mirrored entries 1:1 in the same order,
      verdicts AND scores AND outcome/resolution/topScore re-derived from
      the sibling's matched signals — a stored lie is malformed);
      `absent`/`unsupported_version`/`malformed` stay distinct; pre-5C-4
      drafts read absent (NO backfill); replay stays free and
      byte-identical. Evidence: unit suite (score subset-sum injectivity
      over all 7 non-empty subsets, determinism, outcome/resolution
      precedence incl. overflow-with-zero-candidates, fixed sets, reader
      negatives incl. 16 stored-lie cases) + REAL workerd-D1 integration
      suite (flag-OFF byte-identical accepted path with NO
      candidateMatching key; stale identical-content locator ⇒ reuse
      refuses + identical-content relation observed as a LOCATOR ONLY;
      weak-title path ⇒ similar_signals_only; two-story title tie ⇒
      honest ambiguous tie; 10-story overflow ⇒ unresolvable with the
      8-candidate truncated page; zero-new-SQL batch-shape equality
      flag-ON vs flag-OFF; snapshot race writes NOTHING; replay free and
      byte-stable). All gates stay OFF; free ingestion/full-poll stays
      NOT_READY; no Phase-5-completion claim.
- [x] **Phase 5.3 (V4 local slice, v1.19.0): DETERMINISTIC candidate-ADJUDICATION
      report — the identity-stance + merge-disposition layer over the 5C-4
      matching report — explicitly an ADVISORY projection that NEVER executes
      a merge** — the owner's V4 directive (2026-11-10) lifted the former
      "5.3 waits for an owner decision" gate FOR LOCAL design/build/test with
      the hard constraints (deterministic, versioned, bounded, conservative,
      default OFF, reversible, conflict-tested, no production-data change,
      never claim event identity from similarity or AI alone). A PURE,
      versioned (`adjudicationVersion: 1`, `mergePolicyVersion: 'mp1'`)
      evaluator derives a `candidateAdjudication` report from the SAME
      draft's `candidateMatching` (+ its discovery/assessment parents,
      cross-checked) at the lookup moment and rides INSIDE
      `drafts.document_json` of the SAME fenced atomic commit (ZERO new SQL
      statements, ZERO provider calls, ZERO cost; schema 6 untouched). Per
      candidate: ONLY the exact content-composite fingerprint equality is
      identity-grade (`exact_content_identity_observed` +
      `reuse_locator_supported` — an ECHO of the verified 5C-3 reuse locator
      path, never itself an executed merge); every weaker similarity defers
      to review (`identity_not_established_url_only`/`_title_only`/
      `_signals_only`, reasons carry `similarity_never_proves_identity`
      FIRST). Report level: the merge disposition precedence is fixed and
      tested — nothing observed ⇒ `no_ground_no_candidates` (reviewRequired
      false); incomplete coverage (probe overflow OR truncation) ⇒
      `defer_incomplete_coverage` (the SUPPRESSION policy adopted from the
      preserved sm1 proposal — an incomplete window never yields a merge
      proposal while the observed stances stay listed); ≥2 exact-identity
      candidates ⇒ `defer_conflict_multiple_identity_candidates` (a typed
      conflict record, NEVER auto-picked); exactly 1 ⇒
      `reuse_locator_single_exact_identity` (reviewRequired false); only
      weaker signals ⇒ `defer_similarity_only` (reviewRequired true).
      `reviewRequired` is DERIVED, never a stored opinion; every defer is
      ambiguous-or-risky ⇒ review, never a merge. The preserved UNMERGED sm1
      threshold proposal (ADR-0051) was reviewed as the recorded design
      INPUT: its suppression/ambiguity/weak-title concepts and its versioned
      policy id were ADOPTED in honest form; its integer-threshold
      same-story identity proposals and its multi-signal 'bonus' were
      REJECTED (a score cutoff claims identity from similarity — V4-forbidden;
      correlated signals never compound); its dangling OD-010 reference is
      recorded in ADR-0052 (no OD-010 exists in docs/OPEN_DECISIONS.md).
      Fixed `unrelatednessConcluded: false` (a reject is not ours to
      conclude); the same `unassessed` tuple (same_event/truth/
      source_independence) rides verbatim; discovery limits preserved
      verbatim; candidate data NOT re-fetched or re-validated; audit/
      provenance/version/conflict/undo properties BY CONSTRUCTION (the pure
      report mutates nothing — there is nothing to undo; provenance = the
      versioned basis labels + mirrored sibling outcome/resolution). Gated
      by the INDEPENDENT fail-closed `EDITORIAL_ADJUDICATION_ENABLED` (default
      'false' everywhere — .env.example, .dev.vars.example, BOTH wrangler
      environments) AND its sibling `EDITORIAL_MATCHING_ENABLED` — the flags
      NEVER imply each other (without the matching sibling the payload is
      honestly absent and a warn is logged). Typed reader re-derives stances/
      dispositions/reasons/mergeDisposition/reviewRequired from the sibling
      chain (a stored lie is malformed); `absent`/`unsupported_version`/
      `malformed` stay distinct; pre-5.3 drafts read absent (NO backfill);
      replay stays free and byte-identical. Evidence: unit suite 21 tests
      (stance totality over all 4 verdicts, fixed sets, disposition
      precedence incl. incomplete-beats-conflict, determinism, builder
      basis-mismatch negatives, 21 stored-lie reader cases) + REAL
      workerd-D1 integration suite 9 tests (flag-OFF byte-identical;
      adjudication-without-matching ⇒ absent + honest warn; single
      exact-identity ⇒ locator echo with NO story merge; weak-title ⇒
      similarity-only defer; TWO exact-identity candidates ⇒ typed conflict;
      9-story overflow ⇒ suppression with stances listed; zero-new-SQL
      batch-shape equality; snapshot race writes NOTHING; replay free and
      byte-stable). All gates stay OFF; free ingestion/full-poll stays
      NOT_READY; no Phase-5-completion claim.
- [x] **Phase 5.4 (V4 local round, ON the 1.19.0 tree): TESTS & SELF-REVIEW —
      the adversarial cross-cutting round over the delivered 5.1–5.3 surfaces;
      tests + docs ONLY (no product-code change, NO version bump, schema 6
      untouched, every gate stays OFF)** — the roadmap dimensions were mapped
      onto the EXISTING suites first and NEW tests were written ONLY for the
      proven gaps (no duplicated coverage): NEW REAL workerd-D1 adversarial
      suite 7 tests (crash mid-commit WITH both 5.2/5.3 gates ON → D1-layer
      batch failure → atomic rollback → honest retry recomputes FRESH coherent
      sibling reports; duplicate enqueue resolves the SAME durable job row;
      url+title_key mixed signals with UPDATED content →
      identity_not_established_signals_only defer; two same-name stories tie
      at the weak score → ambiguous_tie + similarity-only defer, NOT a
      conflict; version update at the same url → url-only defer, never a
      locator; duplicate content from TWO INDEPENDENT sources → typed
      conflict + every candidate-owned row byte-untouched + unassessed
      verbatim + raw_json preserved — the P1 false-merge proof; the P1
      provenance witness walk: item→draft chain preserved AND recomputable
      incl. the exact-content GROUP anchor) + NEW unit cells 3 tests (zero-
      candidates-under-overflow precedence; the ≥3-exact conflict boundary;
      the derived reviewRequired↔disposition coherence matrix). The recorded
      self-review lives at docs/reviews/PHASE_5_4_SELF_REVIEW.md (the
      bullet→test matrix, the four-layer false-merge analysis, the witness-
      chain analysis, three honest mid-round findings, and the explicit
      limitations: fake provider only, same_event/truth/source_independence
      unassessed BY DESIGN, BLOCKED_LIVE unchanged, NO Phase-5-completion
      claim). Gates re-run green on the final tree. Free readiness stays
      NOT_READY.
- [x] **Phase 5→6 GATE (V4 local round, on the 1.19.0 tree): the
      roadmap's «گیت ۵→۶» executed as a documented evidence-based review at
      docs/reviews/PHASE_5_TO_6_GATE.md — PASS FOR LOCAL ENGINEERING
      HAND-OFF (no Phase-5-completion claim; Posidon acceptance + live
      evidence still outstanding for every live surface)**: the
      wrong-merge safety verified as four INDEPENDENT layers (pure
      projections with zero new SQL — batch-shape equality suites; the
      only identity-grade output echoes the verified 5C-3 reuse path;
      typed conflicts never auto-picked; suppression precedes proposals
      under incomplete coverage) with the P1 independent-source proof
      (byte-untouched candidate rows + raw_json + unassessed verbatim);
      the real failures of Phase 5 listed WITH their fixes (R1.15.2
      accepted, R1.16.1 accepted, the VERSION.json drift caught by
      check:versions, the three 5.4 in-round findings); the unresolved
      assumptions tabulated (same_event/truth/source_independence
      unassessed, Gemini eligibility unverified, OD-009 open, live
      Cloudflare UNKNOWN, Free readiness NOT_READY); the evidence
      limitations restated as binding conditions carried INTO Phase 6
      (fail-closed flag discipline, additive-document pattern, no
      numeric-accuracy claims without a real benchmark, AI never replaces
      truth verification or provenance — proven structurally: claims stay
      `unverified`, the witness chain is recomputable, the conversion path
      launders nothing).
- [x] **Phase 6.3 (V4 local slice, v1.20.0, ADR-0053, ON the post-gate
      tree): the DETERMINISTIC FACT-GUARD report — the roadmap's ۶.۳
      bounded lexical layer, delivered in the established house shape
      (pure, versioned `factGuardVersion: 1`, bounded, deterministic,
      additive document key, typed reader, independent fail-closed
      EDITORIAL_FACT_GUARD_ENABLED default-OFF everywhere, ZERO new SQL,
      ZERO provider calls, ZERO cost, schema 6 untouched)** — per-claim
      OBSERVATIONS (never verdicts): witness (unwitnessed claims /
      foreign evidence basis), numbers (digit tokens NEVER folded across
      Persian/Latin/Arabic-Indic scripts; missing numbers flagged with
      bounded sorted token lists; ≤16-token scan bound with the honest
      capped note), quotation (guillemet/straight/curly spans observed
      verbatim; unclosed/empty/over-cap spans typed honest notes), rumor
      (the FIXED versioned non-exhaustive hedging-marker list observed on
      either side — claim hedges beyond its source OR the source's rumor
      language is NOT reflected in the claim (the promotion-to-fact risk)
      OR the benign reflected case), negation (a small FIXED token-bounded
      vocabulary — token equality OR the ZWNJ-attached نمی verbal prefix,
      substrings never match — with polarity asymmetry flagged in either
      direction, never a contradiction conclusion); reviewRequired DERIVED
      (any non-benign finding ⇒ true), the evidence guard's identity gate
      inherited, the ONE limited normalization inherited (never
      redefined), the Evidence Guard v1 contract FROZEN; the permanent
      limitation labels travel inside EVERY report and NO claim's stored
      `unverified` status is ever rewritten (asserted end-to-end on the
      real path: modelClaims AND facts_json); injection-like text is INERT
      DATA (observed lexically, never obeyed); the reader re-derives the
      code→lens mapping, token discipline, reviewRequired coherence, exact
      counts and identity coherence — a stored lie is malformed. Tests:
      unit 40/40 (incl. Persian-digit-vs-Latin non-folding, ZWNJ
      discipline, نیه/مانه never matching نه, the flagship promotion
      case, bounds, injection inertness, reader stored-lie cases) + REAL
      workerd-D1 integration 6/6 (flag-OFF byte-identical; flag-ON rides
      the SAME commit with ZERO new SQL — batch-shape equality; the
      honesty boundary end-to-end; flags never imply each other; replay
      free + byte-stable via the no-provider-port re-execution; snapshot
      race writes nothing). Free readiness stays NOT_READY; BLOCKED_LIVE
      unchanged.
- [x] **Phase 6.4 (V4 local slice, v1.21.0, ADR-0054, on the post-6.3
      tree): the END-TO-END PATH REVIEW — the roadmap's «۶.۴ مسیر
      سرتاسری» executed at full depth per the owner's FULLER-steps order:
      the REAL chain (durable source snapshot → durable job → REAL engine
      dispatch → REAL prepare-draft handler → REAL budget authority +
      allowlist ladder + wall deadline + output validation → REAL fenced
      commit → REAL /drafts review view → REAL /post_from_draft
      conversion) exercised with the ONE artificial piece being the
      provider PORT (the documented ADR-0042 §6 seam; zero network, zero
      live inference), re-verifying the roadmap failure taxonomy ALONG
      the whole chain over real workerd D1 — provider deadline → typed
      retry_wait + honest failed ai_run; the wall-deadline race with a
      LATE response ABSORBED (the manual-scheduler test seam fires the
      deadline while the call is in flight; the late resolution never
      commits/resurrects; the attempt stays charged conservatively; the
      legitimate retry is the ONLY draft — proven by its own traced
      content); budget-first quota denial with ZERO provider calls and
      the budget row unchanged; invalid output (unknown evidence
      reference) retried per allowlist model (2 calls for the 2-model
      ladder — invalid output is NOT a refusal) then exhausted to the
      typed provider_unavailable retry; retry exhaustion → dead_letter
      job_exhausted after exactly max_attempts with still NO draft; the
      terminal safety refusal → dead_letter editorial_ai_refused with
      the honest provider_safety_refusal run; the R1.11.1 acceptance
      guard → TERMINAL editorial_no_traced_claim with an invalid run —
      PLUS the fact-guard report (6.3) SURFACED by the read-only review
      view: the projection reads the stored factGuard key through its
      OWN strict typed reader and the renderer adds ONE section in the
      exact house pattern of the other five stored reports (ok → the
      evaluated counts line + a findings line + the mandatory
      observation-not-truth note RESERVED before variable content per
      the S1 discipline; absent/unsupported_version/malformed → the
      shared honest-state line under its own reservation; a stored lie
      displays malformed — never guessed into ok, never a crash); the
      view stays READ-ONLY (the existing two bounded SELECTs, ZERO new
      SQL, zero writes, zero provider calls, zero recomputation); flags
      OFF keep the stored document shape byte-identical (the flag-OFF
      draft shows the honest absent line, the same treatment every
      legacy document gets for the other five reports); the two honest
      in-round assertion corrections recorded (per-model invalid-output
      retry; the distinct editorial_no_traced_claim reason); the
      suite registered in test:db; NO Phase-6-completion claim; live
      surfaces BLOCKED_LIVE (Posidon only); Free readiness NOT_READY.
- [x] **Phase 6 GATE (V4 local round, docs/reviews/PHASE_6_GATE.md, on the
      1.21.0 tree, tests+docs only, no version bump): the roadmap's Phase 6
      gate executed as a documented EVIDENCE-BASED review — PASS FOR LOCAL
      ENGINEERING HAND-OFF. Pillar 1 (no numeric-accuracy or
      model-competence claim without a REAL benchmark): a full-text scan of
      docs/src/tests/VERSION.json classified every accuracy/benchmark/percent
      hit — ZERO achieved-capability claims in the delivered surface; the
      shipped reports structurally cannot claim accuracy (the mandatory
      observation-not-truth note RESERVED before variable content and pinned
      by the 6.4 view suite; non-exhaustive lens lists travel in every
      report; a truncated excerpt adds NO false precision); the demos ASSERT
      the disclaimer as a rendered output ("plumbing/contract correctness,
      NOT live-model semantic accuracy"); the ONLY ≥95% vocabulary is the
      blueprint v1 §25 SHADOW-GATE required metrics — future Phase-11
      entry criteria for Posidon's real measurement, the opposite of a
      claim, cited nowhere as met. Pillar 2 (every suspicious output
      fail-closed or reviewed): the 16-class taxonomy mapped to NAMED tests
      (malformed output / unknown evidence refs / no-traced-claim terminal /
      provider deadline / wall-deadline late-response ABSORBED / quota-first
      zero-calls / safety refusal / exhaustion / Gemini structurally OFF on
      unverified eligibility even when gated / fail-closed invalid requests
      with zero side effects / reviewRequired DERIVED on non-benign
      findings / stored lies render malformed / injection text INERT /
      no-false-precision truncation / evidence-guard identity gate / the
      catch-all: every claim stays `unverified` and conversion launders
      nothing) — no gap class found; gates re-run for the review with real
      exits: check=0 (160 files/2076 tests), test:db=0 (54 files/584),
      targeted design+demo suites=0 (6 files/53). Cannot-prove recorded
      honestly: real provider behavior, live quota/cost, real 15 s waits,
      independent acceptance of the adapter foundation. Binding conditions
      carried INTO Phase 7 (flag discipline, additive documents, no claims
      without real benchmarks, blueprint metrics stay future criteria,
      media rights ambiguity ⇒ reject/defer, BLOCKED_LIVE, PR #11 draft,
      FF-only pushes); NO Phase-6-completion claim (Gemini eligibility
      UNVERIFIED, OD-009 OPEN, adapter foundation UNDER INDEPENDENT
      REVIEW, Free readiness NOT_READY).
- [x] **Phase 5D (R1.16, v1.11.0, ADR-0044): CONTROLLED entity aliases →
      DURABLE story mentions — the next real roadmap step: a fresh news
      draft is now durably connected to its REGISTERED entities through
      the existing `entities`/`entity_aliases` catalog, and a registered
      Persian and English name of one entity resolve to the SAME id; the
      connection is a real `story_entities` row (relation `mentioned`,
      confidence 0), not another JSON-only report. Versioned policy `em1`
      (pure `src/domain/editorial/entity-mentions.ts`): normalization =
      NFC + whitespace-collapse + trim ONLY (no case folding, no
      ی/ک/digit conversion — matching is byte-exact under the registered
      forms); candidate phrases are byte-exact 1..4-token windows between
      Unicode word boundaries (letters/numbers/marks; ZWNJ نیم‌فاصله is
      word-INTERNAL — conscious and tested), generated width-major so
      single-token aliases get the coverage first; ONE parameterized
      indexed IN-list lookup (≤90 phrases, ≤ D1 per-query bound-parameter
      limit; ORDER BY before LIMIT 91 = cap+overflow probe) against
      `idx_entity_alias_lookup` — no full-table scan, no per-word
      unbounded queries, no SQL interpolation. A normalized_alias with
      EXACTLY ONE owner resolves it; a shared alias is AMBIGUOUS with
      ZERO auto links (no first-row-wins, no invented confidence);
      ≥91-row result overflow embeds NOTHING (honest lookup_overflow);
      cap hits are recorded (bounded_scan_window — NO full-coverage
      claim); empty catalog and zero-row lookup are the SAME honest
      no_match_observed (never a proof of absence). The SAME fenced
      atomic commit writes each unique link with an SQL predicate that
      re-checks INSIDE the batch that the alias STILL maps to exactly
      that entity — a mapping deleted/remapped/second-owned between
      lookup and commit no-ops ONLY that link (never an invalid link,
      never a partial state, never a forced AI re-run). The versioned
      `entityMentions` report (policy em1, snapshot identity, observation,
      matched/ambiguous, scan flags, caps, fixed limitations) rides
      inside document_json (schemaVersion stays 1) with a typed reader
      (v1/absent/unsupported_version/malformed + real invariants).
      Mention resolution runs strictly AFTER the input gates and the
      early-reuse decisions — replay/reuse never run lookups and old
      drafts are NEVER enriched (reuse_drafts_not_enriched; the accepted
      R1.15.2 reuse contract preserved). Tests: RED recorded on the
      8f68c5d baseline (module absent), GREEN after — new unit suite
      (policy/boundaries/caps/ambiguity/overflow/reader malformed table),
      new REAL-D1 integration suite (fa/en → one entity on two
      independent stories with NO merge; Doomlike/Doom2 never match Doom
      while 'Doom 2' matches both game and franchise; ZWNJ vs spaced;
      multi-word Half-Life; reversed-order ambiguity; multi-mention dedup
      to ONE row; empty catalog; cap window; overflow; alias
      delete/remap/second-owner in the lookup→commit window; REAL replay
      write-free; stale-fence/snapshot-changed/mid-batch-failure → zero
      orphans; EXPLAIN QUERY PLAN index proof — LOCAL PROXY only), and
      the new offline demo (`npm run demo:entity-mentions`); full gate
      re-run green; version 1.11.0; no Phase-5-completion claim; news
      text NEVER adds to the catalog and no real catalog was seeded on
      cloud (fixture helpers are LOCAL-D1 only).
- [x] **Phase 5D corrections (R1.16.1, v1.11.1, ADR-0044): ENTITY MENTIONS
      CORRECTNESS — exactly the THREE independently reproduced R1.16
      defects (Posidon probes C1/U1/R1: 3 failed / 18 skipped / exit 1)
      closed with RED→GREEN recorded on the caa7402 baseline inside the
      PERMANENT suites; NO new capability started, schema stays 3, ZERO
      DDL, the accepted reuse contract untouched. C1: the WHOLE editorial
      commit result is now SQL-conditioned on the validity of EVERY relied
      (alias, entity) mapping — a whole-result catalog-mapping gate (ONE
      bound `json_each` pairs parameter + ONE expected-count parameter per
      statement, heaviest statement 23/100 of the D1 bound limit; EXPLAIN
      QUERY PLAN seeks `idx_entity_alias_lookup` per claimed pair, no table
      scan, LOCAL PROXY only) zeroes EVERY statement on one invalidated
      mapping → typed `catalogChanged` → ONE bounded in-handler re-resolve
      against the CURRENT catalog (fresh SQL lookup, the SAME provider
      draft, ZERO new provider calls/charges) before any engine retry — a
      committed report now EQUALS the durable `story_entities` rows (the
      weak no-op-only-link contract and its docs/tests are corrected with
      the reason recorded). U1: the tokenizer walks UNICODE CODE POINTS
      (`codePointAt`/`fromCodePoint`), never UTF-16 units — astral
      letters/numbers/marks are token characters and can never split a word
      around `Doom`; unpaired surrogates and emoji stay separators;
      Persian/ZWNJ/NFC/`Doomlike`/`Doom2`/`Half-Life` behavior preserved;
      the 256-token cap is enforced DURING traversal with an honest
      truncation probe. R1: the typed reader enforces strict ALIAS ascent
      (one alias can never claim TWO owners), matched ∩ ambiguous = ∅, and
      the shared candidate-phrase bound (matched + ambiguous ≤
      phrasesConsidered); the malformed/round-trip tables unchanged, no
      invented format constraints. Tests: unit 43/43, integration 20/20
      (REAL workerd D1; incl. the new gate EXPLAIN probe and the corrected
      REMAPPED expectation), demo 1/1, full gate 113 files / 1577 tests
      green; version 1.11.1; no Phase-5-completion claim. INDEPENDENTLY
      ACCEPTED (Posidon round R1.16.1, offline) — the accepted contract is
      the one R1.17 builds on.
- [x] **Phase 5E-1 (R1.17, v1.12.0, ADR-0045): BOUNDED EVENT-RELATION
      EVALUATION → DURABLE, EVIDENCE-REFERENCED DECISIONS — the FIRST
      event-relation + decision-persistence slice, NO MERGE. On the NEW
      draft path of `editorial.prepare_draft` (strictly after validation
      and the early exact-content reuse/replay, strictly before commit,
      and AFTER the R1.16 mentions resolution whose resolved entities feed
      it): the deterministic UNION of the fingerprint-discovery candidates
      (zero new fingerprint probes) with shared-entity candidates from ≤3
      indexed probes on `idx_story_entities_entity(entity_id, story_id)`
      (≤9 rows each, `ORDER BY story_id ASC` before LIMIT — row-order
      independent), ≤8 unique candidates with honest overflow/truncation
      and `origin` labels (`fingerprint:<signal>` / `entity:<id>`); per
      candidate the basis is the candidate's OWN ready draft's durable
      document record + the bridged reference row (missing/legacy/stale
      bases are TYPED `basis_unavailable` — never silently skipped, never
      a different-event verdict); ≤2 pairs are bundled (both-side real
      text ≤16 KiB, canonical input hash over BOTH bases + prompt/policy
      version) and evaluated by the SEPARATE `event_relation` AI task
      (own immutable prompt `pixel-event-relation-v1`, own strict output
      schema with the EXPLICIT `insufficient_evidence` citation contract,
      foreign refs/self-pairs/wrong pairIds/command fields rejected) over
      the SAME durable budget authority (scope 'ai', SAME per-provider
      caps — no separate bucket), the SAME allowlist ladder (Gemini stays
      unverified/unwired), ≤3 REAL provider attempts for the WHOLE step
      and ONE 15 s wall deadline; every REAL attempt gets its own
      deterministic `event_relation` ai_runs row settling ATOMICALLY with
      the versioned `eventRelation` ledger inside document_json of the
      SAME fenced draft INSERT (drafts.ai_run_id stays the news_draft
      run); the evaluated candidate bases are re-verified INSIDE the batch
      by the SQL candidate-basis gate (exact document bytes + reference
      identity — one invalidated basis zeroes EVERY statement, typed
      `eventRelationBasisChanged`, real runs honestly recorded, bounded
      retry; heaviest statement ≤35/100 bound params, LOCAL PROXY); the
      independent fail-closed `EVENT_RELATION_ENABLED=false` flag ships
      everywhere (disabled ⇒ the honest `disabled` ledger, ZERO relation
      SQL, ZERO calls; AI_ENABLED/EDITORIAL_ENABLED stay OFF; the
      accepted normal path intact). Verdicts are MODEL PROPOSALS over
      named evidence — `same_event_proposed`/`different_event_proposed`/
      `insufficient_evidence` — never truth, never a merge, never
      source-independence; shared signals never count as confirmation;
      conflicting numbers/times/negations stay recorded conflicts; no
      candidate ≠ unrelated. Offline demo `npm run demo:event-relations`
      (translation→same via SHARED-ENTITY retrieval, different-events→
      different, thin→insufficient; safe output incl. candidate origins,
      pair/basis ids, evidence ids, stored readback, REAL attempts and
      LOCAL PROXY SQL costs, no-merge proof). Gates: clean npm ci, check,
      test:db 34 files / 427 tests incl. the new suites (unit 37 +
      integration 10 + demo 1), full suite 117 files / 1625 tests green,
      secret scan 428/0; version 1.12.0; schema stays 3, ZERO DDL; NO
      Phase-5-completion / semantic-accuracy / production-ready claim.
- [x] **R1.17.1 (v1.12.1, ADR-0045 correction): EVENT-RELATION SAFETY &
      CORRECTNESS — exactly three independent Posidon findings closed, NO
      new capability, NO Phase-5 scope claim. G1: the effective relation
      gate is the GLOBAL `AI_ENABLED` kill switch AND the independent
      `EVENT_RELATION_ENABLED` flag — both fail-closed, enforced in TWO
      layers (the production wiring passes the global gate into the
      relation service's config AND into the handler's relation step; the
      service itself refuses on `aiEnabled=false` even for a wrongly-wired
      caller) — with the global gate OFF: ZERO relation provider calls,
      ZERO budget authorizations, ZERO usage writes. A1: ALL post-provider
      failure exits are audited — the first commit throw is caught and the
      generation's REAL invocations (drafting AND relation) are recorded
      best-effort through the fenced standalone ai_runs inserts with
      deterministic per-(job,generation,pair,attempt) ids and the own-row
      guard (charges stay, no refund, no collision across generations, no
      misattribution, no free lunch; a persistent store outage defeats the
      best-effort record — an honest limitation, never an invented
      exactly-once guarantee); deferred-pair ledgers carry the REAL
      self-side identity instead of the old empty-evidence placeholder.
      D1: the step deadline is ABSOLUTE from the FIRST relation work
      (retrieval probes included) through basis packaging, budget
      authorization, the provider call and usage — the handler computes it
      and the service can only SHORTEN its local 15 s cap (never reset or
      extend); reads stop STARTING after expiry (no new probe, no new
      basis read — the unread candidate is TYPED
      `basis_unavailable/step_deadline_expired`), every pair after expiry
      is TYPED `skipped_deadline` with zero run rows, pending D1 queries
      are never claimed cancellable (the bounded race frees the caller
      only), and the pairs/attempt caps plus the separate drafting
      deadline stay untouched. All three counterexamples were reproduced
      RED on the untouched baseline and are GREEN after the corrections;
      the permanent regressions live in the main suites (unit 41,
      integration 20 incl. the real engine-env wiring matrix with a
      native-binding stub and zero network); full suite 118 files / 1640
      tests green; version 1.12.1; schema stays 3, ZERO DDL; NO
      Phase-5-completion / semantic-accuracy / production-ready claim.
- [x] **R1.17.2 (v1.12.2, ADR-0045 correction): EVENT-RELATION AUDIT
      DURABILITY & BOUNDED PENDING READS — exactly two second-generation
      findings closed, NO new capability, NO Phase-5 scope claim. A2: the
      durable relation audit no longer depends on the relation step's
      post-return outcome mapping — the service surfaces EVERY REAL
      provider attempt at RECORD time (before the outcome mapping and
      before any observability sink that may itself fail) through a
      trusted caller collector, and the handler unions the record-time
      observations with the outcome-mapped rows on every post-provider
      failure exit (deterministic per-(job,generation,pair,attempt) ids,
      the fenced standalone insert's own-row guard dedups; charges stay,
      no refund, no collision across generations, no misattribution, no
      free lunch; zero fabricated rows). D2: the pending retrieval/basis/
      reference reads are BOUNDED by the same absolute step deadline
      through the accepted race primitive — expiry frees the CALLER (a
      pending D1 query is never claimed cancellable), a late settlement
      is observed and absorbed (never an unhandled rejection), an expiry
      observed by a race stops ALL further relation reads (TYPED
      `basis_unavailable/step_deadline_expired`, honest unprobed
      accounting), and a basis whose reference identity was not verified
      before expiry is NEVER bundled. Both counterexamples were
      reproduced RED on the untouched baseline (A2 {relationCalls:1,
      rowsDelta:0}; D2 {pending read ⇒ no deadline race, the step
      suspends past expiry}) and are GREEN after the corrections; the
      permanent regressions live in the main suites (unit 16,
      integration 23); version 1.12.2; schema stays 3, ZERO DDL; NO
      Phase-5-completion / semantic-accuracy / production-ready claim.
- [x] **R1.17.2 (v1.12.3, ADR-0045 correction): the ORIGINAL A2/D2
      obligations closed on the return-for-correction baseline 46f078e —
      NO new capability, NO scope claim, NO substitute counterexample.
      ORIGINAL A2: the handler's ENTIRE post-relation region (the
      drafting await through the document/commit-input construction and
      the fenced commit) is covered by ONE attempt-scoped cleanup —
      EVERY exceptional exit after a real relation invocation records the
      union of the record-time attempt observations with the
      outcome-mapped rows (deterministic per-(job,generation,pair,attempt)
      ids, the fenced standalone insert's own-row guard dedups) plus the
      draft run when one was observed, each audit type INDEPENDENTLY,
      BEFORE the retry is scheduled; the original error propagates
      unchanged (zero fabricated rows, no refund, no re-inference, no
      exactly-once claim; ownership fence and generation separation
      stay). ORIGINAL D2: the SAME absolute step deadline is re-checked
      IMMEDIATELY BEFORE every new asynchronous operation — the
      reference-row read after a returned basis read consumed the budget
      and the hash/bundle work — an expired clock starts NO query and
      builds NO bundle (typed `basis_unavailable/step_deadline_expired`).
      Both ORIGINAL counterexamples were reproduced RED on the untouched
      baseline (2 failed / 23 skipped, exit 1, outputs byte-identical to
      the task) and are GREEN after the corrections; the previous
      delivery's observer-first and bounded-pending-reads regressions
      stay green; the permanent regressions live in the main integration
      suite (the EXACT drafting-throw audit + the INITIATED-query count
      after expiry; the temporary copied proof suite removed — the 23
      pre-existing tests NOT duplicated); version 1.12.3; schema stays 3,
      ZERO DDL; NO Phase-5-completion / semantic-accuracy /
      production-ready claim.
- [ ] Story MERGING and semantic/deterministic matching with thresholds
      (Phase 5C-1/5C-2 provide ONLY fingerprints + candidate discovery +
      conservative observation assessment, and Phase 5D provides ONLY
      controlled-alias MENTIONS with confidence 0 — merging, fuzzy or
      semantic matching, and event detection remain explicitly future;
      a shared entity mention is NEVER a same-event proof and NEVER
      source independence).
- [ ] AI adjudication path (compact claim sets) and decision persistence
      BEYOND Phase 5E-1 (the R1.17 slice covers ONLY the bounded NEW-draft
      event-relation step with ≤2 pairs and fixture-verifiable plumbing;
      live-model evaluation, calibrated confidence, compact-claim
      adjudication at scale, and any merge/publication authorization
      remain explicitly future).

_(The round 1.10.6 / 1.10.6.1 AI ADAPTER foundation does NOT complete any
part of this phase: the story/claim/evidence engine, the editorial fact
guard, and the durable AI caller remain future work — see the unchecked
items in Phase 6. Phase 5A adds the FIRST bounded vertical slice (one
snapshot → one conservative story → one ready draft) and deliberately NOT
the full engine.)_

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
      claim is true) — still FUTURE work. (Phase 5B's Evidence Guard v1 is
      a BOUNDED text-presence check over the draft's own claims — direct
      observation is not verification and unresolved is not false; full
      semantic Fact Guard remains future.) Phase 5A/5B keep every
      model-proposed claim `unverified` inside document_json/facts_json.
- [x] Durable caller wiring (job types, cron/queue, admin surfaces) —
      Phase 5A (R1.11, ADR-0042) added the FIRST durable caller: the
      `editorial.prepare_draft` job type on the existing engine (bounded
      application-boundary enqueue; NO cron scheduling, NO public
      endpoint, NO admin surface this round). It ships OFF everywhere
      behind `EDITORIAL_ENABLED`.
- [ ] Story engine / Phase 5 adjudication consumption — NOT complete and
      not claimed by rounds 1.10.6 or 1.10.6.1. (Phase 5A writes ONE
      conservative per-snapshot story + source-report claim; it does NOT
      implement adjudication, matching, or merging.)

Phase 5A (R1.11) delivered the first bounded vertical slice of the
news/claim/evidence path on schema 3. The REMAINING Phase 5 engine work
(fingerprints, aliases, matching, adjudication) and the Free-ingestion
limitation (see the Phase 4 note and
`free-plan/FREE_SAFE_EXECUTION_DESIGN.md`) each stay pending separate
independent decisions; executing them is NOT part of this round.

## Phase 7 — media engine and album publisher ⬜

- [x] **Phase 7.1 (V4 local round, docs/reviews/PHASE_7_1_MEDIA_COMPATIBILITY_REVIEW.md,
      on the post-6-gate tree, docs only, no version bump): the roadmap's
      «۷.۱ حفظ سازگاری» executed as a documented EVIDENCE-BASED inventory —
      the EXISTING single photo/video surface verified clause by clause with
      NAMED tests and NO gap found: single photo = the LARGEST variant's
      file_id (dimension-cap proof), single video with the no-caption
      distinct case sent with NO caption field at all, the bounded opaque
      fileId contract (printable ASCII 1..256 units ≤1024 UTF-8 bytes,
      invalid ⇒ typed rejection), the caption riding the kind-'caption'
      envelope as `caption` + `caption_entities` with NO parse_mode (plain
      captions = EMPTY entity list; editMessageCaption the same discipline;
      kind mismatches fail typed BEFORE any fetch), caption entities under
      the SAME UTF-16 envelope discipline (1024-unit cap pinned at exactly
      1024/reject-1025), and the CORE guarantee — no silent
      caption/media separation — proven as THREE independent layers (MODEL:
      a caption can NEVER exist without media, `content_kind_mismatch` at
      construction; STORAGE: a caption-kind bare envelope never readable as
      a post; SEND: the fingerprint column blocks any post-approval file_id/
      caption alteration); every non-photo/video shape and albums
      (media_group_id) map to typed `unsupported` and are rejected
      EXPLICITLY (never degraded); replay of the SAME media update never
      creates a second version; a Bot-API-rejected file reference is a
      DEFINITIVE honest failure never auto-resent; legacy bare-envelope
      rows read through the documented fallback; the fingerprint covers
      media kind + fileId + caption text + caption entities (deterministic
      serialization; the byte cap fails TYPED, never truncates). Recorded
      honestly: a VERIFICATION round — no new media capability built (the
      album model is 7.3; rights/R2 policy is 7.2); no RED→GREEN cell was
      needed; binding conditions carried into 7.2/7.3 (the three
      no-separation layers are preservation requirements an album must
      extend never weaken; rights ambiguity ⇒ reject/defer; YouTube outside
      download permission; no accuracy claims without real benchmarks;
      BLOCKED_LIVE; PR #11 draft; FF-only pushes).
- [x] **Phase 7.2 (V4 local round, docs/reviews/PHASE_7_2_MEDIA_POLICY_DESIGN.md,
      v1.22.0, ADR-0055, on the post-7.1 tick-record tree): the roadmap's
      «media candidates, rights policy, R2 temporary storage, album
      planning» executed as the PURE typed domain layer `src/domain/media/`
      (four modules, RED-first 82/82 GREEN, zero I/O/SQL/network — the
      blueprint §3 `domain/media` plan): (1) `media-candidate` — the
      versioned candidate (origin/officiality/relevance/freshness ORDINALS,
      photo|video roles, opaque contentHash/visualKey dedup keys,
      previouslyUsed economy input, bounded dimensions), the https-only
      BYTE-PRESERVING canonicalization (credentials/non-ASCII-host/2048-cap
      typed rejections; identity dedup NEVER from URL munging — the 5.3
      lesson), the strict reader (absent version ⇒ malformed, wrong version
      ⇒ unsupported, role/kind mismatch distinct, extra keys fail,
      canonicalUrl must re-canonicalize to itself) and the TOTAL comparator
      officiality > relevance > freshness > unused-before-used > URL
      tiebreak — NO score/percent/weight anywhere; (2) `media-rights` — the
      TOTAL typed decision (allow_temporary/reject/defer + reason +
      policyVersion mrp1) under the DOCUMENTED precedence url > YouTube ban > host policy > MIME > byte cap > redirect cap > rights: the 7.1
      binding is STRICTER than blueprint §14 step 4 (EVERY YouTube-family
      host is OUTSIDE ANY download permission — linking is not downloading),
      SSRF posture (IP literals + localhost/.localhost/.local/.internal
      forbidden outright, bracketed-IPv6 NOT port-split — the in-round
      RED-found bug fixed), the exact four-shape MIME allowlist
      (image/jpeg, image/png, image/webp, video/mp4 — executables/archives/
      documents rejected WITHOUT enumeration), the documented Bot API byte
      caps (photo 10 MiB / video 50 MiB; an UNKNOWN size never sneaks
      through — the allow carries byteCapUnchecked for the adapter), 3
      redirects max, unknown/restricted/piracy REJECT + conflicting rights
      DEFER (rights_ambiguous), and the allow ALWAYS destination
      r2_temporary_only (a rights clearance NEVER grants a publish); (3)
      `r2-temporary` — the 72-hour retention (blueprint §23) + the TOTAL
      lifecycle machine (staged → upload_in_progress → file_id_saved →
      r2_object_deleted terminal; upload_failed → retry/re-expiry; the
      REUSE RULE enforced BY THE MACHINE — a saved file_id never
      re-uploads; invalid fileId fails typed before any state change; no
      transcoding) — NO measured free-tier claims; (4) `album-plan` — the
      DERIVED select mode (none/single/album/official_video_link from the
      FINAL selection), the deterministic blueprint ordering (cover first,
      gameplay before concept UNLESS the story layer's explicit flag, videos
      at the end UNLESS videoAsPrimaryNews promotes the comparator-best
      video — relevance 'primary' ALONE promotes NOTHING), the ≤2-per-
      visualKey cap (typed exclusions, never silent), the ≤10 size cap
      (policy-ordered truncation + typed exclusions), the caption on ONLY
      ordinal 0 (the 7.1 no-separation layer EXTENDED), duplicates (same
      URL or contentHash) fail the WHOLE plan typed, mixed photo+video
      composes, the SAME input is JSON-equal deterministic, and the 3–6
      target is collector guidance — the planner NEVER pads. Binding
      conditions carried into 7.3 (the album media kind + upload/R2-adapter
      work): the three no-separation layers extend never weaken; the plan
      is the ONLY album shape 7.3 may build; every live surface stays
      BLOCKED_LIVE (Posidon only); PR #11 draft; FF-only pushes.
- [x] **Phase 7.3 (V4 local round, docs/reviews/PHASE_7_3_UPLOAD_PATH_REVIEW.md,
      v1.23.0, ADR-0056, on the post-7.2 tick-record tree): the roadmap's
      «Telegram upload with file_id reuse and R2 retention cleanup»
      executed as the REAL upload path over the FOUR documented seams
      (ADR-0042 §6: MediaFetchPort / MediaStoragePort / MediaAssetStore /
      TelegramMediaPort are the ONLY artificial pieces in tests; the D1
      asset store is REAL and driven over real workerd D1) — and the
      DELIBERATE schema decision: NO parallel tables (the FIRST draft's
      parallel media_usage/media_staging migration was REPLACED before any
      commit by the blueprint-faithful design — the APPROVED media_assets
      table from 0001 IS the ledger + staging anchor: canonical_url/
      sha256 = the ledger keys, telegram_file_id = the ledger value,
      r2_key + expires_at = the staging state and the deterministic 72h
      deadline, the candidate→…→uploaded→failed→expired status vocabulary
      = the durable lifecycle; the rtp1 policy machine MAPS onto it,
      documented in ADR-0056; schema 6 UNTOUCHED): the ECONOMY rule (an
      EXACT canonical-url or sha256 hit against an UPLOADED asset reuses
      its file_id — ZERO fetch, ZERO storage, ZERO upload cost; URL
      similarity never establishes identity; a staged non-uploaded row
      never resolves as reuse), the ALL-OR-NOTHING group (one
      deferred/rejected item withholds the WHOLE send typed — no partial
      album, no silent degrade), the staging ('candidate' rows written
      BEFORE the R2 put with the deterministic media/staging/<id> key so a
      crash leaves honest bookkeeping), the blueprint step-10 transition
      IN ONE STORE CALL (file_id saved + r2_key/expires_at cleared +
      status 'uploaded') followed by the IMMEDIATE R2 object deletion (the
      72h deadline is the backstop), the failed-send honesty (rows marked
      'failed', objects stay for the backstop, NOTHING auto-resent), the
      bounded retention cleanup (chunked over idx_media_expiry; the
      uploaded row's ledger value SURVIVES the cleanup), PLUS the album
      CONTENT KIND (album-content: the ONLY legal construction path maps
      a 7.2 alp1 plan + the resolved per-item fileIds; the caption rides
      ordinal 0 ONLY with NO per-item caption field existing at all — the
      7.1 no-separation layer EXTENDED; the SHA-256 fingerprint covers
      EVERY item kind+fileId+url and the caption; the strict fail-closed
      reader) and the sendMediaGroupRich CLIENT transport (2..10 items,
      EXACTLY ONE reference per item — file_id/URL/attach; the
      caption-ordinal-0 invariant AT THE TRANSPORT BOUNDARY; the JSON
      path for reuse/URL references and the MULTIPART FormData path for
      staged bytes; the honest reply parser — photo = the LARGEST variant,
      video = the video's file_id, a malformed reply fails the WHOLE
      parse). Suites: 13 unit (media-usage) + 9 unit (album-content) + 9
      unit (media-group client) + 9 REAL-D1 integration (media-73-upload,
      registered in test:db); gates: check exit 0 (168 files/2201 tests),
      test:db exit 0 (55/593). HONEST CARRY: the album-post PIPELINE
      integration (capture/preview/approve/publish of album versions in
      the admin-post flows) is NOT built here — recorded as the Phase 8
      planning input; every REAL fetch/R2 write/Telegram send stays
      BLOCKED_LIVE (Posidon only); PR #11 draft; FF-only pushes.

- [x] Phase 7.4 (the review-blocker round; app 1.27.0, schema still 6 —
      ZERO DDL): the INDEPENDENT REVIEW's A1–A6 album findings CLOSED with
      the adversarial probe scenarios re-written as a persistent RED-first
      suite (21 of 22 RED on the unfixed tree, then all GREEN): the
      fail-closed rights derivation (an UNOFFICIAL source_metadata claim is
      `unknown` and mrp1 rejects it; only official_api and
      official/verified_source metadata clear) + the honest durable rights
      echo (official / attribution_required / licensed) + the guarded reuse
      predicate (status uploaded + non-blocked rights + the type match);
      the ORDINAL file_id mapping with the response-shape gate BEFORE any
      ledger write; the RECOVERABLE R2 cleanup (delete FIRST, the ledger
      clears the key only after success — the object can never outlive its
      row's discoverability; the backstop proven end-to-end); the pre-send
      gates (destination + caption validated before ANY effect) + the send
      certainty honesty (absent = uncertain) + the versioned send identity
      key (the outbox wiring scaffold); the typed attachment contract (the
      fresh bytes cross the port under the same ref the wire item names);
      the staged/sentConfirmed outcome honesty + the fetch_failed blocker.
      RED-first evidence and the carries in
      docs/reviews/PHASE_7_4_ALBUM_REVIEW_FIXES.md. The album-post pipeline
      WIRING DELIVERED as the V4 carry (ADR-0060, app 1.31.0): the outbox
      send path consumes the durable album document through the
      `PublicationMediaGroupTransport` seam — the ONE shared send-identity
      derivation both sides import, the fail-closed ledger binding BEFORE
      any send, the per-ordinal delivery + usage records after the
      shape-gated reply, the ADR-0032 gate intact; the PRODUCING side (an
      editorial/admin flow that enqueues album drafts) remains the
      documented carry; BLOCKED_LIVE (Posidon only).

## Phase 8 — publication scheduler, edit and correction ⬜

- [x] Phase 8.1 (ADR-0057; app 1.24.0, schema still 6): the publication
      SCHEDULING POLICY layer — the roadmap bullet «Tehran-window
      scheduling, anti-robot rules, priority classes» as FOUR pure
      modules in src/domain/publishing/ (the blueprint §16 policy; zero
      I/O/SQL/network/flags, schema 6 untouched): tehran-windows (twp1 —
      the day TOTALLY partitioned into the 5 active windows + quiet +
      5 named gaps, [start,end) boundaries, TRUE cross-midnight
      late-night occurrences, the exhaustive 4320-minute sweep),
      priority-classes (pcp1 — the P0–P3 descriptors with exactly the
      blueprint facts; the documented P1 quiet pin), anti-robot (arp1 —
      the gap bands with caller-supplied deterministic jitter validated
      per band, the HONEST 2–4-min anti-flood pin for the unrelated-P0
      bypass (related P0 conservatively normal), the 90-min same-game
      cooldown with the explicit story-layer flag, the trailing-run
      layout cap, the rolling-six category cap in exact integer math,
      the rolling-168h mix over the CLOSED ten-category vocabulary with
      integer-exact per-mille status), publication-schedule (psp1 — the
      composed TOTAL decision: layout > category > mix precedence with
      non-time-resolvable blocks as typed DEFERs carrying dueAtMs NULL;
      P0 gap / P1 latency+8-min-floor / P2+P3 clamped-never-past time
      computation; the cooldown shift; the window gate LAST for
      quiet-gated classes only; every applied rule recorded; the four
      policy versions carried; JSON-equal determinism; no randomness
      inside the domain; mix enforcement ONLY on P3 filler discretion —
      news advisory-only, «never forced per day» honored). RED-first
      held (101 tests written first, real RED: 4 files
      cannot-resolve-module, exit 1) then 101/101 GREEN with EIGHT
      in-round findings recorded (3 REAL implementation defects: the
      wrap-piece start bug, the midnight-split ends bug, the
      composition's missing candidate identity — see
      docs/reviews/PHASE_8_1_SCHEDULING_POLICY_DESIGN.md §2). HONEST
      CARRY: the DURABLE scheduler (the publications outbox, claim/
      lease, the ADR-0032 reconciliation) is the NEXT Phase 8 slice and
      the GATE checkbox below stays open; every live surface stays
      BLOCKED_LIVE (Posidon only).
- [x] Phase 8.2 (ADR-0058; app 1.25.0, schema still 6 — ZERO DDL): the
      DURABLE publication scheduler — the roadmap's «publications outbox,
      claim/lease, failed-publication idempotency, the ADR-0032 gate
      reconciliation» as the REAL engine over the blueprint-approved
      `publications`/`publication_messages` tables (migration 0001,
      CONSUMED like ADR-0056 consumed media_assets): the outbox lifecycle
      machine pol1 (the TOTAL typed transition table over the REAL
      nine-value status CHECK with THE HONEST PARKING PIN — the CHECK has
      NO 'uncertain' value, so the ambiguous ADR-0032 outcome parks in
      'failed' «ended WITHOUT A CONFIRMED publication» with the
      classifier's code in last_error, the recorded-evidence heal is the
      ONLY auto exit, `claim`/`schedule_retry` from the parked state are
      machine-ILLEGAL, an unconfirmed attempt is NEVER auto-resent), the
      send-outcome classifier sop1 (429 = proved non-delivery retryable
      after the validated retry_after — the DELIBERATE pin vs the
      admin-post doc/code mismatch recorded as a LOW out-of-scope finding;
      the 4xx family held for a human; timeout/network/5xx/unreadable/
      unknown = the ambiguous window), the publication identity pidek1
      (the versioned deterministic idempotency key — the blueprint §7
      identity: a duplicate enqueue returns the EXISTING row, never a
      second publication; the exact-bytes text_hash), the REAL D1 store
      (the atomic claim with the budget IN the WHERE — a spent row never
      re-executes, the ADR-0037 lesson; the attempts value as the
      GENERATION fence; the release with attempts RESTORED; the ledger's
      UNIQUE(chat_id,message_id) rejecting a forged reused response id
      into the honest unconfirmed parking; the stale-lease reclaim with
      attempts preserved), and the scan engine (the 8.1 psp1 decision
      INSIDE the claim on fresh JOINed history; the pre-send EVIDENCE
      CHECK healing a crashed generation's recorded delivery WITHOUT a
      second send — the recorded sub-window of the ambiguous window is
      CLOSED, the stronger at-most-once protection ADR-0032 requires;
      defers released with the exact dueAt or the pinned 10-minute
      re-evaluation with scheduled_at NULL; the deterministic
      per-candidate jitter cross-validated against the real psp1 for
      every class/context; the TOTAL explicit 24→10 content-type map; the
      decision-only observe mode; the LOUD misconfiguration refusal —
      gate ON without a transport writes NOTHING). RED-first held (5
      suites, 79 tests, real RED: 5 files cannot-resolve-module, exit 1)
      then 79/79 GREEN (60 unit + 19 REAL-D1 registered in test:db); the
      SEVEN in-round findings recorded in
      docs/reviews/PHASE_8_2_DURABLE_SCHEDULER_DESIGN.md §2 (the
      vocabulary constraint the tests discovered and the machine redesign;
      the claim-batch generation-read defect; the render contract fixture
      mismatch; the dueCount list-vs-true-count semantics; the gate-OFF
      report carry; the admin-post 429 doc/code mismatch; the anti-robot
      same-round gap pin). HONEST CARRY: the LIVE wiring (the cron route,
      the real transport, the enablement flag + owner decision) stays
      BLOCKED_LIVE (Posidon only); the story-layer inputs (game keys,
      event-driven) default conservatively until the producing pipeline
      exists; the audit_events per-outcome integration is deferred to a
      dedicated slice; edit/correction (Phase 8.4's supersede consumption)
      and the carried album-post pipeline integration remain.
- [x] Phase 8.4 (ADR-0059; app 1.26.0, schema still 6 — ZERO DDL): the
      EDIT/CORRECTION workflows — the roadmap bullet «Edit/correction
      workflows» consuming the blueprint §15 scenarios as the PURE ecl1
      decision layer (the five correction classes × materiality × edit
      reachability × denial follow-up desire over the pinned 48h EDIT REACH
      WINDOW; TOTAL, deterministic, JSON-equal), the machine-legal
      supersede over exactly pending/retry_wait/published/failed (pol1
      authority — the reserved transition CONSUMED), the DRAFT supersede as
      the crash-safe route for in-flight rows (the 8.2 scheduler's own
      eligibility check dead-letters without a send — the queued-on-supersede
      behavior proven by test), the deterministic caid1 audit id claimed
      BEFORE the transport (the blueprint §7 «revision ID + target message
      ID unique in audit» by construction, NO new table) with the
      compare-and-set outcome finalization, the sop1 classification reused
      for edits (429 recorded retryable with NO auto-retry; timeout/5xx/
      unknown recorded uncertain, never re-applied), and the house gate
      pattern (OFF = decision-only zero writes; ON without transport = the
      LOUD refusal; an edit disposition without payloads = the typed
      edits_absent refusal). RED-first held (2 suites written FIRST, real
      RED: 2 files cannot-resolve-module) then 55/55 GREEN (30 unit + 25
      REAL-D1 registered in test:db); the FIVE in-round findings recorded in
      docs/reviews/PHASE_8_4_EDIT_CORRECTION_DESIGN.md §2. HONEST CARRY:
      the correction CONTENT rendering (label prepend, version binding) is
      an editorial-domain slice; the whole-story sweep reports other active
      priors for a later orchestration slice; the LIVE wiring stays
      BLOCKED_LIVE (Posidon only). «Failed-publication idempotency» was
      delivered by Phase 8.2 (pidek1 + the ledger).
- [x] Phase 8.5 (ADR-0062; app 1.36.0, schema still 6 — ZERO DDL): the TWO
      documented carries of the plan's slice 2 closed — the album DRAFT
      PRODUCER and the WHOLE-STORY correction sweep. (1) The producer (the
      ADR-0060 carry): the LEDGER-BOUND editorial flow
      (`produceAlbumDraft` + `enqueueAlbumDraft` over the NEW
      `album-draft-store`) — the plan from the pure 7.2 planner (the ONLY
      legal plan path), every item resolved to an UPLOADED media_assets row
      through the SAME `resolveAssetReuse` predicate the send/evidence
      paths enforce (uploaded + PUBLICATION_MEDIA_RIGHTS_V1 + the kind
      match; NO fetch, NO staging, NO transport, NO license minted — an
      unknown echo refuses exactly like the send gate, OD-010 stands),
      ALL-OR-NOTHING with the per-item reasons distinguished
      (no_uploaded_asset / rights_not_publishable / kind_mismatch) and
      ZERO durable writes on a refusal, the document from the ONLY legal
      construction path, the draft ships 'ready' (the machine mints no
      approval) with the version fence + the honest duplicate/conflict
      mapping, and the enqueue gated by the ADR-0060 discriminator (a text
      draft can never ride the album enqueuer) riding the existing
      idempotent enqueuePublication — an explicit approval transition is
      the ONLY route a publication row is created. (2) The sweep (the 8.4
      carry): `engine.applyCorrectionSweep` — ONE revision drives EVERY
      active prior through the engine's own applyCorrection one prior at a
      time, the deterministic caid1 LINK audit as the per-(revision, prior)
      at-most-once skip anchor (a re-sweep = already_swept, ZERO channel
      effects), the original envelope re-derived from the STORED draft
      document and VERIFIED against the ledger's exact-bytes text_hash
      BEFORE the edits are derived (content_changed_after_publication
      refuses that prior — the readers' seen text is never re-interpreted),
      an album prior corrects ONLY its ordinal-0 caption through the
      caption seam, the 16-prior bounded cap refusing typed with zero
      writes, per-prior isolation with the honest aggregate
      (applied/already_swept/decision_only/refused), the gate is the
      engine's own. RED-first held: the producer suite real RED
      (cannot-resolve-module) + the sweep suite 11/11 behavioral RED on the
      unfixed tree, then GREEN 16+11 (both registered in test:db); the
      publication-84/85/86 regressions green UNMODIFIED. HONEST CARRY: the
      album-draft CAPTURING side (the admin surface that gathers a media
      group from real Telegram updates) and the write-capable queue
      dispositions stay carried; LIVE surfaces BLOCKED_LIVE (Posidon only).
- [x] Phase 8.6 (ADR-0063; app 1.37.0, schema still 6 — ZERO DDL): the
      plan's SLICE 3 delivered — the measurable fail-closed AUTO gates and
      the CONNECTED end-to-end chain (source → story/evidence → draft →
      review → scheduling demonstrated over REAL D1 with the provider PORT
      and the Telegram TRANSPORT the only artificial pieces). (1) The PURE
      candidate gate `ag1` (`evaluateAutoPublishGate`, src/domain/publishing/
      auto-gate.ts) over the STORED draft bytes only: the document re-read
      through the send path's own strict reader (`renderEditorialPostText` —
      a refused shape, a laundered claim status or a composition over the
      send caps can never be AUTO-approved; a doomed publication is never
      created quietly); the fact-guard report REQUIRED present +
      well-formed + v1 + snapshot-bound (absence — the flag-off historical
      shape — is the fail-closed refusal, never a pass); the report TOTAL
      over the document's own claim indices; ANY non-benign finding on ANY
      claim ⇒ `requires_review` with the per-claim finding CODES (the
      injection containment is measurable and bounded — injection text is
      INERT DATA never interpreted nor obeyed; a claim it generated has no
      lexical basis in the stored excerpt and refuses BY CODE, never by a
      semantic-detection claim); zero findings ⇒ `eligible_auto` carrying
      the report's limitation labels VERBATIM (`lexical_presence_not_truth`
      rides every verdict — references alone are never semantic proof).
      (2) The FENCED durable transition `approveDraftForAutoPublication`
      (src/adapters/db/auto-approval-store.ts): ELIGIBILITY IS NOT
      ACTIVATION (the eligible verdict AND the independent enablement flag
      both required; either missing = ZERO writes); the fence
      `UPDATE drafts SET status='auto_approved' WHERE id = ? AND
status = 'ready'` (the rowcount the authority; the post-fence re-read
      distinguishes the honest `already_auto_approved` idempotent
      absorption from `not_ready` — a HUMAN approval never flipped); a
      non-eligible verdict refuses BEFORE any write; ONE system audit event
      (`draft_auto_approved`, actor `auto_gate:ag1`) carrying the measured
      data (gate version, claim count, fact-guard version, limitation
      labels) — never document content, never secrets; the `auto_approved`
      value the outbox `MODE_STATUS_MATRIX` already accepted for the
      `auto`/`safe_auto` modes finally has its producer — the AUTO lane
      reachable end-to-end while every activation stays Posidon's.
      (3) The connected demonstration (tests/integration/
      editorial-94-auto-gate-e2e.test.ts, 6 REAL-D1 registered in test:db):
      REAL snapshot → durable job → prepare-draft (fake provider port) →
      budget authority + fenced commit (the fact-guard report riding the
      SAME commit) → the gate over the STORED bytes → the fenced
      transition → idempotent `enqueuePublication` (auto mode; the
      duplicate absorbed) → the scheduler scan/claim/psp1 → the rendered
      send through the FAKE transport → the at-most-once ledger (one
      ordinal-0 record with the content hash) → published — with the
      refusal family pinned at the SAME chain (requires_review keeps the
      ungrounded number on the HUMAN path; report_absent;
      document_unreadable; gate_disabled with an eligible verdict = ZERO
      writes; the fence never flipping a human decision). RED-first held:
      tests/unit/auto-gate.test.ts (15) + the integration suite (6)
      written FIRST with real RED (cannot-resolve-module on both) then
      GREEN; the four defect suites (publication-90/91/92, media-93) and
      the d65d811 families (publication-85/87/88/89,
      publication-send-safety) plus editorial-64 and publication-82 green
      UNMODIFIED. HONEST CARRY: the album-draft CAPTURING side (the admin
      surface that gathers a media group from real Telegram updates), the
      write-capable queue dispositions, the zod v4 TRACKED migration and
      the rights-EVIDENCE model (OD-010: scope/expiry/attribution/write
      surface) stay carried; LIVE surfaces BLOCKED_LIVE (Posidon only).
- [x] R1.19 (ADR-0047; app 1.14.0 candidate, schema still 3): the Telegram
      rich-text FOUNDATION — dependency-pulled for future editorial input and
      Phase 8/9 publishing, NOT a completion of either phase. Bounded typed
      native rich-text extraction in the real `parseTelegramUpdate`
      (text/entities + caption/caption_entities, passive metadata, commands
      and captions untouched), the pure versioned schemaVersion-1 envelope
      (all 20 current Bot API entity types incl. `date_time` explicitly
      classified; fail-closed UTF-16 range, nesting, metadata, cap and URL
      scheme validation; text identity absolute — no trim/NFC/escape/Markdown
      interpretation; 128 KiB serialized-byte cap, never truncation),
      canonical serialization + defensive re-reader proving FUTURE
      persistence compatibility only, and separate typed direct-entity
      transport on the EXISTING Bot API client factory (`sendMessageRich` /
      `editMessageTextRich` / `editMessageCaptionRich` with exact
      text+entities / caption+caption_entities and NO `parse_mode`; runtime
      re-validation with zero fetch on rejection; custom_emoji output behind
      an explicit eligibility capability). Offline demo
      `npm run demo:telegram-rich-text`. Limits: NO durable persistence, NO
      inbox/capture route, NO approval action, NO outbox, NO live sending or
      channel operation; raw Markdown/HTML input parsing deferred as a
      separate future mode; existing admin-safe HTML path unchanged.
- [x] R1.19.1 (ADR-0047 correction addendum; app 1.14.1 candidate, schema
      still 3): three ORIGINAL Posidon valid-input failures in the 1.14.0
      foundation closed with the smallest coherent changes — M1: the real
      incoming parser now projects the documented minimal text_mention User
      fields wire→canonical (real-User extras dropped by the documented
      ignore policy; wrong-typed/oversized fields still fail typed at the
      envelope); N1: the containment matrix adds the official be-part-of
      direction (the five formatting styles may be part of any entity except
      pre/code; crossing, code/pre isolation, quote non-nesting, duplicates
      and non-container leaves unchanged); P1: a plain caption with OMITTED
      optional `caption_entities` is preserved as the canonical plain-caption
      extraction (metadata absence is not content absence; explicit
      null/primitive metadata stays a typed malformed outcome). The ORIGINAL
      proof is kept permanently byte-identical (RED 3/1 on untouched
      d175b53 → GREEN 4/4); F1 was already green and is retained. NO new
      capability, endpoint, engine, media workflow or DDL; no live sending.
- [ ] Tehran-window scheduling, anti-robot rules, priority classes.
- [x] Edit/correction workflows; failed-publication idempotency. (8.4:
      the ecl1 workflows — ADR-0059; failed-publication idempotency: 8.2's
      pidek1 + the at-most-once ledger.)
- [ ] GATE (ADR-0032): publishing-side duplicate mitigation and
      reconciliation (outbox-style per-publication/per-message
      reconciliation over `publications` / `publication_messages`) MUST be
      designed, implemented, and tested BEFORE autonomous channel publishing
      is enabled — exactly-once database claim ownership does not imply
      exactly-once Telegram message delivery, and channel-facing posts need
      stronger at-most-once protection than the webhook ingress provides.

## Phase 9 — admin Telegram screens ⬜

- [x] R1.18 (ADR-0046): the FIRST read-only admin review slice — `/drafts`
      bounded ready first page + `/drafts <draftId>` stored detail via the
      EXISTING ingress/router/RBAC/HTML stack, gated by the fail-closed
      `ADMIN_REVIEW_ENABLED` flag (ships 'false' everywhere); exactly two
      read-only SELECTs (real-EXPLAIN-verified index plan, 128 KiB SQL byte
      guard), the existing strict typed readers, budget-first ≤3500 safe
      HTML, ZERO editorial writes/provider calls; offline demo
      `npm run demo:editorial-review`. Explicit early Phase 9A dependency
      pull-forward — NOT a Phase 5/6/9 completion; NO approval/publishing.
- [x] R1.18.1 review-correctness correction (app 1.13.1; ADR-0046 addendum;
      schema still 3): the three ORIGINAL Posidon counterexamples closed —
      S1 mandatory safety/report-state lines RESERVED before variable
      content (long stored text truncates more; mandatory distinctions never
      drop); V1 newline-bearing malformed `/drafts` arguments rejected as
      grammar failures BEFORE any editorial SQL (never the list action);
      C1 stored conflicts rendered verbatim, distinct from reasons, with
      honest omission/truncation signals; original probes kept verbatim in
      `admin-review-originals.test.ts`.
- [x] Phase 9A (app 1.28.0, schema still 6 — ZERO DDL): the read-only
      publication-queue screen (`/queue`) in the EXACT R1.18 shape — the
      fail-closed `ADMIN_QUEUE_ENABLED` flag (independent, default false,
      invalid-present = disabled) gating ONLY that command and its /help
      advertisement; the router stays PURE (the no-argument grammar
      validated before any query; the typed `queue_view` action), the
      injected queue-view service performs exactly TWO bounded read-only
      SELECTs (the TOTAL status histogram over the pol1 vocabulary — a
      zero is information; the capped recent list of identity/status/
      priority/attempt-counters/stable-error-codes only — never draft
      content, never destinations); the honest send-gate note (no wired
      scheduler gate exists — the screen says decision-only, never a
      pretend live scheduler); RBAC `publication.view` with the honest
      role matrix (viewer included; the localized denial; the fixed
      English denial for unknown actors; private-only; edited noop); ZERO
      publication writes on the whole flow (asserted on the SQL texts);
      the wiring failure stays a retryable service_unavailable. 17
      REAL-D1 tests registered in test:db. Opaque action tokens and the
      multi-step sessions pre-exist (R1.20-R/R1.21); the story screen and
      the write-capable queue dispositions remain.
- [x] Phase 9B (app 1.33.0, schema still 6 — ZERO DDL): the read-only
      story-identity screen (`/story <storyId>`) in the EXACT R1.18/9A
      shape — the independent fail-closed `ADMIN_STORY_ENABLED` flag
      (default false, invalid-present = disabled) gating ONLY that command
      and its /help advertisement; the router stays PURE (the
      REQUIRED one-opaque-token grammar — no list form — validated before
      any query; the typed `story_view` action), the injected story-view
      service performs exactly TWO bounded read-only SELECTs (the story
      identity PK lookup with the bounded headline projection + the capped
      per-story publication history over `idx_publications_story`, LIMIT
      9 = 8 visible + 1 probe; identity/status/counters/stable codes only
      — never draft content, never destinations); the HONEST boundary: NO
      drafts/corrections reads exist because NO index covers
      `drafts.story_id`/`corrections.story_id` — a per-story listing there
      would be a full scan (pinned by the ZERO `FROM drafts` assertion);
      the reserved-skeleton renderer with the honest empty/not-found/
      merged states and the honest send-gate note; RBAC `story.view` (the
      TOTAL blueprint map pinned — every non-owner role holds it); 32
      tests (grammar/flag/renderer/routing + the REAL EXPLAIN QUERY PLAN
      family) registered in test:db. docs/reviews/PHASE_9B_STORY_SCREEN.md
      records the design and the three in-round findings. The
      write-capable queue dispositions remain.
- [ ] Command map, screens, opaque action tokens, multi-step sessions.

## Phase 10 — security hardening and budget controls ⬜

- [x] Phase 10.1 (app 1.29.0, schema still 6 — ZERO DDL): the
      CONSOLIDATED adversarial security sweep (27 REAL-D1/unit tests
      registered in test:db) pinning the cross-cutting invariants — the
      SSRF host-policy family over the TOTAL rights decision, the
      scheme/userinfo injection boundary, the TOTAL request-id boundary,
      the durable replay claim (ADR-0025) over REAL D1, and the
      closed-vocabulary echo discipline; ONE REAL GAP closed fail-closed
      (`isForbiddenHost` now rejects SINGLE-LABEL hosts — the shipped code
      missed its own docblock's public-DNS-only contract; the 7.2 unit
      family re-ran green); the non-breaking `npm audit fix` subset only
      (16 to 13, NO blind --force) with the per-advisory exposure
      inventory (zod = a bounded direct-runtime high with the v4
      migration tracked; sharp/undici = dev-only chains) in
      docs/reviews/PHASE_10_SECURITY_AUDIT.md. The budget side recorded
      as the existing pinned machinery (ingestion/ai/budget-authority/
      attempt-budget). The budget-soft-limit bullet stays carried to the
      Free activation (BLOCKED_LIVE data).
- [ ] Security test suite (webhook spoofing, replay, SSRF, injection).
- [ ] Budget counters and soft-limit enforcement.

## Phase 11 — shadow mode ◒ (tooling DONE_ENGINEERING; the run BLOCKED_LIVE)

- [x] 7–14 day shadow run instrumentation and blueprint §25 metrics gates.
      (11.1, app 1.30.0: the shd1 pure read-layer report + the TYPED gates
      (duplicate_pressure / parked_uncertainty / publication_throughput —
      data, never prose) + docs/reviews/PHASE_11_SHADOW_RUNBOOK.md; the RUN
      itself stays BLOCKED_LIVE — zero days elapsed, zero evidence.)

## Phase 12 — private test channel ◒ (kit DONE_ENGINEERING; execution BLOCKED_LIVE)

- [ ] Test-channel publication verification on real clients. (The KIT:
      docs/reviews/PHASE_12_PRIVATE_CHANNEL_KIT.md — the installer
      checklist + the scenario matrix mapped to the REAL offline suites +
      the evidence template; the real-client verification remains
      Posidon-only, no evidence exists.)

## Phase 13 — production rollout ◒ (READY_FOR_POSIDON)

- [ ] `safe_auto` → `auto` staged rollout with final default `AUTO`.
      (13.1/13.3: docs/reviews/PHASE_13_READINESS_MATRIX.md — the
      per-lane state+evidence matrix, the staged plan with the typed stop
      conditions, the honest boundaries; the ENGINEERING side is
      READY_FOR_POSIDON, the live rollout is Posidon-only.)

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

## R1.20-R — admin post pipeline (REBUILD round; review candidate, NOT activated)

- [x] Authorized admin post CAPTURE (subphase A): plain (non-command) text
      from an authorized admin in a PRIVATE chat only; groups/channels and
      unauthorized senders keep silent legacy noop semantics; edited
      messages are explicitly rejected and never applied; media posts
      (including caption-only) are EXPLICITLY rejected — a caption is never
      treated as a complete post; oversized/empty/malformed-rich-text
      content is rejected with stable replies; nothing is silently dropped.
- [x] Durable versioned STORAGE (subphase B): migration
      `0005_admin_post_pipeline.sql` (schema 3 → 4, LOCAL candidate); the
      canonical R1.19 rich-text envelope is stored verbatim with a stable
      SHA-256 content fingerprint; one OPEN draft per creator, each content
      message appends a version and atomically invalidates older approvals;
      a redelivered update can never create a duplicate version
      (durable source-update guard on top of the telegram_updates claim).
- [x] Faithful PREVIEW (subphase C): the content message is the EXACT
      stored envelope re-read from D1, re-validated and fingerprint-verified
      (a corrupted stored document fails loudly, never silently);
      control information (label + buttons) travels in a SEPARATE message so
      text and UTF-16 offsets are never altered; NO parse_mode anywhere.
- [x] Version-bound APPROVAL (subphase D): the callback token is consumed
      exactly once, bound to ONE user, and resolved through the durable
      preview-session row; the optional fingerprint field cannot bypass the
      binding (session + stored version must agree server-side) and a
      foreign fingerprint is rejected as tampered; one ACTIVE approval per
      version; stale versions, unknown/expired sessions and revoked
      permissions all fail closed with honest replies.
- [x] Safe/recoverable PUBLICATION (subphase E): destination is the
      operator-configured TARGET_CHANNEL (never user input); the partial
      UNIQUE index admits one primary publication per version; the send is
      claimed (lease + owner fence) and the outcome recorded HONESTLY as
      sent / failed_definitive (proved non-delivery) / uncertain (timeout,
      network, 5xx, unreadable response — the message MAY have arrived);
      uncertain outcomes are NEVER auto-resent; the ONLY re-send path is the
      explicit human-confirmed supersede flow (/post_status confirm button,
      audit-linked via supersede_of); a late response from a worker whose
      claim was superseded can never flip the newer state (fence-tested);
      LIVE publication ships default-OFF
      (ADMIN_POST_LIVE_PUBLISH_ENABLED=false) and while OFF the publish
      action stops BEFORE any publication row or Bot API call.
- [x] Self-check integration (subphase F): 47 new tests across
      migration-0005, admin-post-pipeline, admin-post-security,
      admin-post-publication-safety and the offline demo
      (`npm run demo:admin-post`); R1.19.1 regression suites stay green.

## R1.21 — post path completion + single photo/video (review candidate, NOT activated)

- [x] SEND-INTEGRITY GATE (2A): before EVERY send — first publish AND the
      human-confirmed re-send — the stored content is re-read, fully
      re-validated, and its fingerprint RE-DERIVED from the re-read document
      (previously the stored fingerprint column alone was compared). A
      version whose stored bytes were altered after approval — even with an
      untouched fingerprint column — can never be sent: the publication is
      recorded `failed_definitive` with a stable
      `content_changed_after_approval` error code and the answer says the
      content no longer matches the approval. Proven for text AND media
      versions, and for the confirmed recovery path (a tampered version
      cannot ride it).
- [x] USABLE ROLE FLOW (2B): the DRAFT ID now reaches the creator in the
      capture reply ("Draft id: …") and in /post_status; `/post_status
<draftId>` (same whole-token argument grammar as /post_preview) gives
      a `publication.publish` holder the publication state — including the
      uncertain-outcome recovery path — of a post they did NOT create;
      non-holders get one honest denial, unknown ids get the one not-found
      answer (no existence oracle), and the confirm-re-send button is minted
      for the calling publisher. The flow tests take EVERY id and button
      from the bot's REAL replies (recorded network sends) — never from a
      direct DB read or undelivered tokens.
- [x] SINGLE PHOTO/VIDEO (3): a single photo (largest variant file_id) or a
      single video, with an OPTIONAL faithful caption (text byte-for-byte +
      validated caption_entities, UTF-16 offsets preserved), is captured as
      a complete post inside the same explicit session/permission gates.
      The stored version is the versioned POST-CONTENT DOCUMENT
      (schemaVersion 1: media none|photo|video + fileId + text/caption
      envelope) — the fingerprint covers the media identity, the caption
      and the entities together. Preview sends sendPhoto/sendVideo with
      caption+caption_entities (NO parse_mode, no text field); the channel
      send is the SAME dispatch through the SAME real client; a media post
      without a caption is a valid distinct case and a caption can never be
      stored or published without its media (structural invariant +
      kind-checked transport). ALBUMS (media_group_id), documents, audio,
      stickers and every conflicting/malformed media shape are rejected
      EXPLICITLY — nothing is degraded into a partial post. Caption bounds
      (1024 units), oversized captions and malformed caption metadata are
      explicit rejections. A file reference the Bot API rejects at send
      time (invalid/expired/unusable) is a definitive failure reported
      honestly (publishMediaFileFailed answer); file_id is never treated as
      an eternal access guarantee. No media download, no R2, no parallel
      media system; no rights claim from the fact an admin sent media.
- [x] Legacy compatibility: R1.20-R1 rows (bare envelope + fingerprint) are
      read via the documented fallback and their fingerprint re-derived the
      exact legacy way; the migration chain stays 0004 → 0005 (schema 5, no
      new migration needed — the document lives in the existing
      envelope_json column).
- [x] Gates: 5 new suites (unit post-content, unit parser-media,
      integration media, integration role-flow-UI, integration
      send-integrity) added to `test:db`; full `npm run check` green; all
      R1.19.1/R1.20-R1 regression suites stay green.

### R1.22 Phase A — the editorial→post bridge (version 1.17.0, schema 6)

- [x] `/post_from_draft <editorialDraftId>`: ONE stored READY editorial
      draft converts into a NEW admin post version through the EXISTING
      preview/approve/publication flow — no bypass, no real send. The
      render is DETERMINISTIC and HONEST: headline (bold entity) + summary + model claims + the fixed unverified note + source attribution;
      empty sections stay absent (nothing invented); over-limit
      compositions fail TYPED (never truncated); a stored claim that is not
      exactly `unverified` fails the conversion (the unverified status is
      structural, never laundered); the raw source excerpt stays in the
      editorial draft (the channel carries the editorial OUTPUT).
- [x] Migration 0006 (schema 5 → 6, LOCAL-ONLY candidate, append-only):
      `admin_post_versions` rebuilt with a nullable `source_update_id` +
      `editorial_draft_id`/`editorial_draft_version` + an EXACTLY-ONE-origin
      CHECK (a fabricated update id is refused by the database) + a partial
      UNIQUE index admitting at most ONE derived version per editorial
      draft version — the bridge is idempotent (a second conversion answers
      with an honest pointer, never a duplicate). Legacy rows are copied
      byte-identically with NULL provenance; upgrade tested from a
      populated schema-5 database in its own isolated suite.
- [x] Existing-draft conversion bumps the version and invalidates older
      approvals in the SAME atomic batch (the manual-capture invariant).
- [x] Gates: `EDITORIAL_TO_POST_ENABLED` independent fail-closed default
      OFF; the conversion needs `draft.create` in a private chat (re-checked
      in the service); preview/approval/publication stay the exact
      R1.20-R1/R1.21 flows with version/fingerprint bindings and the
      live-publish gate.
- [x] Tests: unit render suite (8), migration-0006 suite (6), the REAL-path
      bridge suite (5: full flow + live publish + existing-draft
      invalidation + typed failures + flag-off/group noop) — all over the
      REAL webhook/D1/Bot API client with ids and tokens taken ONLY from
      real bot replies; `test:db` and `npm run check` re-run green.
