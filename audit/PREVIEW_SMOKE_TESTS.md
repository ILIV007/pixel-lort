# PIXEL — Preview End-to-End Smoke Tests (SPEC ONLY — to execute LATER)

**R1.10.2 corrected edition (TR-03 accounting + ordering fixes applied).**
No smoke test below has been executed and no live result is fabricated.
Execution requires SEPARATE owner authorization and a deployed,
webhook-registered preview worker. The R1.10.1 editions of every scenario
are preserved inside the sealed input
(`input/R1.10.1_61a01947_ORIGINAL.zip`) as history.

**Three-stage structure (TR-03 fix — the Stage-7.5/8 cycle is removed):**

- **Phase A — PRE-MIGRATION (Stage 6; expected schema = 3, applied = 3,
  shipped preview profile):** Telegram webhook security, command routing,
  policy-pause semantics, health/version. NO provider fetch. NO R09-ownership
  experiment (the owned path does not exist at schema 3 by design).
- **BOUNDED gate-ON window — Stage 8a authorization, Stage 8b execution
  (expected schema = 4, applied = 4):** runs ONLY after the separately
  authorized Stage-7 migration AND the explicit Stage-8a bounded-window
  authorization (permission BEFORE any network proof). Bounded ingestion
  fetch (S-07) and ownership observability (S-08) live HERE. **S-08 CANNOT
  precede S-07.**
- **Stage 8c — cleanup + separate sustained-activation decision** (no smoke
  scenario; requires Free-safe design acceptance per
  `free-plan/FREE_SAFE_EXECUTION_DESIGN.md`).

Environment assumed at Phase A execution time (per checklist Stages 1–5):
`pixel-preview` deployed; secrets present (NAMES: `BOT_TOKEN`,
`WEBHOOK_SECRET`, `OWNER_TELEGRAM_ID`); `TELEGRAM_INGRESS_ENABLED="true"`,
`JOBS_ENABLED="true"`, `SOURCE_INGESTION_ENABLED="false"`; preview D1 at
schema 3 (migrations 0001–0003 applied, 0004 NOT applied).

Environment assumed at Phase B execution time: migration authorized and
applied (applied = 4), `SCHEMA_VERSION="4"` flipped, health green at 4, and
the Stage-8a bounded window ACTIVE (one enabled low-volume RSS source,
budgets row present, DLQ observable). The window auto-reverts to
`SOURCE_INGESTION_ENABLED="false"` at its end.

Legend: each scenario lists **expected schema, applied schema, flags,
resource assumptions, fixture preparation, allowed writes, steps, expected
observable outcomes, stage, abort and cleanup**. "Owner action" = real
Telegram client message sent by the owner account. Observations come from
the Telegram client, worker logs (`observability`), `GET /health/ready`,
`/version`, and owner-side D1 console reads. NEVER log secret values.
Every scenario states the EXPECTED and the APPLIED schema separately.

---

## S-01 Webhook authentication — wrong secret  [Phase A]

- **Expected schema:** 3. **Applied schema (verify first):** 3.
  **Flags:** ingress ON, jobs ON, ingestion OFF.
- **Fixture prep:** none. **Allowed writes:** none (rejected pre-claim).
- **Steps:** send an arbitrary POST to `/telegram/webhook` with header
  `x-telegram-bot-api-secret-token: <wrong value>`.
- **Expected:** HTTP 401 with reason code only; no echo of the secret or
  payload; log line contains rejection reason, no body content.
- **Stage:** Stage 6. **Abort:** any 2xx, any echoed value. **Cleanup:** none.

## S-02 Webhook authentication — missing header / disabled-ingress probe  [Phase A]

- **Expected/Applied schema:** 3/3. **Flags:** as S-01.
- **Fixture prep:** none. **Allowed writes:** none.
- **Steps:** POST without the secret header; GET/PUT/DELETE on the same path.
- **Expected:** missing header → 401; other verbs → uniform 404 identical to
  unknown routes (no information leak).
- **Stage:** Stage 6. **Abort:** differentiated error messages per verb.
  **Cleanup:** none.

## S-03 Command routing — owner `/start`  [Phase A]

- **Expected/Applied schema:** 3/3. **Flags:** as S-01.
- **Fixture prep:** none. **Allowed writes:** `telegram_updates` claim/terminal
  rows for THIS update; admin settings row (language) only in S-05.
- **Steps:** owner sends `/start` in the private bot chat.
- **Expected:** bot replies with localized welcome; one durable
  `telegram_updates` row reaching terminal `processed`; the reply arrives once
  per accepted delivery even if Telegram retries the update (durable update_id
  dedup).
- **R110-02 scope correction (kept):** the durable dedup is the KNOWN Bot API
  side-effect contract (ADR-0030/0031): redelivery + terminal-state dedup,
  at-least-once from Telegram's side. It is **NOT** an external
  exactly-once-after-any-crash guarantee, and the spec must not claim one.
- **Stage:** Stage 6. **Abort:** duplicate replies observed for the SAME
  accepted delivery; no reply; 5xx to Telegram without a durable claim.
  **Cleanup:** none.

## S-04 Command routing — unauthorized actor  [Phase A]  (R110-02 corrected, kept)

- **Expected/Applied schema:** 3/3. **Flags:** as S-01.
- **Fixture prep:** a second Telegram account (pre-arranged, NOT an admin).
- **Allowed writes:** the pipeline claims the update DURABLY
  BEFORE authorization routing (`src/application/telegram-ingress.ts`,
  `claimTelegramUpdate` precedes routing), so for a foreign `/start`:
  `telegram_updates` bookkeeping (claim INSERT → terminal) IS expected and
  allowed, plus the denial-reply attempt. Local trace T-03 confirms the
  order (claim INSERT → admin-role SELECT → terminal UPDATE); with
  transport available the denial IS delivered and the claim reaches
  terminal `processed` (trace T-05), tokenless-offline ends at
  `failed` + 503 (trace T-03).
- **Steps:** the foreign account sends `/start` and `/status`.
- **Expected:** fixed minimal English denial (or, in tokenless offline mode,
  a retryable 503 with the claim row durably `failed` — the documented
  no-BOT_TOKEN contract); NO admin data leakage; NO mutation of admin
  configuration, source registry/content, budgets, jobs, or publication
  tables by the foreign actor.
- **Stage:** Stage 6. **Abort:** denial reveals admin list/config; a foreign
  actor changes admin settings, sources, budgets, jobs, or publication state.
  **Cleanup:** none (bookkeeping rows are historical record).

## S-05 Command routing — `/language fa` persistence  [Phase A]

- **Expected/Applied schema:** 3/3. **Flags:** as S-01.
- **Fixture prep:** none. **Allowed writes:** `admin_ui_language:` settings row
  for the OWNER admin only.
- **Steps:** owner sends `/language fa` then `/help`.
- **Expected:** first reply acknowledges persistence-first; `/help` now
  renders in Persian; a second `/language fa` is idempotent.
- **Stage:** Stage 6. **Abort:** language flips without persistence; error on
  read-back. **Cleanup:** owner may restore `/language en` (allowed write).

## S-06 Policy pause semantics on preview (gate OFF)  [Phase A]  (R110-02 corrected, kept)

- **Expected/Applied schema:** 3/3. **Flags:** `JOBS_ENABLED="true"`,
  `SOURCE_INGESTION_ENABLED="false"` (shipped preview profile).
- **Resource assumptions:** queue `pixel-jobs-preview` + DLQ provisioned;
  preview D1 at schema 3; NO enabled source required.
- **Fixture preparation (SEPARATE step from observation):** the operator
  injects ONE controlled `sources.fetch_poll` job/reference through the
  owner-authorized queue path so a durable job row exists BEFORE the
  observation window. Gate-OFF cron must NOT be relied upon to produce one:
  with the gate OFF the scheduler excludes the paused type IN SQL and
  schedules NOTHING (local trace T-04: idle cron produced 0 envelopes and 0
  durable writes; traces T-07/T-08 show cron only seeds/schedules when the
  gate is ON — as SEPARATE single-pass measurements).
- **Observation window (zero-effect proof):** deliver the pre-existing job
  through the real consumer path (or observe one natural redelivery) and
  record exactly: ack outcome `paused_by_policy`, ZERO durable writes (no
  budget row consumption, no `source_state` change, no attempts increment on
  the durable row), no network fetch, and an idle cron pass producing zero
  envelopes/writes. Local reference measurement (corrected units, TR-01):
  trace T-09 — ONE real consumer invocation spanning a batch of 10 durable
  poll jobs at gate OFF = 10 execution-API-call attempts (1 per job), 0
  batch calls, 0 durable writes, all 10 acked `paused_by_policy`.
- **Expected:** as above; pause is lossless (ADR-0040) — attempts, lease and
  exhaustion metadata preserved exactly.
- **Stage:** Stage 6. **Abort:** ANY fetch attempt, budget charge, state
  write, or attempts increment while OFF. **Cleanup:** the injected fixture
  job may be left in its `paused_by_policy`-acked durable state or cancelled
  by the owner; document which.

## S-07 One bounded provider fetch with budget  [Stage 8b ONLY — inside the 8a window]

- **Expected schema:** **4**. **Applied schema (verify first):** 4 (this
  scenario EXISTS only post-migration inside a Stage-8a window; at schema 3
  the owned path is absent by design).
- **Flags:** `JOBS_ENABLED="true"`, `SOURCE_INGESTION_ENABLED="true"`
  (Stage-8a authorization FIRST — permission before network), health
  exact-equality green at 4.
- **Resource assumptions:** budgets row for the enabled source (registry seed
  provides `daily_request_budget`), DLQ observable, ONE low-volume RSS source
  enabled (smallest footprint, e.g. the `playstation_blog` registry entry).
- **Fixture preparation:** enable exactly the one source; verify budgets row;
  verify DLQ empty at start; record the Cron cadence (*/5).
- **Allowed writes:** jobs lifecycle rows for THIS poll; `budgets` scope
  `ingestion` for THIS source/day; `source_items` rows; `source_state` row;
  queue bookkeeping. Nothing else.
- **Steps:** wait for the due cron window; observe the produced job, its
  delivery, and the terminal state.
- **Expected (bounded-profile counters — NOT "exactly one unit"):**
  - **R1.10.2 TR-03 correction — counter semantics:** the accepted product
    counter `requestCount` is the observed raw ATTEMPT count (it includes
    thrown attempts; R10). Operators record FOUR SEPARATE counters and must
    never merge or redefine them: `authorized` (per-hop grants),
    `attempted` (raw HTTP attempts — the product counter), `completed`
    (raw HTTP attempts that returned a response), `charged` (durable budget
    units). They need NOT be equal: redirects consume a hop each (trace
    T-12: 2 raw attempts = 2 completed = 2 charged — per-hop authority),
    and a thrown attempt after an ordinary grant is charged WITHOUT a
    completed response (trace T-22: 1 attempt, 0 completed, 1 charged,
    delivery acked after durable backoff — NO platform retry storm; pacing
    owned by `source_state.next_poll_at`).
  - **LATE-authorization evidence boundary (TR-03):** a transport throw
    AFTER an ordinary grant (T-08/T-22 shape) is NOT evidence about a LATE
    authorization grant. Late-authorizer behavior (a grant arriving after
    the deadline never resumes the network; an in-flight authority may
    still commit its unit) is an ACCEPTED UNIT-TEST property
    (`tests/integration/round18-r10-budget-authority.test.ts`) and is cited
    as such — it is never claimed from a smoke observation.
  - **Empty-success semantics (TR-03):** a 304 answer resolves
    `not_modified` for the RSS connector (trace T-10). An EMPTY 200 feed is
    `changed` with zero items for RSS (trace T-11) — and for the OTHER
    connectors the empty-success mapping is NOT established by this audit;
    record the observed status per connector without assuming
    `not_modified`.
  - On provider failure: backoff ladder in `source_state`
    (`consecutive_failures`, `next_poll_at`), strongest Retry-After respected
    as a lower bound, no crash loop.
- **Volume guard (TR-02):** with the shipped profile the poll volume stays
  tiny (T-12: 13 execution-API-call attempts / 17 statements for 2 items).
  If the operator observes counters approaching the documented Free
  "50 queries per Worker invocation" row (execution-API-call attempts OR
  statements — both interpretations tracked), STOP and re-assess per
  `free-plan/FREE_PLAN_COMPATIBILITY.md` §4 (a 100-item poll measured 110
  attempts / 211 statements — the advertised batch-10/100-item profile is
  NOT_READY_FOR_INGESTION_ON_FREE).
- **Stage:** Stage 8b (post-migration, inside the bounded 8a window).
  **Abort:** unbounded retries, budget double-charge for a single completed
  hop, items from more than the enabled source, any schema-3 fallback
  executed AFTER the flip. **Cleanup:** owner may disable the source
  (durable state remains historical record); the window auto-reverts at
  Stage 8c.

## S-08 Durable state & ownership observability  [Stage 8b ONLY]  (R110-01 corrected, kept)

- **Expected/Applied schema:** 4/4. Depends on S-07 having run; **S-08
  CANNOT precede S-07** (dependency stated).
- **Flags:** as S-07 (inside the Stage-8a window). **Resource assumptions:**
  as S-07.
- **Fixture preparation:** during S-07's window, kill/observe one poll
  mid-window (owner-approved operational fault injection OR natural lease
  expiry).
- **Allowed writes:** the ownership fence's own durable rows (owner id,
  generation, hold/lease fields) and the recovery path's terminal state.
- **Expected:** at schema 4 the A1 acquisition + ownership-fenced commit
  applies: a second window cannot double-commit while the owner generation is
  durable; the R09 defect (legacy hold-only fence) is EXPECTED ONLY at
  schema 3 — asserting it at schema 4 is a failure. Lease-expiry recovery
  re-claims with an incremented generation; stale owners are fenced out.
  Application-level recovery for stranded work is IMPLEMENTED (expired-claim
  reclaim + stranded `queued` re-kick with grace, measured locally by trace
  T-28: a 25h-aged queued row re-enqueued by the real cron with the SAME job
  id) — a smoke observation of lease expiry should match that mechanism, not
  a "missing recovery" hypothesis.
- **Stage:** Stage 8b. **Abort:** worker crash; silent state corruption;
  ownership fields missing. **Cleanup:** none (durable history is the
  record).

## S-09 No publication side effect (constant invariant)  [All phases]

- **Schema expectation:** any (invariant). **Flags:** any.
- **Fixture prep:** none. **Allowed writes:** none by this test.
- **Steps:** during ALL of S-01…S-08, monitor the target channel and
  `publications`/`drafts`/`publication_messages` tables.
- **Expected:** NO message is ever posted to the channel; publication tables
  remain empty; no editorial code path exists to trigger.
- **Stage:** constant. **Abort:** any channel message or publication row —
  this would falsify the capability matrix and stop everything. **Cleanup:**
  N/A (abort = stop).

## S-10 Health & version endpoints  [Both phases — stage-dependent expectations]

- **Schema expectation:** STAGE-DEPENDENT (R110-01 correction, kept).
- **Flags:** any. **Fixture prep:** none. **Allowed writes:** none.
- **Steps:** GET `/health`, `/health/live`, `/health/ready`, `/version` from
  the public preview URL. Record BOTH the configured expectation and the
  observed applied version from `/health/ready` details.
- **Phase A expected:** live 200; ready 200 with exact-equality
  `SCHEMA_VERSION=3`; version reports app 1.4.0 + commit sha injected at
  deploy.
- **Phase B expected (only after the authorized Stage-7 flip):** ready 200
  with exact-equality `SCHEMA_VERSION=4`. Between "0004 applied" and "var
  flipped" the worker is UNHEALTHY BY DESIGN (exact-equality contract) — this
  transient state is expected and must be driven through quickly by the
  runbook, never papered over.
- **Stage:** Stage 6 (A) / Stage 8b (B). **Abort:** ready 503 with
  `schema_version_mismatch` or config-invalid reasons OUTSIDE the declared
  transition window (diagnose before proceeding). **Cleanup:** none.

---

## DLQ semantics for ALL scenarios (TR-03 correction)

Bounded infrastructure retries can legitimately exhaust: a durable
`dead_letter` row reached through the bounded ladder (max_retries/attempt
ceilings) inside a DECLARED drill is an EXPECTED outcome and is recorded,
never treated as an operational abort. The application's DLQ reconciliation
send (cron `reconcileDeadLetters` → DLQ producer → guarded
`dlq_delivered_at` confirmation) is implemented and locally measured
(trace T-27). An abort applies only to UNEXPECTED DLQ growth: messages in
non-drill stages, references for jobs outside the declared window's scope,
or send-failure loops visible in cron logs.

## Execution notes (R1.10.2 corrected)

- Stage 6 (Phase A) runs: S-01, S-02, S-03, S-04, S-05, S-06, S-09, S-10(A).
- Stage 7 = separately authorized schema 3→4 migration decision (see
  `audit/SCHEMA3_TO_4_TRANSITION_REVIEW.md`).
- Stage 8a = the owner's explicit BOUNDED gate-ON test authorization
  (permission BEFORE any network proof — TR-03).
- Stage 8b (Phase B) runs: S-07, S-08, S-10(B) — AFTER Stage 7 completes AND
  inside the Stage-8a window; S-08 never precedes S-07.
- Stage 8c = gate OFF/cleanup + the separate sustained-ingestion decision
  (requires Free-safe design acceptance).
- No activation happens merely by running smoke tests; every gate flip is a
  separate owner-authorized procedure.
- Capture: HTTP statuses, log event codes, Telegram client screenshots,
  owner-side D1 row counts, and the FOUR separate S-07 counters. Store under
  the owner's operational record; never in the repository.
- Every abort criterion met → STOP that stage, return gates to their shipped
  values (pause is lossless), record findings, and re-plan.

> R1.10.3 note: the connector multi-request fixtures (RSS multi-feed, Steam 3 apps,
> YouTube 2 playlists + details, GitHub 2 repos, Reddit 2 subreddits) are
> REPRESENTATIVE shapes, NOT supported-max proofs; per-connector max-bound
> budgets are excluded from the FIRST Free preview profile until separately
> measured (free-plan/FREE_SAFE_EXECUTION_DESIGN.md §6).
