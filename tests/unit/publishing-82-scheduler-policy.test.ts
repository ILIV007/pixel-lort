import { describe, expect, it } from 'vitest';
import { planPublicationTime } from '../../src/domain/publishing/publication-schedule';
import { MIX_CATEGORIES, isMixCategoryValue } from '../../src/domain/publishing/anti-robot';
import {
  mapContentTypeToMixCategory,
  deriveDeterministicJitterMs,
  scanJitterForCandidate,
} from '../../src/application/publishing/scheduler-policy';

/**
 * Phase 8.2 — the scheduler's PURE policy pieces.
 *
 * 1. `mapContentTypeToMixCategory` — the TOTAL, explicit map from the CLOSED
 *    24-label `stories.content_type` vocabulary (migration 0001) onto the
 *    CLOSED ten-label mix vocabulary (arp1). Every label maps; every unknown
 *    label fails typed — a future vocabulary growth can never be silently
 *    miscategorized into a wrong mix cell.
 *
 * 2. `deriveDeterministicJitterMs` / `scanJitterForCandidate` — the
 *    per-candidate deterministic humanizing jitter. The DOMAIN has no
 *    randomness (the 8.1 rule); the jitter is a caller-supplied validated
 *    input. The scheduler derives it from a hash of the candidate id inside
 *    the candidate's class band — reproducible, bounded, and CROSS-VALIDATED
 *    below: for EVERY class and context combination the derived jitter is
 *    accepted by the real psp1 `planPublicationTime` (never
 *    jitter_out_of_bounds).
 */

describe('publishing-82 scheduler policy: the content-type map is TOTAL', () => {
  it('maps all 24 closed content_type labels onto the ten mix labels', () => {
    const allContentTypes = [
      'official_news',
      'breaking',
      'industry',
      'release',
      'trailer',
      'gameplay',
      'patch',
      'dlc',
      'leak',
      'rumor',
      'crack_status',
      'drm_update',
      'mod',
      'emulator',
      'homebrew',
      'jailbreak',
      'indie',
      'free_game',
      'discount',
      'mobile',
      'hardware',
      'esports',
      'analysis',
      'community',
    ];
    expect(allContentTypes).toHaveLength(24);
    for (const contentType of allContentTypes) {
      const mapped = mapContentTypeToMixCategory(contentType);
      expect(mapped.ok).toBe(true);
      if (mapped.ok) {
        expect(isMixCategoryValue(mapped.category)).toBe(true);
      }
    }
  });

  it('pins the explicit correspondences (the mix label names the grouped content types)', () => {
    expect(mapContentTypeToMixCategory('crack_status')).toMatchObject({ category: 'crack_drm' });
    expect(mapContentTypeToMixCategory('drm_update')).toMatchObject({ category: 'crack_drm' });
    expect(mapContentTypeToMixCategory('leak')).toMatchObject({ category: 'leak_rumor' });
    expect(mapContentTypeToMixCategory('rumor')).toMatchObject({ category: 'leak_rumor' });
    expect(mapContentTypeToMixCategory('mod')).toMatchObject({ category: 'mods' });
    expect(mapContentTypeToMixCategory('emulator')).toMatchObject({
      category: 'emulator_homebrew_jailbreak',
    });
    expect(mapContentTypeToMixCategory('homebrew')).toMatchObject({
      category: 'emulator_homebrew_jailbreak',
    });
    expect(mapContentTypeToMixCategory('jailbreak')).toMatchObject({
      category: 'emulator_homebrew_jailbreak',
    });
    expect(mapContentTypeToMixCategory('official_news')).toMatchObject({
      category: 'mainstream_industry',
    });
    expect(mapContentTypeToMixCategory('breaking')).toMatchObject({
      category: 'mainstream_industry',
    });
    expect(mapContentTypeToMixCategory('industry')).toMatchObject({
      category: 'mainstream_industry',
    });
    expect(mapContentTypeToMixCategory('analysis')).toMatchObject({
      category: 'mainstream_industry',
    });
    expect(mapContentTypeToMixCategory('community')).toMatchObject({
      category: 'mainstream_industry',
    });
    expect(mapContentTypeToMixCategory('release')).toMatchObject({
      category: 'release_trailer_patch_dlc',
    });
    expect(mapContentTypeToMixCategory('trailer')).toMatchObject({
      category: 'release_trailer_patch_dlc',
    });
    expect(mapContentTypeToMixCategory('patch')).toMatchObject({
      category: 'release_trailer_patch_dlc',
    });
    expect(mapContentTypeToMixCategory('dlc')).toMatchObject({
      category: 'release_trailer_patch_dlc',
    });
    expect(mapContentTypeToMixCategory('gameplay')).toMatchObject({
      category: 'release_trailer_patch_dlc',
    });
    expect(mapContentTypeToMixCategory('mobile')).toMatchObject({ category: 'mobile' });
    expect(mapContentTypeToMixCategory('hardware')).toMatchObject({ category: 'hardware' });
    expect(mapContentTypeToMixCategory('free_game')).toMatchObject({
      category: 'free_discount_indie',
    });
    expect(mapContentTypeToMixCategory('discount')).toMatchObject({
      category: 'free_discount_indie',
    });
    expect(mapContentTypeToMixCategory('indie')).toMatchObject({ category: 'free_discount_indie' });
    expect(mapContentTypeToMixCategory('esports')).toMatchObject({ category: 'esports' });
  });

  it('every mix label is reachable from at least one content type (no dead mix cell)', () => {
    const allContentTypes = [
      'official_news',
      'breaking',
      'industry',
      'release',
      'trailer',
      'gameplay',
      'patch',
      'dlc',
      'leak',
      'rumor',
      'crack_status',
      'drm_update',
      'mod',
      'emulator',
      'homebrew',
      'jailbreak',
      'indie',
      'free_game',
      'discount',
      'mobile',
      'hardware',
      'esports',
      'analysis',
      'community',
    ];
    const reached = new Set<string>();
    for (const contentType of allContentTypes) {
      const mapped = mapContentTypeToMixCategory(contentType);
      if (mapped.ok) reached.add(mapped.category);
    }
    for (const category of MIX_CATEGORIES) {
      expect(reached.has(category)).toBe(true);
    }
  });

  it('an unknown content type fails typed (future vocabulary growth is loud)', () => {
    expect(mapContentTypeToMixCategory('something_new')).toEqual({
      ok: false,
      reason: 'unknown_content_type',
    });
    expect(mapContentTypeToMixCategory('')).toEqual({ ok: false, reason: 'unknown_content_type' });
    expect(mapContentTypeToMixCategory('OFFICIAL_NEWS')).toEqual({
      ok: false,
      reason: 'unknown_content_type',
    });
  });
});

describe('publishing-82 scheduler policy: the deterministic per-candidate jitter', () => {
  it('is deterministic for the same candidate identity and context', () => {
    const input = {
      candidateId: 'pub-1',
      priorityClass: 'P2' as const,
      hasPreviousSend: true,
      related: false,
    };
    expect(deriveDeterministicJitterMs(input)).toBe(deriveDeterministicJitterMs(input));
  });

  it('spreads positions across candidates (the humanizing intent — not one constant gap)', () => {
    const positions = new Set<number>();
    for (let index = 0; index < 40; index += 1) {
      positions.add(
        deriveDeterministicJitterMs({
          candidateId: `pub-${index}`,
          priorityClass: 'P2',
          hasPreviousSend: true,
          related: false,
        }),
      );
    }
    expect(positions.size).toBeGreaterThan(10);
  });

  it('stays inside the class band: P1 latency 5–20 min', () => {
    for (let index = 0; index < 50; index += 1) {
      const jitter = deriveDeterministicJitterMs({
        candidateId: `p1-${index}`,
        priorityClass: 'P1',
        hasPreviousSend: false,
        related: false,
      });
      expect(jitter).toBeGreaterThanOrEqual(5 * 60_000);
      expect(jitter).toBeLessThanOrEqual(20 * 60_000);
      expect(Number.isInteger(jitter)).toBe(true);
    }
  });

  it('stays inside the band: P2/P3 and related-P0 normal gap 25–45 min', () => {
    for (const priorityClass of ['P2', 'P3'] as const) {
      for (let index = 0; index < 50; index += 1) {
        const jitter = deriveDeterministicJitterMs({
          candidateId: `${priorityClass}-${index}`,
          priorityClass,
          hasPreviousSend: true,
          related: false,
        });
        expect(jitter).toBeGreaterThanOrEqual(25 * 60_000);
        expect(jitter).toBeLessThanOrEqual(45 * 60_000);
      }
    }
    for (let index = 0; index < 50; index += 1) {
      const jitter = deriveDeterministicJitterMs({
        candidateId: `p0-related-${index}`,
        priorityClass: 'P0',
        hasPreviousSend: true,
        related: true,
      });
      expect(jitter).toBeGreaterThanOrEqual(25 * 60_000);
      expect(jitter).toBeLessThanOrEqual(45 * 60_000);
    }
  });

  it('stays inside the band: the unrelated-P0 anti-flood bypass 2–4 min', () => {
    for (let index = 0; index < 50; index += 1) {
      const jitter = deriveDeterministicJitterMs({
        candidateId: `p0-unrelated-${index}`,
        priorityClass: 'P0',
        hasPreviousSend: true,
        related: false,
      });
      expect(jitter).toBeGreaterThanOrEqual(2 * 60_000);
      expect(jitter).toBeLessThanOrEqual(4 * 60_000);
    }
  });

  it('a first send with no previous send carries jitter 0 (the gap rule yields zero anyway)', () => {
    expect(
      deriveDeterministicJitterMs({
        candidateId: 'pub-first',
        priorityClass: 'P2',
        hasPreviousSend: false,
        related: false,
      }),
    ).toBe(0);
    expect(
      deriveDeterministicJitterMs({
        candidateId: 'pub-first',
        priorityClass: 'P0',
        hasPreviousSend: false,
        related: false,
      }),
    ).toBe(0);
  });

  it('CROSS-VALIDATION: the derived jitter is accepted by the real psp1 for EVERY class/context', () => {
    const NOW = 3_000_000_000;
    const contexts = [
      { priorityClass: 'P0' as const, hasPreviousSend: false, related: false },
      { priorityClass: 'P0' as const, hasPreviousSend: true, related: false },
      { priorityClass: 'P0' as const, hasPreviousSend: true, related: true },
      { priorityClass: 'P1' as const, hasPreviousSend: false, related: false },
      { priorityClass: 'P1' as const, hasPreviousSend: true, related: false },
      { priorityClass: 'P2' as const, hasPreviousSend: false, related: false },
      { priorityClass: 'P2' as const, hasPreviousSend: true, related: false },
      { priorityClass: 'P3' as const, hasPreviousSend: true, related: true },
    ];
    for (const context of contexts) {
      for (let index = 0; index < 25; index += 1) {
        const candidateId = `${context.priorityClass}-${context.hasPreviousSend}-${context.related}-${index}`;
        const jitter = deriveDeterministicJitterMs({ candidateId, ...context });
        const decision = planPublicationTime({
          schemaVersion: 1,
          nowMs: NOW,
          category: 'mainstream_industry',
          candidateLayout: 'standard',
          priorityScore:
            context.priorityClass === 'P0'
              ? 95
              : context.priorityClass === 'P1'
                ? 80
                : context.priorityClass === 'P2'
                  ? 60
                  : 20,
          jitterMs: jitter,
          previousSend: context.hasPreviousSend
            ? { atMs: NOW - 3 * 60 * 60_000, related: context.related, priorityClass: 'P2' }
            : null,
          recentLayouts: [],
          recentCategories: [],
          sameGame: null,
          eventDriven: false,
        });
        expect(decision.ok).toBe(true);
        if (decision.ok) {
          expect(decision.outcome).toBe('schedule');
        }
      }
    }
  });
});

describe('publishing-82 scheduler policy: the scan-level jitter helper', () => {
  it('scanJitterForCandidate composes classifyPriority + the derivation from a raw score', () => {
    const outcome = scanJitterForCandidate({
      candidateId: 'pub-x',
      priorityScore: 62,
      hasPreviousSend: true,
      related: false,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.jitterMs).toBeGreaterThanOrEqual(25 * 60_000);
      expect(outcome.jitterMs).toBeLessThanOrEqual(45 * 60_000);
      expect(outcome.priorityClass).toBe('P2');
    }
  });

  it('an invalid score fails typed', () => {
    expect(
      scanJitterForCandidate({
        candidateId: 'pub-y',
        priorityScore: 101,
        hasPreviousSend: false,
        related: false,
      }),
    ).toEqual({ ok: false, reason: 'invalid_score' });
  });
});
