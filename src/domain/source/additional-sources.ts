/**
 * Slice-9 registry additions (Tier A editorial RSS the frozen blueprint
 * catalog never listed).
 *
 * The blueprint registry (`docs/blueprint/v1/pixel_source_registry_v1.json`)
 * is NEVER edited, so additions live HERE, in code — exactly like the
 * dead-source removal lives in `dead-sources.ts`: the EFFECTIVE registry
 * the scheduler seeds and polls is the embedded catalog minus the dead
 * sources PLUS these entries. The guard is written defensively: an id
 * collision with the embedded catalog, or a merged catalog that fails
 * the SAME zod validation the embedded catalog passes, invalidates the
 * WHOLE addition (fail safe — the scheduler treats it as
 * `registry_invalid` and schedules nothing).
 *
 * The three sources (all verified live 2026-11-20, RSS 2.0):
 *   - VGC (`vgc_news`) — https://www.videogameschronicle.com/feed/
 *   - Gematsu (`gematsu_news`) — https://www.gematsu.com/feed
 *   - GameSpot (`gamespot_news`) — https://www.gamespot.com/feeds/news/
 *
 * Trust/interval/budget/threshold mirror the existing editorial peer
 * (`eurogamer_news`: trustTier 86, 900 s, 150/day, threshold 88) — Tier A
 * editorial, below the official lane (96) and above community (66–76).
 * The T1/T2/T3 shadow items all ride these feeds: GTA VI official
 * day-one figures (GameSpot + Gematsu), Hounded (PS Blog, already in the
 * catalog), Zenless Zone Zero 3.4 (Gematsu).
 *
 * Pure domain module: no I/O, no network, no storage.
 */
import { RegistrySchema, type Registry, type RegistrySource } from './source-registry';

/** The code-level additions, in seeding order. */
export const ADDITIONAL_REGISTRY_SOURCES: readonly RegistrySource[] = [
  {
    id: 'vgc_news',
    name: 'Video Games Chronicle',
    connector: 'rss',
    lane: 'editorial',
    endpoint: 'https://www.videogameschronicle.com/feed/',
    trustTier: 86,
    intervalSeconds: 900,
    dailyRequestBudget: 150,
    approvalPolicy: 'threshold',
    autoPublishThreshold: 88,
    content: ['breaking', 'industry', 'release', 'leak', 'rumor'],
    attribution: 'VGC',
  },
  {
    id: 'gematsu_news',
    name: 'Gematsu',
    connector: 'rss',
    lane: 'editorial',
    endpoint: 'https://www.gematsu.com/feed',
    trustTier: 86,
    intervalSeconds: 900,
    dailyRequestBudget: 150,
    approvalPolicy: 'threshold',
    autoPublishThreshold: 88,
    content: ['breaking', 'industry', 'release'],
    attribution: 'Gematsu',
  },
  {
    id: 'gamespot_news',
    name: 'GameSpot',
    connector: 'rss',
    lane: 'editorial',
    endpoint: 'https://www.gamespot.com/feeds/news/',
    trustTier: 86,
    intervalSeconds: 900,
    dailyRequestBudget: 150,
    approvalPolicy: 'threshold',
    autoPublishThreshold: 88,
    content: ['breaking', 'industry', 'release', 'leak', 'rumor'],
    attribution: 'GameSpot',
  },
];

export type AdditionalSourcesResult =
  | {
      readonly ok: true;
      readonly registry: Registry;
      readonly addedIds: readonly string[];
    }
  | { readonly ok: false; readonly reason: 'additional_sources_invalid' };

/**
 * Merge the code-level additions into a validated registry. The merged
 * catalog is re-validated through the SAME schema as the embedded one —
 * an addition that breaks the catalog (bad id, bad endpoint, a catalog
 * over the 32-source cap, a collision with an embedded id) fails the
 * WHOLE merge, never a partial catalog.
 */
export function withAdditionalSources(registry: Registry): AdditionalSourcesResult {
  const existingIds = new Set(registry.sources.map((source) => source.id));
  if (ADDITIONAL_REGISTRY_SOURCES.some((source) => existingIds.has(source.id))) {
    return { ok: false, reason: 'additional_sources_invalid' };
  }
  const merged: Registry = {
    ...registry,
    sources: [...registry.sources, ...ADDITIONAL_REGISTRY_SOURCES],
  };
  const parsed = RegistrySchema.safeParse(merged);
  if (!parsed.success) {
    return { ok: false, reason: 'additional_sources_invalid' };
  }
  return {
    ok: true,
    registry: parsed.data,
    addedIds: ADDITIONAL_REGISTRY_SOURCES.map((source) => source.id),
  };
}
