# PIXEL Editorial Agent — Implementation Specification v1

**Channel:** PIXEL LORT  
**Username:** `@pixellort`  
**Bot persona:** Pixel  
**Platform:** Cloudflare Workers Free + D1 + Queues + KV + R2 + Workers AI  
**Primary interface:** Telegram private admin chat  
**Default publishing mode:** `AUTO`  
**Timezone:** `Asia/Tehran`

## 1. Architectural decisions

1. Use an event-driven modular monolith; no microservices in v1.
2. D1 is the source of truth. Queue messages carry only durable job references.
3. Cloudflare Queues is at-least-once; every consumer must be idempotent and every externally visible action needs a unique idempotency key.
4. KV is cache/state optimization only; never use it as a queue, publication lock, approval store, or audit history.
5. R2 stores temporary, rights-cleared media only. YouTube audiovisual content is never downloaded.
6. AI emits validated semantic JSON, never final Telegram HTML.
7. Rendering, escaping, RTL, length enforcement, footer insertion, and chunking are deterministic.
8. Sources create evidence, not posts. Story and policy modules decide publication.
9. No public web manager in v1. Admin control is private Telegram only.
10. Authentication is fail-closed; missing secrets make readiness fail.

## 2. Runtime topology

```text
Telegram webhook ──► update claim (D1) ──► durable job (D1) ──► pixel-jobs
Cron */5 ──────────► due source/publication scan ─────────────► pixel-jobs
pixel-jobs ────────► use case handlers ──► D1/R2/KV/external APIs
Publisher ─────────► Telegram API ───────► @pixellort
Failures ──────────► retry_wait/D1 ──────► pixel-dlq after max attempts
```

Cron only dispatches due work. It does not fetch all feeds, call AI, or publish inline.

## 3. Module boundaries

- `domain/story`: Story, Claim, Evidence, fingerprint and trust rules.
- `domain/editorial`: Draft document, layout, persona and fact contracts.
- `domain/publication`: Publication state machine and edit/correction rules.
- `domain/source`: Source, cursor, budget, reputation and normalized SourceItem.
- `domain/media`: Media candidate, rights state, album plan and usage history.
- `domain/identity`: Admin, permission and one-time action token.
- `application/commands`: mutating use cases.
- `application/queries`: read-only use cases for admin screens.
- `application/workflows`: orchestration across domain ports.
- `infrastructure/*`: D1, Queue, KV, R2, Telegram, AI and HTTP adapters.
- `connectors/*`: one connector implementation per source family.
- `interfaces/*`: webhook, queue, cron and private bot screens.

Domain code imports no Cloudflare, Telegram, provider SDK, or HTTP client types.

## 4. Required secrets and bindings

### Required secrets

- `BOT_TOKEN`
- `WEBHOOK_SECRET`
- `OWNER_TELEGRAM_ID`
- `TARGET_CHANNEL=@pixellort`
- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `YOUTUBE_API_KEY`
- `REDDIT_CLIENT_ID`
- `REDDIT_CLIENT_SECRET`
- `IGDB_CLIENT_ID`
- `IGDB_CLIENT_SECRET`

### Optional secrets

- `GITHUB_TOKEN`
- `BLUESKY_APP_PASSWORD` only if authenticated access becomes necessary

### Bindings

- `DB`: D1
- `CACHE`: KV
- `JOBS`: Queue producer
- queue consumer for `pixel-jobs`
- DLQ: `pixel-dlq`
- `MEDIA`: R2
- `AI`: Workers AI

No secret appears in `wrangler.toml`, logs, audit metadata, callback data, or query strings.

## 5. Public HTTP surface

- `POST /telegram/webhook`: validates Telegram secret before reading body.
- `GET /health/live`: static process liveness; no secret inventory.
- `GET /health/ready`: returns only `ready/degraded/not_ready`; detailed reasons go to owner chat.
- `GET /version`: version, build commit and schema version only.

All other paths return 404. There is no public debug, manager, source-run, cron-run, webhook-info, or mutation endpoint.

## 6. Telegram update handling

1. Validate `x-telegram-bot-api-secret-token` with constant-time comparison.
2. Enforce POST and JSON content type; cap body size.
3. Parse minimal update envelope.
4. Atomically insert `telegram_updates(update_id)` as `claimed`.
5. Duplicate primary-key conflict returns 200 without side effects.
6. Authorize admin for commands/callbacks before creating a job.
7. Insert durable job with a deterministic idempotency key.
8. Enqueue only `{jobId,type,attempt,traceId}`.
9. Mark update processed after durable job creation.
10. Return 200 quickly.

## 7. Queue and job semantics

### Message envelope

```ts
interface QueueEnvelope {
  version: 1;
  jobId: string;
  type: JobType;
  attempt: number;
  traceId: string;
}
```

### Claim query

A job is claimed only with a conditional state transition and lease:

```sql
UPDATE jobs
SET status='claimed', lease_until=?, attempts=attempts+1, updated_at=?
WHERE id=?
  AND status IN ('pending','queued','retry_wait')
  AND run_after<=?
  AND (lease_until IS NULL OR lease_until<?);
```

### Retry policy

- network timeout/429/5xx: exponential backoff with full jitter
- auth 401/403: disable connector/provider, no blind retry, notify owner
- malformed source: one retry, then source health penalty
- invalid AI schema: one repair/retry on fallback provider
- Telegram 400 semantic error: no blind retry; hold and notify
- Telegram 429: respect `retry_after`
- max attempts: 3 normal, 5 P0 publication
- exhausted jobs: `dead_letter` in D1 and copied to DLQ

### Idempotency

- source item: `(source_id, external_id)` or canonical URL unique
- story fingerprint: `(kind,value)` unique
- job: `idempotency_key` unique
- publication: `idempotency_key` unique
- Telegram result: `(chat_id,message_id)` unique
- edit action: revision ID + target message ID unique in audit

## 8. Source connector contract

```ts
interface SourceConnector {
  readonly id: string;
  fetch(ctx: FetchContext): Promise<FetchResult>;
  normalize(raw: unknown, ctx: NormalizeContext): Promise<SourceItem[]>;
  health(): ConnectorHealth;
}

interface FetchResult {
  status: 'changed' | 'not_modified' | 'rate_limited' | 'failed';
  items: unknown[];
  cursor?: string;
  etag?: string;
  lastModified?: string;
  retryAfterSeconds?: number;
  requestCount: number;
}
```

Rules:

- RSS sends both `If-None-Match` and `If-Modified-Since` when available.
- A `304` creates no downstream job.
- Connectors never call AI or Telegram.
- Connector-specific raw data stays behind normalization.
- Every fetch has timeout, byte cap, redirect cap and SSRF checks.
- Source state updates and item inserts use D1 batch transactions.

## 9. Source schedule

- official fast group: every 5 minutes
- Steam/YouTube watchlists: every 10 minutes
- editorial RSS: every 15 minutes
- Reddit/Bluesky watchlists: every 10 minutes
- GitHub releases: every 15 minutes
- Mod DB: every 30 minutes
- itch.io: every 60 minutes
- IGDB: on demand; daily maintenance only for stale entities

Actual next poll uses adaptive backoff and ±10% fetch jitter. Polling jitter does not delay breaking publication.

## 10. Story matching pipeline

1. Reject exact external-ID duplicate.
2. Canonicalize URL; reject exact canonical duplicate.
3. Normalize title and hash content.
4. Resolve known entities using alias table.
5. Build event key: primary entity + event type + normalized object/date/version.
6. Retrieve candidate stories by entity, event key and recency window.
7. Apply deterministic score.
8. If score is conclusive, decide without AI.
9. If ambiguous, send compact claim sets to story-adjudication model.
10. Persist fingerprints, claims, evidence and decision in one D1 batch.

### Recency windows

- breaking/official/industry: 14 days
- patch/hotfix: 30 days per version
- leak/rumor: 90 days
- crack/DRM: 180 days
- mod/emulator/homebrew: 180 days per version/release
- release date and cancellation stories: no automatic expiry until closed

### Decision thresholds

- exact key match: duplicate or update determined by changed claims
- deterministic similarity ≥ 92: semantic duplicate
- 75–91: AI adjudication
- < 75: new story unless a high-risk ambiguity flag exists

## 11. Trust and publication policy

### Trust calculation inputs

- source base trust
- official-domain bonus
- independent corroboration
- direct evidence
- historical accuracy
- retraction history
- source deletion
- conflict penalty
- anonymous-source penalty
- age/freshness

### Default auto thresholds

- official source: 82
- trusted editorial: 88
- mod/project official release: 84
- crack/DRM: 88 and at least one corroborating evidence path
- leak/rumor: 92 and at least two independent evidence paths
- signal-only source can never satisfy auto policy alone
- unknown/disputed/denied: hold or correction workflow

When Approval mode is off, low-confidence items are held, not silently auto-published.

## 12. AI contracts

Use strict JSON Schema where supported. All provider outputs are parsed with Zod and semantically validated. Schema-valid does not mean factually valid.

### Routing

- extraction: Gemini Flash-Lite → Groq Qwen → deterministic parser
- editorial: Gemini Flash → Groq Qwen → GPT-OSS → template
- sensitive fact guard: GPT-OSS → Gemini Flash
- emergency: Workers AI Qwen → template

### Privacy

Send only public source excerpts and canonical fact packets. Strip secrets, admin IDs, private messages, headers, cookies and unrelated URLs.

### Prompt versioning

Every prompt has an immutable semantic version, for example:

- `extract.v1.0.0`
- `story-match.v1.0.0`
- `editorial.fa.v1.0.0`
- `fact-guard.v1.0.0`

Prompt changes require Golden test results and create new versions; never mutate a published version.

## 13. Internal rich document

AI returns semantic blocks, not markup:

```ts
type RichBlock =
  | { type: 'paragraph'; text: InlineSpan[] }
  | { type: 'bullets'; items: InlineSpan[][] }
  | { type: 'quote'; text: InlineSpan[]; expandable: boolean }
  | { type: 'code'; text: string; language?: string };
```

Renderer responsibilities:

- HTML escape
- supported-tag allowlist
- visible-length calculation after entities
- text limit 4096
- caption limit 1024
- safe balanced splitting
- no split inside URL/code/entity
- RTL treatment and bidi isolation
- deterministic source line
- deterministic footer
- fallback to plain text on parse failure

Use classic Telegram HTML in v1. New Rich Messages are feature-flagged until client compatibility is tested.

## 14. Media pipeline

1. Collect media candidates from source metadata and official APIs.
2. Canonicalize URL and compare URL/hash/visual key history.
3. Enforce HTTPS, host policy, redirect cap, byte cap and MIME validation.
4. Reject unknown rights, piracy payloads, executable/archive downloads and YouTube audiovisual downloads.
5. Score officiality, relevance, freshness, quality, aspect ratio and prior use.
6. Select mode: none, single, album or official video link.
7. Album: 2–10 compatible items; caption only on ordinal 0.
8. Direct URL only when Telegram limits and MIME permit.
9. Otherwise stream rights-cleared temporary media to R2; no CPU-heavy transcoding.
10. After Telegram upload, save `file_id` and delete temporary R2 object on retention schedule.

### Default album policy

- target 3–6 items
- maximum 10
- no more than two visually similar screenshots
- cover/key art first
- gameplay screenshots before concept art unless story demands otherwise
- video at end unless it is the primary news item

## 15. Publication and edit scenarios

### New official story

Official evidence → story → draft → fact guard → auto policy → immediate or dynamic slot → publish.

### Same story, minor detail

Attach evidence → update internal story/draft → no new post unless it changes reader value.

### Same story, meaningful update

Create new draft version. Policy chooses edit, follow-up, or both based on elapsed time and claim significance.

### Rumor confirmed

Edit old message label/uncertainty when possible; publish follow-up if confirmation is materially newsworthy; connect both publications to one story.

### Rumor denied

Edit old post to show denial and optionally publish correction. Never delete silently unless legal/safety reason requires it.

### Crack status

Require status evidence and no prohibited links. Publish status, DRM and elapsed time only. Update prior Story instead of repeating the same release.

### Failed publication

No second send without checking existing `publication_messages`. Retry uses the same idempotency key and claimed state.

## 16. Scheduling policy

### Tehran windows

- 09:30–11:30 morning scan
- 13:00–15:30 midday
- 17:00–19:30 evening
- 20:00–23:00 prime
- 23:00–00:45 late-night/radar
- 01:00–08:30 quiet for P2/P3

### Priority

- P0 (90–100): publish after verification, no daily cap, bypass quiet hours
- P1 (75–89): within 5–20 minutes
- P2 (40–74): dynamic window
- P3 (0–39): evergreen filler only

### Anti-robot rules

- 25–45 minute normal gap
- 8–15 minute P1 gap
- unrelated P0 can bypass with a small anti-flood gap
- same game cooldown: 90 minutes unless meaningful update
- same layout max three consecutive posts
- same category target max 40% of rolling six posts unless event-driven
- content mix enforced over rolling seven days, never forced per day

### Weekly target mix

- crack/DRM 10%
- leak/rumor 8%
- mods 7%
- emulator/homebrew/jailbreak 5%
- mainstream/industry 25%
- release/trailer/patch/DLC 15%
- mobile 10%
- hardware 10%
- free/discount/indie 7%
- esports 3%

## 17. Admin roles and permissions

### owner
All permissions; only role allowed to manage owners, rotate bot configuration, export backups and execute emergency controls.

### chief_editor
Publish, edit, correct, schedule, manage editorial/style policy and merge/split stories.

### editor
Create/edit/regenerate drafts, media selection and scheduling; publish only if granted `publication.publish`.

### reviewer
Approve/reject/hold drafts and view evidence; cannot change sources or admins.

### source_manager
Manage source enablement, interval, watchlists and health; cannot publish.

### viewer
Read-only dashboards.

Permissions are atomic strings, not inferred only from role names.

## 18. Command map

### General

- `/start` — authenticated home
- `/panel` — dashboard
- `/help` — role-aware help
- `/version` — build/schema/prompt versions
- `/health` — concise system health

### Editorial

- `/inbox` — new and held items
- `/breaking` — P0/P1 stories
- `/radar` — leak/rumor/crack/mod signal view
- `/drafts` — ready/failed drafts
- `/stories` — search and recent stories
- `/queue` — publication queue
- `/calendar` — upcoming schedule
- `/mode` — auto/safe-auto/approval/paused

### Operations

- `/sources` — source registry/health
- `/budgets` — API/AI/Cloudflare counters
- `/errors` — failed jobs and DLQ
- `/audit` — recent sensitive actions
- `/settings` — versioned settings

### Owner only

- `/admins`
- `/emergency_stop`
- `/emergency_resume`
- `/export`

No command accepts secrets. Secret rotation is done via Cloudflare.

## 19. Callback architecture

Telegram callback data is limited to 64 bytes. Buttons carry only an opaque one-time token:

```text
a:<base64url_token>
```

Full action details live in `admin_action_tokens` with actor, permission, target, payload, expiry and consumed timestamp.

Rules:

- default TTL: 15 minutes
- destructive action TTL: 5 minutes
- every token is bound to one Telegram user
- mutation token is single-use
- expired/consumed/wrong-user token receives a harmless alert
- destructive actions require a confirmation token generated after first click

## 20. Telegram admin screens

### Dashboard
Mode, due queue, drafts, held items, source health, AI health, budget and next publication.

### Inbox
Filters: new, held, conflict, failed; actions: inspect, generate, reject, merge.

### Review
Original facts, evidence, confidence, duplicate risk, final preview and media; actions: publish, edit, regenerate, media, schedule, merge, hold, reject.

### Story
Timeline, claims, evidence, publications, corrections; actions: merge, split, recheck, close.

### Source
Health, last poll, new/duplicate/error rates, trust and budget; actions: pause, run once, interval, watchlist.

### Queue/Calendar
Due time, priority, category and status; actions: publish now, reschedule, cancel.

### System
Readiness, Queue/DLQ, D1, AI, Telegram and source summary; sensitive details visible only to owner.

## 21. Multi-step admin sessions

Use `admin_sessions` for text edit, custom schedule, source watchlist edit, story merge/split and settings changes.

- one active flow per admin per chat
- default TTL 30 minutes
- `/cancel` clears current session
- all transitions validate expected step
- no state is kept only in memory

## 22. Security requirements

- fail-closed webhook and admin authorization
- no query-string secrets
- no public mutation/debug endpoints
- positive allowlist for official media/source domains when feasible
- block loopback, private, link-local, metadata and non-routable IP ranges
- revalidate every redirect target
- cap redirects at 2
- XML parser with external entities disabled
- HTML treated as data
- file extension never trusted over MIME/signature
- source text isolated as untrusted prompt data
- audit all publish/edit/delete/admin/source/policy/emergency actions
- redact tokens, cookies, headers and raw private messages from logs

## 23. Retention and maintenance

- source raw payload: 90 days
- AI raw output: 30 days
- debug/error events: 30 days
- processed Telegram updates: 14 days
- action tokens/sessions: delete after 7 days
- temporary R2: 72 hours
- failed jobs: 90 days
- stories/publications/revisions/audit/corrections: permanent until explicit owner export/archive policy
- fingerprints: minimum 2 years

Daily maintenance is chunked and bounded; no full-table deletes.

## 24. Testing strategy

### Unit
Normalization, URL canonicalization, fingerprints, state transitions, permissions, schedules, Persian normalizer, HTML renderer.

### Contract
Every connector against saved fixtures; no live network in CI.

### Integration
D1 migrations/repositories, queue idempotency, publication claim/retry and callback token consumption.

### Golden editorial
The 50 cases in `PIXEL_PERSONA_PROMPTS_v1.md` across all configured models.

### Security
Webhook spoofing, callback replay, SSRF, redirects, XML entities, prompt injection, oversized content and malformed Telegram HTML.

### Chaos
Duplicate queue delivery, provider 429, source timeout, D1 overload, Telegram unknown success, Queue expiry and Cron overlap.

## 25. Deployment and launch gates

### Build gate
Strict TypeScript, lint, schema validation, migration dry-run, unit/contract/integration tests and secret scan.

### Shadow gate
7–14 days; no production publishing. Required metrics:

- duplicate precision ≥ 95%
- update-vs-duplicate accuracy ≥ 95%
- zero unsupported factual mutations in accepted samples
- zero prohibited piracy links
- source failure isolation works
- daily Queue/KV/D1/AI usage remains inside 70% soft budget

### Test channel gate
Album, video link, RTL, edit, correction, retries and P0 schedule verified on real Telegram clients.

### Production gate
Start `safe_auto`, then official `auto`, then expand category auto policies. Final target remains default `AUTO`.

## 26. Roadmap implementation order

0. product/config freeze
1. repository, CI, bindings and migrations
2. Telegram webhook, auth, RBAC and renderer
3. job/queue framework and idempotency
4. source registry and initial connectors
5. story/claim/evidence engine
6. AI adapters, prompt contracts and Persian editorial
7. media engine and album publisher
8. publication scheduler, edit and correction
9. admin Telegram screens
10. security hardening and budget controls
11. shadow mode
12. private test channel
13. production rollout

## 27. Definition of implementation-ready

The package is implementation-ready when:

- `pixel_schema_v1.sql` migrates successfully on D1.
- `pixel_source_registry_v1.json` validates against its application schema.
- all commands/screens have atomic permissions and use cases.
- all Queue job types have Zod payload schemas and idempotency keys.
- all AI tasks use immutable schemas/prompts and no final HTML generation.
- all 50 Golden fixtures are populated with actual source/fact/expected files.
- initial watchlists are supplied.
- Telegram bot/channel credentials are configured as secrets.

At this point, the remaining work is implementation and fixture population, not architectural decision-making.
