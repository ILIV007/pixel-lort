/**
 * Steam Most Played chart route (slice 5; STEAM_KEY_ALTERNATIVES §2b).
 *
 * Keyless, no Steam Web API key needed:
 *   GET https://store.steampowered.com/charts/mostplayed  (HTML, Top 100)
 *   GET https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid={id}
 *     (JSON, no key — per-game live counts, used by the daily spike check)
 *
 * This module is the DEFENSIVE PARSER + the bounded fetch for the chart
 * page. It produces snapshot rows; movers are computed from two snapshots
 * by the watchlist rules (src/domain/watchlist/watchlist-rules.ts) — a
 * count alone is never a post, only a CHANGE is. SteamDB is never used:
 * no public API, operators asked not to scrape it.
 *
 * Pure parsing (no I/O) plus one injected-fetch function. Never throws
 * for malformed HTML — unparseable rows are counted, never invented.
 */

export const STEAM_MOST_PLAYED_URL = 'https://store.steampowered.com/charts/mostplayed';
export const STEAM_CURRENT_PLAYERS_URL =
  'https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/';

export interface SteamChartRow {
  /** Steam appid as a string (the stable watchlist key). */
  readonly key: string;
  readonly appId: number;
  readonly rank: number;
  readonly playersNow: number | null;
  readonly peakToday: number | null;
}

export interface SteamChartParseResult {
  readonly rows: readonly SteamChartRow[];
  /** Rows skipped because they carried no usable appid/rank. */
  readonly malformedCount: number;
}

const MAX_CHART_ROWS = 100;

function parseCountToken(token: string): number | null {
  const cleaned = token.replaceAll(',', '').trim();
  if (!/^[0-9]+$/.test(cleaned)) {
    return null;
  }
  const value = Number.parseInt(cleaned, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Parse the Most Played HTML table into Top-100 rows. The parser looks
 * for table rows carrying a `/app/<appid>/` link and reads the numeric
 * cells in order (rank, current players, today's peak). Rows without an
 * appid or without a rank are skipped and counted — a page redesign
 * degrades to "no rows", never to invented rows.
 */
export function parseSteamMostPlayedHtml(html: string): SteamChartParseResult {
  const rows: SteamChartRow[] = [];
  let malformedCount = 0;
  if (typeof html !== 'string' || html.length === 0) {
    return { rows, malformedCount: 1 };
  }
  const seen = new Set<number>();
  const rowChunks = html.split(/<tr[\s>]/i).slice(1);
  for (const chunk of rowChunks) {
    if (rows.length >= MAX_CHART_ROWS) {
      break;
    }
    const rowHtml = chunk.split(/<\/tr>/i)[0] ?? '';
    const appMatch = /\/app\/(\d+)\//.exec(rowHtml);
    if (appMatch === null) {
      continue;
    }
    const appId = Number.parseInt(appMatch[1] ?? '', 10);
    if (!Number.isSafeInteger(appId) || appId <= 0 || seen.has(appId)) {
      malformedCount += 1;
      continue;
    }
    // Read the numeric CELLS in order (rank, current players, today's
    // peak): a cell counts only when its whole stripped text is numeric,
    // so a game name carrying a number ("Counter-Strike 2") or a price
    // ("$59.99", "Free") can never shift the columns.
    const numbers: number[] = [];
    const cellMatches = rowHtml.matchAll(/<td[^>]*>(.*?)<\/td>/gis);
    for (const cellMatch of cellMatches) {
      const cellText = (cellMatch[1] ?? '').replace(/<[^>]*>/g, ' ').trim();
      if (/^[\d,]+$/.test(cellText)) {
        const value = parseCountToken(cellText);
        if (value !== null) {
          numbers.push(value);
        }
      }
    }
    const rank = numbers[0];
    if (rank === undefined || rank < 1 || rank > MAX_CHART_ROWS) {
      malformedCount += 1;
      continue;
    }
    seen.add(appId);
    rows.push({
      key: String(appId),
      appId,
      rank,
      playersNow: numbers[1] ?? null,
      peakToday: numbers[2] ?? null,
    });
  }
  rows.sort((a, b) => a.rank - b.rank);
  return { rows, malformedCount };
}

export type SteamChartFetchStatus = 'ok' | 'rate_limited' | 'failed';

export interface SteamChartFetchResult {
  readonly status: SteamChartFetchStatus;
  readonly rows: readonly SteamChartRow[];
  readonly malformedCount: number;
  readonly requestCount: number;
  /** Stable reason when status === 'failed' (never provider text). */
  readonly failureReason: string | null;
  readonly retryAfterSeconds: number | null;
}

export interface SteamChartFetchEffects {
  readonly safeFetch: (input: {
    url: string;
    headers: Record<string, string>;
    byteCap: number;
    timeoutMs: number;
    maxRedirects: number;
    allowedHosts: readonly string[];
  }) => Promise<
    | { ok: true; status: number; headers: Headers; bodyText: string; requestCount: number }
    | { ok: false; reason: string; requestCount: number }
  >;
  readonly nowMs: () => number;
}

/**
 * Fetch the Most Played page once and parse it. A 429 is a hard stop for
 * this poll (reported, never retried here); any other failure returns a
 * typed failure with zero rows — the weekly snapshot is simply skipped
 * that week and the previous snapshot stays valid (live-watchlists §3.1).
 */
export async function fetchSteamMostPlayed(
  effects: SteamChartFetchEffects,
): Promise<SteamChartFetchResult> {
  const response = await effects.safeFetch({
    url: STEAM_MOST_PLAYED_URL,
    headers: { accept: 'text/html' },
    byteCap: 2 * 1024 * 1024,
    timeoutMs: 10_000,
    maxRedirects: 2,
    allowedHosts: ['store.steampowered.com'],
  });
  if (!response.ok) {
    return {
      status: 'failed',
      rows: [],
      malformedCount: 0,
      requestCount: response.requestCount,
      failureReason: 'network_error',
      retryAfterSeconds: null,
    };
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    let retryAfterSeconds: number | null = null;
    if (retryAfter !== null && /^[0-9]+$/.test(retryAfter)) {
      retryAfterSeconds = Number.parseInt(retryAfter, 10);
    }
    return {
      status: 'rate_limited',
      rows: [],
      malformedCount: 0,
      requestCount: response.requestCount,
      failureReason: null,
      retryAfterSeconds,
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      status: 'failed',
      rows: [],
      malformedCount: 0,
      requestCount: response.requestCount,
      failureReason: 'http_status_error',
      retryAfterSeconds: null,
    };
  }
  const parsed = parseSteamMostPlayedHtml(response.bodyText);
  return {
    status: 'ok',
    rows: parsed.rows,
    malformedCount: parsed.malformedCount,
    requestCount: response.requestCount,
    failureReason: null,
    retryAfterSeconds: null,
  };
}

/** Parse one GetNumberOfCurrentPlayers JSON body (keyless, per-game). */
export function parseCurrentPlayersResponse(body: unknown): number | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const count = (body as Record<string, unknown>)['player_count'];
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
    return null;
  }
  return Math.trunc(count);
}
