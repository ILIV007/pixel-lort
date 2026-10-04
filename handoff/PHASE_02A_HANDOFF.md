# Phase 2A handoff — Telegram secure ingress and admin foundation

## 1. Result

Phase 2A implements the secure, **fully offline** Telegram ingress and the
initial administration foundation on branch `phase/02a-telegram-ingress`.

- Starting authoritative main commit: `446f3f14865a1ce57871f50d1979fbe5494a1e4a`
  (verified: `origin/main` of `https://github.com/ILIV007/pixel-lort.git`).
- Final branch: `phase/02a-telegram-ingress` (created directly from
  `origin/main`).
- Application version aligned to the approved **1.2.0** (package.json,
  package-lock via npm tooling, wrangler.jsonc, `/version` defaults, tests).
- **No schema changes.** The migration set remains exactly
  `0001_initial_schema.sql` (schema version 1); no migration 0002 was needed
  because the approved `telegram_updates`, `admins`, and
  `admin_action_tokens` tables already cover every Phase 2A requirement.

## 2. Commits (no history rewritten)

| #   | Commit          | Subject                                             |
| --- | --------------- | --------------------------------------------------- |
| 1   | `a885826`       | feat: add secure Telegram webhook ingress           |
| 2   | `aba48ba`       | feat: add durable Telegram update claims            |
| 3   | `217e29a`       | feat: add admin authorization and command contracts |
| 4   | `6476131`       | feat: add Telegram API client boundary              |
| 5   | `3ccb791`       | test: cover Telegram security and idempotency       |
| 6   | `f78906b`       | docs: document Phase 2A Telegram foundation         |
| 7   | `93860e3`       | test: drop unused helper from the admin flow suite  |
| 8   | _(this commit)_ | docs: record final Phase 2A commit list             |

Commit 7 is a one-line lint fixup flagged by the clean-environment quality
gate run (no behavioral change).

## 3. Implemented Telegram contracts

### 3.1 HTTP edge — POST /telegram/webhook (ADR-0024)

- Route enumerated in the allowlist router; **non-POST methods fall through
  to the same uniform safe 404** as unknown routes.
- **Fail-closed ingress flag:** the handler treats a disabled or
  misconfigured ingress as a nonexistent route (uniform 404); probing
  reveals neither route existence nor configuration state.
- **Timing-safe secret verification:** `x-telegram-bot-api-secret-token`
  compared via a fresh per-comparison, non-extractable HMAC-SHA256 key
  (Web Crypto `importKey`/`sign`); only the 32-byte digests are compared in
  a fixed 32-iteration XOR loop. No plain-string comparison anywhere.
- **Lifecycle order:** secret → JSON content type → body cap (declared
  `Content-Length` pre-check AND actual byte count) → strict JSON parse →
  bounded Update parse. The body is read only after the caller is verified.
- Body cap: **64 KiB**. Rejections: stable reason codes (`invalid_secret`,
  `secret_unavailable`, `unsupported_media_type`, `payload_too_large`,
  `malformed_json`, `invalid_update`) mapped to safe AppError responses.
- Correlation-ID behavior and all existing security headers retained;
  responses are fast and deterministic (`200 {"ok":true}` once durably
  claimed).

### 3.2 Bounded Update parser (ADR-0026)

- `message`, `edited_message`, `callback_query`; unknown kinds classified
  `unsupported` while keeping `update_id` (dedup still applies).
- Numerics: JSON numbers only, safe integers, sign constraints per field
  (update_id ≥ 0, user ids > 0, chat ids any sign).
- Strings bounded **by omission** (never truncated): text ≤ 4096 chars,
  callback data ≤ 64 UTF-8 bytes, callback query id ≤ 64 chars.
- Command extraction: `/cmd` and `/cmd@botname`, lowercased, conservative
  32-char command bound.
- No Zod (ADR-0010 boundary respected); no recursive traversal; payload
  fields can never become log fields automatically.

### 3.3 Durable idempotency (ADR-0025)

- **update_id is the idempotency boundary** on `telegram_updates`.
- Claim = parameterized `INSERT (update_id, received_at, 'claimed')`;
  concurrent claims serialize on the primary key → exactly one winner;
  losers read back the winner's status (duplicate).
- State machine: `claimed -> processed | failed` with guarded transitions
  (`WHERE status = 'claimed'`); terminal states are never overwritten.
- Duplicate deliveries (including of failed updates) are acknowledged
  without reprocessing; recovery of failed updates is an explicit operator
  action deferred to a later admin slice.
- A transient claim failure throws a mapped AppError (safe 5xx) with nothing
  marked — Telegram redelivery retries. A failure after claiming marks the
  row `failed` (never falsely processed); if even the marking fails the row
  stays `claimed` (observable, recoverable).
- HTTP: once durably claimed, the webhook answers a deterministic 2xx in
  every terminal case (the D1 row is the source of truth).
- Parameterized SQL only; only update_id/timestamps/status stored — no
  Telegram payload content; no in-memory dedup; KV never the authority.

### 3.4 Phase 2 configuration (ADR-0024)

- `TELEGRAM_INGRESS_ENABLED` (non-secret, `'true'|'false'`, default
  `'false'`).
- Secrets: `BOT_TOKEN` (structural format validation only),
  `WEBHOOK_SECRET` (min strength 32 chars of `[A-Za-z0-9_-]`, max 256),
  `OWNER_TELEGRAM_ID` (positive decimal, safe-integer range).
- Non-secret: `TARGET_CHANNEL` (`@name`, 5–32 chars, safe username shape).
- Readiness: any present-but-invalid Phase 2 value fails readiness in every
  environment; while ingress is ENABLED, `WEBHOOK_SECRET` and
  `OWNER_TELEGRAM_ID` are required (plus a D1 binding for durable claims)
  or readiness reports `not_ready`. `BOT_TOKEN` stays optional until the
  Phase 2B live-wiring gate — without it the ingress runs in documented
  OFFLINE mode (routed actions skipped, never executed against the network).
- Validation issues carry field names + stable reason codes only; values are
  never echoed. No Cloudflare secrets are configured in Phase 2A; the flag
  ships `false` in every environment.

### 3.5 Authorization foundation (ADR-0026)

- Six approved roles (`owner`, `chief_editor`, `editor`, `reviewer`,
  `source_manager`, `viewer`); the permission map mirrors
  `pixel_admin_map_v1.json` verbatim (owner wildcard).
- Actor resolution: `OWNER_TELEGRAM_ID` bootstrap identity (missing/invalid
  owner config can never resolve to owner) + active admins from D1
  (`admins.status='active'`).
- Disabled admins, unknown users, and identity-less updates: unauthorized.
- Numeric Telegram user IDs only — never usernames. No automatic promotion;
  no role-mutation endpoints.
- Authorization DB failures throw (transient internal failure → update
  marked failed) rather than masquerading as denial.

### 3.6 Command routing (ADR-0026)

- Allowlist: `/start`, `/help`, `/status`, `/version`.
- Authorized senders: static Persian admin response contracts (escaped build
  metadata only). Unauthorized senders of allowlisted commands: minimal
  fixed denial ("دسترسی مجاز نیست."). Outside the allowlist: ignored for
  every sender (no probe feedback).
- Output is a **typed action** (`send_message` | `answer_callback` | `noop`
  | `denied`) — never an immediate uncontrolled fetch; future approval,
  scheduling, and editor workflows attach here without touching webhook
  security.
- No publishing controls exist yet.

### 3.7 Telegram Bot API client boundary (ADR-0026)

- Typed `getMe`, `sendMessage`, `editMessageText`, `answerCallbackQuery`.
- Injectable fetch; strict timeout (default 10 s via `AbortSignal`); **a
  single attempt per call — no automatic retries, no retry storm**.
- Error mapping: timeout/network/429/5xx → retryable; 4xx and malformed
  responses → permanent; `retry_after` parsed safely (integer seconds
  1..3600 → ms).
- `BOT_TOKEN` appears only in the request URL — never logged, echoed, or
  embedded in errors; raw Telegram descriptions are discarded; request and
  response bodies never logged (bounded response reading).
- HTML parse mode only; MarkdownV2 deliberately not implemented.
- Not called from the live preview environment in Phase 2A (offline mode).

### 3.8 Callback data foundation (ADR-0026)

- Contract per the approved admin map: `a:<base64url_token>`, total ≤ 64
  UTF-8 bytes (checked on bytes), opaque token only — no embedded JSON, no
  permission decisions client-side.
- Repository boundary over `admin_action_tokens`: issuance validates the
  token shape and payload bound; consumption is a single guarded UPDATE
  (single-use, bound to one telegram user, expiry-aware) — concurrent
  consumers produce exactly one winner; wrong-user attempts neither consume
  nor reveal information.
- The full admin menu that issues/uses tokens is deferred to Phase 9.

### 3.9 Telegram-safe HTML (ADR-0026)

- `escapeTelegramHtml` escapes `&`, `<`, `>` in entity-safe order.
- Builder helpers emit only allowlisted tags with escaped content; link
  targets must match a conservative https-only shape BEFORE interpolation.
- `isSafeTelegramHtml`: bounded structural validator (balanced allowlisted
  tags, no attributes except a validated href on `<a>`, no self-closing,
  depth cap 16, length cap 4096) used as a final gate before every send.
- Persian text, RTL markers, mixed RTL/LTR content, and emoji pass through
  untouched; hostile markup is rejected by tests.

## 4. Database changes

**None.** No migration 0002, no schema-version increment, no metadata
changes. Tables used (as approved in 0001): `telegram_updates` (claims),
`admins` (lookup), `admin_action_tokens` (token boundary). Remote migrations
were not touched.

## 5. Webhook state machine (summary)

```
verified request
  └─ parse update ──fail──> 400 (bad_request, stable reason)
  └─ claim update_id (INSERT)
       ├─ transient DB failure ─────────> 5xx (nothing marked; redelivery retries)
       ├─ duplicate ────────────────────> 200 {"ok":true}  (no reprocessing)
       └─ claimed
            ├─ route (typed action) + execute (offline skip w/o BOT_TOKEN)
            │    ├─ ok ────────────────> status='processed' -> 200
            │    └─ throw ─────────────> status='failed'    -> 200
            │         └─ (mark-failed failure) row stays 'claimed' (observable)
```

## 6. Authorization model (summary)

Untrusted update → actor resolution (owner bootstrap ∥ D1 active admin ∥
unauthorized) → command router (allowlist + role-agnostic initial commands)
→ typed action. Owner-only permissions arrive with real workflows; the map
already carries them via the wildcard. All decisions numeric-ID based and
fail closed.

## 7. Test totals

- **Final suite: 341 tests in 30 files, all passing** (Phase 1A/0 suites
  remain green; version assertions updated to 1.2.0).
- New Phase 2A test files (9):
  - `tests/unit/phase2-config.test.ts` (18) — format patterns, flag
    semantics, fail-closed gating, values-never-echoed.
  - `tests/unit/timing-safe.test.ts` (7) — equality/exactness/length/
    UTF-8/stability of the timing-safe comparison.
  - `tests/unit/update-parser.test.ts` (19) — supported kinds, unsupported
    classification, unsafe numerics, string bounds, command extraction.
  - `tests/integration/telegram-webhook-security.test.ts` (22) — flag
    gating, method matrix, secret matrix, content-type/body caps, JSON and
    update_id validation, response hygiene, D1-unavailable fail-closed,
    leak scan.
  - `tests/integration/telegram-update-claims.test.ts` (9) — claim
    lifecycle, guarded transitions, concurrent duplicate claims, duplicate
    delivery through the worker.
  - `tests/unit/telegram-html.test.ts` (19) — escaping, Persian/RTL/emoji,
    composition, hostile markup, bounds.
  - `tests/unit/callback-tokens.test.ts` (11) — byte limits, malformed
    shapes, code-only failures.
  - `tests/unit/authorization.test.ts` (7) + `tests/unit/command-router.test.ts`
    (13) — authorization and routing matrices.
  - `tests/integration/telegram-admin-flow.test.ts` (13) — owner bootstrap,
    active/disabled/unknown D1 admins, allowlist, callbacks, action-token
    boundary (single-use, user-bound, expiry).
  - `tests/unit/bot-api-client.test.ts` (18) — success paths, error mapping,
    retry_after safety, transport failures, malformed responses, no-leak.
  - `tests/integration/telegram-ingress-pipeline.test.ts` (7) — duplicate
    deliveries with a counting fake client, concurrent claims, failed
    processing (incl. mark-failure → stays claimed), pipeline leak scans.
- Migration-plan suites (Phase 1A correction): 16 tests in 2 files —
  unchanged and green.
- **No test performs a real network request.**

## 8. Dependency changes

**None.** Zero new runtime or dev dependencies (ADR-0003 posture; Zod
remains deferred to Phase 3 per ADR-0010). package.json/package-lock changed
only for the approved version bump to 1.2.0 (via npm tooling).

## 9. Quality-gate results (from a clean environment)

Executed exactly: `rm -rf node_modules dist .wrangler && npm ci && npm run check`

- `npm ci`: exit 0.
- `npm run check` (lint + format:check + typecheck + test + test:secrets +
  scan:secrets + build): **exit 0** —
  - eslint clean; prettier clean; `tsc --noEmit` (strict) clean;
  - Vitest: **341/341 in 30 files**;
  - secret-scanner self-test: 10/10;
  - secret scan: 0 findings across tracked files;
  - `wrangler deploy --dry-run` (offline build): OK.
- D1-specific suites also run explicitly (`npm run test:db`): green.

## 10. Security review

- No real credentials anywhere; all fixtures are obviously-fake shapes that
  satisfy documented formats and were checked against the secret scanner
  (`scan:secrets` 0 findings; the scanner's Telegram pattern requires a
  `:AA…` token body which fake fixtures deliberately do not match).
- Timing-safe secret verification only; no plain-string comparison.
- Fail-closed at every boundary: disabled/misconfigured ingress = uniform
  404; missing D1 = 503; invalid config = readiness `not_ready` +
  fail-closed behavior; authorization fails closed; terminal transitions
  guarded.
- Logging: no request bodies, message text, usernames, phone numbers, chat/
  user ids, callback data, tokens, or provider responses — pinned by canary
  tests at handler, pipeline, and client levels.
- SSRF: the Bot API client speaks ONLY to `https://api.telegram.org` with a
  https-only validated link policy for content; no user-supplied URLs are
  fetched.
- Concurrency: durable claims serialize on the primary key; single-use
  token consumption via guarded atomic UPDATE.

## 11. Diff summary

Recorded as `git diff --stat 446f3f1..HEAD` at handoff time (see the ZIP's
handoff/PHASE_02A_HANDOFF.md in the repository for the authoritative
numbers, or run the command in the extracted artifact).

## 12. Documentation

- README.md — Phase 2A status, contracts, updated layout and boundary
  statement.
- docs/ARCHITECTURE.md — §3.8 Telegram ingress and admin foundation; §6
  Phase 2A non-goals.
- docs/ROADMAP.md — Phase 2A section (complete) + deferred-to-2B list.
- docs/SECURITY_MODEL.md — webhook trust boundary implemented; Telegram
  event-logging rules; Phase 2 readiness gating; prohibited practices
  extended (raw HTML to Telegram; automatic retries).
- docs/DECISIONS/ADR-0024/0025/0026 + index — decisions actually made.
- AGENTS.md — standing Telegram rules for future agents.
- Module READMEs (src/admin, src/application, src/adapters) updated from
  "planned" to their implemented scope.

## 13. Open decisions / deferred items

- **Phase 2B (live wiring):** configure BOT_TOKEN / WEBHOOK_SECRET /
  OWNER_TELEGRAM_ID / TARGET_CHANNEL as Cloudflare secrets (+ preview vars),
  register the webhook, enable the ingress flag, require BOT_TOKEN at that
  gate, and only then flip preview readiness to include live Telegram
  health.
- **Failed-update recovery UX** (operator re-queue tooling) — deferred to
  the admin-screens slice (Phase 9); the `failed` status is the observable
  anchor.
- **`degraded` readiness** (ADR-0015) — still unused; arrives with
  subsystem checks in a later phase.
- **ESLint major evaluation** — unchanged tooling-maintenance backlog item
  (docs/ROADMAP.md).

## 14. Compliance confirmations

- **No push** — the branch exists only in the local working copy and the
  delivered artifact.
- **No deploy** — no Cloudflare deployment was performed or triggered.
- **No webhook registration** — no Telegram API call of any kind was made.
- **No Cloudflare secret configuration** — no resources or secrets touched.
- **No live Telegram traffic** — all tests and tooling run offline with
  injected fakes.
- **No Phase 2B work started.**

Single artifact: `pixel-lort-phase02a-v1.2.0.zip` (full working tree +
complete `.git` history at the ZIP root; excludes node_modules, dist,
.wrangler, coverage, credentials, local env files, and temporary files).

---

# Correction round — v1.2.1 (Phase 2A correction review: CHANGES REQUIRED)

## C1. Scope and authority

Alexios' Phase 2A correction review (verdict CHANGES REQUIRED) against
branch `phase/02a-telegram-ingress` at HEAD `8f23b42` (base
`446f3f14865a1ce57871f50d1979fbe5494a1e4a`, version 1.2.0, 341/341 tests).
This round implements the six required fixes in ONE focused correction
commit, bumps the artifact version to **1.2.1**, and adds ADR-0027/0028/0029.
Sections 1–14 above document the original v1.2.0 round and are preserved.

## C2. FIX 1 — Prevent permanent update loss (ADR-0027)

- The claim boundary now returns FOUR outcomes: `claimed` (new INSERT),
  `reclaimed` (atomic `failed -> claimed`, guarded UPDATE with
  `processed_at` reset — exactly one concurrent winner), `already_processed`
  (terminal — ack, never reprocessed), `in_flight` (owned by another
  delivery — ack as duplicate).
- Processing failures are classified RETRYABLE vs PERMANENT at the ingress:
  `TelegramApiError.retryable` is authoritative for API errors; DB and
  service-availability codes are retryable; deterministic application
  rejections (`config_invalid`, `internal_error` HTML-gate, 4xx-class codes)
  are permanent; UNKNOWN errors default RETRYABLE (a wrong retryable guess
  is bounded — durable claims prevent double processing — while a wrong
  permanent guess loses the update).
- RETRYABLE failure → row marked `failed` (best effort, observable) and a
  safe AppError with HTTP 503 semantics PROPAGATES — the webhook never
  answers 200, so Telegram redelivery reclaims and retries. PERMANENT
  failure → row marked `failed`, webhook answers 200 (no infinite retry
  loop); logs carry only update_id, stable event, error code, and the
  retryable flag.
- Authorization denial is a handled typed action, never a failure.
- Missing Bot API client: noop actions complete (offline-safe); OUTBOUND
  actions fail retryably as `service_unavailable` — BOT_TOKEN absence can
  never falsely produce successful processing.
- **No migration 0002** — the existing `status` column is sufficient.

## C3. FIX 2 — True bounded webhook body reading (ADR-0028)

- New shared primitive `src/shared/http/bounded-reader.ts`:
  `readStreamBounded` reads the request BYTE stream up to the 64 KiB cap,
  stops consuming and CANCELS the reader immediately after the first chunk
  crossing the cap (allocation bounded by cap + one chunk — the complete
  body is never buffered first).
- Content-Length is an early, untrusted gate only: digits-only declarations
  within the cap pass, oversized/huge declarations → 413 before any read,
  invalid/negative/non-integer → safe 400 (`invalid_content_length`).
- Strict UTF-8 decoding (fatal): malformed sequences → safe 400, never
  silent U+FFFD replacement. Body content is never logged.

## C4. FIX 3 — Hardened Telegram HTML links (ADR-0029)

- The href shape regex is replaced by URL PARSING (`safeHrefCanonical`):
  protocol exactly `https:`, non-empty hostname, no username/password
  credentials, no control characters, and no attribute-hazard characters
  (`"`, `'`, `<`, `>`, backtick) in input or canonical form; malformed URLs
  rejected.
- `telegramLink` interpolates the CANONICAL form after HTML-attribute
  escaping (`&`→`&amp;` etc.), so raw `&` and hazard characters can never
  break out of the attribute; Persian text, query parameters, fragments,
  and Unicode URLs keep working (percent-encoded canonical form).
- `isSafeTelegramHtml` accepts EXACTLY builder-shaped hrefs: the attribute
  value must decode (exact entity set) to a URL-safe target AND be its
  canonical attribute escaping — forged values, raw hazards, and
  non-canonical entities fail.
- The Bot API client re-runs `isSafeTelegramHtml` at runtime before
  `sendMessage`/`editMessageText` — a forged TypeScript cast cannot bypass
  the boundary; rejection throws deterministic `internal_error` BEFORE any
  fetch.

## C5. FIX 4 — True bounded Telegram API response reading (ADR-0028)

- Every Bot API request is sent with `redirect: "error"`; redirect failures
  map to the retryable network-error class without exposing the token,
  request URL, or redirect target.
- Declared Content-Length is checked early when present (invalid or
  oversized → `telegram_response_invalid` before any read) and is never the
  only check: the response is STREAMED under `MAX_TELEGRAM_RESPONSE_BYTES`
  (1 MiB) with immediate cancellation after the cap is crossed — applied to
  the success path AND the error/429 payload path.
- Strict UTF-8 response decoding; mid-stream transport failures → retryable
  `telegram_network_error`; `retry_after` parsing stays bounded and safe
  (an unreadable payload only means "no retry_after"). Response bodies are
  never logged.

## C6. FIX 5 — Bot command target safety

- The parser preserves the optional lowercased target username
  (`/status@some_bot` → `commandTarget`) in the parsed command contract.
- The routing context carries an optional `expectedBotUsername`; a command
  with an explicit target executes only on a case-insensitive match and
  otherwise returns noop with the stable `command_for_other_bot` reason.
  No expected username is wired in Phase 2A (no live getMe), so EVERY
  explicitly-targeted command is ignored — fail closed.

## C7. FIX 6 — Action-token input validation

- `issueActionToken`/`consumeActionToken` validate BEFORE any database
  access: positive safe-integer `telegramUserId`; positive safe-integer
  timestamps with `expiresAtMs` strictly after `nowMs`; token format per the
  approved callback contract; permission restricted to the approved
  admin-map set (owner wildcard included); bounded action descriptor shape;
  bounded `targetType`/`targetId`; bounded payload that must parse as a
  JSON OBJECT (never arrays/scalars/malformed).
- Rejections never echo the offending value; a unit suite proves the D1
  stub is untouched for every invalid input class.

## C8. Version and documentation

- Version bumped consistently to **1.2.1**: package.json, package-lock.json
  (via npm tooling), wrangler.jsonc (root + preview), config defaults
  (`DEFAULT_APP_VERSION`), test helpers, `/version` expectations, and
  documentation.
- ADR-0027 (retryable reclaim), ADR-0028 (bounded stream reading), ADR-0029
  (HTML URL safety boundary) added and indexed; ADR-0025/0026 marked
  amended.
- README.md, docs/ARCHITECTURE.md (§3.8), docs/SECURITY_MODEL.md (trust
  boundary + new prohibited practices), docs/ROADMAP.md (Phase 2A section),
  and this handoff updated.

## C9. Verification (correction round)

- Clean-environment gate: `rm -rf node_modules dist .wrangler && npm ci &&
npm run check` — exit 0 (lint, prettier, strict typecheck, tests, secret
  self-test, secret scan, offline dry-run build). `npm run test:db` green.
- Suite totals: **417 tests in 33 files, all passing** (v1.2.0 baseline was
  341 tests in 30 files; the correction adds 3 new test files and extends 8
  existing suites). All new FIX categories are covered; Phase 1A/0 suites
  unchanged and green. New suites:
  `tests/integration/telegram-update-reclaim.test.ts`,
  `tests/unit/bounded-reader.test.ts`,
  `tests/unit/action-token-validation.test.ts`.
- Secret scanner: 151 files scanned, 0 findings; scanner self-test 10/10.
- Dry-run build: OK (offline `wrangler deploy --dry-run`).
- No deployment, no push, no webhook registration, no resource creation, no
  remote migration, no credentials, no live Telegram traffic.

## C10. Correction commit

| Round        | Commit          | Subject                                                 |
| ------------ | --------------- | ------------------------------------------------------- |
| v1.2.1 (fix) | _(this commit)_ | fix: harden Telegram ingress reliability and boundaries |

Ancestry: `446f3f1` (authoritative main) → `8f23b42` (v1.2.0 head) → this
commit. No history rewritten.

---

# Second correction round — v1.2.2 (Phase 2A second correction review: CHANGES REQUIRED)

## D1. Scope and authority

Alexios' second Phase 2A correction review (verdict CHANGES REQUIRED)
against branch `phase/02a-telegram-ingress` at HEAD `d49ba6862b7214d55886512ce96317d91de918e0`
(base Phase 2A HEAD `8f23b42`, main baseline
`446f3f14865a1ce57871f50d1979fbe5494a1e4a`, version 1.2.1, independently
verified 417/417 tests and 24/24 D1 tests). The first correction fixed the
security boundaries but left two reliability defects in the durable update
state machine. This round implements the four required fixes in ONE focused
correction commit, bumps the artifact version to **1.2.2**, adds migration
0002 (schema v2), and adds ADR-0030/0031/0032. Sections 1–14 (v1.2.0) and
C1–C10 (v1.2.1) above are preserved as history.

## D2. FIX 1 — Recover abandoned claimed updates (ADR-0030, migration 0002)

- **Migration `0002_telegram_update_lifecycle.sql`** (schema version 1 → 2;
  0001 untouched): adds `telegram_updates.claim_expires_at INTEGER` (the
  claim lease), `failure_class TEXT NULL` (CHECK retryable/permanent/NULL),
  `attempt_count INTEGER NOT NULL DEFAULT 0` (CHECK >= 0), and the
  `idx_tg_updates_lifecycle (status, claim_expires_at)` recovery index.
  Advances `schema_metadata` to `schema_version = 2` /
  `migration_id = 0002_telegram_update_lifecycle` inside the same atomic
  batch. `SCHEMA_VERSION` config/defaults updated to 2 everywhere.
- Every new claim writes a FULL lease state: `status='claimed'`,
  `claim_expires_at = now + TELEGRAM_UPDATE_CLAIM_LEASE_MS`,
  `failure_class = NULL`, `attempt_count = 1`.
- **Lease duration centralized:** `TELEGRAM_UPDATE_CLAIM_LEASE_MS = 5 min`
  in `src/adapters/telegram/update-claims.ts`, documented (far above the
  bounded webhook processing time, far below any operational horizon), and
  boundary-tested at lease − 1 ms (active → in_flight), exact expiry
  (stale → reclaimable), and after expiry (stale). No wall-clock calls in
  repositories — time stays explicitly injected.
- Active unexpired lease → explicit `in_flight` outcome. An in-flight
  delivery is NOT acknowledged as a successful duplicate: the webhook
  returns safe retryable 503 semantics so Telegram keeps redelivering until
  the lease resolves (winner completes → later delivery sees
  `already_processed`; or lease expires → stale reclaim).
- Expired lease (or NULL lease from a pre-0002 legacy row) → atomic guarded
  reclaim (`WHERE status='claimed' AND (claim_expires_at IS NULL OR
claim_expires_at <= ?)`): exactly one concurrent winner; losers observe
  the winner's FRESH lease as in-flight. Reclaim refreshes the lease,
  clears `failure_class`, resets `processed_at`, and increments
  `attempt_count`.
- **Marking-failure recovery sequence proven end to end** (integration
  test): processing fails retryably AND marking the failure fails → 503
  with the row still claimed under its lease → next delivery in-flight
  503 → lease expiry → `reclaimed_stale` → action executes once →
  processed (attempt_count 2).
- Claim outcomes now explicitly: `claimed`, `reclaimed_retryable`,
  `reclaimed_stale`, `already_processed`, `permanently_failed`, `in_flight`.

## D3. FIX 2 — Distinguish retryable and permanent failure persistence (ADR-0031)

- Retryable failure: `status='failed'`, `failure_class='retryable'`, lease
  cleared; webhook 503; later deliveries may atomically reclaim
  (`reclaimed_retryable`).
- Permanent failure: `status='failed'`, `failure_class='permanent'`, lease
  cleared; webhook 200; the row is TERMINAL — reclaim is guarded to
  `failure_class = 'retryable'` (plus NULL fail-safe) so a permanent row can
  never be reclaimed; every later duplicate/redelivery observes the explicit
  `permanently_failed` outcome and answers 200 WITHOUT executing.
- The v1.2.1 test that proved a permanent failed update is repeatedly
  reclaimed was REMOVED/REWRITTEN. New tests prove: permanent failure
  executes at most once (counting client); later duplicates return 200
  without executing; retryable failures remain reclaimable; concurrent
  retryable reclaim has exactly one winner; concurrent stale-claim reclaim
  has exactly one winner; processed is never reclaimable; permanent failed
  is never reclaimable.
- Legacy backfill (documented, fail-safe): migration 0002 backfills every
  pre-0002 failed row to `failure_class='retryable'` — consistent with the
  ADR-0027 principle that a wrong retryable guess is bounded while a wrong
  permanent guess loses the update. Proven by the populated v1→v2 migration
  tests (legacy rows remain valid and recoverable).

## D4. FIX 3 — Honest external side-effect semantics (ADR-0032)

- No exactly-once claim is made anywhere for Telegram API side effects. The
  contract is stated as: **durable at-least-once processing with duplicate
  suppression before execution, plus bounded duplicate risk for ambiguous
  external side effects.** Exactly-once database claim ownership does NOT
  imply exactly-once Telegram message delivery (sendMessage has no
  application-provided idempotency key).
- ADR-0025's "exactly-once command execution" wording is superseded via an
  amendment note; ADR-0027 carries a status note (completed by 0030/0031);
  README, ARCHITECTURE, SECURITY_MODEL, ROADMAP, and this handoff use the
  honest wording. Deterministic update_id deduplication is preserved.
- A new integration test documents and proves the ambiguous window: the
  outbound send SUCCEEDS, the processed transition (and the failure
  marking) fail → 503; after lease expiry the next delivery re-executes the
  action and the message is delivered a SECOND time (sends = 2), after
  which duplicate suppression resumes. This is the documented bounded
  duplicate risk — not an exactly-once guarantee.
- Roadmap gate recorded (Phase 8, docs/ROADMAP.md): publishing-side
  duplicate mitigation and reconciliation MUST exist before autonomous
  channel publishing is enabled. No outbox was added in this correction
  (the architecture does not yet support one safely — no publishing exists).

## D5. FIX 4 — Version and example consistency (1.2.2)

- Version bumped consistently to **1.2.2**: package.json and
  package-lock.json (via `npm version` tooling), wrangler.jsonc (root +
  preview), `DEFAULT_APP_VERSION`, `/version` tests and expectations,
  test helpers, and documentation.
- The specific defects were corrected: `.env.example` now carries
  `APP_VERSION=1.2.2` (was 1.1.0) and `.dev.vars.example` carries
  `APP_VERSION=1.2.2` (was 1.2.0).
- **New automated version-consistency gate** `scripts/check-versions.mjs`
  (wired into `npm run check` as `npm run check:versions`): package.json is
  the source of truth; the script fails the build on drift across
  package-lock.json, wrangler.jsonc vars, `DEFAULT_APP_VERSION`,
  `.env.example`, `.dev.vars.example`, the test env helper — and also pins
  the schema-version touch points (`EXPECTED_SCHEMA_VERSION`, wrangler
  `SCHEMA_VERSION`, `.env.example`). Historical ADR/handoff text is
  intentionally not scanned (clearly-identified history may retain old
  versions).

## D6. Migration and database tests

- Append-only test migration plan extended with the real 0002 descriptor;
  0001 unchanged.
- `tests/integration/migration-0002.test.ts` (new, isolated storage):
  applies ONLY 0001 to build a genuine populated schema-v1 database, seeds
  legacy telegram_updates rows (claimed without lease, processed, failed),
  applies the real plan (only 0002 pending), and proves: schema version
  becomes 2 with the 0002 migration id; existing rows remain valid; the
  legacy failed row is backfilled retryable and stays reclaimable; the
  legacy lease-less claimed row is recoverable via stale reclaim; applying
  twice is a no-op; the new CHECK constraints are enforced.
- `migration-plan.test.ts` / `migration-plan-failures.test.ts` reworked for
  schema v2 (partial-plan v1 baselines; rollback atomicity recovery now
  lands at the real version 2). The synthetic TEST-ONLY version-2 fixture
  is retained for plan-mechanics proofs.
- D1 schema contract updated: exactly 30 indexes (29 approved +
  `idx_tg_updates_lifecycle`), schema metadata pinned to v2, lifecycle
  columns + CHECKs asserted.
- `npm run test:db` now explicitly runs the migration/schema suites
  (d1-schema, db-boundary, migration-plan, migration-plan-failures,
  migration-0002). NO remote migration was applied.

## D7. Documentation

- New ADRs: ADR-0030 (claimed-update lease and stale reclaim), ADR-0031
  (permanent vs retryable failure persistence), ADR-0032 (honest
  at-least-once side-effect semantics); ADR index updated; ADR-0025 and
  ADR-0027 carry clearly-marked amendment notes (history preserved).
- Updated: README.md, docs/ARCHITECTURE.md (§3.7/§3.8), docs/SECURITY_MODEL.md
  (trust boundary + prohibited practices), docs/ROADMAP.md (Phase 2A + the
  Phase 8 publishing-duplicate-mitigation gate), migrations/README.md, and
  this handoff (second correction section appended, earlier history
  preserved). A claimed row is described as recoverable ONLY through the
  tested lease-expiry path.

## D8. Verification (second correction round)

- Clean-environment gate (exact commands): `rm -rf node_modules dist
.wrangler && npm ci && npm run check` — exit 0 (lint, prettier, strict
  typecheck, tests, secret-scanner self-test, secret scan,
  version-consistency gate, offline dry-run build). `npm run test:db` green
  (d1-schema, db-boundary, migration-plan, migration-plan-failures,
  migration-0002 run explicitly; migration tests also run inside
  `npm run check`).
- Suite totals: **440 tests in 34 files, all passing** (v1.2.1 baseline was
  417 tests in 33 files; this round adds 23 tests and the new
  `tests/integration/migration-0002.test.ts` file, and extends the claims /
  reclaim / pipeline / plan / schema / version suites). Phase 1A/0 suites
  unchanged and green.
- Secret scanner: 164 files scanned, 0 findings; scanner self-test 10/10.
- Version-consistency gate: application version 1.2.2 and schema version 2
  consistent across all active configuration files.
- Dry-run build: OK (offline `wrangler deploy --dry-run`).
- No deployment, no push, no webhook registration, no resource creation,
  no remote migration, no credentials, no live Telegram traffic.

## D9. Correction commit

| Round        | Commit          | Subject                                          |
| ------------ | --------------- | ------------------------------------------------ |
| v1.2.2 (fix) | _(this commit)_ | fix: complete Telegram update lifecycle recovery |

Ancestry: `446f3f1` (authoritative main) → `8f23b42` (v1.2.0 head) →
`d49ba68` (v1.2.1 correction head) → this commit. No history rewritten.

Single artifact: `pixel-lort-phase02a-v1.2.2.zip` (full working tree +
complete `.git` history at the ZIP root; excludes node_modules, dist,
.wrangler, coverage, environment/secret files, credentials, logs, temporary
files, and previous ZIP artifacts).
