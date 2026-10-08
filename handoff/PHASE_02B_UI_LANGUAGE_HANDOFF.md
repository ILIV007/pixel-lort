# Phase 2B (admin UI language) handoff — English default, per-admin selection

## 1. Result

Phase 2B correction implements the **admin bot UI language** feature on
branch `phase/02b-admin-ui-language`, per Alexios' correction packet.

- Starting authoritative main commit: `564116ed374c3e1a032ff10aa1c1b71420ad9f3f`
  (verified: `origin/main` of `https://github.com/ILIV007/pixel-lort.git`;
  NOT continued from any older v1.2.3 ZIP).
- Final branch: `phase/02b-admin-ui-language` (created directly from
  `origin/main`; upstream tracking intentionally unset).
- Application version: **1.2.5** (package.json, package-lock via npm
  tooling, wrangler.jsonc, `/version` default, env examples, test helper).
- **No schema changes.** Schema version remains **2** (migrations
  0001+0002); NO migration was added — the preference uses the EXISTING
  blueprint `settings` table (ADR-0019) under a dedicated key namespace.
- All previous history and historical handoffs preserved untouched.

## 2. Requirement compliance

| Requirement                                                                   | Implementation                                                                                                          |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| English DEFAULT admin UI language                                             | `DEFAULT_ADMIN_UI_LANGUAGE = 'en'`; router renders English absent a preference                                          |
| Explicit, discoverable `/language` (`en`/`fa`)                                | Bare `/language` reports current + usage; `/language en                                                                 | fa` changes it |
| Durable per-admin persistence by numeric Telegram ID                          | `settings` row `admin_ui_language:<user_id>` (JSON value), D1-backed                                                    |
| One admin's preference never affects another                                  | Per-user key namespace; integration isolation tests                                                                     |
| STRICT separation from editorial/channel language                             | Named `AdminUiLanguage` types + `admin_ui_language:` namespace; blueprint/editorial files untouched (asserted by tests) |
| Localized `/start` `/help` `/status` `/version`                               | Full en/fa string tables; Persian preserves the Phase 2A texts verbatim                                                 |
| Minimal English denial for unauthorized users                                 | Fixed "Access denied." (replaces Phase 2A Persian denial — ADR-0034)                                                    |
| Authorization + private chat + fresh message for changes                      | Guards with stable noop reasons `language_not_private_chat` / `language_edited_message`                                 |
| No changing another person's preference                                       | The write target is ALWAYS the sender's own numeric user ID; no such syntax exists                                      |
| Claim fencing / honest 200-503 / HTML safety / redirect rejection / redaction | Unchanged pipelines reused; confirmations sent only after the fenced write                                              |
| Storage failures never fake success                                           | Persist-first execution; write/read failures → retryable 503, zero confirmations                                        |
| Older retried messages never overwrite newer choices                          | Single atomic UPSERT fenced by `last_update_id` (COALESCE repair for corrupt rows)                                      |
| Use existing schema; no speculative migration                                 | Existing `settings` table; schema stays 2                                                                               |
| No admin CRUD / publishing in this correction                                 | Explicitly out of scope (issue #8 remains open)                                                                         |

## 3. Commits (no history rewritten)

| #   | Commit          | Subject                                                |
| --- | --------------- | ------------------------------------------------------ |
| 1   | `01b4d5f`       | feat: add admin UI language types and fenced D1 store  |
| 2   | `e48d590`       | feat: route admin commands in the sender's UI language |
| 3   | `817df53`       | chore: bump application version to 1.2.5               |
| 4   | `46bd3b5`       | test: cover admin UI language selection and fencing    |
| 5   | `4fcc43a`       | docs: record the admin UI language decision            |
| 6   | _(this commit)_ | docs: record the Phase 2B UI-language handoff          |

## 4. Implemented contracts

### 4.1 Language domain (`src/admin/ui-language.ts`, ADR-0034)

- `AdminUiLanguage = 'en' | 'fa'`, English default; exact-match guard plus a
  trim/lowercase normalizer for command arguments.
- Dedicated `admin_ui_language:` settings-key namespace — never editorial.
- Per-language admin string tables (`start`/`help`/`status`/`version`/
  `language`), per-target-language saved confirmations, per-current-language
  honest stale replies, fixed English denial.
- `AdminUiLanguageStore` port: `findPreference` (corrupt → null) and
  `savePreference` (fenced outcome `saved` | `stale`).

### 4.2 D1 store (`src/adapters/db/admin-ui-language-store.ts`)

- ONE atomic fenced UPSERT over the existing `settings` table:
  `WHERE COALESCE(json_extract(settings.value_json,'$.last_update_id'), -1)
<= json_extract(excluded.value_json,'$.last_update_id')` — insert/newer
  wins; equal update_id (same-message redelivery) re-applies idempotently;
  a strictly older retried message writes NOTHING (`changes = 0` → stale).
- `updated_by` is NULL on every write: the column carries an FK to `admins`
  and the bootstrap owner has NO admins row (a non-null owner value would
  fail the first save on a foreign-key violation).
- Every storage failure throws a mapped AppError — callers can never confirm
  an unpersisted preference.

### 4.3 Router + pipeline

- Allowlist: `/start`, `/help`, `/status`, `/version`, `/language`.
- `route(update, actor, uiLanguage?)` renders every authorized response in
  the sender's persisted language (English default). Unauthorized senders of
  allowlisted commands get the minimal English denial; non-allowlisted
  commands stay silent for everyone.
- `/language` guards: authorized + PRIVATE chat + non-edited message;
  otherwise stable noop, no feedback, no state change. Malformed arguments
  (unknown codes, multi-token) answer the localized usage text with NO write.
- New typed action `set_admin_ui_language` carries the SENDER's user id, the
  chosen language, the fencing update_id, and both pre-composed
  confirmations; the ingress persists FIRST (logging
  `telegram.action.ui_language_result` with the outcome word only) and sends
  exactly one confirmation afterwards.
- The pipeline loads the authorized sender's preference before routing; a
  preference READ failure is a retryable processing failure (never a silent
  English fallback, never a denial).
- Parser: bounded `chatType` extraction for the four known Telegram chat
  types (anything else absent; never logged).

## 5. Verification (all executed locally in this workspace)

- `npx vitest run`: **500 tests / 38 files, all passing** (452 → 500; +48
  tests across the new/extended suites).
- `npm run test:db`: 47/47 (D1 schema + migration suites unchanged and
  green).
- `npm run test:telegram-setup`: 14/14 offline operator tests.
- `npm run test:secrets`: 10/10 scanner self-test; `npm run scan:secrets`:
  170 tracked files, 0 findings.
- `npm run check:versions`: application 1.2.5 / schema 2 consistent.
- `npm run build`: wrangler dry-run bundle OK (never a deploy).
- Clean-environment gate: `rm -rf node_modules dist .wrangler && npm ci &&
npm run check && npm run test:db` — all green (see §7 for the recorded
  run).
- Storage-failure honesty and stale-fence behavior verified over the REAL
  workerd D1 binding (`tests/integration/admin-ui-language-failures.test.ts`,
  `tests/integration/admin-ui-language.test.ts`).

## 6. Explicitly unchanged (strict separation)

- `migrations/` (still exactly 0001 + 0002), `docs/blueprint/v1/**`
  (byte-identical), editorial defaults (`drafts.language DEFAULT 'fa'`),
  publishing settings, TARGET_CHANNEL, webhook security, claim/lease/failure
  semantics, redirect rejection (ADR-0033), secret redaction, and every
  historical handoff document.

## 7. Limitations and next steps

- `/language` currently supports exactly `en` and `fa`; adding a language
  means extending `ADMIN_UI_LANGUAGES` + string tables (single source).
- The stale-reply wording ("Not applied: a newer language choice is already
  saved.") also covers the same-message-redelivery race in the rare window
  where the first attempt's confirmation was lost; behavior is honest but
  the wording could later distinguish "already applied".
- Owner-only in-bot admin management (issue #8) remains UNIMPLEMENTED —
  intentionally untouched by this correction.
- No live operations were performed: no credentials, no push, no merge, no
  deploy, no webhook re-registration, no remote migrations, no live Telegram
  calls.
