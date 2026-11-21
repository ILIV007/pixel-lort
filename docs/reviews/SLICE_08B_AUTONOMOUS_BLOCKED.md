# Slice 8b — Autonomous path: BLOCKED (missing links, no posts sent)

Date: 2026-11-20/21 (checked ~22:40 UTC 2026-11-20 / ~02:10 Tehran 2026-11-21)
Worker: slice-8b autonomous-path probe. Branch state: repo at origin/main HEAD
`9213882`, preview live v1.46.0 / schema 10. **Nothing was changed, nothing
was sent: no flags flipped, no deploy, no D1 writes, no Telegram sends.
`published_posts` is still 0, mode is still `paused`.**

## Verdict

The autonomous chain **source → draft → publish cannot run on the deployed
preview**. It is not a flag problem: five links in the chain are missing or
unwired in production code (v1.46.0). Per the slice-8b instruction no
workaround was attempted (no hand-written `published_posts` rows, no raw
Bot API sends, no direct D1 item inserts).

## Live state verified (read-only, D1 API + public endpoints)

- `/version`: `1.46.0`, commit `9213882…`, schema `10`, env `preview`.
- `/health/ready`: `{"ok":true,"service":"pixel","status":"ready"}`.
- D1 `pixel-db-preview`: `sources` 0, `source_state` 0, `source_items` 0,
  `publications` 0, `published_posts` 0, `drafts` 0, `stories` 0,
  `jobs` 3 (old `jobs.maintenance_heartbeat` rows, 2026-10-08), `souls` 1
  (Soul v1), `audit_events` 4.
- `settings`: `publishing.mode = paused` (updated_by 126679582),
  `soul.current_version = 1`.
- Feeds live at check time (fetched 2026-11-20 22:39 UTC): PS Blog feed
  (Hounded item 2026-11-17 still present; podcast ep. 553 today) and
  GameSpot feed (T1 article "GTA 6's Astonishing $4 Billion Day One
  Includes 32.5 Million Copies Sold", 2026-11-20 19:30 UTC, 32.5M /
  $3.79B — identical facts to the shadow run). Content is available;
  the pipeline is what is missing.

## The missing links (each verified by grep over `src/`)

### Link 0 — Registry gap: VGC / Gematsu / GameSpot are not sources

The embedded registry (`docs/blueprint/v1/pixel_source_registry_v1.json`,
14 sources) contains `playstation_blog` and `xbox_wire` but **no VGC, no
Gematsu, no GameSpot**. T1's sources (GameSpot + Gematsu) and T3's source
(Gematsu) can never be polled. Minimal fix: add the three RSS sources to
the registry (code change; review + PR + CI + deploy).

### Link 1 — Ingestion off and empty (flippable by procedure, not code)

Preview `SOURCE_INGESTION_ENABLED=false`; live `sources` table is empty.
The cron scheduler (`src/application/ingestion/scheduler.ts`) would seed
the 14 registry rows on the next pass, but new rows stay `enabled=0`
("New rows stay disabled"), so zero due sources → zero poll jobs until
the owner enables specific sources per `docs/RUNBOOK_PHASE4_SOURCES.md`
(`UPDATE sources SET enabled = 1 …`). The RSS connector itself IS
implemented (`src/connectors/rss.ts`, registered), so this link needs
activation, not code.

### Link 2 — Ingestion → editorial is UNWIRED (core break)

`src/application/editorial/enqueue-prepare-draft.ts` header: the ONLY way
an `editorial.prepare_draft` job is created is programmatic, "NOT
auto-scheduled by cron, NOT reachable through any public endpoint or
command … the integration suite and the demo runner are the sanctioned
callers this round." Zero production callers in `src/`; the poll handler
commits items and stops. Ingested items would sit in `source_items`
forever. Minimal fix: a production trigger — poll-handler (or a cron /
post-poll step) calls `enqueueEditorialPrepareDraft` for newly inserted
items, behind the editorial gate; tests + PR + CI + deploy.

### Link 3 — No draft is producible with AI off; there is NO no-AI fallback

`src/application/ai/draft-service.ts:148`: `AI_ENABLED` off → typed
deferred `ai_disabled`, zero provider calls. The prepare-draft handler
maps `ai_disabled` onto the recoverable retry path
(`RETRYABLE_DEFERRED_REASONS`), so the job retries to exhaustion and
dead-letters — never a draft. There is no template / no-AI draft path in
the service or the handler (the service's "fallback" is provider
fallback CF → Gemini, not a no-AI draft). The slice-8b premise of an
acceptable no-AI fallback does not match the code. Minimal fix, one of:
(a) enable AI (`AI_ENABLED=true`; Workers AI binding already exists on
preview; free-tier models per policy; Gemini fallback stays unwired /
unverified) — a reviewed owner activation; or (b) build a deterministic
no-AI draft path (template render from the item's own fields + Soul v1
formatting + fact-guard) as new code.

### Link 4 — Draft → publication is UNWIRED

`enqueuePublication` (`src/adapters/db/publication-outbox-store.ts:241`)
is called in production only by `album-draft-producer.ts`, which has zero
production callers; `createPublication`
(`src/adapters/db/admin-post-store.ts:802`) has zero callers in `src/`.
Nothing converts a ready / `auto_approved` draft into a `publications`
outbox row. `evaluateAutoPublishGate` (`src/domain/publishing/auto-gate.ts`)
and the auto-approval store likewise have zero callers — a draft can
never even reach `auto_approved` in production. Minimal fix: a production
bridge (approved/auto-approved draft → `enqueuePublication` with the
pidek1 key + Tehran-window scheduling) + wiring the auto-gate; tests +
PR + CI + deploy.

### Link 5 — The publication scheduler NEVER runs in production

`createPublicationScheduler(...).scanDuePublications()` has zero
production callers (tests only). Cron (`src/entrypoints/cron.ts`) does
ingestion scheduling + job dispatch + DLQ reconcile only; the queue
consumer (`src/entrypoints/queue.ts`) runs only job handlers, and the
only job types (`src/domain/jobs/job-types.ts`) are
`jobs.maintenance_heartbeat`, `sources.fetch_poll`,
`editorial.prepare_draft` — there is NO publishing job type. Even a due
`publications` row would never be scanned, claimed, or sent. Minimal
fix: invoke the scheduler from cron (or a new `publishing.scan` job
type) with the send gate resolved from publishing settings (mode) and
the Telegram transport wired; tests + PR + CI + deploy. The mode flip
`paused` → `auto` in D1 `settings` is additionally an owner action.

## What DOES work (the only live send path)

The inbound admin-post path: owner pastes text in `@Pixel_IVbot` PV →
approve → `src/application/admin-post/admin-post-service.ts` sends
directly via the transport (`sendStoredContent`, direct `sendMessage`),
gated by `ADMIN_POST_ENABLED` + `ADMIN_POST_LIVE_PUBLISH_ENABLED`, and
records `published_posts` with `soul_version`. Wired in
`src/entrypoints/http/handlers/telegram-webhook.ts` /
`src/application/telegram-ingress.ts`. That is the path slice 8 already
identified — it is manual, not autonomous.

## Minimal fix, in order (all through the normal gates)

1. Registry: add VGC / Gematsu / GameSpot RSS sources.
2. Activation (procedure, no code): `SOURCE_INGESTION_ENABLED=true`
   deploy + enable `playstation_blog` / `xbox_wire` (+ the new three)
   in D1 per the Phase 4 runbook.
3. Wire ingestion → editorial: production `enqueueEditorialPrepareDraft`
   trigger for newly inserted items.
4. Draft production: enable AI (reviewed activation) OR build the
   deterministic no-AI draft path.
5. Wire draft → publication: approved/auto-approved draft →
   `enqueuePublication` + auto-gate wiring.
6. Wire the publisher: call `scanDuePublications` from cron (or a
   publishing job type) with send gate + transport; owner flips mode
   `paused` → `auto` for the test window only, then back.
7. Re-run slice 8b end to end on the same T1/T2/T3 items (feeds verified
   live above; T1/T2 facts unchanged).
