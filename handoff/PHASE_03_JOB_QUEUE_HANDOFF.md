# Phase 3 — durable job/queue framework and idempotency handoff

## 1. Result

Phase 3 (blueprint §26 step 3 — job/queue framework and idempotency) is
implemented on branch `phase/03-job-queue-engine`, created from the verified
baseline and delivered for independent review. Application version **1.3.0**;
schema version **3** (incremental migration 0003; migrations 0001/0002
untouched). Blueprint files remain byte-identical; all historical handoffs
are preserved.

- Baseline (verified before work): `origin/main` =
  `d7872db92f2c1ef2f3e6c841998af252e3b294f2` (merge of old main `564116e`
  and the reviewed v1.2.6 feature HEAD `318d0979…`; tree identical to the
  reviewed delivery — no differences to disclose).
- Decision record: **[ADR-0036](../docs/DECISIONS/adr-0036-job-queue-engine.md)**
  (lifecycle, fencing, dispatch reconciliation, retry ownership, poison
  handling, DLQ delivery/reconciliation, activation safety) + operator
  runbook [docs/RUNBOOK_PHASE3_QUEUE_SETUP.md](../docs/RUNBOOK_PHASE3_QUEUE_SETUP.md).
- `docs/ROADMAP.md` synchronized: Phase 2B (preview live wiring + UI
  language v1.2.5/v1.2.6) recorded complete; Phase 3 marked
  implemented-offline with activation gated; phases 4+ untouched.
- **Offline pass:** no credentials, no push/merge, no deploy, no resource
  creation, no remote migrations, no webhook changes, no live Telegram/AI
  traffic, no admin CRUD, no publishing.

## 2. What was built (and what deliberately was not)

- **Domain (`src/domain/jobs/`)** — pure, SDK-free vocabulary and rules:
  statuses/types/error-code registries, strict Zod envelope contract,
  per-type Zod payload schemas + canonical JSON + size bounds, backoff
  (full jitter, capped, `retry_after` floor) and retry classification,
  handler port + registry.
- **Store (`src/adapters/db/job-store.ts`)** — ALL job SQL behind the typed
  D1 boundary: idempotent create (UNIQUE key; conflict detection by type +
  canonical payload), atomic claim CAS (one winner, generation =
  `attempts + 1`, expired-lease stale-reclaim, unexpired lease never
  stolen), generation-fenced complete/retry/dead-letter, guarded poison
  transitions, queued marker, bounded deterministic recovery scans,
  DLQ-delivery confirmation.
- **Engine (`src/application/jobs/`)** — orchestration with injected
  executor/producers/handlers/clock/random/logger: durable-create-FIRST
  dispatch with both uncertainty windows solved, bounded consumer decision
  table (persist-before-ack; never acknowledge uncertain completion), DLQ
  reconciliation, fail-closed env resolution.
- **Entrypoints** — `cron.ts`: structured no-op when disabled; bounded
  reclaim → dispatch → DLQ-reconcile passes when enabled (no inline
  connector/AI/publishing). `queue.ts`: validated dispatch → claim →
  handler → fenced persistence; poison messages acked, uncertain work
  retried; disabled/misconfigured deployments retry (never ack-all —
  ADR-0011 honored).
- **Handler** — exactly ONE registered type,
  `jobs.maintenance_heartbeat`: idempotent D1-only upsert in the dedicated
  `jobs_maintenance:` settings namespace. Working Telegram commands remain
  synchronous; no public smoke endpoint; no fake handlers for later phases.
- **Configuration/activation** — `JOBS_ENABLED` flag (fail-closed, default
  false) preserving the Telegram-only deployment when off; preview queue
  bindings DECLARED in wrangler.jsonc (`JOBS`→`pixel-jobs-preview`,
  `DLQ`→`pixel-dlq-preview`, consumer `dead_letter_queue` + `max_retries`
  3 + batch 10/5s) with resources provisioned ONLY by the runbook;
  `*/5` cron trigger declared (handler is a no-op while disabled);
  production bindings remain future-only.
- **Zod** — first (and ADR-0010-planned) runtime dependency, `zod@3.25.76`,
  used ONLY for envelope/payload contracts (the config validator remains
  dependency-free per ADR-0003).

## 3. Schema delta (migration 0003 → schema version 3)

The existing `jobs` table (migration 0001) already carried every lifecycle
field the engine needs. ONE genuinely missing capability required a field:
DLQ-delivery reconciliation ("was the safe reference confirmed enqueued?")
without re-sending every dead-letter row forever.

- `ALTER TABLE jobs ADD COLUMN dlq_delivered_at INTEGER` (NULL = not yet
  delivered → reconcilable).
- `CREATE INDEX idx_jobs_dlq_pending ON jobs(status, dlq_delivered_at)` —
  serves the bounded reconciliation scan (`EXPLAIN QUERY PLAN` verified in
  tests); dispatch/reclaim scans reuse `idx_jobs_due` and the lease/grace
  mechanics keep claimed/queued populations bounded.
- `schema_metadata` advanced to version `3` / `0003_job_dlq_delivery` inside
  the same atomic batch. No hypothetical future tables.

## 4. Lifecycle and crash-window design (summary; details in ADR-0036)

- **Creation** is idempotent under races; a same-key request with an
  incompatible type/payload is a CONFLICT and never overwrites.
- **Claim** awards one execution generation atomically; `attempts` is the
  fencing generation for every owner-dependent mutation; a stale owner can
  never succeed/fail/extend/release a newer owner's job. Lease = 2 minutes
  (centralized constant), renewal deliberately NOT supported (bounded D1-only
  handlers; ADR-0036 §1). Boundaries tested at −1 ms / exact expiry / +1 ms.
- **Dispatch windows:** (1) persist-ok + enqueue-failed/unknown → row stays
  `pending`/`retry_wait`, recoverable by the bounded cron scan;
  (2) enqueue-ok + marker-write failure/death → the delivered reference
  still processes and cron re-dispatch only produces duplicate REFERENCES.
  A `queued` marker alone cannot strand work (60 s grace re-kick, re-armed
  on re-dispatch). Overlapping crons create duplicate REFERENCES absorbed by
  claim fencing — never duplicate durable effects.
- **Retry ownership:** D1 `run_after` is the single durable schedule; queue
  `retry()` is delivery pressure only. A retry is acked ONLY after its
  `retry_wait` schedule is durably persisted; provider retries and cron
  cannot amplify each other (each delivery = at most one claim attempt;
  each claim burns one of `max_attempts`).
- **Poison/DLQ:** unregistered types + corrupt payloads → fenced
  `dead_letter` (no execution, no hot loop); malformed envelope/unsupported
  version/missing row → ack without durable mutation; exhaustion → durable
  `dead_letter` then bounded safe reference to DLQ (jobId/type/attempts/
  errorCode/failedAtMs ONLY) reconciled via `dlq_delivered_at`; a crash
  between send and confirm yields ONE duplicate reference — never a lost
  record. Platform (`max_retries`) DLQ needs no D1 mutation: cron reclaim +
  re-dispatch converge on D1. Operator replay: documented, controlled,
  new-job-with-fresh-key semantics (no terminal mutation, no UI/endpoint;
  live replay not authorized in this pass).

## 5. Verification (all executed in this workspace)

- Full suite on the final tree: `npx vitest run` — **600 tests / 46 files,
  all passing** (baseline 519/40 + 81 new tests across
  `job-contracts`, `phase3-config`, `job-store-lifecycle`,
  `job-engine`, `job-entrypoints`, `migration-0003`, and updated
  queue/scheduled/config/version/migration suites).
- `npm run test:db` — **98/98** (D1 schema, boundaries, migration plans,
  migrations 0002/0003, job store lifecycle, engine, entrypoint activation).
- `npm run test:telegram-setup` — 14/14; `npm run test:secrets` — 10/10;
  `npm run scan:secrets` — 0 findings (tracked tree).
- `npm run check:versions` — application 1.3.0 / schema 3 consistent across
  every active touch point (package.json/lock root, wrangler vars ×2,
  phase0 default, .env.example, .dev.vars.example, test-env helper; lock
  dependency resolution integrity preserved — `word-wrap` stays 1.2.5).
- `npm run lint`, `format:check`, `typecheck` — clean.
- `npm run build` — wrangler dry-run (top-level: unchanged Telegram-only
  shape, no queue bindings) AND `npm run build:preview` — wrangler dry-run
  with the declared preview queue bindings. Both dry-runs only; never a
  deploy.
- Test totals are reported as measured — no predetermined total was chased.

## 6. Remaining limits (disclosed, not hidden)

- The previously-noted dependency-audit/build-system limitations carry over
  unchanged (the branch Cloudflare Workers Builds failure was never
  diagnosed; per scope this phase does not expand into a CI rewrite).
- `failed` status remains RESERVED (never written by this engine; consumers
  treat it as non-executable). A future owner must ADR it.
- Lease renewal is intentionally unsupported; long-running future handlers
  need their own ADR. `max_attempts` defaults to 3; the 5-attempt P0
  publication policy is documented, not implemented (no publishing exists).
- The 5-attempt publishing gate from ADR-0032 stands: no autonomous channel
  publishing before the outbox-style reconciliation layer exists (Phase 8).
- Queue bindings are DECLARED for preview but no Cloudflare resource was
  created; the engine cannot run live until the runbook steps are executed
  by the owner after review.
- Consumer batch processing is sequential per message (bounded by
  `max_batch_size` 10); no intra-batch parallelism was needed at this scale.

## 7. Delivery

- Single artifact: `pixel-lort-phase03-job-queue-v1.3.0.zip` — full working
  tree + complete `.git` history at the archive root; tracked
  `.env.example`/`.dev.vars.example` INCLUDED; node_modules, dist, .wrangler,
  coverage, logs, real env/secret files, and prior ZIPs excluded; index file
  modes preserved and verified with `core.filemode=true` on extraction.
- No push, merge, deploy, provisioning, remote migration, or webhook change
  was performed. **STOP — awaiting independent review.**

## 8. Review corrections — v1.3.1 (same branch, same history; ADR-0037)

The independent review of v1.3.0 returned three critical findings, each
demonstrated by a real integration path. All three are fixed in this
corrective release; the six reviewer regression tests
(`tests/integration/phase03-review-regressions.test.ts`) pass verbatim —
no assertion was weakened. Blueprint files remain byte-identical; schema
stays at version 3; ADR-0037 records the decisions.

1. **Wire contract (producer → delivered body → consumer).** The JOBS
   producer adapter pre-stringified the envelope while the consumer
   expected the object Cloudflare Queues delivers — a valid message was
   classified `poison_malformed_envelope` and no handler ran. Fix: ONE
   canonical wire form — producers send the Zod-validated envelope OBJECT
   (`toWireEnvelope`; DLQ producer likewise sends the structured bounded
   reference), and the consumer normalizes a JSON-encoded string
   defensively (one bounded parse, identical validation) so pre-upgrade
   in-flight messages and replay tooling still resolve. The end-to-end
   path (real adapter output consumed by the engine, no manual
   `JSON.parse`) is pinned by the reviewer's test 1 plus adapter unit
   tests.
2. **Attempt budget at the atomic claim/recovery boundary.** A job at
   `attempts = max_attempts` whose final generation crashed before
   persisting an outcome was re-claimed after lease expiry and executed a
   fourth time. Fix: the boundary itself enforces the budget —
   `claimJob` dead-letters a spent-budget row by ONE guarded UPDATE
   (fenced by the observed state; the CAS also carries
   `AND attempts < max_attempts`), `reclaimExpiredClaims` applies the same
   rule with mutually exclusive guarded transitions, and the consumer
   acknowledges `job_dead_lettered` only after the durable terminal write
   (persist-before-ack). A new `reclaimedExhausted` dispatch metric and
   honest tests (`handlerCalls() === 0`) pin the behavior.
3. **Strict activation gating shared by runtime and readiness.** An
   invalid present `JOBS_ENABLED` was silently treated as disabled, an
   enabled engine without JOBS/DLQ bindings resolved ready, and
   `/health/ready` returned 200. Fix: validation runs BEFORE the flag is
   read; an enabled engine requires DB + JOBS + DLQ bindings
   (`config_invalid` otherwise); `/health/ready` consumes the SAME
   resolution and returns 503 (`jobs_config_invalid`). Disabled remains
   the ordinary Telegram-only ready state; engine-layer ports stay
   optional for offline harnesses (only the environment resolver is
   strict).

Verification for this round (measured, no totals chased): reviewer
regression suite 6/6; jobs-related suites 92/92; full gate + test:db +
preview dry-run re-run on the bumped version 1.3.1 — all green (numbers in
the final report). Version touch points aligned to 1.3.1 by
`scripts/check-versions.mjs`. Artifact: `pixel-lort-phase03-job-queue-v1.3.1.zip`
(full tree + complete `.git`, same packaging and verification recipe as
§7). **STOP — awaiting independent review of the corrective release; no
activation, provisioning, or Phase 4 work performed.**
