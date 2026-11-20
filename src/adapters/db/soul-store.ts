/**
 * Slice 8 — Soul versioning store (DESIGN §9.3).
 *
 * The Pixel persona lives in a VERSIONED document (docs/soul/SOUL_v1.md is
 * canonical). D1 carries the versioned record:
 *
 * - `souls` (migration 0010): ONE row per Soul version — the full text,
 *   its SHA-256, the creator and the timestamp. Append-only: a Soul change
 *   is a NEW row, never an edit of a published version.
 * - `settings` key `soul.current_version`: the pointer at the ACTIVE
 *   version (JSON {"version": N, "updated_by": ..., "updated_at_ms": ...}).
 *
 * Resolution order for the current version (fail-soft, never fails a
 * publish): a valid settings pointer wins; otherwise the highest recorded
 * `souls` version; otherwise NULL (no Soul recorded yet — legacy rows
 * carry NULL `soul_version`). A missing `souls` table (a pre-0010
 * database) also resolves to NULL: the publish path must never break on
 * a Soul lookup.
 *
 * BOUNDARY (ADR-0022): all D1 access for these rows goes through this
 * module. Never log SQL text or bind parameters; never log full rows.
 */
import type { DbExecutor } from './db-executor';

/** Settings-table key pointing at the active Soul version. */
export const SOUL_CURRENT_VERSION_SETTINGS_KEY = 'soul.current_version';

export interface SoulRecordInput {
  readonly version: number;
  readonly text: string;
  readonly sha256: string;
  readonly createdBy: number;
  readonly nowMs: number;
}

function isValidSoulVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function parsePointerVersion(valueJson: string): number | null {
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const version = (parsed as Record<string, unknown>)['version'];
    return isValidSoulVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * The active Soul version, or NULL when no Soul is recorded. Fail-soft:
 * any read failure (including a missing `souls` table on a pre-0010
 * database) resolves to NULL instead of throwing.
 */
export async function getCurrentSoulVersion(executor: DbExecutor): Promise<number | null> {
  try {
    const pointer = await executor.first<{ value_json: string }>({
      sql: `SELECT value_json FROM settings WHERE key = ?`,
      params: [SOUL_CURRENT_VERSION_SETTINGS_KEY],
    });
    if (pointer !== null) {
      const pointed = parsePointerVersion(pointer.value_json);
      if (pointed !== null) {
        return pointed;
      }
    }
    const highest = await executor.first<{ version: number }>({
      sql: `SELECT MAX(version) AS version FROM souls`,
    });
    const version = highest?.version;
    return isValidSoulVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Point the `soul.current_version` settings key at a recorded version.
 * The pointer is an operator action (the seed step after a Soul change);
 * the value JSON carries the version + the actor + the timestamp. The
 * `updated_by` column stays NULL (the ui-language-store discipline: the
 * bootstrap owner is authorized WITHOUT an admins row).
 */
export async function setCurrentSoulVersion(
  executor: DbExecutor,
  input: { readonly version: number; readonly actorId: number; readonly nowMs: number },
): Promise<void> {
  if (!isValidSoulVersion(input.version)) {
    throw new Error('invalid soul version');
  }
  const valueJson = JSON.stringify({
    version: input.version,
    updated_by: input.actorId,
    updated_at_ms: input.nowMs,
  });
  await executor.run({
    sql: `INSERT INTO settings (key, value_json, schema_version, updated_by, updated_at)
          VALUES (?, ?, 1, NULL, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at`,
    params: [SOUL_CURRENT_VERSION_SETTINGS_KEY, valueJson, input.nowMs],
  });
}

/**
 * Record ONE Soul version (append-only). A duplicate version is refused
 * by the PRIMARY KEY — a Soul change must mint a NEW version, never
 * rewrite a published one. Throws on invalid input (a seed/operator
 * error must be loud); the publish path never calls this.
 */
export async function recordSoulVersion(
  executor: DbExecutor,
  input: SoulRecordInput,
): Promise<void> {
  if (!isValidSoulVersion(input.version)) {
    throw new Error('invalid soul version');
  }
  if (typeof input.text !== 'string' || input.text.length === 0) {
    throw new Error('invalid soul text');
  }
  if (typeof input.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new Error('invalid soul sha256');
  }
  if (
    typeof input.createdBy !== 'number' ||
    !Number.isSafeInteger(input.createdBy) ||
    input.createdBy <= 0
  ) {
    throw new Error('invalid soul creator');
  }
  await executor.run({
    sql: `INSERT INTO souls (version, text, sha256, created_by, created_at_ms)
          VALUES (?, ?, ?, ?, ?)`,
    params: [input.version, input.text, input.sha256, input.createdBy, input.nowMs],
  });
}
