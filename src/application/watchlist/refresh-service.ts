/**
 * Live-watchlist refresh service (slice 5; live-watchlists-design §3–§4).
 *
 * Two refreshes, both fail-closed and cap-respecting:
 *   1. `refreshWatchlistFromChartSnapshot` — the weekly Sunday snapshot:
 *      save the snapshot (never twice for one date), diff it against the
 *      previous snapshot, record one append-only signal per mover, auto-add
 *      at most 10 fresh live `game` entries per week (by score), refresh
 *      the rank/players/score of entries still in the chart, and stage-prune
 *      entries that fell out (active → cooling → dormant → expired).
 *      Exits NEVER produce a post — they are pruning input only.
 *   2. `refreshFreeOffers` — Epic/GamerPower offers: upsert one temporary
 *      `free_game` entry per offer (keyed by the offer source id, so a
 *      re-offered game is a FRESH entry and a fresh post — design §7.2),
 *      alias it to the canonical `game` entry when the normalized title
 *      matches, and expire offers past `expires_at` + 1 day.
 *
 * Nothing here posts, publishes, or touches the daily cap: refreshes only
 * produce CANDIDATES in D1 for the pipeline (slice 8 wires the cron).
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  countRecentSignals,
  findWatchlistEntry,
  insertWatchlistAlias,
  latestChartSnapshot,
  listWatchlistEntries,
  listWatchlistExclusions,
  recordWatchlistSignal,
  saveChartSnapshot,
  setWatchlistEntryStatus,
  upsertWatchlistEntry,
  type ChartSnapshotRowInput,
} from '../../adapters/db/watchlist-store';
import {
  computeGameScore,
  detectChartMovers,
  isFreeOfferExpired,
  nextPruneStatus,
  normalizeGameTitle,
  shouldAutoAddGame,
  WATCHLIST_THRESHOLDS,
  type ChartMover,
} from '../../domain/watchlist/watchlist-rules';
import type { EpicFreeOffer } from '../../connectors/epic-free-games';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ChartRefreshSummary {
  readonly snapshotDate: string;
  /** False when this date's snapshot already existed (refresh skipped). */
  readonly snapshotCreated: boolean;
  readonly rowsSaved: number;
  readonly movers: readonly ChartMover[];
  readonly entriesAdded: number;
  readonly entriesUpdated: number;
  readonly entriesPruned: number;
  readonly exits: number;
}

function daysBetween(earlierMs: number, laterMs: number): number {
  return Math.max(0, Math.floor((laterMs - earlierMs) / DAY_MS));
}

/** Does an exclusion pattern match a kind+key? Exact match or `prefix*`. */
export function isExcluded(
  exclusions: readonly { kind: string; keyPattern: string }[],
  kind: string,
  key: string,
): boolean {
  for (const exclusion of exclusions) {
    if (exclusion.kind !== kind) {
      continue;
    }
    const pattern = exclusion.keyPattern;
    if (pattern === key) {
      return true;
    }
    if (pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1))) {
      return true;
    }
  }
  return false;
}

export async function refreshWatchlistFromChartSnapshot(
  executor: DbExecutor,
  input: {
    readonly snapshotDate: string;
    readonly rows: readonly ChartSnapshotRowInput[];
    readonly nowMs: number;
  },
): Promise<ChartRefreshSummary> {
  const prev = await latestChartSnapshot(executor, { beforeDate: input.snapshotDate });
  const saved = await saveChartSnapshot(executor, {
    snapshotDate: input.snapshotDate,
    rows: input.rows,
    nowMs: input.nowMs,
  });
  if (!saved.created) {
    return {
      snapshotDate: input.snapshotDate,
      snapshotCreated: false,
      rowsSaved: 0,
      movers: [],
      entriesAdded: 0,
      entriesUpdated: 0,
      entriesPruned: 0,
      exits: 0,
    };
  }

  const prevRows = prev?.rows ?? [];
  const { movers: detectedMovers, exits } = detectChartMovers(prevRows, input.rows);
  const exclusions = await listWatchlistExclusions(executor);
  // Excluded games are dropped from the reported movers entirely: the
  // summary is the posting-candidate list, and an excluded game is
  // never a candidate (no signal, no auto-add).
  const movers = detectedMovers.filter((mover) => !isExcluded(exclusions, 'game', mover.key));

  // Record one append-only signal per mover, then auto-add by score
  // (weekly cap: at most 10 fresh live entries).
  const candidates: { mover: ChartMover; score: number }[] = [];
  for (const mover of movers) {
    const signals7d = await countRecentSignals(executor, {
      kind: 'game',
      key: mover.key,
      sinceMs: input.nowMs - 7 * DAY_MS,
    });
    const score = computeGameScore({
      rank: mover.rank,
      playersNow: mover.playersNow,
      signals7d,
    });
    await recordWatchlistSignal(executor, {
      entryId: null,
      kind: 'game',
      key: mover.key,
      signalType:
        mover.kind === 'new_entry'
          ? 'chart_new_entry'
          : mover.kind === 'climber'
            ? 'chart_climber'
            : 'chart_spike',
      source: 'steam-chart',
      valueJson: JSON.stringify({
        rank: mover.rank,
        prevRank: mover.prevRank,
        playersNow: mover.playersNow,
        prevPlayers: mover.prevPlayers,
      }),
      observedAtMs: input.nowMs,
    });
    if (
      shouldAutoAddGame({
        moverKind: mover.kind,
        rank: mover.rank,
        rankJump: mover.rankJump,
        playerRatio: mover.playerRatio,
        playersNow: mover.playersNow,
      })
    ) {
      candidates.push({ mover, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const fresh = candidates.slice(0, WATCHLIST_THRESHOLDS.maxNewLiveEntriesPerWeek);
  let entriesAdded = 0;
  for (const { mover, score } of fresh) {
    const existing = await findWatchlistEntry(executor, 'game', mover.key);
    if (existing !== null) {
      // A cooling/dormant entry that re-enters the chart RETURNS to
      // active (design §4.3) — its comeback is itself a post candidate.
      if (existing.status === 'cooling' || existing.status === 'dormant') {
        await setWatchlistEntryStatus(executor, {
          kind: 'game',
          key: mover.key,
          status: 'active',
          nowMs: input.nowMs,
        });
      }
      continue;
    }
    await upsertWatchlistEntry(executor, {
      kind: 'game',
      key: mover.key,
      label: `steam:${mover.key}`,
      source: 'live',
      originDetail: 'steam-chart',
      status: 'active',
      score,
      rankCurrent: mover.rank,
      rankPrev: mover.prevRank,
      playersCurrent: mover.playersNow,
      lastSignalAtMs: input.nowMs,
      nowMs: input.nowMs,
    });
    entriesAdded += 1;
  }

  // Refresh the entries still in the chart (rank/players/score/seen).
  const currByKey = new Map(input.rows.map((row) => [row.key, row]));
  let entriesUpdated = 0;
  const activeGames = await listWatchlistEntries(executor, { kind: 'game', status: 'active' });
  for (const entry of activeGames) {
    const row = currByKey.get(entry.key);
    if (row === undefined) {
      continue;
    }
    const signals7d = await countRecentSignals(executor, {
      kind: 'game',
      key: entry.key,
      sinceMs: input.nowMs - 7 * DAY_MS,
    });
    const score = computeGameScore({
      rank: row.rank,
      playersNow: row.playersNow,
      signals7d,
    });
    await upsertWatchlistEntry(executor, {
      kind: 'game',
      key: entry.key,
      label: entry.label,
      source: entry.source === 'manual' ? 'manual' : 'live',
      originDetail: entry.origin_detail ?? undefined,
      status: 'active',
      score,
      rankCurrent: row.rank,
      playersCurrent: row.playersNow,
      nowMs: input.nowMs,
    });
    entriesUpdated += 1;
  }

  // Stage-prune the live entries that fell out of the chart. Manual and
  // pinned entries never auto-prune (nextPruneStatus enforces that).
  let entriesPruned = 0;
  const liveGames = await listWatchlistEntries(executor, { kind: 'game' });
  for (const entry of liveGames) {
    if (entry.status !== 'active' && entry.status !== 'cooling' && entry.status !== 'dormant') {
      continue;
    }
    if (currByKey.has(entry.key)) {
      continue;
    }
    const next = nextPruneStatus({
      status: entry.status as 'active' | 'cooling' | 'dormant',
      source: entry.source === 'manual' ? 'manual' : 'live',
      pinned: entry.pinned === 1,
      daysSinceLastSeen: daysBetween(entry.last_seen_at_ms, input.nowMs),
      daysSinceLastSignal: daysBetween(
        entry.last_signal_at_ms ?? entry.last_seen_at_ms,
        input.nowMs,
      ),
    });
    if (next !== null) {
      await setWatchlistEntryStatus(executor, {
        kind: 'game',
        key: entry.key,
        status: next,
        nowMs: input.nowMs,
      });
      entriesPruned += 1;
    }
  }

  return {
    snapshotDate: input.snapshotDate,
    snapshotCreated: true,
    rowsSaved: input.rows.length,
    movers,
    entriesAdded,
    entriesUpdated,
    entriesPruned,
    exits: exits.length,
  };
}

export interface FreeOfferRefreshSummary {
  readonly offersSeen: number;
  readonly entriesUpserted: number;
  readonly entriesExpired: number;
  readonly aliasesCreated: number;
}

/** Parse an Epic endDate ISO string to epoch ms (null when unparseable). */
export function parseOfferEndMs(endDate: string | null): number | null {
  if (endDate === null) {
    return null;
  }
  const parsed = Date.parse(endDate);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function refreshFreeOffers(
  executor: DbExecutor,
  input: { readonly offers: readonly EpicFreeOffer[]; readonly nowMs: number },
): Promise<FreeOfferRefreshSummary> {
  const exclusions = await listWatchlistExclusions(executor);
  const activeGames = await listWatchlistEntries(executor, { kind: 'game', status: 'active' });
  const gameByNormalizedTitle = new Map(
    activeGames.map((entry) => [normalizeGameTitle(entry.label), entry.key]),
  );
  let entriesUpserted = 0;
  let aliasesCreated = 0;
  for (const offer of input.offers) {
    if (isExcluded(exclusions, 'free_game', offer.sourceId)) {
      continue;
    }
    const expiresAtMs = parseOfferEndMs(offer.endDate);
    await upsertWatchlistEntry(executor, {
      kind: 'free_game',
      key: offer.sourceId,
      label: offer.title,
      source: 'live',
      originDetail: 'epic-api',
      status: 'active',
      expiresAtMs,
      metadataJson: JSON.stringify({
        pageSlug: offer.pageSlug,
        storeUrl: offer.storeUrl,
        originalPrice: offer.originalPrice,
        currencyCode: offer.currencyCode,
      }),
      nowMs: input.nowMs,
    });
    entriesUpserted += 1;
    const canonicalKey = gameByNormalizedTitle.get(normalizeGameTitle(offer.title));
    if (canonicalKey !== undefined) {
      await insertWatchlistAlias(executor, {
        kind: 'game',
        canonicalKey,
        aliasKey: offer.sourceId,
        aliasSource: 'epic',
        nowMs: input.nowMs,
      });
      aliasesCreated += 1;
    }
  }

  // Expire offers past `expires_at` + 1 day (design §7.2). No "expired"
  // post is ever produced here — expiry is bookkeeping only.
  let entriesExpired = 0;
  const liveOffers = await listWatchlistEntries(executor, { kind: 'free_game', status: 'active' });
  for (const offer of liveOffers) {
    if (isFreeOfferExpired(input.nowMs, offer.expires_at_ms)) {
      await setWatchlistEntryStatus(executor, {
        kind: 'free_game',
        key: offer.key,
        status: 'expired',
        nowMs: input.nowMs,
      });
      entriesExpired += 1;
    }
  }

  return {
    offersSeen: input.offers.length,
    entriesUpserted,
    entriesExpired,
    aliasesCreated,
  };
}
