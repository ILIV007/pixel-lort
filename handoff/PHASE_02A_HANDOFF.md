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
