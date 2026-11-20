/**
 * Dead-source removal (slice 5; PROVIDER_RESEARCH §1.8).
 *
 * Two blueprint-era sources are DEAD and must never be polled again:
 *   - r/CrackStatus — dead since September 2016 (the subreddit is gone);
 *   - Nintendo US RSS (`https://www.nintendo.com/feed`) — 0 posts in 30 days.
 *
 * The frozen blueprint (`docs/blueprint/v1/`) is NEVER edited, so the
 * removal lives HERE, in code: the effective registry the scheduler seeds
 * and polls is the embedded registry MINUS these entries. The guard is
 * written defensively — even if a future registry revision re-introduced
 * either source, the scheduler would still drop it before any seed, poll,
 * job, or network effect.
 *
 * Pure domain module: no I/O, no network, no storage.
 */
import type { Registry, RegistrySource } from './source-registry';

/** Dead subreddits (matched case-insensitively, exact name only). */
export const DEAD_REDDIT_SUBREDDITS: readonly string[] = ['CrackStatus'];

/** Dead RSS endpoints (matched on exact https host + path, case-insensitive). */
export const DEAD_RSS_ENDPOINTS: readonly string[] = ['https://www.nintendo.com/feed'];

export function isDeadSubreddit(name: unknown): boolean {
  if (typeof name !== 'string') {
    return false;
  }
  const lowered = name.toLowerCase();
  return DEAD_REDDIT_SUBREDDITS.some((dead) => dead.toLowerCase() === lowered);
}

export function isDeadEndpoint(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string') {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') {
    return false;
  }
  const pathname = parsed.pathname.replace(/\/$/, '') || '/';
  const normalized = `https://${parsed.hostname.toLowerCase()}${pathname}`;
  return DEAD_RSS_ENDPOINTS.some((dead) => dead.toLowerCase() === normalized);
}

/**
 * Strip dead subreddits from a reddit watchlist. Returns the kept names
 * and the removed ones (for the audit trail — never silently dropped).
 */
export function stripDeadSubreddits(subreddits: readonly unknown[]): {
  readonly kept: readonly string[];
  readonly removed: readonly string[];
} {
  const kept: string[] = [];
  const removed: string[] = [];
  for (const entry of subreddits) {
    if (typeof entry !== 'string') {
      continue;
    }
    if (isDeadSubreddit(entry)) {
      removed.push(entry);
    } else {
      kept.push(entry);
    }
  }
  return { kept, removed };
}

export interface DeadSourceFilterResult {
  /** The sources the scheduler may seed and poll (dead ones removed). */
  readonly kept: readonly RegistrySource[];
  /** Ids dropped entirely (a source whose every target was dead). */
  readonly removedSourceIds: readonly string[];
  /** Dead subreddits stripped from otherwise-kept reddit sources. */
  readonly strippedSubreddits: readonly { readonly sourceId: string; readonly subreddit: string }[];
}

/**
 * Apply the dead-source removal to a validated registry. A source is
 * dropped when its endpoint (or every endpoint template) is a dead RSS
 * endpoint; a reddit source loses its dead subreddits and is dropped
 * only when none remain. Every other source passes through UNCHANGED
 * (same object identity for kept rows is not guaranteed — the registry
 * shape is rebuilt, the field values are preserved).
 */
export function filterDeadSources(registry: Registry): DeadSourceFilterResult {
  const kept: RegistrySource[] = [];
  const removedSourceIds: string[] = [];
  const strippedSubreddits: { readonly sourceId: string; readonly subreddit: string }[] = [];

  for (const source of registry.sources) {
    // Dead RSS endpoint (single endpoint or every template dead).
    if (source.connector === 'rss') {
      const endpoints: readonly (string | undefined)[] =
        source.endpoint !== undefined ? [source.endpoint] : (source.endpointTemplates ?? []);
      if (endpoints.length > 0 && endpoints.every((endpoint) => isDeadEndpoint(endpoint))) {
        removedSourceIds.push(source.id);
        continue;
      }
    }
    // Dead subreddits inside a reddit source.
    if (source.connector === 'reddit-oauth') {
      const rawSubreddits = source.config;
      const subreddits =
        rawSubreddits !== undefined &&
        typeof rawSubreddits === 'object' &&
        rawSubreddits !== null &&
        Array.isArray((rawSubreddits as Record<string, unknown>)['subreddits'])
          ? ((rawSubreddits as Record<string, unknown>)['subreddits'] as readonly unknown[])
          : [];
      const { kept: keptSubs, removed } = stripDeadSubreddits(subreddits);
      for (const subreddit of removed) {
        strippedSubreddits.push({ sourceId: source.id, subreddit });
      }
      if (subreddits.length > 0 && keptSubs.length === 0) {
        removedSourceIds.push(source.id);
        continue;
      }
      if (removed.length > 0) {
        kept.push({
          ...source,
          config: { ...(source.config ?? {}), subreddits: keptSubs },
        });
        continue;
      }
    }
    kept.push(source);
  }

  return { kept, removedSourceIds, strippedSubreddits };
}

/** The effective registry: the embedded catalog minus the dead sources. */
export function effectiveRegistry(registry: Registry): Registry {
  const filtered = filterDeadSources(registry);
  return { ...registry, sources: [...filtered.kept] };
}
