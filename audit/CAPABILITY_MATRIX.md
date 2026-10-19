# PIXEL — Capability Matrix (evidence-based) — R1.10.2 corrected edition

Audit scope: LOCAL Preview-readiness audit ONLY. Every row cites file evidence
inside the accepted source (commit `f70205648922d0f8e60619e45e5d54e6e87b8f1b`,
branch `phase/04-corrections-round191`) and its local test evidence. No product
change was made in Rounds 1.10/1.10.1/1.10.2; no live network, Cloudflare, or
Telegram operation was performed. This edition carries the R110-04 secrets
classification (§10) and applies the R1.10.2 corrections: §7 registers the
IMPLEMENTED application-level recovery and DLQ reconciliation-send paths with
measured tool-trace evidence (TR-04 — the R1.10.1 "no automatic re-kick"
claim is withdrawn), and all resource counts quoted anywhere use the
corrected unit vocabulary (TR-01). The R1.10.1 edition is preserved inside the
sealed input `input/R1.10.1_61a01947_ORIGINAL.zip`.

Tier legend:

- **IMPL+TESTED** — implemented in the accepted source and exercised by local
  automated tests on real workerd (offline; scripted HTTP only).
- **LIVE-UNVERIFIED** — implemented, but only ever exercised against
  fixtures/mocks or asserted by operator runbook documents; never verified
  against the real external system by this round.
- **FUTURE / NOT IMPLEMENTED** — blueprint/schema/docs only; no product code.

A download page, a green suite, or a `/start` acknowledgement is **not**
proof of full editorial publishing. The publishing pipeline does not exist in
code yet (see §5/§8).

---

## 1. Telegram webhook entrypoint & security edge

| Capability | File evidence | Test evidence | Tier |
|---|---|---|---|
| `POST /telegram/webhook` route in allowlist router | `src/entrypoints/http/router.ts` (routeRequest); `src/entrypoints/worker.ts` (fetch/scheduled/queue export) | `tests/integration/telegram-webhook-security.test.ts` (real `worker.fetch` in workerd) | IMPL+TESTED |
| Fail-closed handler lifecycle: ingress flag gate → timing-safe secret check → content-type → bounded 64 KiB stream read → strict UTF-8/JSON → bounded Update parse | `src/entrypoints/http/handlers/telegram-webhook.ts` (`handleTelegramWebhook`, `TELEGRAM_WEBHOOK_MAX_BODY_BYTES`) | `telegram-webhook-security.test.ts`; `tests/unit/bounded-reader.test.ts` | IMPL+TESTED |
| Secret verification — header `x-telegram-bot-api-secret-token`, env secret name `WEBHOOK_SECRET`, timing-safe compare | `telegram-webhook.ts` (TELEGRAM_SECRET_HEADER); `src/shared/config/phase2.ts` (parseTelegramPhase2Config); `src/shared/security/timing-safe.ts` | `telegram-webhook-security.test.ts` (missing/empty/wrong → 401, no echo); `tests/unit/timing-safe.test.ts` | IMPL+TESTED |
| Unauthorized actors: flag off/misconfig → uniform 404; bad secret → 401; reason codes only, no payload logging | `telegram-webhook.ts` (TelegramWebhookRejectionReason, rejectionError) | `telegram-webhook-security.test.ts` | IMPL+TESTED |
| Tokenless offline mode: no `BOT_TOKEN` → no Bot API client; outbound actions fail retryably 503 `service_unavailable`; missing `DB` → 503 `db_binding_missing` | `telegram-webhook.ts`; `src/application/telegram-ingress.ts` (requireBotApi) | `tests/integration/telegram-admin-flow.test.ts` (503 + `outbound_unavailable`); `telegram-webhook-security.test.ts` | IMPL+TESTED |
| Live webhook registration (`setWebhook` with `secret_token`, `allowed_updates`, `max_connections=4`; target `https://pixel-preview.pixellort.workers.dev/telegram/webhook`) | `scripts/telegram-webhook-setup.mjs` (operator-only; not imported by the Worker) | `scripts/telegram-webhook-setup.test.mjs` + `tests/unit/telegram-webhook-setup-worker.test.ts` (mocked network only) | LIVE-UNVERIFIED |

## 2. Telegram command handlers (admin router)

Allowlist: `INITIAL_ADMIN_COMMANDS = ['start','help','status','version','language']`
— `src/admin/command-router.ts`. This is a **minimal** set; the blueprint's
full map (`/inbox /breaking /radar /drafts /stories /queue /calendar /mode
/sources /budgets /errors /audit /settings /admins /emergency_stop
/emergency_resume /export` — `docs/blueprint/v1/PIXEL_IMPLEMENTATION_SPEC_v1.md`)
is **not implemented**. Callback menus are deferred (Phase 9).

| Command | Behavior | File evidence | Test evidence | Tier |
|---|---|---|---|---|
| `/start` | Localized welcome (title/body/hint per admin UI language) | `src/admin/command-router.ts` (startResponse) | `tests/unit/command-router.test.ts`; `tests/integration/telegram-admin-flow.test.ts` | IMPL+TESTED |
| `/help` | Localized command list | `command-router.ts` (helpResponse) | `command-router.test.ts` | IMPL+TESTED |
| `/status` | "active" + APP_VERSION | `command-router.ts` (statusResponse) | `command-router.test.ts` | IMPL+TESTED |
| `/version` | Version string | `command-router.ts` (versionResponse) | `command-router.test.ts` | IMPL+TESTED |
| `/language [en\|fa]` | Read/change per-admin UI language; persisted FIRST (`admin_ui_language:` settings namespace), fenced by Telegram `(date, message_id)` ordering (ADR-0035); private-chat, non-edited, ordering-metadata guards | `command-router.ts`; `src/application/telegram-ingress.ts`; `src/adapters/db/admin-ui-language-store.ts` | `tests/unit/ui-language.test.ts`; `tests/integration/admin-ui-language*.test.ts` (incl. ordering + failures) | IMPL+TESTED |
| Unauthorized sender of allowlisted command | Fixed minimal English denial | `command-router.ts` (denialText) | `command-router.test.ts`; `telegram-admin-flow.test.ts` | IMPL+TESTED |
| Non-allowlisted / non-command / other-bot-targeted (`/cmd@bot`) / callbacks | Stable noops (`command_not_allowlisted`, `not_a_command`, `command_for_other_bot`, `callback_not_supported`); `expectedBotUsername`/`getMe` deliberately NOT wired → fail-closed ignore | `command-router.ts`; `telegram-webhook.ts` (expectedBotUsername comment) | `command-router.test.ts`; `tests/unit/update-parser.test.ts` | IMPL+TESTED |
| `/mode`, `/pause`, `/resume`, editorial/admin screens | No such commands exist (grep over `src/` = 0 hits) | `docs/blueprint/v1/PIXEL_IMPLEMENTATION_SPEC_v1.md` (future map) | none | FUTURE / NOT IMPLEMENTED |

## 3. Outbound Telegram capabilities

Client: `src/adapters/telegram/bot-api-client.ts` (`createBotApiClient`;
injectable fetch, 10 s timeout, `redirect:'manual'`, bounded 1 MiB reads,
retryable/permanent classification, runtime safe-HTML gate, token never
logged). **All Bot API tests are mocked-fetch/offline; no live Telegram test
exists anywhere in the repo.**

| Capability | File evidence | Test evidence | Tier |
|---|---|---|---|
| `sendMessage` (HTML parse_mode, link preview off) | `bot-api-client.ts` (sendMessage); ingress `sendSafely` | `tests/unit/bot-api-client.test.ts`; `tests/integration/telegram-ingress-pipeline.test.ts` (counting fake client, real workerd D1) | IMPL+TESTED (mocked transport) |
| `getMe` | `bot-api-client.ts` | `bot-api-client.test.ts` | IMPL+TESTED but **unwired** (no production caller) |
| `editMessageText` | `bot-api-client.ts` | `bot-api-client.test.ts` | IMPL+TESTED but **never exercised by any flow** |
| `answerCallbackQuery` | `bot-api-client.ts`; ingress path | `bot-api-client.test.ts`; ingress pipeline test | IMPL+TESTED but **dormant** (router never emits `answer_callback`) |
| Media upload (`sendPhoto`/`sendMediaGroup`/R2 `file_id` reuse) | `docs/ROADMAP.md` Phase 7 | none | FUTURE / NOT IMPLEMENTED |
| Channel publishing to `TARGET_CHANNEL` | `TARGET_CHANNEL` validated in `src/shared/config/phase2.ts` but **no code consumes it for sending** | none | FUTURE / NOT IMPLEMENTED |

## 4. Policy pause / recovery (D01) and gates

D01 policy pause is a **job-type pause in the jobs engine**, not a Telegram
command system. There is no `/pause` or `/resume` command.

| Capability | File evidence | Test evidence | Tier |
|---|---|---|---|
| Enablement policy registry; `sources.fetch_poll` gated by `ingestion_gate` | `src/domain/jobs/policy.ts` (JOB_ENABLEMENT_POLICY, isPausedByPolicy, policyExcludedTypes, isHandlerMisconfigured) | `tests/integration/round16-d01-policy-pause.test.ts` (production-path) | IMPL+TESTED |
| Pause state: per-invocation gate snapshot from strictly parsed `SOURCE_INGESTION_ENABLED`; ZERO durable writes while paused (ack `paused_by_policy` before atomic claim) | `src/application/jobs/engine-env.ts` (resolveJobsEngine); `src/application/jobs/engine.ts`; `src/shared/config/phase4.ts` | `round16-d01-policy-pause.test.ts` (no movement while OFF; lossless OFF economics; resume ≤ 1 cron interval) | IMPL+TESTED |
| Gate flags (names; local + preview values in shipped tree): `TELEGRAM_INGRESS_ENABLED` (local `false`, preview `true`), `JOBS_ENABLED` (local `false`, preview `true`), `SOURCE_INGESTION_ENABLED` (**`false` in BOTH** — ADR-0038) | `wrangler.jsonc` vars | `tests/integration/ingestion-gate.test.ts` | IMPL+TESTED |
| Cron trigger `*/5 * * * *` declared TOP-LEVEL only (R110-04 note: the in-source comment "not environment-overridable" is superseded factually by official docs — per-environment Cron Triggers ARE supported; shipped config unchanged, real-account state UNKNOWN; see checklist A.7) | `wrangler.jsonc` triggers; https://developers.cloudflare.com/workers/configuration/cron-triggers/ | `tests/unit/scheduled.test.ts` | IMPL+TESTED (handler); platform-cron LIVE-UNVERIFIED |
| Blueprint editorial "paused" mode (`/mode … paused`) | `PIXEL_IMPLEMENTATION_SPEC_v1.md` | none | FUTURE / NOT IMPLEMENTED |

## 5. Editorial pipeline (Story / Evidence / AI / media / publishing)

| Component | File evidence | Test evidence | Tier |
|---|---|---|---|
| `src/editorial/` (renderer, Persian normalization, prompt contracts) | `src/editorial/README.md`: "planned (not implemented…) — No code exists" | none | FUTURE / NOT IMPLEMENTED |
| `src/domain/story|editorial|publication|media|identity` directories | Named as planned in `src/domain/README.md` ("Domain code must not be added before its phase"); directories do not exist | none | FUTURE / NOT IMPLEMENTED |
| Editorial D1 schema (stories, claims, evidence, story_fingerprints, ai_runs, drafts with `approval_required`/`auto_approved`, publications with `approval_mode`, media_assets, publications_messages, corrections) | `migrations/0001_initial_schema.sql` (27 blueprint tables ported verbatim) | `tests/integration/d1-schema.test.ts`, `db-boundary.test.ts` (schema/FK only — no business logic) | SCHEMA-ONLY, dormant |
| AUTO policy: default publishing mode `AUTO`; `/mode` switch (auto/safe-auto/approval/paused); threshold policy (auto thresholds 82–92) | `PIXEL_IMPLEMENTATION_SPEC_v1.md` (blueprint contract); approval columns in `migrations/0001` | none (no runtime reader/writer of approval columns exists in `src/`) | FUTURE / NOT IMPLEMENTED — AUTO default is trivially preserved by absence: **no code can publish, approve, or hold anything**; no universal manual-approval requirement is added in this round |
| Approval primitives (role permission map incl. draft.approve-style actions; single-use admin action tokens) | `src/admin/roles.ts`; `src/adapters/telegram/action-tokens.ts` | `tests/unit/authorization.test.ts`, `action-token-validation.test.ts`, `callback-tokens.test.ts` | IMPL+TESTED (primitives only; no approval workflow) |
| Channel publishing pipeline incl. ADR-0032 duplicate-mitigation GATE | `docs/ROADMAP.md` Phase 8 ⬜ | none | FUTURE / NOT IMPLEMENTED |

## 6. Source registry & connectors (ingestion fetch paths)

| Capability | File evidence | Test evidence | Tier |
|---|---|---|---|
| Embedded source registry — 14 sources, zod-validated, seeded `enabled=0` | `src/domain/source/source-registry.ts` (imports `docs/blueprint/v1/pixel_source_registry_v1.json`) | `tests/integration/source-registry-seed.test.ts`; `round131-seed-contract.test.ts` | IMPL+TESTED |
| Connector contract + registry (exactly 5 implemented connectors) | `src/connectors/contract.ts` (incl. R10 `budgetDenied` propagation); `src/connectors/registry.ts` | `round18-r10-budget-authority.test.ts` | IMPL+TESTED |
| RSS/Atom connector (7 registry entries; conditional GET, multi-feed cursors) | `src/connectors/rss.ts`; `src/connectors/xml/safe-xml.ts`, `feed-reader.ts` | `tests/unit/connectors-rss.test.ts`; `round13-r03-r07-r08.test.ts` | LIVE-UNVERIFIED (scripted fetch only) |
| Steam News connector + R04 rotation cursor | `src/connectors/steam-news.ts`; `src/connectors/steam-cursor.ts` | `tests/unit/connectors-steam.test.ts`, `steam-rotation.test.ts`; `round17-r04-steam-rotation.test.ts` | LIVE-UNVERIFIED |
| YouTube playlists connector (playlistItems + video details only; API key header) | `src/connectors/youtube-playlists.ts` | `tests/unit/connectors-youtube.test.ts`; `round131-real-http-port.test.ts` (still scripted) | LIVE-UNVERIFIED |
| Reddit OAuth connector (client_credentials + `/r/{sub}/new`; no scraping) | `src/connectors/reddit-oauth.ts` | `tests/unit/connectors-reddit.test.ts` | LIVE-UNVERIFIED |
| GitHub releases connector (owner/repo pairs, prerelease policy, If-None-Match, optional `GITHUB_TOKEN`) | `src/connectors/github-releases.ts` | `tests/unit/connectors-github.test.ts` | LIVE-UNVERIFIED |
| Catalog-only connectors `bluesky-public`, `igdb` → `connector_not_implemented` | `src/domain/source/types.ts` (IMPLEMENTED_CONNECTORS vs CATALOG_CONNECTORS) | blocked-source paths in R09 suites; `docs/RUNBOOK_PHASE4_SOURCES.md` §1 | FUTURE / NOT IMPLEMENTED |
| Normalization (safe text, canonical URLs, tracking-param denylist, sha256 contentHash) | `src/connectors/normalize.ts` | `tests/unit/ingestion-normalization.test.ts` | IMPL+TESTED (pure) |
| Safe HTTP transport (SSRF guard, bounded reads, per-hop budget authority) | `src/shared/http/safe-http.ts`; `src/shared/security/url-guard.ts`; `src/shared/http/bounded-reader.ts` | `tests/unit/safe-http.test.ts`, `url-guard.test.ts`; `round18-r10-budget-authority.test.ts` | IMPL+TESTED (logic); LIVE-UNVERIFIED against real hosts/redirects |

**Key audit fact:** every external fetch path is exercised only through
`tests/helpers/fetch-mock.ts`; **no real Steam/Reddit/YouTube/GitHub/RSS
response has ever been processed by this tree.**

## 7. Ingestion pipeline, queues, budgets, DLQ

| Capability | File evidence | Test evidence | Tier |
|---|---|---|---|
| Cron trigger `*/5 * * * *`; scheduled handler = jobs-engine resolution → (gate on) `scheduleDueSources` → `dispatchDueJobs` → `reconcileDeadLetters`; never fetches inline | `wrangler.jsonc` (triggers); `src/entrypoints/cron.ts`; `src/entrypoints/worker.ts` | `tests/unit/scheduled.test.ts`; `tests/integration/job-entrypoints.test.ts` | IMPL+TESTED (handler); LIVE-UNVERIFIED (real platform cron) |
| Due-source scheduler: R08 completeness probe + registry seed + due scan + per-source preflight + owned scheduling (v4) or legacy durable job (v3) | `src/application/ingestion/scheduler.ts` | `ingestion-gate.test.ts` (incl. EXPLAIN QUERY PLAN index proof); `round19-r09-ownership.test.ts` | IMPL+TESTED |
| Poll handler `sources.fetch_poll`: capability check → A1 ownership → preflight → per-hop budgeted transport → connector fetch → fenced commit with adaptive backoff/jitter/circuit | `src/application/ingestion/poll-handler.ts` | `tests/integration/source-poll-pipeline.test.ts`; `round18-r10-budget-authority.test.ts` | IMPL+TESTED; LIVE-UNVERIFIED (real providers) |
| Queue bindings (preview env): producers `JOBS` → `pixel-jobs-preview`, `DLQ` → `pixel-dlq-preview`; consumer with `dead_letter_queue`, `max_retries: 3`, `max_batch_size: 10`, `max_batch_timeout: 5`; production queue names only as comments | `wrangler.jsonc` | fail-closed binding tests (`round181-boundary-corrections.test.ts`, `job-entrypoints.test.ts`) | DECLARED; provisioned by runbook only (`docs/RUNBOOK_PHASE3_QUEUE_SETUP.md`) — LIVE-UNVERIFIED |
| Budgets: atomic 1-unit per hop, `budgets` scope `ingestion`, Tehran day (`tehranBudgetDay`), rollover, D1-failure infrastructure path | `src/adapters/db/ingestion-budget-store.ts` | `tests/integration/ingestion-budget.test.ts`; `round18-r10-budget-authority.test.ts` | IMPL+TESTED |
| **Expired-claim recovery** (`reclaimExpiredClaims`: abandoned claims re-enter the dispatchable pool; spent-budget rows dead-letter at the recovery boundary) | `src/application/jobs/engine.ts` (dispatchDueJobs step 2); `src/adapters/db/job-store.ts` | accepted engine suites; **tool trace T-28** (25h-aged stranded queued row re-enqueued by the REAL cron, same durable job id) | IMPL+TESTED |
| **Stranded-`queued` re-kick with grace window** (`scanStrandedQueuedJobs` — the application-level recovery for queue loss/outage; re-sends the SAME durable job reference) | `src/application/jobs/engine.ts` (dispatchDueJobs step 3); `mergeDispatchCandidates` | accepted engine suites; **tool trace T-28** | IMPL+TESTED (local); real-Queue TTL expiry/recovery LIVE-UNVERIFIED |
| **DLQ reconciliation SEND from cron** (`reconcileDeadLetters`: scans dead-letter rows with `dlq_delivered_at IS NULL`, sends the safe reference to the DLQ producer, guarded `markDlqDelivered` confirmation — at-least-once) | `src/application/jobs/engine.ts` (reconcileDeadLetters); `src/entrypoints/cron.ts`; `src/adapters/db/job-store.ts` | `migration-0003.test.ts`; `job-store-lifecycle.test.ts`; **tool trace T-27** (one real cron pass: 1 DLQ send + guarded confirmation) | IMPL+TESTED (fake producer); real DLQ queue send/receive LIVE-UNVERIFIED |
| Durable bounded-retry ladder → `dead_letter` terminal row (message acked each delivery; durable dispatch owns retries) | `src/domain/jobs/lifecycle.ts`; `src/application/jobs/engine.ts` (decideRetry/markJobRetryWait) | accepted engine suites; **tool trace T-26** (3 deliveries → dead_letter; terminal-row transition ONLY — not DLQ-send proof) | IMPL+TESTED |
| DLQ: queue-level dead-letter + durable bookkeeping (`jobs.dlq_delivered_at`), bounded reconciliation from cron | `migrations/0003_job_dlq_delivery.sql`; `src/adapters/db/job-store.ts`; `src/application/jobs/engine.ts` (reconcileDeadLetters); `src/adapters/queue/jobs-producer.ts` (DlqReference — safe fields only) | `migration-0003.test.ts`; `job-store-lifecycle.test.ts`; `job-engine.test.ts` | IMPL+TESTED (fakes); LIVE-UNVERIFIED on real Queues |
| D1 tables (applied 0001–0003) | `migrations/0001_initial_schema.sql`, `0002*`, `0003*` | `d1-schema.test.ts` pins exact table/index set | IMPL+TESTED |
| **Ingestion has never run with the gate ON anywhere** (gate `false` in shipped tree, local AND preview) | `wrangler.jsonc` | — | LIVE-UNVERIFIED |

## 8. Schema capability (three states) & R09 ownership

| Capability | File evidence | Test evidence | Tier |
|---|---|---|---|
| Default expected schema version = **3** (top-level AND preview) | `wrangler.jsonc` (`SCHEMA_VERSION: "3"`); `src/shared/config/phase1a.ts` (EXPECTED_SCHEMA_VERSION); surfaced by `GET /version` | `phase1a-config.test.ts`; `version.test.ts` | IMPL+TESTED |
| Health = exact-equality vs configured expectation; never accepts arbitrary versions | `src/adapters/db/schema-health.ts` (checkSchemaHealth) | `round19-r09-ownership.test.ts` R09-P16 (v4 DB + expectation 3 → unhealthy); `http.test.ts` readiness | IMPL+TESTED |
| Three typed capability states (R19-01): `known_v3_legacy` / `known_v4_ownership` / `unresolved{reason}` | `schema-health.ts` (resolveSchemaCapability, OWNERSHIP_SCHEMA_VERSION=4) | `tests/integration/round191-capability-failclosed.test.ts` (16 tests) | IMPL+TESTED |
| Unresolved stops scheduling BEFORE probe/seed/scan AND stops poll BEFORE preflight/budget/network/items/state; bounded retries → observable dead-letter | `scheduler.ts`; `poll-handler.ts`; `cron.ts` (`cron.ingestion_capability_unresolved`) | `round191-capability-failclosed.test.ts` (zero side effects asserted) | IMPL+TESTED |
| R09 owned scheduling S1/S2/S3 (atomic batch, 7-outcome classification); claim-time A1 acquisition; ownership-fenced commit (P-fenced items/state, atomic release) | `src/adapters/db/source-ingest-store.ts`; `poll-handler.ts` | `round19-r09-ownership.test.ts` (R09-P1…P17) on disposable schema-4 D1 only | IMPL+TESTED (disposable D1) |
| Foreign-window job rejection (R19-02): complete durable identity checked BEFORE terminal/nonterminal classification; no auto-cancel/transfer | `source-ingest-store.ts` (schedulePollWindowOwned) | `tests/integration/round191-foreign-window-identity.test.ts` (7) | IMPL+TESTED |
| Migration 0004 (candidate): `source_state.poll_owner_job_id` + partial unique outstanding-poll index + metadata→4 | `migrations/0004_source_poll_ownership.sql`; test-only plan `tests/helpers/migrations.ts` (`ROUND19_MIGRATION_PLAN`) | R09-P14 (whole/atomic/idempotent), R09-P15 (duplicate preflight empty on healthy DB) | IMPL+TESTED on disposable D1; **NOT applied anywhere real** |
| C.3 duplicate preflight `scanOutstandingPollDuplicates` (read-only, runs on schema 3 or 4) | `src/adapters/db/source-ingest-store.ts` | R09-P15; design lab P-M1/P-M2 | IMPL+TESTED |
| Owner-runbook recovery for non-empty preflight (drain-and-retry; guarded owner-approved dedup reference impl NOT wired into product) | `docs/reviews/PIXEL_ROUND1_9_MIGRATION_0004_TRANSITION.md` §3; `tests/design/round15-ownership.ts` (`cancelSupersededPollJob`) | design lab P-M3 | FUTURE / NOT IMPLEMENTED (deliberately absent from product) |

## 9. Observability & HTTP surface

| Capability | File evidence | Test evidence | Tier |
|---|---|---|---|
| Structured JSON logger (only module allowed `console.*`), redaction, safe-error policy; platform `observability.enabled` | `src/observability/logger.ts`, `redaction.ts`, `safe-error.ts`; `wrangler.jsonc` | `tests/unit/logger.test.ts`, `redaction.test.ts`, `request-errors.test.ts` | IMPL+TESTED |
| `GET /health`, `/health/live`, `/health/ready` (readiness 503 with reasons incl. `schema_version_mismatch`, `jobs_config_invalid`), `GET /version` | `src/entrypoints/http/router.ts`; `handlers/health.ts`, `handlers/version.ts` | `tests/integration/http.test.ts`; `version.test.ts`; `worker-fetch.test.ts` | IMPL+TESTED |
| Ingestion event codes (`cron.ingestion_*`, `ingestion.schedule.*` incl. `foreign_window_job`, `ingestion.poll.*`) | `src/application/*` | asserted across round19*/round18/source-poll-pipeline suites | IMPL+TESTED |

## 10. Preview environment & remote-operation surface (NAMES ONLY)

| Item | Evidence | Tier / note |
|---|---|---|
| Preview worker `pixel-preview`; D1 binding `DB` → database name `pixel-db-preview` (id `0212653a-b989-4953-9179-ddc01899c7f2` declared in wrangler.jsonc); migrations dir `migrations` | `wrangler.jsonc` env.preview | DECLARED |
| Preview queues: `pixel-jobs-preview`, `pixel-dlq-preview` (bindings `JOBS`, `DLQ`) | `wrangler.jsonc` env.preview.queues | DECLARED; provisioned by owner runbook only |
| Vars (names): `APP_VERSION`, `ENVIRONMENT`, `LOG_LEVEL`, `APP_COMMIT`, `SCHEMA_VERSION`, `TELEGRAM_INGRESS_ENABLED`, `JOBS_ENABLED`, `SOURCE_INGESTION_ENABLED` | `wrangler.jsonc` | DECLARED |
| Secrets — TELEGRAM CURRENT (names): `BOT_TOKEN`, `WEBHOOK_SECRET`, `OWNER_TELEGRAM_ID` | `src/shared/config/phase2.ts` (INGRESS_REQUIRED_SECRETS); `src/shared/types/env.ts` (WorkerEnv) | NAMES ONLY; values are owner-managed Cloudflare secrets |
| Secrets — CONDITIONAL on enabling the named CURRENT connector (names): `YOUTUBE_API_KEY`, `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, optional `GITHUB_TOKEN` | `src/connectors/{youtube-playlists,reddit-oauth,github-releases}.ts` preflight/secret reads; `src/shared/types/env.ts` | NAMES ONLY; consumed ONLY when that connector's source is enabled via the Stage-8 runbook — never run so far (gate OFF everywhere) |
| Secrets — FUTURE SERVICES ONLY (names): `GEMINI_API_KEY`, `GROQ_API_KEY`, `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET`, `BLUESKY_APP_PASSWORD`; future bindings `CACHE` (KV), `MEDIA` (R2), `AI` | `src/shared/types/env.ts` (PixelSecrets, PixelBindings); commented blocks in `wrangler.jsonc` | FUTURE / NOT IMPLEMENTED (R110-04 classification; no current code consumes them) |
| `scripts/deploy-preview.mjs`: exits 1 without `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN`; then **real** `wrangler deploy --env preview` | `scripts/deploy-preview.mjs` | LIVE-UNVERIFIED, **REMOTE-OPERATING — NOT run in this round** |
| `db:migrations:list:preview` / `db:migrations:apply:preview` (remote D1 ops) | `package.json` | **REMOTE-OPERATING — NOT run in this round** |
| CI workflow: `permissions: contents: read`, never deploys; runs `npm run check` incl. dry-run build | `.github/workflows/ci.yml` | Safe (no remote ops) |

---

## Snapshot summary

- **Fully implemented + locally tested (offline workerd, zero live traffic in tests):**
  webhook security edge, update parsing, durable claim lifecycle, authorization,
  5-command admin router, per-admin UI language, `sendMessage`/`answerCallbackQuery`
  client paths (mocked transport), D01 policy pause, ingestion pipeline end-to-end
  (gate OFF), budgets, DLQ bookkeeping, schema capability three-state, R09
  ownership on disposable schema-4 D1.
- **Implemented but dormant/unwired:** `getMe`, `editMessageText`, callback
  routing, action-token menu contract, `TARGET_CHANNEL`, approval schema columns.
- **LIVE-UNVERIFIED:** all five connector fetch paths (mock-only), preview queue
  provisioning, real platform cron, preview webhook registration + one-time live
  smoke (operator-asserted only).
- **FUTURE / NOT IMPLEMENTED:** full admin command map (`/mode`, `/pause`, …),
  editorial Story/Evidence/AI/media/publishing code, admin screens, shadow mode,
  test channel, production rollout, production infra, catalog-only connectors.

> R1.10.3 note: the connector multi-request fixtures (RSS multi-feed, Steam 3 apps,
> YouTube 2 playlists + details, GitHub 2 repos, Reddit 2 subreddits) are
> REPRESENTATIVE shapes, NOT supported-max proofs; per-connector max-bound
> budgets are excluded from the FIRST Free preview profile until separately
> measured (free-plan/FREE_SAFE_EXECUTION_DESIGN.md §6).
