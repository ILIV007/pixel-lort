/**
 * D1 storage adapter for admin UI language preferences (Phase 2B, v1.2.5) —
 * over the EXISTING blueprint `settings` table (ADR-0019). No schema change:
 * the preference is a JSON value under the dedicated
 * `admin_ui_language:<telegram_user_id>` key namespace (strict separation
 * from editorial language and every other settings namespace).
 *
 * Stored value shape (JSON):
 *   { "language": "en" | "fa", "changed_at_ms": <epoch ms>,
 *     "last_update_id": <fencing token> }
 *
 * WRITE FENCE (ADR-0034) — ONE atomic UPSERT statement, so the
 * read-decide-write race is impossible:
 *
 *   INSERT … ON CONFLICT(key) DO UPDATE …
 *     WHERE COALESCE(json_extract(settings.value_json,'$.last_update_id'), -1)
 *           <= json_extract(excluded.value_json,'$.last_update_id')
 *
 *   - no row                    -> INSERT applies            -> saved
 *   - stored update_id <  new   -> newer change applies      -> saved
 *   - stored update_id == new   -> same message redelivered;
 *                                  idempotent re-apply       -> saved
 *   - stored update_id >  new   -> OLDER retried message is
 *                                  REJECTED (changes = 0)    -> stale
 *
 * A corrupt stored value reads as "no preference" (English default) while
 * COALESCE(…, -1) lets the next write repair it — a presentation preference
 * must never become a permanently stuck row. `changes === 0` on the UPSERT is
 * the authoritative `stale` signal (SQLite reports changes for the winning
 * path only).
 *
 * Failure semantics: every storage failure THROWS (mapped AppError via the
 * DbExecutor boundary) — callers can never send a success confirmation for a
 * preference that was not durably persisted.
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

/** Safe-integer guard for stored JSON fields. */
function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Defensively parse a stored preference value. Anything that does not match
 * the documented shape exactly is treated as unreadable (null) — never as a
 * crash and never as a partially-trusted value.
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
  if (
    typeof language !== 'string' ||
    !isAdminUiLanguage(language) ||
    !isSafeNonNegativeInteger(changedAtMs) ||
    !isSafeNonNegativeInteger(lastUpdateId)
  ) {
    return null;
  }
  return { language, changedAtMs, lastUpdateId };
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
  }): Promise<AdminUiLanguageSaveOutcome> {
    const valueJson = JSON.stringify({
      language: input.language,
      changed_at_ms: input.changedAtMs,
      last_update_id: input.updateId,
    });
    const meta = await executor.run({
      sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
            VALUES (?, ?, ${SETTINGS_ROW_SCHEMA_VERSION}, NULL, ?)
            ON CONFLICT(key) DO UPDATE SET
              value_json = excluded.value_json,
              updated_at = excluded.updated_at
            WHERE COALESCE(json_extract(settings.value_json, '$.last_update_id'), -1)
                  <= json_extract(excluded.value_json, '$.last_update_id')`,
      params: [adminUiLanguageSettingsKey(input.telegramUserId), valueJson, input.changedAtMs],
    });
    // changes === 1 -> INSERT or fenced UPDATE won; changes === 0 -> the
    // fence rejected an OLDER message (a newer choice is already stored).
    return meta.changes > 0 ? { kind: 'saved' } : { kind: 'stale' };
  }

  return { findPreference, savePreference };
}
