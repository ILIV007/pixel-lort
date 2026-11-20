/**
 * Live-watchlist rules (slice 5; providers/live-watchlists-design.md §3–§4).
 *
 * A watchlist is a DERIVED VIEW of live data, not a static list. Two
 * layers, never mixed:
 *   - live core: the machine adds/removes entries by thresholds below;
 *   - manual exceptions: the owner pins/suppresses/adds specific
 *     games/publishers — a manual entry is NEVER auto-pruned.
 *
 * Pure domain module: no I/O, no network, no storage. Every threshold is
 * a named constant matching the design's proposed defaults (panel-tunable
 * later — never hardcode a different value silently).
 */

/** Watchlist entry kinds (design §5.1). */
export const WATCHLIST_KINDS = [
  'game',
  'free_game',
  'publisher',
  'youtube_channel',
  'github_repo',
  'bsky_account',
  'nexus_domain',
  'moddb_slug',
  'workshop_appid',
  'esports_title',
  'esports_team',
  'crack_game',
  'nexus_mod',
  'modrinth_project',
  'workshop_mod',
] as const;

export type WatchlistKind = (typeof WATCHLIST_KINDS)[number];

export const WATCHLIST_STATUSES = [
  'active',
  'cooling',
  'dormant',
  'expired',
  'proposed',
  'rejected',
  'suppressed',
] as const;

export type WatchlistStatus = (typeof WATCHLIST_STATUSES)[number];

export function isWatchlistKind(value: string): value is WatchlistKind {
  return (WATCHLIST_KINDS as readonly string[]).includes(value);
}

export function isWatchlistStatus(value: string): value is WatchlistStatus {
  return (WATCHLIST_STATUSES as readonly string[]).includes(value);
}

/** Design §4 thresholds (proposed defaults, panel-tunable later). */
export const WATCHLIST_THRESHOLDS = {
  /** Auto-add: rank at or better than this in the weekly snapshot. */
  autoAddRank: 50,
  /** Auto-add: a new entry at or better than this rank. */
  autoAddNewEntryRank: 25,
  /** Climber: rank improvement of at least this many places in a week. */
  climberRankJump: 20,
  /** Spike: player growth of at least this ratio week over week. */
  spikePlayerRatio: 1.5,
  /** Spike: and at least this many current players. */
  spikeMinPlayers: 50_000,
  /** Daily spike check: 3x the 7-day median and at least this many players. */
  dailySpikeRatio: 3,
  dailySpikeMinPlayers: 50_000,
  /** Safety cap: at most this many fresh live entries per week. */
  maxNewLiveEntriesPerWeek: 10,
  /** Cooling: rank out of Top 100 for this many consecutive snapshots. */
  coolingMissedSnapshots: 2,
  /** Cooling: and no signal in the last this many days. */
  coolingSignalQuietDays: 14,
  /** Dormant: this many further quiet days after cooling. */
  dormantQuietDays: 30,
  /** Expired: this many days since the last signal. */
  expiredQuietDays: 90,
  /** Free offers expire 1 day after `expires_at`. */
  freeOfferExpiryGraceMs: 24 * 60 * 60 * 1000,
  /** Proposals live 30 days without an owner decision. */
  proposalLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  /** Mod candidates live 14 days after first_seen. */
  modCandidateLifetimeMs: 14 * 24 * 60 * 60 * 1000,
} as const;

export interface ChartRowInput {
  readonly key: string;
  readonly rank: number;
  readonly playersNow: number | null;
}

export type ChartMoverKind = 'new_entry' | 'climber' | 'spike';

export interface ChartMover {
  readonly kind: ChartMoverKind;
  readonly key: string;
  readonly rank: number;
  readonly prevRank: number | null;
  readonly playersNow: number | null;
  readonly prevPlayers: number | null;
  /** Rank improvement in places (climbers only). */
  readonly rankJump: number | null;
  /** Player growth ratio (spikes only). */
  readonly playerRatio: number | null;
}

export interface ChartDiff {
  /** Post candidates: only CHANGES post, never a bare count. */
  readonly movers: readonly ChartMover[];
  /** Games that left the Top 100: NEVER a post, only pruning input. */
  readonly exits: readonly { readonly key: string; readonly prevRank: number }[];
}

/**
 * Diff one weekly snapshot against the previous one (design §3.2).
 *   - new entry: in this week, not in the previous Top 100;
 *   - climber: rank improved by ≥ 20 places, new rank ≤ 100;
 *   - spike: players grew ≥ 50% AND current players ≥ 50,000.
 * A game can be both a climber and a spike — it is reported once, as a
 * climber when the rank jump qualifies (rank is the stronger signal).
 * Exits are reported separately and never become movers.
 */
export function detectChartMovers(
  prevRows: readonly ChartRowInput[],
  currRows: readonly ChartRowInput[],
): ChartDiff {
  const prevByKey = new Map(prevRows.map((row) => [row.key, row]));
  const movers: ChartMover[] = [];
  const exits: { readonly key: string; readonly prevRank: number }[] = [];
  const currKeys = new Set(currRows.map((row) => row.key));

  for (const row of currRows) {
    const prev = prevByKey.get(row.key);
    if (prev === undefined) {
      movers.push({
        kind: 'new_entry',
        key: row.key,
        rank: row.rank,
        prevRank: null,
        playersNow: row.playersNow,
        prevPlayers: null,
        rankJump: null,
        playerRatio: null,
      });
      continue;
    }
    const rankJump = prev.rank - row.rank;
    if (rankJump >= WATCHLIST_THRESHOLDS.climberRankJump) {
      movers.push({
        kind: 'climber',
        key: row.key,
        rank: row.rank,
        prevRank: prev.rank,
        playersNow: row.playersNow,
        prevPlayers: prev.playersNow,
        rankJump,
        playerRatio: null,
      });
      continue;
    }
    if (
      row.playersNow !== null &&
      prev.playersNow !== null &&
      prev.playersNow > 0 &&
      row.playersNow >= WATCHLIST_THRESHOLDS.spikeMinPlayers
    ) {
      const ratio = row.playersNow / prev.playersNow;
      if (ratio >= WATCHLIST_THRESHOLDS.spikePlayerRatio) {
        movers.push({
          kind: 'spike',
          key: row.key,
          rank: row.rank,
          prevRank: prev.rank,
          playersNow: row.playersNow,
          prevPlayers: prev.playersNow,
          rankJump: null,
          playerRatio: ratio,
        });
      }
    }
  }
  for (const prev of prevRows) {
    if (!currKeys.has(prev.key)) {
      exits.push({ key: prev.key, prevRank: prev.rank });
    }
  }
  return { movers, exits };
}

/** Design §4.1: the 0–100 game score (rank 50% + players 30% + signals 20%). */
export function computeGameScore(input: {
  readonly rank: number | null;
  readonly playersNow: number | null;
  readonly signals7d: number;
}): number {
  const rankScore = input.rank === null ? 0 : Math.max(0, Math.min(100, 101 - input.rank));
  const playersScore =
    input.playersNow === null || input.playersNow <= 0
      ? 0
      : Math.max(
          0,
          Math.min(100, (Math.log10(input.playersNow + 1) / Math.log10(2_000_000)) * 100),
        );
  const signalScore = Math.max(0, Math.min(100, (Math.min(input.signals7d, 5) / 5) * 100));
  const score = 0.5 * rankScore + 0.3 * playersScore + 0.2 * signalScore;
  return Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
}

/**
 * Design §4.2: does this mover auto-add a `game` entry? Any single
 * condition is enough. The weekly cap (max 10 fresh entries) is enforced
 * by the caller, which orders candidates by score.
 */
export function shouldAutoAddGame(input: {
  readonly moverKind: ChartMoverKind;
  readonly rank: number;
  readonly rankJump: number | null;
  readonly playerRatio: number | null;
  readonly playersNow: number | null;
}): boolean {
  if (input.rank <= WATCHLIST_THRESHOLDS.autoAddRank) {
    return true;
  }
  if (input.moverKind === 'new_entry' && input.rank <= WATCHLIST_THRESHOLDS.autoAddNewEntryRank) {
    return true;
  }
  if (
    input.moverKind === 'climber' &&
    input.rankJump !== null &&
    input.rankJump >= WATCHLIST_THRESHOLDS.climberRankJump
  ) {
    return true;
  }
  if (
    input.moverKind === 'spike' &&
    input.playerRatio !== null &&
    input.playersNow !== null &&
    input.playerRatio >= WATCHLIST_THRESHOLDS.dailySpikeRatio &&
    input.playersNow >= WATCHLIST_THRESHOLDS.dailySpikeMinPlayers
  ) {
    return true;
  }
  return false;
}

export interface PruneInput {
  readonly status: WatchlistStatus;
  /** 'live' entries prune on schedule; 'manual' entries NEVER auto-prune. */
  readonly source: 'live' | 'manual';
  readonly pinned: boolean;
  /** Days since the entry was last seen in the live data. */
  readonly daysSinceLastSeen: number;
  /** Days since the last meaningful signal (news/trailer/mod/crack). */
  readonly daysSinceLastSignal: number;
}

/**
 * Design §4.3: the staged auto-prune. Returns the next status, or null
 * when the entry stays where it is. A pinned or manual entry never
 * auto-prunes (manual entries only ever go dormant, by owner action —
 * never by this function).
 */
export function nextPruneStatus(input: PruneInput): WatchlistStatus | null {
  if (input.pinned || input.source === 'manual') {
    return null;
  }
  if (input.status === 'active') {
    if (
      input.daysSinceLastSeen >= WATCHLIST_THRESHOLDS.coolingMissedSnapshots * 7 &&
      input.daysSinceLastSignal >= WATCHLIST_THRESHOLDS.coolingSignalQuietDays
    ) {
      return 'cooling';
    }
    return null;
  }
  if (input.status === 'cooling') {
    if (
      input.daysSinceLastSignal >=
      WATCHLIST_THRESHOLDS.coolingSignalQuietDays + WATCHLIST_THRESHOLDS.dormantQuietDays
    ) {
      return 'dormant';
    }
    return null;
  }
  if (input.status === 'dormant') {
    if (input.daysSinceLastSignal >= WATCHLIST_THRESHOLDS.expiredQuietDays) {
      return 'expired';
    }
    return null;
  }
  return null;
}

/** Design §7.2: a free-game offer expires 1 day after `expires_at`. */
export function isFreeOfferExpired(nowMs: number, expiresAtMs: number | null): boolean {
  if (expiresAtMs === null) {
    return false;
  }
  return nowMs > expiresAtMs + WATCHLIST_THRESHOLDS.freeOfferExpiryGraceMs;
}

/** Design §4.5: a proposal dies silently after 30 days without a decision. */
export function isProposalExpired(createdAtMs: number, nowMs: number): boolean {
  return nowMs - createdAtMs > WATCHLIST_THRESHOLDS.proposalLifetimeMs;
}

/**
 * Title normalization for alias matching (design §6.1): lowercase, drop
 * edition suffixes and the release year, drop non-alphanumerics, collapse
 * spaces. Two sources naming the same game normalize to the same key.
 */
export function normalizeGameTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(deluxe|ultimate|goty|game of the year|standard|premium)\s+edition\b/g, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The weekly most-played roundup: Top 5 + the single biggest mover. */
export function buildMostPlayedRoundup(input: {
  readonly currRows: readonly ChartRowInput[];
  readonly movers: readonly ChartMover[];
}): {
  readonly top5: readonly ChartRowInput[];
  readonly biggestMover: ChartMover | null;
} {
  const sorted = [...input.currRows].sort((a, b) => a.rank - b.rank);
  const top5 = sorted.slice(0, 5);
  let biggestMover: ChartMover | null = null;
  for (const mover of input.movers) {
    if (mover.kind === 'climber' && mover.rankJump !== null) {
      if (biggestMover === null || (biggestMover.rankJump ?? 0) < mover.rankJump) {
        biggestMover = mover;
      }
    }
  }
  if (biggestMover === null) {
    for (const mover of input.movers) {
      if (mover.kind === 'new_entry') {
        biggestMover = mover;
        break;
      }
    }
  }
  return { top5, biggestMover };
}
