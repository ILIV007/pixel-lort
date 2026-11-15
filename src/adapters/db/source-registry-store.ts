/**
 * Source registry seeding store (Phase 4 — ADR-0038 §2; typed D1 boundary
 * per ADR-0022; R07 field ownership + R08 bounded atomic reconciliation).
 *
 * Idempotent seed of the validated registry catalog into `sources` +
 * `source_state`:
 * - ONE atomic D1 batch for the whole catalog (2 statements per source:
 *   sources upsert + state insert). Bounded by construction: the registry
 *   schema caps sources at 32 ⇒ ≤ 64 statements per batch. If ANY
 *   statement fails, the WHOLE batch rolls back — a failed reconciliation
 *   can never leave partially applied changes (R08).
 * - NEW rows insert fully (enabled = 0 — nothing activates implicitly).
 * - EXISTING rows are merged under an EXPLICIT field-ownership contract
 *   (R07 — documented in docs/PHASE4_SOURCE_FIELD_OWNERSHIP.md):
 *   * REGISTRY-OWNED columns are refreshed: name, connector, lane,
 *     trust_tier, approval_policy, attribution_template, updated_at;
 *   * OWNER-OVERRIDABLE columns are preserved: enabled, priority,
 *     interval_seconds, daily_request_budget, created_at (a repeated
 *     import can never silently re-enable a disabled source, retune an
 *     owner schedule, or clobber an owner budget override);
 *   * config_json is NEVER overwritten wholesale: the registry side is
 *     merged INTO the current persisted config with SQLite `json_patch`
 *     evaluated in-row (atomic — no read-modify-write race can lose a
 *     concurrent owner change), with the OWNER WATCHLIST keys (`apps`,
 *     `playlists`, `repositories`, `subreddits`) removed from the patch
 *     side so a re-import can never touch them;
 *   * `source_state` rows are insert-only: existing state is preserved
 *     ENTIRELY (INSERT … DO NOTHING).
 * - Persisted config must be a JSON OBJECT at the atomic mutation boundary
 *   (Round 1.3.1): `json_patch` alone would silently DISCARD a non-object
 *   persisted root (RFC-7396 MergePatch — `null`, `[]`, `"str"`, `42` are
 *   all valid JSON and would be replaced by the registry defaults). The
 *   merge therefore runs inside a `CASE` that requires
 *   `json_type(sources.config_json) = 'object'`; any other root shape —
 *   or malformed JSON (json_type/json_patch raise) — makes the statement
 *   FAIL visibly (NOT NULL violation on config_json / SQL error) and the
 *   whole batch rolls back: the original value is never reset, replaced,
 *   or silently repaired, and there is no application-layer pre-read
 *   whose snapshot could race (the check lives in the same statement that
 *   mutates the row).
 *
 * `SeedSummary.written` counts the SOURCE descriptor statements via an
 * EXPLICIT statement-index map (Round 1.3.1 fix): the batch alternates
 * one sources-upsert with one state-insert per source, so positional
 * metadata indexing (`metas[i]`) read the wrong half of the alternation
 * and under-counted a full re-import as 7 instead of 14. The mapping is
 * recorded while statements are built, so the count remains correct even
 * if the statement layout ever changes.
 *
 * Registry-owned config keys (refreshed by the merge): the connector
 * config block of the blueprint (e.g. steam `appsPerBatch`/`maxItemsPerApp`,
 * youtube `useSearchEndpoint`/`downloadVideo`, reddit `limit`/
 * `stripDownloadLinks`, github `includePrereleases`, bluesky/igdb policy
 * keys) plus the endpoint facts (`endpoint`, `detailsEndpoint`,
 * `endpointTemplates`). The singular `endpointTemplate` is informational
 * in the blueprint (connectors pin their own official endpoints) and is
 * not part of the runtime config surface — unchanged from Phase 4.
 */
import type { DbExecutor, DbStatement } from './db-executor';
import type { Registry, RegistrySource } from '../../domain/source/source-registry';
import { laneDefaultPriority } from '../../domain/source/source-registry';

export interface SeedSummary {
  /** Rows whose descriptor was written (new inserts + refreshed rows). */
  readonly written: number;
  /** Registry sources processed (14 for the blueprint catalog). */
  readonly total: number;
}

/**
 * Owner watchlist keys (R07): runtime watchlists are OWNER domain across
 * every connector family. The registry may ship EMPTY defaults for some
 * of them (github `repositories`, bluesky `accounts`) — those defaults
 * apply only on FIRST insert; a re-import never rewrites a watchlist.
 * AUTHORED constants only (never user content) — safe to inline as SQL
 * literals in the fragment below (character set: `$.a-z`).
 */
const OWNER_WATCHLIST_CONFIG_KEYS: readonly string[] = [
  '$.apps',
  '$.playlists',
  '$.repositories',
  '$.subreddits',
];

/** SQL fragment: strip owner watchlist keys from the registry patch side. */
const WATCHLIST_STRIP_SQL = `json_remove(excluded.config_json, ${OWNER_WATCHLIST_CONFIG_KEYS.map(
  (key) => `'${key}'`,
).join(', ')})`;

/**
 * Seed the validated registry catalog as ONE atomic batch. The registry
 * is ALREADY validated (ADR-0038 §2) — this store persists it faithfully
 * under the R07 field-ownership contract. Storage failures propagate as
 * AppError and roll back the whole batch (R08).
 */
export async function seedSourcesFromRegistry(
  executor: DbExecutor,
  registry: Registry,
  nowMs: number,
): Promise<SeedSummary> {
  const statements: DbStatement[] = [];
  /**
   * Explicit map: source index → batch index of that source's descriptor
   * (sources upsert) statement. The batch interleaves one descriptor
   * statement with one state statement per source; counting via positional
   * metadata would read the wrong half of the alternation (Round 1.3.1
   * defect: a full re-import reported written = 7 instead of 14).
   */
  const descriptorStatementIndex: number[] = [];

  for (const source of registry.sources) {
    descriptorStatementIndex.push(statements.length);
    const configJson = canonicalizeConfig(source);
    const attribution = source.attribution ?? null;

    // Per-source upsert under the field-ownership contract. The merge
    // expression reads `sources.config_json` (the CURRENT persisted row)
    // inside the UPDATE itself: there is no application-layer read, so a
    // concurrent owner change between "read" and "write" is impossible
    // by construction (R07).
    statements.push({
      sql: `INSERT INTO sources
              (id, name, connector, lane, trust_tier, enabled, interval_seconds,
               priority, daily_request_budget, approval_policy, attribution_template,
               config_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET
              name = excluded.name,
              connector = excluded.connector,
              lane = excluded.lane,
              trust_tier = excluded.trust_tier,
              approval_policy = excluded.approval_policy,
              attribution_template = excluded.attribution_template,
              config_json = CASE
                WHEN json_type(sources.config_json) = 'object'
                THEN json_patch(sources.config_json, ${WATCHLIST_STRIP_SQL})
                ELSE NULL
              END,
              updated_at = excluded.updated_at`,
      params: [
        source.id,
        source.name,
        source.connector,
        source.lane,
        source.trustTier,
        source.intervalSeconds,
        laneDefaultPriority(source.lane),
        source.dailyRequestBudget,
        source.approvalPolicy,
        attribution,
        configJson,
        nowMs,
        nowMs,
      ],
    });

    // Existing source_state rows are NEVER touched (R07: state preserved
    // entirely); missing state rows are created at next_poll_at = 0.
    statements.push({
      sql: `INSERT INTO source_state (source_id, next_poll_at, consecutive_failures,
                                      requests_today, updated_at)
            VALUES (?, 0, 0, 0, ?)
            ON CONFLICT (source_id) DO NOTHING`,
      params: [source.id, nowMs],
    });
  }

  const metas = await executor.batch(statements);
  let written = 0;
  for (const descriptorIndex of descriptorStatementIndex) {
    const descriptorMeta = metas[descriptorIndex]; // explicit map, not position
    if ((descriptorMeta?.changes ?? 0) > 0) {
      written += 1;
    }
  }
  return { written, total: registry.sources.length };
}

/**
 * Deterministic per-source runtime config JSON: the registry's
 * connector config merged with its ENDPOINT facts (rss `endpoint` /
 * `endpointTemplates`, steam `endpoint`, youtube `endpoint` +
 * `detailsEndpoint`) so connectors read one config surface. Connector
 * runtime additions (app watchlists, playlist ids, repositories) are
 * OWNER operations on the same config_json column — documented in
 * docs/PHASE4_SOURCE_FIELD_OWNERSHIP.md and preserved by the merge.
 */
function canonicalizeConfig(source: RegistrySource): string {
  const merged: Record<string, unknown> = { ...(source.config ?? {}) };
  if (source.endpoint !== undefined) {
    merged['endpoint'] = source.endpoint;
  }
  if (source.detailsEndpoint !== undefined) {
    merged['detailsEndpoint'] = source.detailsEndpoint;
  }
  if (source.endpointTemplates !== undefined) {
    merged['endpointTemplates'] = source.endpointTemplates;
  }
  return JSON.stringify(merged);
}
