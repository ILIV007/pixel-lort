import { describe, expect, it } from 'vitest';
import { parseEmbeddedRegistry, RegistrySchema } from '../../src/domain/source/source-registry';
import {
  ADDITIONAL_REGISTRY_SOURCES,
  withAdditionalSources,
} from '../../src/domain/source/additional-sources';

/**
 * Slice-9 registry additions (VGC / Gematsu / GameSpot): the code-level
 * Tier A editorial RSS the frozen blueprint catalog never listed. The
 * blueprint file itself is NEVER edited — the additions live in code
 * (the dead-source precedent), and the merged catalog re-validates
 * through the SAME schema as the embedded one.
 */

describe('slice 9 — additional registry sources', () => {
  it('adds exactly VGC, Gematsu and GameSpot as editorial RSS', () => {
    expect(ADDITIONAL_REGISTRY_SOURCES.map((source) => source.id)).toEqual([
      'vgc_news',
      'gematsu_news',
      'gamespot_news',
    ]);
    for (const source of ADDITIONAL_REGISTRY_SOURCES) {
      expect(source.connector).toBe('rss');
      expect(source.lane).toBe('editorial');
      expect(source.approvalPolicy).toBe('threshold');
      expect(source.trustTier).toBe(86);
      expect(source.intervalSeconds).toBe(900);
      expect(source.dailyRequestBudget).toBe(150);
      expect(source.autoPublishThreshold).toBe(88);
      expect(source.endpoint).toMatch(/^https:\/\//);
    }
  });

  it('uses the live-verified feed endpoints', () => {
    const byId = new Map(ADDITIONAL_REGISTRY_SOURCES.map((source) => [source.id, source.endpoint]));
    expect(byId.get('vgc_news')).toBe('https://www.videogameschronicle.com/feed/');
    expect(byId.get('gematsu_news')).toBe('https://www.gematsu.com/feed');
    expect(byId.get('gamespot_news')).toBe('https://www.gamespot.com/feeds/news/');
  });

  it('merges into the embedded catalog: 14 + 3 = 17, still schema-valid', () => {
    const embedded = parseEmbeddedRegistry();
    expect(embedded.ok).toBe(true);
    if (!embedded.ok) return;
    expect(embedded.registry.sources).toHaveLength(14);
    const merged = withAdditionalSources(embedded.registry);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.addedIds).toEqual(['vgc_news', 'gematsu_news', 'gamespot_news']);
    expect(merged.registry.sources).toHaveLength(17);
    const parsed = RegistrySchema.safeParse(merged.registry);
    expect(parsed.success).toBe(true);
  });

  it('never collides with an embedded id and never mutates the input', () => {
    const embedded = parseEmbeddedRegistry();
    expect(embedded.ok).toBe(true);
    if (!embedded.ok) return;
    const before = embedded.registry.sources.map((source) => source.id);
    const merged = withAdditionalSources(embedded.registry);
    expect(merged.ok).toBe(true);
    // The input registry is untouched (same ids, same order, same length).
    expect(embedded.registry.sources.map((source) => source.id)).toEqual(before);
    expect(embedded.registry.sources).toHaveLength(14);
  });

  it('fails safe on an id collision (a future catalog re-listing one)', () => {
    const embedded = parseEmbeddedRegistry();
    expect(embedded.ok).toBe(true);
    if (!embedded.ok) return;
    const colliding = {
      ...embedded.registry,
      sources: [
        ...embedded.registry.sources,
        {
          id: 'vgc_news',
          name: 'Video Games Chronicle (catalog)',
          connector: 'rss',
          lane: 'editorial',
          endpoint: 'https://www.videogameschronicle.com/feed/',
          trustTier: 86,
          intervalSeconds: 900,
          dailyRequestBudget: 150,
          approvalPolicy: 'threshold',
          autoPublishThreshold: 88,
          content: ['breaking'],
        },
      ],
    };
    const result = withAdditionalSources(RegistrySchema.parse(colliding));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('additional_sources_invalid');
    }
  });
});
