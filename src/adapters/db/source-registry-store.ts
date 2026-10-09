/**
 * Source registry seeding store (Phase 4 — ADR-0038 §2; typed D1 boundary
 * per ADR-0022).
 *
 * Idempotent seed of the validated registry catalog into `sources` +
 * `source_state`:
 * - NEW rows insert fully (enabled = 0 — nothing activates implicitly);
 * - EXISTING rows refresh ONLY registry-descriptor facts; `enabled` and
 *   `priority` are owner-managed and NEVER overwritten (a repeated import
 *   can never silently re-enable a disabled source);
 * - existing `source_state` rows are never touched (INSERT DO NOTHING).
 *
 * Safe fields to refresh (registry-descriptor facts): name, connector,
 * lane, trust_tier, interval_seconds, daily_request_budget,
 * approval_policy, attribution_template, config_json.
 */
import type { DbExecutor } from './db-executor';
import type { Registry, RegistrySource } from '../../domain/source/source-registry';
import { laneDefaultPriority } from '../../domain/source/source-registry';

export interface SeedSummary {
  /** Rows whose descriptor was written (new inserts + refreshed rows). */
  readonly written: number;
  /** Registry sources processed (14 for the blueprint catalog). */
  readonly total: number;
}

/**
 * Seed the validated registry catalog. The registry is ALREADY validated
 * (ADR-0038 §2) — this store persists it faithfully. Never throws for
 * domain conditions; storage failures propagate as AppError.
 */
export async function seedSourcesFromRegistry(
  executor: DbExecutor,
  registry: Registry,
  nowMs: number,
): Promise<SeedSummary> {
  let written = 0;

  for (const source of registry.sources) {
    const configJson = canonicalizeConfig(source);
    const attribution = source.attribution ?? null;
    const result = await executor.run({
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
              interval_seconds = excluded.interval_seconds,
              daily_request_budget = excluded.daily_request_budget,
              approval_policy = excluded.approval_policy,
              attribution_template = excluded.attribution_template,
              config_json = excluded.config_json,
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
    if (result.changes > 0) {
      written += 1;
    }
    // Ensure the state row exists (insert-only; existing rows untouched).
    await executor.run({
      sql: `INSERT INTO source_state (source_id, next_poll_at, consecutive_failures,
                                      requests_today, updated_at)
            VALUES (?, 0, 0, 0, ?)
            ON CONFLICT (source_id) DO NOTHING`,
      params: [source.id, nowMs],
    });
  }

  return { written, total: registry.sources.length };
}

/**
 * Deterministic per-source runtime config JSON: the registry's
 * connector config merged with its ENDPOINT facts (rss `endpoint` /
 * `endpointTemplates`, youtube `detailsEndpoint`) so connectors read one
 * config surface. Connector runtime additions (app watchlists, playlist
 * ids, repositories) are OWNER operations on the same config_json column —
 * documented in the runbook.
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
