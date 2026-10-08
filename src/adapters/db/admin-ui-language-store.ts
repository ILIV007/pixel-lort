/**
 * D1 storage adapter for admin UI language preferences (Phase 2B, v1.2.5;
 * ordering + recovery corrected in v1.2.6 — ADR-0035) — over the EXISTING
 * blueprint `settings` table (ADR-0019). No schema change: the preference is
 * a JSON value under the dedicated `admin_ui_language:<telegram_user_id>`
 * key namespace (strict separation from editorial language and every other
 * settings namespace).
 *
 * Stored value shape (JSON):
 *   { "language": "en" | "fa", "changed_at_ms": <epoch ms>,
 *     "last_update_id": <dedup boundary / audit>, "last_message_id": <n>? }
 *
 * ORDERING FENCE (v1.2.6, ADR-0035) — preference ordering uses VALIDATED
 * TELEGRAM MESSAGE-ORDER METADATA, the lexicographic pair
 * `(changed_at_ms, last_message_id)`:
 *   - `changed_at_ms` is the changing message's SERVER-assigned `date`
 *     (Unix seconds × 1000) — never a local clock reading (an old retry
 *     ARRIVES later; local time would let it win).
 *   - `last_message_id` is the per-chat monotonic `message_id`, breaking
 *     ties between messages sent within the SAME SECOND.
 * `update_id` is deliberately NOT the chronological fence: Telegram may
 * RANDOMIZE update_id after one week without updates, so its numeric value
 * proves nothing about message order. It remains the durable DEDUPLICATION
 * boundary (ADR-0025 claims layer) and is recorded here for audit only.
 *
 * WRITE FENCE — ONE atomic UPSERT statement, so the read-decide-write race
 * is impossible:
 *
 *   INSERT … ON CONFLICT(key) DO UPDATE …
 *     WHERE CASE
 *       WHEN <stored row is FULLY VALID> THEN
 *         stored.(changed_at_ms, message_id)  <  incoming.(…)   (lexicographic,
 *            equal pair = duplicate delivery -> idempotent re-apply)
 *       ELSE 1   -- absent or UNREADABLE row -> safe atomic repair
 *     END
 *
 *   - no row                       -> INSERT applies            -> saved
 *   - stored strictly older        -> newer change applies      -> saved
 *   - stored equal ordering        -> same-message redelivery;
 *                                    idempotent re-apply        -> saved
 *   - stored strictly newer        -> OLDER retried message is
 *                                    REJECTED (changes = 0)     -> stale
 *   - stored row UNREADABLE        -> the write applies and
 *                                    REPAIRS the row atomically -> saved
 *
 * CORRUPT-ROW RECOVERY (v1.2.6, ADR-0035): "unreadable" means the stored
 * JSON is malformed (`json_valid = 0` — e.g. `'{broken'`) or valid JSON with
 * invalid field types/values (wrong `json_type`, language outside
 * en/fa, ordering numbers out of the safe-integer/epoch range). The
 * `json_valid(...)` guard is evaluated FIRST inside the CASE so
 * `json_extract` never even runs on malformed JSON (which would otherwise
 * throw and turn the row permanently stuck), and the fence comparisons run
 * ONLY for fully valid rows — recovery never weakens the fence for valid
 * data. The repair is the SAME single atomic statement: no separate
 * read-decide-write step, no window where a corrupt row can be observed
 * half-repaired. All writes stay inside the dedicated `admin_ui_language:`
 * namespace (the statement targets exactly one computed key).
 *
 * `changes === 0` on the UPSERT is the authoritative `stale` signal (SQLite
 * reports changes for the winning path only; 0 means a fully valid, strictly
 * newer row was already stored).
 *
 * Failure semantics: every storage failure THROWS (mapped AppError via the
 * DbExecutor boundary) — callers can never send a success confirmation for a
 * preference that was not durably persisted. Invalid INPUT (a programming
 * error, e.g. non-integer ordering metadata) throws a deterministic
 * `internal_error` — retrying cannot fix it, so it is never classified
 * retryable.
 *
 * `updated_by` is deliberately NULL on both paths: the column carries a
 * foreign key to `admins`, and the bootstrap owner is authorized WITHOUT an
 * admins row — a non-null owner value would fail the first save on an FK
 * violation. The admin identity is already encoded in the key namespace.
 *
 * Observability: parameterized SQL only; keys, JSON values, and user IDs are
 * never logged (ADR-0022).
 */
import type { DbExecutor } from './db-executor';
import { AppError } from '../../shared/errors/app-error';
import {
  adminUiLanguageSettingsKey,
  isAdminUiLanguage,
  type AdminUiLanguage,
  type AdminUiLanguagePreference,
  type AdminUiLanguageSaveOutcome,
  type AdminUiLanguageStore,
} from '../../admin/ui-language';

/** The `settings` row format version (blueprint column, independent of the DB schema version). */
const SETTINGS_ROW_SCHEMA_VERSION = 1;

/** Safe-integer upper bound mirrored from the JS side (Number.MAX_SAFE_INTEGER). */
const MAX_SAFE_JSON_INT = 9_007_199_254_740_991;

/**
 * SQL predicate: the stored row is a FULLY VALID preference — readable JSON
 * object whose fields all match the documented shape (same shape the JS
 * parser `parseStoredPreference` enforces). `json_valid` is evaluated first
 * so the `json_extract`/`json_type` calls can never run on malformed JSON.
 * `$.last_message_id` may be ABSENT (optional field) but must be a positive
 * safe integer when present — a JSON null is treated as invalid (writes
 * omit the key instead of storing null).
 */
const STORED_ROW_VALID_SQL = `
    json_valid(settings.value_json) = 1
    AND json_type(settings.value_json, '$') = 'object'
    AND json_type(settings.value_json, '$.language') = 'text'
    AND json_extract(settings.value_json, '$.language') IN ('en', 'fa')
    AND json_type(settings.value_json, '$.changed_at_ms') = 'integer'
    AND json_extract(settings.value_json, '$.changed_at_ms') BETWEEN 0 AND ${MAX_SAFE_JSON_INT}
    AND json_type(settings.value_json, '$.last_update_id') = 'integer'
    AND json_extract(settings.value_json, '$.last_update_id') BETWEEN 0 AND ${MAX_SAFE_JSON_INT}
    AND (
      json_type(settings.value_json, '$.last_message_id') IS NULL
      OR (
        json_type(settings.value_json, '$.last_message_id') = 'integer'
        AND json_extract(settings.value_json, '$.last_message_id') BETWEEN 1 AND ${MAX_SAFE_JSON_INT}
      )
    )`.replace(/\n/g, ' ');

/**
 * SQL fence for a FULLY VALID stored row: lexicographic
 * `(changed_at_ms, last_message_id)` ordering. The stored value wins unless
 * the incoming pair is strictly greater; an EQUAL pair is the same message
 * redelivered and re-applies idempotently. `COALESCE(..., -1)` treats an
 * absent `last_message_id` as "unordered" (-1), which can never beat a
 * same-second write that carries a real message_id — fail-safe direction.
 */
const ORDERING_FENCE_SQL = `
    json_extract(settings.value_json, '$.changed_at_ms')
      < json_extract(excluded.value_json, '$.changed_at_ms')
    OR (
      json_extract(settings.value_json, '$.changed_at_ms')
        = json_extract(excluded.value_json, '$.changed_at_ms')
      AND COALESCE(json_extract(settings.value_json, '$.last_message_id'), -1)
            <= COALESCE(json_extract(excluded.value_json, '$.last_message_id'), -1)
    )`.replace(/\n/g, ' ');

/** Safe-integer guard for inputs and stored JSON fields. */
function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Defensively parse a stored preference value. Anything that does not match
 * the documented shape exactly is treated as unreadable (null) — never as a
 * crash and never as a partially-trusted value. This mirrors the SQL
 * validity predicate exactly, so a row the SQL fence calls "valid" is also a
 * row this parser returns, and vice versa.
 */
function parseStoredPreference(valueJson: string): AdminUiLanguagePreference | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(valueJson);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return null;
  }
  const record = decoded as Record<string, unknown>;
  const language = record['language'];
  const changedAtMs = record['changed_at_ms'];
  const lastUpdateId = record['last_update_id'];
  const lastMessageId = record['last_message_id'];
  if (
    typeof language !== 'string' ||
    !isAdminUiLanguage(language) ||
    !isSafeNonNegativeInteger(changedAtMs) ||
    !isSafeNonNegativeInteger(lastUpdateId)
  ) {
    return null;
  }
  // Optional field: absent means "unordered"; present means positive safe
  // integer. Anything else (null, string, float, non-positive) is invalid.
  if (lastMessageId === undefined) {
    return { language, changedAtMs, lastUpdateId };
  }
  if (!isSafeNonNegativeInteger(lastMessageId) || lastMessageId < 1) {
    return null;
  }
  return { language, changedAtMs, lastUpdateId, lastMessageId };
}

export function createAdminUiLanguageStore(executor: DbExecutor): AdminUiLanguageStore {
  async function findPreference(telegramUserId: number): Promise<AdminUiLanguagePreference | null> {
    const row = await executor.first<{ value_json: string }>({
      sql: 'SELECT value_json FROM settings WHERE key = ? LIMIT 1',
      params: [adminUiLanguageSettingsKey(telegramUserId)],
    });
    if (row === null) {
      return null;
    }
    return parseStoredPreference(row.value_json);
  }

  async function savePreference(input: {
    telegramUserId: number;
    language: AdminUiLanguage;
    updateId: number;
    changedAtMs: number;
    messageId?: number;
  }): Promise<AdminUiLanguageSaveOutcome> {
    // Last line of defense against invalid metadata (the router already
    // fails safe on updates without validated ordering fields): a
    // deterministic programming error throws a PERMANENT classification
    // code — it must never write garbage and never loop as retryable.
    if (
      !isSafeNonNegativeInteger(input.telegramUserId) ||
      !isAdminUiLanguage(input.language) ||
      !isSafeNonNegativeInteger(input.updateId) ||
      !isSafeNonNegativeInteger(input.changedAtMs) ||
      (input.messageId !== undefined &&
        (!isSafeNonNegativeInteger(input.messageId) || input.messageId < 1))
    ) {
      throw new AppError('internal_error', {
        details: { reason: 'invalid_admin_ui_language_input' },
      });
    }
    // The optional tiebreak key is OMITTED (never null) when unknown, so the
    // SQL validity predicate sees a missing path — not a JSON null.
    const valueJson = JSON.stringify({
      language: input.language,
      changed_at_ms: input.changedAtMs,
      last_update_id: input.updateId,
      ...(input.messageId !== undefined ? { last_message_id: input.messageId } : {}),
    });
    const meta = await executor.run({
      sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
            VALUES (?, ?, ${SETTINGS_ROW_SCHEMA_VERSION}, NULL, ?)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            WHERE CASE WHEN ${STORED_ROW_VALID_SQL}
                  THEN ${ORDERING_FENCE_SQL}
                  ELSE 1 END`,
      params: [adminUiLanguageSettingsKey(input.telegramUserId), valueJson, input.changedAtMs],
    });
    // changes === 1 -> INSERT, a newer ordering won, an idempotent
    // redelivery re-applied, OR an unreadable row was atomically repaired;
    // changes === 0 -> a fully valid, strictly newer choice is already
    // stored and an OLDER message lost the fence.
    return meta.changes > 0 ? { kind: 'saved' } : { kind: 'stale' };
  }

  return { findPreference, savePreference };
}
