import { describe, expect, it } from 'vitest';
import {
  DEAD_REDDIT_SUBREDDITS,
  DEAD_RSS_ENDPOINTS,
  effectiveRegistry,
  filterDeadSources,
  isDeadEndpoint,
  isDeadSubreddit,
  stripDeadSubreddits,
} from '../../src/domain/source/dead-sources';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';

/**
 * Slice 5 — dead-source removal (PROVIDER_RESEARCH §1.8): r/CrackStatus
 * (dead since September 2016) and the Nintendo US RSS (0 posts in 30
 * days) must never be polled again. The frozen blueprint is never edited,
 * so the removal lives in code: the effective registry drops them before
 * any seed, probe, or poll.
 */

describe('dead sources — the denylist itself', () => {
  it('names exactly the two dead sources', () => {
    expect(DEAD_REDDIT_SUBREDDITS).toEqual(['CrackStatus']);
    expect(DEAD_RSS_ENDPOINTS).toEqual(['https://www.nintendo.com/feed']);
  });

  it('matches CrackStatus case-insensitively, but not CrackWatch', () => {
    expect(isDeadSubreddit('CrackStatus')).toBe(true);
    expect(isDeadSubreddit('crackstatus')).toBe(true);
    expect(isDeadSubreddit('CRACKSTATUS')).toBe(true);
    expect(isDeadSubreddit('CrackWatch')).toBe(false);
    expect(isDeadSubreddit('GamingLeaksAndRumours')).toBe(false);
    expect(isDeadSubreddit(42)).toBe(false);
  });

  it('matches the Nintendo feed on exact host + path (query and trailing slash do not save it)', () => {
    expect(isDeadEndpoint('https://www.nintendo.com/feed')).toBe(true);
    expect(isDeadEndpoint('https://www.nintendo.com/feed/')).toBe(true);
    expect(isDeadEndpoint('https://www.nintendo.com/feed?x=1')).toBe(true);
    expect(isDeadEndpoint('https://www.nintendo.com/news/feed')).toBe(false);
    expect(isDeadEndpoint('https://www.eurogamer.net/feed/news')).toBe(false);
    expect(isDeadEndpoint('http://www.nintendo.com/feed')).toBe(false);
    expect(isDeadEndpoint('not a url')).toBe(false);
  });

  it('strips dead subreddits and reports them (never silently)', () => {
    const stripped = stripDeadSubreddits(['CrackWatch', 'CrackStatus', 'crackstatus']);
    expect(stripped.kept).toEqual(['CrackWatch']);
    expect(stripped.removed).toEqual(['CrackStatus', 'crackstatus']);
  });
});

describe('dead sources — the embedded registry is already clean', () => {
  it('contains neither dead source', () => {
    const parsed = parseEmbeddedRegistry();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    for (const source of parsed.registry.sources) {
      expect(isDeadEndpoint(source.endpoint)).toBe(false);
      for (const template of source.endpointTemplates ?? []) {
        expect(isDeadEndpoint(template)).toBe(false);
      }
      const subreddits =
        source.connector === 'reddit-oauth' &&
        source.config !== undefined &&
        typeof source.config === 'object' &&
        source.config !== null &&
        Array.isArray((source.config as Record<string, unknown>)['subreddits'])
          ? ((source.config as Record<string, unknown>)['subreddits'] as readonly unknown[])
          : [];
      for (const subreddit of subreddits) {
        expect(isDeadSubreddit(subreddit)).toBe(false);
      }
    }
    // The effective registry is the full 14-source catalog (nothing dropped).
    const effective = effectiveRegistry(parsed.registry);
    expect(effective.sources).toHaveLength(14);
    expect(filterDeadSources(parsed.registry).removedSourceIds).toEqual([]);
  });
});

describe('dead sources — a future registry re-introducing them is still filtered', () => {
  it('drops a dead RSS source and strips a dead subreddit from a live source', () => {
    const parsed = parseEmbeddedRegistry();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const poisoned = {
      ...parsed.registry,
      sources: [
        ...parsed.registry.sources,
        {
          id: 'nintendo_us',
          name: 'Nintendo US',
          connector: 'rss' as const,
          lane: 'official' as const,
          endpoint: 'https://www.nintendo.com/feed',
          trustTier: 90,
          intervalSeconds: 3600,
          dailyRequestBudget: 24,
          approvalPolicy: 'auto' as const,
          autoPublishThreshold: 80,
          content: ['news'],
        },
        {
          id: 'reddit_crack_mixed',
          name: 'Reddit crack radar (mixed)',
          connector: 'reddit-oauth' as const,
          lane: 'radar' as const,
          trustTier: 30,
          intervalSeconds: 1800,
          dailyRequestBudget: 48,
          approvalPolicy: 'signal_only' as const,
          autoPublishThreshold: null,
          content: ['crack_status'],
          config: { subreddits: ['CrackWatch', 'CrackStatus'], limit: 25 },
        },
      ],
    };
    const filtered = filterDeadSources(poisoned);
    expect(filtered.removedSourceIds).toEqual(['nintendo_us']);
    expect(filtered.strippedSubreddits).toEqual([
      { sourceId: 'reddit_crack_mixed', subreddit: 'CrackStatus' },
    ]);
    const keptReddit = filtered.kept.find((source) => source.id === 'reddit_crack_mixed');
    expect(keptReddit?.config).toEqual({ subreddits: ['CrackWatch'], limit: 25 });
    expect(filtered.kept).toHaveLength(15);
  });

  it('drops a reddit source whose every subreddit is dead', () => {
    const parsed = parseEmbeddedRegistry();
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const poisoned = {
      ...parsed.registry,
      sources: [
        ...parsed.registry.sources,
        {
          id: 'reddit_crackstatus_only',
          name: 'r/CrackStatus',
          connector: 'reddit-oauth' as const,
          lane: 'radar' as const,
          trustTier: 10,
          intervalSeconds: 1800,
          dailyRequestBudget: 48,
          approvalPolicy: 'signal_only' as const,
          autoPublishThreshold: null,
          content: ['crack_status'],
          config: { subreddits: ['CrackStatus'], limit: 25 },
        },
      ],
    };
    const filtered = filterDeadSources(poisoned);
    expect(filtered.removedSourceIds).toEqual(['reddit_crackstatus_only']);
    expect(filtered.kept).toHaveLength(14);
  });
});
