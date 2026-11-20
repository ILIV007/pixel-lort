import { describe, expect, it } from 'vitest';
import {
  buildMostPlayedRoundup,
  computeGameScore,
  detectChartMovers,
  isFreeOfferExpired,
  isProposalExpired,
  nextPruneStatus,
  normalizeGameTitle,
  shouldAutoAddGame,
} from '../../src/domain/watchlist/watchlist-rules';

/**
 * Slice 5 — live-watchlist rules (live-watchlists-design §3–§4): only
 * CHANGES post (new entry / climber ≥ 20 / spike ≥ 50%); exits never post;
 * auto-add thresholds; staged auto-prune (never for manual/pinned).
 */

describe('watchlist rules — chart movers (only changes post)', () => {
  const prev = [
    { key: '730', rank: 1, playersNow: 1_200_000 },
    { key: '570', rank: 2, playersNow: 600_000 },
    { key: '440', rank: 50, playersNow: 80_000 },
    { key: '999', rank: 90, playersNow: 60_000 },
  ];

  it('detects a new entry, a climber, and a spike — and an exit separately', () => {
    const curr = [
      { key: '730', rank: 1, playersNow: 1_210_000 },
      { key: '570', rank: 2, playersNow: 610_000 },
      { key: '440', rank: 25, playersNow: 200_000 },
      { key: '123', rank: 40, playersNow: 90_000 },
    ];
    const { movers, exits } = detectChartMovers(prev, curr);
    // 440: rank 50 -> 25 (jump 25) AND players +150% — reported ONCE, as climber.
    expect(movers).toHaveLength(2);
    expect(movers.find((mover) => mover.key === '440')).toMatchObject({
      kind: 'climber',
      rankJump: 25,
    });
    expect(movers.find((mover) => mover.key === '123')).toMatchObject({
      kind: 'new_entry',
      prevRank: null,
    });
    // 999 left the chart: an exit, NEVER a mover/post.
    expect(exits).toEqual([{ key: '999', prevRank: 90 }]);
    expect(movers.some((mover) => mover.key === '999')).toBe(false);
  });

  it('detects a spike only with ≥ 50% growth AND ≥ 50,000 players', () => {
    const curr = [
      { key: '730', rank: 1, playersNow: 1_200_000 },
      { key: '570', rank: 2, playersNow: 600_000 },
      { key: '440', rank: 50, playersNow: 130_000 },
      { key: '999', rank: 90, playersNow: 60_000 },
    ];
    const { movers } = detectChartMovers(prev, curr);
    expect(movers).toHaveLength(1);
    expect(movers[0]).toMatchObject({ kind: 'spike', key: '440' });
    expect(movers[0]?.playerRatio).toBeCloseTo(1.625, 3);
  });

  it('ignores small moves: a 10-place climb and a 20% player bump are not movers', () => {
    const curr = [
      { key: '730', rank: 1, playersNow: 1_200_000 },
      { key: '570', rank: 2, playersNow: 600_000 },
      { key: '440', rank: 40, playersNow: 96_000 },
      { key: '999', rank: 90, playersNow: 60_000 },
    ];
    const { movers } = detectChartMovers(prev, curr);
    expect(movers).toEqual([]);
  });

  it('reports nothing when the snapshots are identical', () => {
    const { movers, exits } = detectChartMovers(prev, prev);
    expect(movers).toEqual([]);
    expect(exits).toEqual([]);
  });
});

describe('watchlist rules — score and auto-add', () => {
  it('scores rank 1 with many players near the top, and rank 100 near the bottom', () => {
    const top = computeGameScore({ rank: 1, playersNow: 1_200_000, signals7d: 5 });
    const bottom = computeGameScore({ rank: 100, playersNow: 1_000, signals7d: 0 });
    expect(top).toBeGreaterThan(85);
    expect(bottom).toBeLessThan(25);
    expect(computeGameScore({ rank: null, playersNow: null, signals7d: 0 })).toBe(0);
  });

  it('auto-adds on rank ≤ 50, a good new entry, or a ≥ 20 climber', () => {
    expect(
      shouldAutoAddGame({
        moverKind: 'new_entry',
        rank: 60,
        rankJump: null,
        playerRatio: null,
        playersNow: 40_000,
      }),
    ).toBe(false);
    expect(
      shouldAutoAddGame({
        moverKind: 'new_entry',
        rank: 20,
        rankJump: null,
        playerRatio: null,
        playersNow: 40_000,
      }),
    ).toBe(true);
    expect(
      shouldAutoAddGame({
        moverKind: 'climber',
        rank: 60,
        rankJump: 25,
        playerRatio: null,
        playersNow: 80_000,
      }),
    ).toBe(true);
    expect(
      shouldAutoAddGame({
        moverKind: 'spike',
        rank: 60,
        rankJump: null,
        playerRatio: 3.5,
        playersNow: 60_000,
      }),
    ).toBe(true);
    expect(
      shouldAutoAddGame({
        moverKind: 'spike',
        rank: 60,
        rankJump: null,
        playerRatio: 1.8,
        playersNow: 60_000,
      }),
    ).toBe(false);
  });
});

describe('watchlist rules — staged auto-prune', () => {
  it('prunes active -> cooling -> dormant -> expired on schedule', () => {
    expect(
      nextPruneStatus({
        status: 'active',
        source: 'live',
        pinned: false,
        daysSinceLastSeen: 14,
        daysSinceLastSignal: 14,
      }),
    ).toBe('cooling');
    expect(
      nextPruneStatus({
        status: 'active',
        source: 'live',
        pinned: false,
        daysSinceLastSeen: 14,
        daysSinceLastSignal: 5,
      }),
    ).toBeNull();
    expect(
      nextPruneStatus({
        status: 'cooling',
        source: 'live',
        pinned: false,
        daysSinceLastSeen: 50,
        daysSinceLastSignal: 44,
      }),
    ).toBe('dormant');
    expect(
      nextPruneStatus({
        status: 'dormant',
        source: 'live',
        pinned: false,
        daysSinceLastSeen: 100,
        daysSinceLastSignal: 90,
      }),
    ).toBe('expired');
    expect(
      nextPruneStatus({
        status: 'dormant',
        source: 'live',
        pinned: false,
        daysSinceLastSeen: 100,
        daysSinceLastSignal: 89,
      }),
    ).toBeNull();
  });

  it('never auto-prunes a manual or pinned entry', () => {
    expect(
      nextPruneStatus({
        status: 'active',
        source: 'manual',
        pinned: false,
        daysSinceLastSeen: 200,
        daysSinceLastSignal: 200,
      }),
    ).toBeNull();
    expect(
      nextPruneStatus({
        status: 'cooling',
        source: 'live',
        pinned: true,
        daysSinceLastSeen: 200,
        daysSinceLastSignal: 200,
      }),
    ).toBeNull();
    expect(
      nextPruneStatus({
        status: 'expired',
        source: 'live',
        pinned: false,
        daysSinceLastSeen: 200,
        daysSinceLastSignal: 200,
      }),
    ).toBeNull();
  });
});

describe('watchlist rules — offer/proposal expiry and title normalization', () => {
  it('expires a free offer 1 day after expires_at, never before', () => {
    const expiresAt = Date.UTC(2026, 10, 27, 16, 0, 0);
    expect(isFreeOfferExpired(Date.UTC(2026, 10, 27, 16, 0, 0), expiresAt)).toBe(false);
    expect(isFreeOfferExpired(Date.UTC(2026, 10, 28, 16, 0, 1), expiresAt)).toBe(true);
    expect(isFreeOfferExpired(Date.UTC(2027, 0, 1), null)).toBe(false);
  });

  it('expires a proposal after 30 days without a decision', () => {
    const created = Date.UTC(2026, 9, 20, 0, 0, 0);
    expect(isProposalExpired(created, Date.UTC(2026, 10, 19, 0, 0, 0))).toBe(false);
    expect(isProposalExpired(created, Date.UTC(2026, 10, 20, 0, 0, 1))).toBe(true);
  });

  it('normalizes titles so editions and years do not split one game', () => {
    expect(normalizeGameTitle('ELDEN RING: Shadow of the Erdtree')).toBe(
      'elden ring shadow of the erdtree',
    );
    expect(normalizeGameTitle('Hollow Knight — Deluxe Edition (2023)')).toBe('hollow knight');
    expect(normalizeGameTitle('  The Witcher 3: Wild Hunt — GOTY Edition ')).toBe(
      'the witcher 3 wild hunt',
    );
  });

  it('builds the most-played roundup: Top 5 + the biggest climber', () => {
    const currRows = [
      { key: '730', rank: 1, playersNow: 1_200_000 },
      { key: '570', rank: 2, playersNow: 600_000 },
      { key: '440', rank: 25, playersNow: 200_000 },
      { key: '123', rank: 40, playersNow: 90_000 },
      { key: '555', rank: 41, playersNow: 85_000 },
      { key: '777', rank: 42, playersNow: 80_000 },
    ];
    const { top5, biggestMover } = buildMostPlayedRoundup({
      currRows,
      movers: [
        {
          kind: 'climber',
          key: '440',
          rank: 25,
          prevRank: 50,
          playersNow: 200_000,
          prevPlayers: 80_000,
          rankJump: 25,
          playerRatio: null,
        },
        {
          kind: 'new_entry',
          key: '123',
          rank: 40,
          prevRank: null,
          playersNow: 90_000,
          prevPlayers: null,
          rankJump: null,
          playerRatio: null,
        },
      ],
    });
    expect(top5.map((row) => row.key)).toEqual(['730', '570', '440', '123', '555']);
    expect(biggestMover?.key).toBe('440');
  });
});
