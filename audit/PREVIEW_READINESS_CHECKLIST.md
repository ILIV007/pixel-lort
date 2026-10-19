# PIXEL — Operator Preview-Readiness Checklist & Proposed Ordered Plan

**R1.10.2 corrected edition (TR-03 ordering fix applied; TR-01/TR-06 unit and
accounting corrections carried). PROPOSED, NOT EXECUTED.** This document
identifies configuration/binding/secret NAMES only. It invents NO secret
values and asserts NO live resource state. Every execution stage below
requires separate owner authorization. No Cloudflare API/CLI remote call,
provider call, or live Telegram message was made in Rounds 1.10, 1.10.1 or
1.10.2. The Round-1.10 original is preserved under
`input/R1.10.1_61a01947_ORIGINAL.zip` (sealed history); the R1.10.1 editions
are preserved inside that same sealed input.

Convention: `NAMES` are exactly as declared in the accepted source
(`wrangler.jsonc`, `src/shared/config/*`, `src/shared/types/env.ts`,
`package.json`). **Free-plan constraint (owner):** the whole plan is
Free-plan-first — no paid upgrade, no quota bypass. The advertised
batch-10 / 100-item ingestion profile is **NOT_READY_FOR_INGESTION_ON_FREE**
(local measured evidence: one supported 100-item poll alone issues 110
execution-API-call attempts / 211 statements — above the documented Free
"50 queries per Worker invocation" under BOTH unit interpretations; see
`free-plan/FREE_PLAN_COMPATIBILITY.md` §1/§4 and
`free-plan/FREE_SAFE_EXECUTION_DESIGN.md`). Sustained activation requires
acceptance of that design FIRST (Stage 8c).

---

## A. Configuration inventory (NAMES ONLY — nothing provisioned or read remotely)

### A.1 Worker environments

- Top-level worker name: `pixel` (local/dev scope)
- Preview worker name: `pixel-preview` (env `preview`)
- Production infra: intentionally unprovisioned until its release gate
  (`docs/ROADMAP.md` Phase 1B note)

### A.2 D1 bindings

- Binding name: `DB`
- Local placeholder database name: `pixel-db-local` (placeholder id in `wrangler.jsonc`)
- Preview database name: `pixel-db-preview` (id declared in `wrangler.jsonc` env.preview)
- Migrations dir: `migrations` (applied state on any real DB: **schema 3**;
  0004 is a local candidate only, applied NOWHERE real)

### A.3 Queues (preview env only)

- Producer bindings: `JOBS` → queue `pixel-jobs-preview`; `DLQ` → queue `pixel-dlq-preview`
- Consumer: `pixel-jobs-preview` with `dead_letter_queue: pixel-dlq-preview`,
  `max_retries: 3`, `max_batch_size: 10`, `max_batch_timeout: 5`
- Production queue names: commented out in `wrangler.jsonc` (unprovisioned)
- Provisioning runbook: `docs/RUNBOOK_PHASE3_QUEUE_SETUP.md`
- Free-plan note (analysis only, corrected units): Queues on Free = 10,000
  operations/day, 24 h retention (non-configurable); a batch of N messages
  = N× operations (official); D1 execution-API-call units are NOT queue
  operations — see `free-plan/FREE_PLAN_COMPATIBILITY.md` §5 and the
  corrected worksheet §3.

### A.4 Vars (non-secret; values in `wrangler.jsonc` as shipped)

| Name                       | Local (top-level) | Preview                                                          |
| -------------------------- | ----------------- | ---------------------------------------------------------------- |
| `APP_VERSION`              | 1.4.0             | 1.4.0                                                            |
| `ENVIRONMENT`              | dev               | preview                                                          |
| `LOG_LEVEL`                | (as shipped)      | (as shipped)                                                     |
| `APP_COMMIT`               | (as shipped)      | (as shipped; deploy script injects HEAD)                         |
| `SCHEMA_VERSION`           | **"3"**           | **"3"**                                                          |
| `TELEGRAM_INGRESS_ENABLED` | **"false"**       | **"true"**                                                       |
| `JOBS_ENABLED`             | **"false"**       | **"true"**                                                       |
| `SOURCE_INGESTION_ENABLED` | **"false"**       | **"false"** (ADR-0038: activation is an owner runbook procedure) |

### A.5 Secrets (NAMES ONLY — owner-managed via `wrangler secret put`/dashboard)

**Classification (R110-04, unchanged by R1.10.2):**

1. **Telegram — current and required for ingress:**
   `BOT_TOKEN`, `WEBHOOK_SECRET`, `OWNER_TELEGRAM_ID`
   (`INGRESS_REQUIRED_SECRETS`, `src/shared/config/phase2.ts`).
   Non-secret Telegram config: `TARGET_CHANNEL` (format-validated; NOT
   consumed for sending by any code path yet).
2. **Conditional on enabling the named CURRENT connector** (no code runs the
   connector until its source is enabled through the Stage-8 runbook):
   - `YOUTUBE_API_KEY` → YouTube playlists connector
   - `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` → Reddit OAuth connector
   - `GITHUB_TOKEN` (optional) → GitHub releases connector
3. **Future services only (declared names; NO current code consumes them):**
   `GEMINI_API_KEY`, `GROQ_API_KEY` (Phase 6 AI adapters),
   `IGDB_CLIENT_ID`, `IGDB_CLIENT_SECRET` (catalog-only igdb),
   `BLUESKY_APP_PASSWORD` (catalog-only bluesky-public)
   (`src/shared/types/env.ts` PixelSecrets).

### A.6 Future bindings (commented in `wrangler.jsonc`; NOT implemented)

`CACHE` (KV), `MEDIA` (R2), `AI`.
Free-plan note (analysis only): KV/R2/Workers AI have their OWN free
allowances/limits — they are NOT automatically covered by Workers Free; each
requires separate review before its phase (see `free-plan/` §9).

### A.7 Cron (R110-04 corrected, unchanged)

- Shipped config: trigger `*/5 * * * *` declared TOP-LEVEL only; the shipped
  tree declares NO per-environment trigger. (The in-source comment claiming
  "not environment-overridable" is part of the accepted source and stays
  byte-unchanged; factually it is superseded by the platform docs.)
- Platform capability: **per-environment Cron Triggers ARE supported** —
  official docs (provenance: `manager-evidence/official/` excerpts;
  https://developers.cloudflare.com/workers/configuration/cron-triggers/).
- Free-plan note (analysis only): 5 Cron Triggers per account on Free
  (official limits page).
- Real-account state: UNKNOWN — no remote inspection performed. Any future
  per-env trigger change is a config decision requiring owner authorization;
  NONE is made or assumed here.

### A.8 Default-OFF gates / behavior switches (as shipped)

| Gate                                                 | Effect when OFF                                                                                    | Where enforced                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `TELEGRAM_INGRESS_ENABLED=false` (local)             | Webhook route behaves as unknown (uniform 404)                                                     | `telegram-webhook.ts` flag gate                                               |
| `JOBS_ENABLED=false` (local)                         | Jobs engine not resolved; cron no-op                                                               | `src/application/jobs/engine-env.ts`, `src/entrypoints/cron.ts`               |
| `SOURCE_INGESTION_ENABLED=false` (local AND preview) | `sources.fetch_poll` jobs acked `paused_by_policy`; ZERO durable writes; scheduling skipped IN SQL | `src/domain/jobs/policy.ts`, `src/application/jobs/engine.ts` (D01, ADR-0040) |
| `SCHEMA_VERSION="3"`                                 | Health expects exactly 3; ownership features feature-detect applied version (3 → legacy path)      | `src/adapters/db/schema-health.ts`, scheduler/poll-handler                    |
| No `BOT_TOKEN`                                       | No Bot API client; outbound actions 503 retryable                                                  | `telegram-webhook.ts`, `telegram-ingress.ts`                                  |

---

## B. Proposed ordered plan (each stage = separate owner authorization checkpoint)

> Success/abort criteria are stated per stage. NOTHING below has been
> executed by Rounds 1.10/1.10.1/1.10.2. Stages 5+ execute REMOTE operations
> and are owner-only. **TR-03 fix — the Stage-7.5/8 dependency cycle is
> REMOVED:** the bounded gate-ON permission (8a) now exists BEFORE any
> network proof, bounded smoke runs INSIDE that permission (8b), and the
> sustained-ingestion decision is a SEPARATE later stage (8c). Smoke-test
> phases: Stage 6 = Phase A (pre-migration, schema 3); Stage 8b = Phase B
> (post-migration, schema 4, bounded, gate-ON window). S-08 never precedes
> S-07.

**Stage 0 — Preconditions audit (read-only, names-only)**

- Confirm this checklist matches the deployed-to-be tree (VERSION.json app 1.4.0, SCHEMA_VERSION 3).
- Confirm no secrets/tokens exist in the repo (`scan:secrets` = 297 files / 0 findings — re-run green this round, `logs/09-secret-scan.log`).
- Success: inventory agrees with `wrangler.jsonc` + config modules. Abort: any mismatch → stop, reconcile docs.

**Stage 1 — Preview infra confirmation (owner; remote read-only)**

- Confirm D1 `pixel-db-preview` exists and queue resources `pixel-jobs-preview` / `pixel-dlq-preview` are provisioned per `docs/RUNBOOK_PHASE3_QUEUE_SETUP.md`.
- Free-plan caution (analysis only): confirm whether the account is on Free and whether these resources share account-wide free allowances with other workers/DBs/queues — entitlement is owner-side knowledge, unknown to this audit.
- Success: resources visible to owner's Cloudflare account. Abort: missing queue/DLQ → do not proceed to deploy.

**Stage 2 — Schema-3 baseline verification on preview D1 (owner; remote read-only)**

- `db:migrations:list:preview` must show 0001–0003 applied, 0004 NOT applied.
- `GET /health/ready` and `GET /version` on the deployed preview must report healthy + `SCHEMA_VERSION=3` equality.
- Success: exact-equality health passes at 3. Abort: mismatch → stop; do NOT flip vars ad hoc.

**Stage 3 — Secrets presence confirmation (owner; names only)**

- Confirm the three TELEGRAM-CURRENT secrets (`BOT_TOKEN`, `WEBHOOK_SECRET`, `OWNER_TELEGRAM_ID`) exist for `pixel-preview`. Values are never echoed, exported, or logged. Connector-conditional secrets are confirmed only at the stage that enables the connector (Stage 8a), never before.
- Success: presence confirmed. Abort: any missing → ingress will fail closed (401/503 paths).

**Stage 4 — Dry-run deploy proof (local, already re-proven)**

- `npm run build:preview` (dry-run) exit 0 — reproduced this round (logs/13, logs/14).
- Success: bundle compiles. Abort: compile failure → fix locally first.

**Stage 5 — Owner-authorized preview deploy + webhook registration (REMOTE; owner-only)**

- Owner runs `npm run deploy:preview` (injects `APP_COMMIT:<HEAD sha>`) and `scripts/telegram-webhook-setup.mjs` (sets webhook with `WEBHOOK_SECRET`, `allowed_updates=[message,edited_message,callback_query]`, `max_connections=4`, target `https://pixel-preview.pixellort.workers.dev/telegram/webhook`).
- **Authorization checkpoint A:** explicit owner "go" for preview deploy + webhook.
- Success: deploy output success + webhook `getWebhookInfo` shows pending update count reset; `/health/ready` green from the public URL. Abort: any deploy error → keep previous worker; do not retry blindly.

**Stage 6 — Preview smoke tests, Phase A (REMOTE; owner-only; spec in `audit/PREVIEW_SMOKE_TESTS.md`)**

- Scope: S-01…S-06, S-09, S-10(A) — schema 3 (expected AND applied = 3),
  ingestion gate OFF, NO provider fetch, NO ownership assertions.
- **Authorization checkpoint B:** explicit owner "go" for live smoke.
- Success/abort criteria per scenario in the smoke doc; global abort =
  unexpected side effect, budget anomaly, or UNEXPECTED DLQ growth
  (see the DLQ nuance in the smoke doc — bounded infrastructure retries
  legitimately exhaust and are NOT an abort).

**Stage 7 — (LATER, separate) schema 3→4 migration decision (REMOTE; owner-only)**

- Follow `audit/SCHEMA3_TO_4_TRANSITION_REVIEW.md` §runbook: owner approval → Time Travel bookmark (owner-side, LIVE-UNVERIFIED capability) → duplicate preflight EMPTY → apply 0004 once, whole → verify metadata → set `SCHEMA_VERSION="4"` → verify health at 4 (expected AND applied = 4).
- **Authorization checkpoint C:** explicit owner "go" for real migration. Success/abort criteria in the review doc §rollback. Free-plan note: Time Travel window on Free is 7 days — the bookmark-restore drill must happen within it.

**Stage 8a — (LATER, separate) BOUNDED gate-ON test authorization (owner-only decision; NO execution here)**

- The owner grants a TIME-BOUNDED, COUNT-BOUNDED test window:
  `SOURCE_INGESTION_ENABLED="true"` on preview ONLY for the window, with
  ONE enabled low-volume RSS source (registry `playstation_blog`),
  budgets row present, DLQ observable. This permission exists BEFORE any
  network proof (TR-03: no active network proof before its gate).
- The window's scope is bounded by the smoke spec (S-07/S-08 bounded
  counters). Window end is an EXPLICIT TIMED OPERATOR SHUTDOWN/CHECK: the
  operator (or an operator-run scheduled check they choose to perform)
  sets the gate back to "false" at the agreed time — R1.10.3 correction:
  NO automatic reversion mechanism exists or is authorized, so none is
  claimed (lossless per ADR-0040).

**Stage 8b — Bounded smoke, Phase B (REMOTE; owner-only; INSIDE the 8a window)**

- Scope: S-07 (bounded provider fetch — attempted/observed-completed/
  authorized/charged recorded as SEPARATE counters), then S-08 (ownership
  observability) — **S-08 never precedes S-07** — and S-10(B) health at 4
  (expected AND applied = 4).
- Abort: unbounded retries, budget double-charge for a single completed
  hop, items from more than the enabled source, any schema-3 fallback
  executed AFTER the flip, UNEXPECTED DLQ growth.

**Stage 8c — OFF/cleanup + separate SUSTAINED-ingestion activation decision**

- Gate returns to `"false"` (lossless), window artifacts reviewed.
- The sustained-activation decision requires: the Free-safe DESIGN
  (`free-plan/FREE_SAFE_EXECUTION_DESIGN.md`) ACCEPTED by the manager and
  THEN implemented by a future authorized round (this round is DESIGN
  ONLY), plus the approved cloud-measurement plan
  (`free-plan/FREE_PLAN_COMPATIBILITY.md` §11). Until both exist, the
  advertised batch-10/100-item profile remains
  **NOT_READY_FOR_INGESTION_ON_FREE**.
- **Authorization checkpoint D:** explicit owner "go" for sustained
  ingestion (only after the above). Abort: budget/dlq/quota anomalies →
  flip back to "false" (lossless per ADR-0040).

---

## C. Standing abort criteria (any stage)

1. Any unexpected durable side effect outside the declared stage scope.
2. Any secret/value echoed to logs or output.
3. Health/readiness failing exact-equality after any var change (outside the
   declared migration transition window).
4. DLQ growth that is UNEXPECTED for the declared stage (bounded
   infrastructure retry exhaustion inside a declared drill is an EXPECTED
   outcome and is recorded, not treated as an abort; anything outside the
   declared drill envelope aborts).
5. Any ambiguity in resource identity (never guess IDs — stop and reconcile).
6. Any indication that a Free-plan account limit is being approached without
   an approved measurement plan (see free-plan §11) — stop and re-assess.
