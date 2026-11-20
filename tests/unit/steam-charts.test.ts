import { describe, expect, it } from 'vitest';
import {
  fetchSteamMostPlayed,
  parseCurrentPlayersResponse,
  parseSteamMostPlayedHtml,
  STEAM_MOST_PLAYED_URL,
} from '../../src/connectors/steam-charts';

/**
 * Slice 5 — Steam Most Played chart route (STEAM_KEY_ALTERNATIVES §2b):
 * keyless HTML Top 100 + keyless per-game player counts. The parser is
 * defensive: a redesigned page degrades to "no rows", never invented rows.
 */

const CHART_HTML = `
<html><body><table><tbody>
<tr><td>1</td><td><a href="https://store.steampowered.com/app/730/Counter-Strike_2/">Counter-Strike 2</a></td><td>1,203,186</td><td>1,350,000</td><td>Free</td></tr>
<tr><td>2</td><td><a href="https://store.steampowered.com/app/570/Dota_2/">Dota 2</a></td><td>650,000</td><td>700,000</td><td>Free</td></tr>
<tr><td>3</td><td><a href="https://store.steampowered.com/app/1245620/ELDEN_RING/">ELDEN RING</a></td><td>120,500</td><td>150,000</td><td>$59.99</td></tr>
<tr><td>4</td><td>No store link in this row</td><td>90,000</td><td>95,000</td><td>Free</td></tr>
<tr><td>5</td><td><a href="https://store.steampowered.com/app/730/Counter-Strike_2/">Counter-Strike 2 again</a></td><td>1,203,186</td><td>1,350,000</td><td>Free</td></tr>
</tbody></table></body></html>
`;

describe('steam charts — Most Played HTML parsing', () => {
  it('parses rank, players, and peak per row (name numbers never shift columns)', () => {
    const parsed = parseSteamMostPlayedHtml(CHART_HTML);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0]).toEqual({
      key: '730',
      appId: 730,
      rank: 1,
      playersNow: 1_203_186,
      peakToday: 1_350_000,
    });
    expect(parsed.rows[1]).toEqual({
      key: '570',
      appId: 570,
      rank: 2,
      playersNow: 650_000,
      peakToday: 700_000,
    });
    // ELDEN RING's "$59.99" price cell is ignored, not read as a count.
    expect(parsed.rows[2]).toEqual({
      key: '1245620',
      appId: 1245620,
      rank: 3,
      playersNow: 120_500,
      peakToday: 150_000,
    });
  });

  it('skips rows without a store link and duplicate appids (counted, never invented)', () => {
    const parsed = parseSteamMostPlayedHtml(CHART_HTML);
    // Row 4 has no /app/ link; row 5 repeats appid 730.
    expect(parsed.malformedCount).toBe(1);
    expect(parsed.rows.map((row) => row.key)).toEqual(['730', '570', '1245620']);
  });

  it('returns no rows (not a crash) for empty or redesigned HTML', () => {
    expect(parseSteamMostPlayedHtml('')).toEqual({ rows: [], malformedCount: 1 });
    expect(parseSteamMostPlayedHtml('<html><body>hello</body></html>')).toEqual({
      rows: [],
      malformedCount: 0,
    });
  });

  it('sorts by rank even when the page lists rows out of order', () => {
    const outOfOrder = `
<table><tbody>
<tr><td>2</td><td><a href="https://store.steampowered.com/app/570/Dota_2/">Dota 2</a></td><td>650,000</td><td>700,000</td><td>Free</td></tr>
<tr><td>1</td><td><a href="https://store.steampowered.com/app/730/Counter-Strike_2/">Counter-Strike 2</a></td><td>1,203,186</td><td>1,350,000</td><td>Free</td></tr>
</tbody></table>`;
    const parsed = parseSteamMostPlayedHtml(outOfOrder);
    expect(parsed.rows.map((row) => row.rank)).toEqual([1, 2]);
    expect(parsed.rows.map((row) => row.key)).toEqual(['730', '570']);
  });
});

describe('steam charts — Most Played fetch', () => {
  it('fetches the pinned chart URL once and parses it', async () => {
    const calls: string[] = [];
    const result = await fetchSteamMostPlayed({
      nowMs: () => 1_000_000,
      safeFetch: async (input) => {
        calls.push(input.url);
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'text/html' }),
          bodyText: CHART_HTML,
          requestCount: 1,
        };
      },
    });
    expect(calls).toEqual([STEAM_MOST_PLAYED_URL]);
    expect(result.status).toBe('ok');
    expect(result.rows).toHaveLength(3);
    expect(result.requestCount).toBe(1);
    expect(result.failureReason).toBeNull();
  });

  it('reports rate_limited on 429 with the Retry-After bound (a hard stop, never retried here)', async () => {
    const result = await fetchSteamMostPlayed({
      nowMs: () => 1_000_000,
      safeFetch: async () => ({
        ok: true,
        status: 429,
        headers: new Headers({ 'retry-after': '60' }),
        bodyText: '',
        requestCount: 1,
      }),
    });
    expect(result.status).toBe('rate_limited');
    expect(result.rows).toEqual([]);
    expect(result.retryAfterSeconds).toBe(60);
  });

  it('fails typed with zero rows on a non-2xx status', async () => {
    const result = await fetchSteamMostPlayed({
      nowMs: () => 1_000_000,
      safeFetch: async () => ({
        ok: true,
        status: 503,
        headers: new Headers(),
        bodyText: '',
        requestCount: 1,
      }),
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toBe('http_status_error');
    expect(result.rows).toEqual([]);
  });
});

describe('steam charts — per-game current players (keyless JSON)', () => {
  it('reads player_count and rejects anything else', () => {
    expect(parseCurrentPlayersResponse({ player_count: 1_203_186, result: 1 })).toBe(1_203_186);
    expect(parseCurrentPlayersResponse({ player_count: 0 })).toBe(0);
    expect(parseCurrentPlayersResponse({})).toBeNull();
    expect(parseCurrentPlayersResponse({ player_count: -1 })).toBeNull();
    expect(parseCurrentPlayersResponse({ player_count: 'many' })).toBeNull();
    expect(parseCurrentPlayersResponse(null)).toBeNull();
    expect(parseCurrentPlayersResponse('junk')).toBeNull();
  });
});
