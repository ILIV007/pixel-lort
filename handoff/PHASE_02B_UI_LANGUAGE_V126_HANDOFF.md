# Phase 2B UI-language review correction (v1.2.6) handoff

## 1. Result

The independent review of the v1.2.5 delivery returned **CHANGES REQUIRED**.
This correction continues on the SAME branch —
`phase/02b-admin-ui-language` — from the reviewed HEAD
`b44db13a8c7e66e179442b8063d3d6e9ba82dec6`. Nothing was restarted from an
older main and no completed UI-language feature was discarded; the
v1.2.5 history and the historical handoff
([PHASE_02B_UI_LANGUAGE_HANDOFF.md](PHASE_02B_UI_LANGUAGE_HANDOFF.md),
corrected in place via an appended §8) are preserved.

- Base (reviewed) HEAD: `b44db13a8c7e66e179442b8063d3d6e9ba82dec6`
- Application version: **1.2.6** (package.json, package-lock via npm
  tooling, wrangler.jsonc, `/version` default, env examples, test helper;
  enforced by `npm run check:versions`).
- **No schema changes.** Schema version remains **2** (migrations
  0001+0002); no migration added — the preference still lives in the
  EXISTING blueprint `settings` table under the dedicated
  `admin_ui_language:` namespace (ADR-0019/0034).
- Decision record: **[ADR-0035](../docs/DECISIONS/adr-0035-admin-ui-language-ordering.md)**
  (amends ADR-0034; status lines and the index updated, original text
  preserved).

## 2. FIX 1 — Correct preference ordering (ADR-0035)

**Problem:** v1.2.5 fenced language-change writes with the numeric
`update_id`. Telegram documents that update_id may be RANDOMIZED after one
week without updates, so its numeric value is not a permanent chronological
order: a genuinely newer choice could be rejected (lower randomized id), or
an older retry could overwrite a newer choice (higher randomized id).

**Correction:** preference ordering now uses VALIDATED TELEGRAM
MESSAGE-ORDER METADATA — the lexicographic pair
`(message.date, message.message_id)`:

| Aspect             | Contract                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary order key  | The changing message's SERVER-assigned `date` (Unix seconds × 1000)                                                                                                     |
| Same-second tie    | Per-chat monotonic `message_id` (higher id = later message, whichever arrives later)                                                                                    |
| Duplicate delivery | Equal `(date, message_id)` pair → idempotent re-apply (`saved`), state unchanged                                                                                        |
| Older retry        | Strictly older pair resolves `stale` — never overwrites, honest localized reply                                                                                         |
| Missing metadata   | `/language` CHANGE without validated `date`+`message_id` is a noop (`language_missing_ordering_metadata`) — no state change; bare `/language` (read-only) still answers |
| Store input guard  | Invalid ordering input throws deterministic `internal_error` (permanent), writes nothing                                                                                |
| update_id          | UNCHANGED as the durable DEDUPLICATION boundary (ADR-0025 claims) + audit value; never compared numerically for freshness                                               |
| Local time         | Deliberately rejected — an old retry ARRIVES later, so arrival time is no order                                                                                         |

Parser: `message.date` is extracted with strict bounds (safe integer in
`[0, 4102444800]`); anything else is absent (fail-safe). Stored JSON gains
an optional `last_message_id` field (omitted — never null — when unknown);
readers of the old shape keep working.

## 3. FIX 2 — Safe corrupt-row recovery (ADR-0035)

**Problem:** v1.2.5 claimed COALESCE "lets the next write repair" a corrupt
row, but that was false: `json_extract` on MALFORMED JSON throws (the UPSERT
fails → permanently stuck row), and valid JSON with invalid field types
(e.g. `changed_at_ms` as TEXT) silently wedged the fence via cross-type
comparison.

**Correction:** the write stays ONE atomic UPSERT whose guard is
`CASE WHEN <stored row fully valid> THEN <ordering fence> ELSE 1 END`:

- `json_valid(value_json) = 1` is evaluated FIRST — `json_extract` never
  runs on malformed JSON (which would throw).
- "Fully valid" mirrors the JS parser exactly (object shape, `en`/`fa`,
  safe-integer ordering fields, optional positive `last_message_id`).
- Any invalid row (malformed JSON, wrong types, wrong values) is repaired
  BY THE SAME atomic statement — no read-decide-write window, no partial
  state; the fence for fully valid rows is never weakened.
- All writes remain inside the dedicated `admin_ui_language:` namespace;
  unrelated settings rows are byte-identical (asserted by tests).

## 4. FIX 3 — Delivery integrity

- Tracked file executable bits normalized to the Git index: exactly
  `scripts/deploy-preview.mjs` is 100755; every OTHER tracked file (180 in
  the current 181-file tree) is 100644. `git status` is clean with
  `core.filemode=true` ENABLED — mode
  drift is surfaced, never hidden by disabling file-mode checks.
- The working tree was mode-corrected (the previous archive extraction had
  drifted disk modes while `core.filemode=false` masked it).
- **Tracked-file count corrected:** the v1.2.5 delivery tree contained
  **177 tracked files** (`git ls-tree -r b44db13a --name-only | wc -l`),
  not the 176 its delivery report claimed. The v1.2.6 correction adds 4
  files (ADR-0035, this handoff, the reviewer regression suite, the
  ordering suite), so the CURRENT tree has **181 tracked files**
  (`git ls-files | wc -l`) — confirmed by `npm run scan:secrets`
  ("181 files scanned").
- The delivered ZIP is verified by extraction with `core.filemode=true`:
  `git status` clean, index modes equal disk modes, HEAD matches this
  handoff.

## 5. Preserved contracts (verified, not weakened)

- English default and per-admin isolation (bootstrap owner included, no
  admins row required; `updated_by` stays NULL).
- STRICT separation from editorial/channel language: `AdminUiLanguage`
  types, `admin_ui_language:` namespace, blueprint/editorial files and
  `drafts.language DEFAULT 'fa'` untouched (byte-identical, tested).
- Owner bootstrap, authorization, private-chat and non-edited-message
  guards with stable noop reasons.
- HTML safety, redirect rejection (ADR-0033), secret/payload redaction,
  persistent claim fencing (ADR-0025/0030/0031), honest 200/503
  acknowledgements: persist-first, confirmation only after the fenced
  write; storage failures propagate as retryable 503 with zero
  confirmations.

## 6. Verification (all executed locally in this workspace)

- Reviewer regression tests added VERBATIM (formatting only):
  `tests/integration/pixel-v125-review-regressions.test.ts` — newer
  selection with LOWER update_id accepted; `'{broken'` row repaired by the
  next valid save.
- New suites: `tests/integration/admin-ui-language-ordering.test.ts`
  (store-level ordering tiebreak, duplicate idempotency, unordered-write
  refusal, invalid-input fail-safety, ten corrupt-row shapes repaired,
  fence strength for valid rows, namespace isolation) and pipeline-level
  message-order scenarios + missing/invalid-date noops in
  `tests/integration/admin-ui-language.test.ts`; parser `date` bounds in
  `tests/unit/update-parser.test.ts`; router metadata guard in
  `tests/unit/command-router.test.ts`.
- Clean-environment gate: `rm -rf node_modules dist .wrangler && npm ci &&
npm run check && npm run test:db` — all green (see §8 for the recorded
  numbers).
- `npm run check:versions`: application 1.2.6 / schema 2 consistent.
- No live operations: no credentials, no push, no merge, no deploy, no
  webhook re-registration, no remote migrations, no live Telegram calls,
  no admin CRUD, no publishing work.

## 7. Limitations and next steps

- Same as v1.2.5: `/language` supports exactly `en`/`fa`; owner-only admin
  management (issue #8) remains unimplemented; no publishing.
- The stored preference JSON now carries an optional `last_message_id`
  (additive; old rows without it keep working and repair normally).
- Same-message-redelivery during a lost-confirmation window still answers
  with the idempotent `saved` path (unchanged v1.2.5 wording caveat).

## 8. Recorded verification numbers

Recorded for the final tree of this handoff (clean `npm ci`, then the full
gate):

- `npx vitest run`: **519 tests / 40 files, all passing** (v1.2.5: 500/38;
  +19 tests across the reviewer regression file, the ordering suite, and
  the extended parser/router/language suites).
- `npm run test:db`: 47/47 (D1 schema + migration suites unchanged, green).
- `npm run test:telegram-setup`: 14/14 offline operator tests.
- `npm run test:secrets`: 10/10 scanner self-test; `npm run scan:secrets`:
  **181 tracked files scanned, 0 findings**.
- `npm run check:versions`: application 1.2.6 / schema 2 consistent.
- `npm run lint`, `npm run format:check`, `npm run typecheck`: clean.
- `npm run build`: wrangler dry-run bundle OK (never a deploy).
