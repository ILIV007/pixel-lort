import { describe, expect, it } from 'vitest';
import {
  classifyNearDupScore,
  jaccardSimilarity,
  nearDupTitleTokens,
  scoreNearDup,
  NEGATIVE_CACHE_TTL_MS,
  NEAR_DUP_CANDIDATE_LIMIT,
  NEAR_DUP_WINDOW_MS,
} from '../../src/domain/editorial/near-dup';

/**
 * Slice 6 — the deterministic near-dup similarity (DESIGN §10.1, policy
 * `nd1`). Pure, offline, no D1: identical titles merge, a reworded
 * same-story title merges through shared entities, different stories stay
 * distinct, the middle band holds for adjudication, Persian/Arabic
 * letters and digits fold, and an empty title never matches.
 */

describe('near-dup similarity (policy nd1)', () => {
  it('identical titles merge', () => {
    const score = scoreNearDup({
      incomingTitle: 'GTA VI trailer drops tomorrow',
      incomingEntityIds: ['game:gta-vi'],
      candidateTitle: 'GTA VI trailer drops tomorrow',
      candidateEntityIds: ['game:gta-vi'],
    });
    expect(score.title).toBe(1);
    expect(score.entity).toBe(1);
    expect(score.combined).toBe(1);
    expect(classifyNearDupScore(score)).toBe('merged_as_update');
  });

  it('a reworded same-story title merges through shared entities', () => {
    const score = scoreNearDup({
      incomingTitle: 'GTA VI trailer drops tomorrow, Rockstar confirms',
      incomingEntityIds: ['game:gta-vi', 'publisher:rockstar'],
      candidateTitle: 'GTA VI trailer drops tomorrow, Rockstar says',
      candidateEntityIds: ['game:gta-vi', 'publisher:rockstar'],
    });
    // Title 6/8 = 0.75, entities 1 → combined 0.825 ≥ MERGE 0.80.
    expect(score.title).toBeGreaterThan(0.5);
    expect(score.entity).toBe(1);
    expect(classifyNearDupScore(score)).toBe('merged_as_update');
  });

  it('different stories stay distinct', () => {
    const score = scoreNearDup({
      incomingTitle: 'Elden Ring DLC announced for next month',
      incomingEntityIds: ['game:elden-ring'],
      candidateTitle: 'GTA VI trailer drops tomorrow',
      candidateEntityIds: ['game:gta-vi'],
    });
    expect(classifyNearDupScore(score)).toBe('distinct');
  });

  it('the middle band holds for adjudication (never posted, never merged)', () => {
    // Similar title, NO shared entities: combined = title alone, inside
    // the 0.60–0.80 review band (5 shared of 7 union = 0.714).
    const score = scoreNearDup({
      incomingTitle: 'GTA VI trailer drops tomorrow morning soon',
      incomingEntityIds: [],
      candidateTitle: 'GTA VI trailer drops tomorrow',
      candidateEntityIds: ['game:gta-vi'],
    });
    expect(score.combined).toBeGreaterThanOrEqual(0.6);
    expect(score.combined).toBeLessThan(0.8);
    expect(classifyNearDupScore(score)).toBe('needs_review');
  });

  it('a high combined score below the title floor holds instead of merging', () => {
    expect(classifyNearDupScore({ combined: 0.95, title: 0.5, entity: 1 })).toBe('needs_review');
  });

  it('Persian/Arabic letters and digits fold to the same tokens', () => {
    const persian = nearDupTitleTokens('بازی جدید ۲');
    const arabic = nearDupTitleTokens('بازی جديد 2');
    expect(persian).toEqual(arabic);
    expect(persian.has('بازی')).toBe(true);
    expect(persian.has('2')).toBe(true);
    expect(persian.has('جدید')).toBe(true);
  });

  it('a differing number lowers the score (2 vs 3 is not the same story)', () => {
    const same = scoreNearDup({
      incomingTitle: 'Season 2 launches Friday',
      incomingEntityIds: ['game:x'],
      candidateTitle: 'Season 2 launches Friday',
      candidateEntityIds: ['game:x'],
    });
    const different = scoreNearDup({
      incomingTitle: 'Season 3 launches Friday',
      incomingEntityIds: ['game:x'],
      candidateTitle: 'Season 2 launches Friday',
      candidateEntityIds: ['game:x'],
    });
    expect(different.title).toBeLessThan(same.title);
    expect(different.combined).toBeLessThan(same.combined);
  });

  it('an empty title never matches', () => {
    const score = scoreNearDup({
      incomingTitle: '',
      incomingEntityIds: ['game:gta-vi'],
      candidateTitle: 'GTA VI trailer drops tomorrow',
      candidateEntityIds: ['game:gta-vi'],
    });
    expect(score.title).toBe(0);
    expect(classifyNearDupScore(score)).toBe('distinct');
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it('pins the policy constants (30-day window, 30-day negative cache)', () => {
    expect(NEAR_DUP_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(NEGATIVE_CACHE_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(NEAR_DUP_CANDIDATE_LIMIT).toBe(20);
  });
});
