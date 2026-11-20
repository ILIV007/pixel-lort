/**
 * Live-watchlist D1 store (slice 5; migration 0008; typed D1 boundary
 * per ADR-0022).
 *
 * Tables (live-watchlists-design §5): `watchlist_entries` (one row per
 * watched thing — game, publisher, channel, repo, account, domain, slug,
 * appid, team, offer, mod candidate), `chart_snapshots` +
 * `chart_snapshot_rows` (the weekly Sunday Steam Top-100 snapshot —
 * movers are ALWAYS diffed between two snapshots, never from the
 * entries' rank columns), `watchlist_signals` (append-only signal log),
 * `watchlist_aliases` (one thing = one entry across sources), and
 * `watchlist_exclusions` (the owner's manual block-list).
 *
 * Rules honored here: no DELETE anywhere (status changes only); every
 * multi-write is ONE atomic batch; no SQL text or bind parameters in
 * logs (the executor handles that); timestamps are epoch ms, dates are
 * Tehran `YYYY-MM-DD` strings.
 */
import type { DbExecutor } from './db-executor';
import type { WatchlistKind, WatchlistStatus } from '../../domain/watchlist/watchlist-rules';

export interface WatchlistEntryRow {
  readonly id: number;
  readonly kind: string;
  readonly key: string;
  readonly label: string;
  readonly source: string;
  readonly origin_detail: string | null;
  readonly status: string;
  readonly score: number;
  readonly velocity: number;
  readonly rank_current: number | null;
  readonly rank_prev: number | null;
  readonly players_current: number | null;
  readonly signal_count_7d: number;
  readonly signal_count_30d: number;
  readonly first_seen_at_ms: number;
  readonly last_seen_at_ms: number;
  readonly last_signal_at_ms: number | null;
  readonly expires_at_ms: number | null;
  readonly pinned: number;
  readonly pinned_until_ms: number | null;
  readonly suppressed_until_ms: number | null;
  readonly suppress_reason: string | null;
  readonly metadata_json: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface UpsertWatchlistEntryInput {
  readonly kind: WatchlistKind;
  readonly key: string;
  readonly label: string;
  readonly source: 'live' | 'manual';
  readonly originDetail?: string;
  readonly status?: WatchlistStatus;
  readonly score?: number;
  readonly velocity?: number;
  readonly rankCurrent?: number | null;
  readonly rankPrev?: number | null;
  readonly playersCurrent?: number | null;
  readonly lastSignalAtMs?: number | null;
  readonly expiresAtMs?: number | null;
  readonly metadataJson?: string;
  readonly nowMs: number;
}

/**
 * Insert a new entry or refresh a live entry's derived columns. The
 * entry's SOURCE never changes on upsert (a manual entry stays manual,
 * a live entry stays live — design §6.3); status is only ever set
 * explicitly by the caller (the refresh service owns transitions).
 */
export async function upsertWatchlistEntry(
  executor: DbExecutor,
  input: UpsertWatchlistEntryInput,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO watchlist_entries
            (kind, key, label, source, origin_detail, status, score, velocity,
             rank_current, rank_prev, players_current,
             first_seen_at_ms, last_seen_at_ms, last_signal_at_ms, expires_at_ms,
             metadata_json, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (kind, key) DO UPDATE SET
            label = excluded.label,
            score = excluded.score,
            velocity = excluded.velocity,
            rank_prev = watchlist_entries.rank_current,
            rank_current = excluded.rank_current,
            players_current = excluded.players_current,
            last_seen_at_ms = excluded.last_seen_at_ms,
            last_signal_at_ms = COALESCE(excluded.last_signal_at_ms, watchlist_entries.last_signal_at_ms),
            expires_at_ms = excluded.expires_at_ms,
            metadata_json = excluded.metadata_json,
            updated_at_ms = excluded.updated_at_ms`,
    params: [
      input.kind,
      input.key,
      input.label,
      input.source,
      input.originDetail ?? null,
      input.status ?? 'active',
      input.score ?? 0,
      input.velocity ?? 0,
      input.rankCurrent ?? null,
      input.rankPrev ?? null,
      input.playersCurrent ?? null,
      input.nowMs,
      input.nowMs,
      input.lastSignalAtMs ?? null,
      input.expiresAtMs ?? null,
      input.metadataJson ?? '{}',
      input.nowMs,
      input.nowMs,
    ],
  });
}

/** Set one entry's status (prune/expire/suppress transitions only). */
export async function setWatchlistEntryStatus(
  executor: DbExecutor,
  input: { kind: WatchlistKind; key: string; status: WatchlistStatus; nowMs: number },
): Promise<void> {
  await executor.run({
    sql: `UPDATE watchlist_entries SET status = ?, updated_at_ms = ?
          WHERE kind = ? AND key = ?`,
    params: [input.status, input.nowMs, input.kind, input.key],
  });
}

export async function listWatchlistEntries(
  executor: DbExecutor,
  input: { kind?: WatchlistKind; status?: WatchlistStatus } = {},
): Promise<readonly WatchlistEntryRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.kind !== undefined) {
    conditions.push('kind = ?');
    params.push(input.kind);
  }
  if (input.status !== undefined) {
    conditions.push('status = ?');
    params.push(input.status);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await executor.query<WatchlistEntryRow>({
    sql: `SELECT * FROM watchlist_entries ${where} ORDER BY score DESC, key ASC`,
    params,
  });
  return result.rows;
}

export async function findWatchlistEntry(
  executor: DbExecutor,
  kind: WatchlistKind,
  key: string,
): Promise<WatchlistEntryRow | null> {
  return executor.first<WatchlistEntryRow>({
    sql: `SELECT * FROM watchlist_entries WHERE kind = ? AND key = ?`,
    params: [kind, key],
  });
}

export interface ChartSnapshotRowInput {
  readonly key: string;
  readonly rank: number;
  readonly playersNow: number | null;
  readonly peakToday: number | null;
}

export interface SaveChartSnapshotResult {
  /** False when this (date, source) snapshot already exists — never duplicated. */
  readonly created: boolean;
  readonly snapshotId: number;
}

/**
 * Save one weekly chart snapshot atomically. A snapshot for the same
 * date+source is NEVER written twice (a failed fetch week simply leaves
 * the previous snapshot valid — design §3.1).
 */
export async function saveChartSnapshot(
  executor: DbExecutor,
  input: {
    readonly snapshotDate: string;
    readonly source?: string;
    readonly rows: readonly ChartSnapshotRowInput[];
    readonly nowMs: number;
  },
): Promise<SaveChartSnapshotResult> {
  const source = input.source ?? 'steam-mostplayed';
  const existing = await executor.first<{ id: number }>({
    sql: `SELECT id FROM chart_snapshots WHERE snapshot_date = ? AND source = ?`,
    params: [input.snapshotDate, source],
  });
  if (existing !== null) {
    return { created: false, snapshotId: existing.id };
  }
  await executor.run({
    sql: `INSERT INTO chart_snapshots (snapshot_date, source, row_count, created_at_ms)
          VALUES (?, ?, ?, ?)`,
    params: [input.snapshotDate, source, input.rows.length, input.nowMs],
  });
  const created = await executor.first<{ id: number }>({
    sql: `SELECT id FROM chart_snapshots WHERE snapshot_date = ? AND source = ?`,
    params: [input.snapshotDate, source],
  });
  if (created === null) {
    throw new Error('watchlist snapshot insert did not persist');
  }
  if (input.rows.length > 0) {
    const statements = input.rows.map((row) => ({
      sql: `INSERT INTO chart_snapshot_rows
              (snapshot_id, kind, key, rank, players_now, peak_today)
            VALUES (?, 'game', ?, ?, ?, ?)`,
      params: [created.id, row.key, row.rank, row.playersNow, row.peakToday],
    }));
    await executor.batch(statements);
  }
  return { created: true, snapshotId: created.id };
}

export interface ChartSnapshot {
  readonly id: number;
  readonly snapshotDate: string;
  readonly source: string;
  readonly rowCount: number;
  readonly rows: readonly ChartSnapshotRowInput[];
}

/** The latest snapshot at or before `snapshotDate` (exclusive when given). */
export async function latestChartSnapshot(
  executor: DbExecutor,
  input: { beforeDate?: string; source?: string } = {},
): Promise<ChartSnapshot | null> {
  const source = input.source ?? 'steam-mostplayed';
  const snapshot = await executor.first<{
    id: number;
    snapshot_date: string;
    source: string;
    row_count: number;
  }>({
    sql:
      input.beforeDate === undefined
        ? `SELECT id, snapshot_date, source, row_count FROM chart_snapshots
           WHERE source = ? ORDER BY snapshot_date DESC LIMIT 1`
        : `SELECT id, snapshot_date, source, row_count FROM chart_snapshots
           WHERE source = ? AND snapshot_date < ? ORDER BY snapshot_date DESC LIMIT 1`,
    params: input.beforeDate === undefined ? [source] : [source, input.beforeDate],
  });
  if (snapshot === null) {
    return null;
  }
  const rows = await executor.query<{
    key: string;
    rank: number;
    players_now: number | null;
    peak_today: number | null;
  }>({
    sql: `SELECT key, rank, players_now, peak_today FROM chart_snapshot_rows
          WHERE snapshot_id = ? ORDER BY rank ASC`,
    params: [snapshot.id],
  });
  return {
    id: snapshot.id,
    snapshotDate: snapshot.snapshot_date,
    source: snapshot.source,
    rowCount: snapshot.row_count,
    rows: rows.rows.map((row) => ({
      key: row.key,
      rank: row.rank,
      playersNow: row.players_now,
      peakToday: row.peak_today,
    })),
  };
}

export interface WatchlistSignalInput {
  readonly entryId: number | null;
  readonly kind: WatchlistKind;
  readonly key: string;
  readonly signalType: string;
  readonly source: string;
  readonly valueJson?: string;
  readonly observedAtMs: number;
}

/** Append one signal (append-only log; never updated, never deleted). */
export async function recordWatchlistSignal(
  executor: DbExecutor,
  input: WatchlistSignalInput,
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO watchlist_signals
            (entry_id, kind, key, signal_type, source, value_json, observed_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [
      input.entryId,
      input.kind,
      input.key,
      input.signalType,
      input.source,
      input.valueJson ?? '{}',
      input.observedAtMs,
    ],
  });
}

/** Count signals for one entry in the last `windowMs` (score input). */
export async function countRecentSignals(
  executor: DbExecutor,
  input: { kind: WatchlistKind; key: string; sinceMs: number },
): Promise<number> {
  const row = await executor.first<{ n: number }>({
    sql: `SELECT COUNT(*) AS n FROM watchlist_signals
          WHERE kind = ? AND key = ? AND observed_at_ms >= ?`,
    params: [input.kind, input.key, input.sinceMs],
  });
  return row?.n ?? 0;
}

/** Insert an alias (one thing = one canonical entry across sources). */
export async function insertWatchlistAlias(
  executor: DbExecutor,
  input: {
    readonly kind: WatchlistKind;
    readonly canonicalKey: string;
    readonly aliasKey: string;
    readonly aliasSource: string;
    readonly nowMs: number;
  },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO watchlist_aliases
            (kind, canonical_key, alias_key, alias_source, created_at_ms)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (kind, alias_source, alias_key) DO NOTHING`,
    params: [input.kind, input.canonicalKey, input.aliasKey, input.aliasSource, input.nowMs],
  });
}

/** Resolve an alias to its canonical key, if one exists. */
export async function resolveWatchlistAlias(
  executor: DbExecutor,
  input: { kind: WatchlistKind; aliasSource: string; aliasKey: string },
): Promise<string | null> {
  const row = await executor.first<{ canonical_key: string }>({
    sql: `SELECT canonical_key FROM watchlist_aliases
          WHERE kind = ? AND alias_source = ? AND alias_key = ?`,
    params: [input.kind, input.aliasSource, input.aliasKey],
  });
  return row?.canonical_key ?? null;
}

/** The owner's exclusion list (kind + key pattern). */
export async function listWatchlistExclusions(
  executor: DbExecutor,
): Promise<readonly { kind: string; keyPattern: string }[]> {
  const result = await executor.query<{ kind: string; key_pattern: string }>({
    sql: `SELECT kind, key_pattern FROM watchlist_exclusions ORDER BY kind, key_pattern`,
  });
  return result.rows.map((row) => ({ kind: row.kind, keyPattern: row.key_pattern }));
}

export async function insertWatchlistExclusion(
  executor: DbExecutor,
  input: {
    readonly kind: WatchlistKind;
    readonly keyPattern: string;
    readonly reason: string;
    readonly createdBy: string;
    readonly nowMs: number;
  },
): Promise<void> {
  await executor.run({
    sql: `INSERT INTO watchlist_exclusions
            (kind, key_pattern, reason, created_by, created_at_ms)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (kind, key_pattern) DO NOTHING`,
    params: [input.kind, input.keyPattern, input.reason, input.createdBy, input.nowMs],
  });
}
