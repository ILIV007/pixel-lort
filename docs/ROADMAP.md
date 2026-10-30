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

## Phase 5 — story/claim/evidence engine ◒ (PARTIAL — Phase 5A ACCEPTED offline; Phase 5B Evidence Guard v1, Phase 5C-1 fingerprints/candidate-discovery, Phase 5C-2 conservative candidate-assessment and Phase 5C-3 exact-content draft reuse with preserved provenance (R1.15.2 correction independently ACCEPTED offline) implemented; Phase 5D controlled entity aliases → durable story mentions implemented with its R1.16.1 corrections INDEPENDENTLY ACCEPTED offline; Phase 5E-1 bounded event-relation evaluation → durable evidence-referenced decisions implemented; Phase 5E-1 UNDER INDEPENDENT REVIEW, OFF)

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
