import { describe, expect, it } from 'vitest';
import {
  createEpicFreeGamesConnector,
  EPIC_FREE_GAMES_ENDPOINT,
  parseEpicFreeGamesResponse,
} from '../../src/connectors/epic-free-games';
import { createFetchMock, connectorEffects } from '../helpers/fetch-mock';

/**
 * Slice 5 — Epic free-games connector (PROVIDER_RESEARCH §2b): the public
 * freeGamesPromotions API, no key. Free = discountPercentage == 0.
 * Discounts never become items; upcoming offers are counted, never emitted.
 */

function freeElement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Hollow Knight',
    id: 'hollow-knight-offer',
    catalogNs: { mappings: [{ pageSlug: 'hollow-knight', pageType: 'productHome' }] },
    price: {
      totalPrice: { discountPrice: 0, originalPrice: 1499, currencyCode: 'USD' },
    },
    promotions: {
      promotionalOffers: [
        {
          promotionalOffers: [
            {
              startDate: '2026-11-20T16:00:00.000Z',
              endDate: '2026-11-27T16:00:00.000Z',
              discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 0 },
            },
          ],
        },
      ],
      upcomingPromotionalOffers: [],
    },
    ...overrides,
  };
}

function epicBody(elements: readonly unknown[]): string {
  return JSON.stringify({
    data: { Catalog: { searchStore: { elements } } },
  });
}

describe('epic-free-games — response parsing', () => {
  it('detects the currently-free game and builds its store URL', () => {
    const parsed = parseEpicFreeGamesResponse(JSON.parse(epicBody([freeElement()])));
    expect(parsed.offers).toHaveLength(1);
    expect(parsed.offers[0]).toMatchObject({
      sourceId: 'epic-free:hollow-knight-offer',
      title: 'Hollow Knight',
      pageSlug: 'hollow-knight',
      storeUrl: 'https://store.epicgames.com/en-US/p/hollow-knight',
      originalPrice: 1499,
      currencyCode: 'USD',
      startDate: '2026-11-20T16:00:00.000Z',
      endDate: '2026-11-27T16:00:00.000Z',
    });
    expect(parsed.upcomingCount).toBe(0);
    expect(parsed.malformedCount).toBe(0);
  });

  it('ignores discounted games (a discount is never a free-game announcement)', () => {
    const discounted = freeElement({
      title: 'Discounted Game',
      id: 'discounted-offer',
      promotions: {
        promotionalOffers: [
          {
            promotionalOffers: [
              {
                startDate: '2026-11-20T16:00:00.000Z',
                endDate: '2026-11-27T16:00:00.000Z',
                discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 50 },
              },
            ],
          },
        ],
        upcomingPromotionalOffers: [],
      },
    });
    const parsed = parseEpicFreeGamesResponse(JSON.parse(epicBody([discounted])));
    expect(parsed.offers).toEqual([]);
    expect(parsed.malformedCount).toBe(0);
  });

  it('counts upcoming free offers without emitting them, and keeps the current one', () => {
    const upcomingOnly = freeElement({
      title: 'Next Week Game',
      id: 'next-week-offer',
      promotions: {
        promotionalOffers: [],
        upcomingPromotionalOffers: [
          {
            promotionalOffers: [
              {
                startDate: '2026-11-27T16:00:00.000Z',
                endDate: '2026-12-04T16:00:00.000Z',
                discountSetting: { discountType: 'PERCENTAGE', discountPercentage: 0 },
              },
            ],
          },
        ],
      },
    });
    const parsed = parseEpicFreeGamesResponse(JSON.parse(epicBody([freeElement(), upcomingOnly])));
    expect(parsed.offers).toHaveLength(1);
    expect(parsed.offers[0]?.title).toBe('Hollow Knight');
    expect(parsed.upcomingCount).toBe(1);
  });

  it('falls back to urlSlug when no pageSlug mapping exists, and to null without any slug', () => {
    const withUrlSlug = freeElement({
      id: 'url-slug-offer',
      catalogNs: { mappings: [] },
      urlSlug: 'url-slug-game',
    });
    const withoutSlug = freeElement({ id: 'no-slug-offer', catalogNs: {} });
    const parsed = parseEpicFreeGamesResponse(JSON.parse(epicBody([withUrlSlug, withoutSlug])));
    expect(parsed.offers).toHaveLength(2);
    expect(parsed.offers[0]?.storeUrl).toBe('https://store.epicgames.com/en-US/p/url-slug-game');
    expect(parsed.offers[1]?.pageSlug).toBeNull();
    expect(parsed.offers[1]?.storeUrl).toBeNull();
  });

  it('counts unusable elements as malformed instead of crashing', () => {
    const parsed = parseEpicFreeGamesResponse(
      JSON.parse(epicBody([freeElement(), { id: 'no-title' }, 'junk', null])),
    );
    expect(parsed.offers).toHaveLength(1);
    expect(parsed.malformedCount).toBe(3);
  });

  it('fails safe on a non-object or shapeless body', () => {
    expect(parseEpicFreeGamesResponse(null).malformedCount).toBe(1);
    expect(parseEpicFreeGamesResponse({ data: {} }).malformedCount).toBe(1);
    expect(parseEpicFreeGamesResponse({ data: { Catalog: {} } }).malformedCount).toBe(1);
    expect(
      parseEpicFreeGamesResponse({ data: { Catalog: { searchStore: { elements: 'nope' } } } })
        .malformedCount,
    ).toBe(1);
  });
});

describe('epic-free-games — connector contract', () => {
  it('is keyless: preflight always passes and exactly one request is planned', () => {
    const connector = createEpicFreeGamesConnector();
    expect(connector.id).toBe('epic-free-games');
    expect(connector.preflight({}, () => undefined)).toEqual({ ok: true });
    expect(connector.plannedRequestCount({})).toBe(1);
    expect(connector.allowedHosts({})).toEqual(['store-site-backend-static.ak.epicgames.com']);
  });

  it('fetches the pinned endpoint and normalizes only the free offer', async () => {
    const mock = createFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: epicBody([freeElement()]),
      },
    ]);
    const connector = createEpicFreeGamesConnector();
    const result = await connector.fetch({
      sourceId: 'epic_free_games',
      config: {},
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.url).toBe(EPIC_FREE_GAMES_ENDPOINT);
    expect(result.status).toBe('changed');
    expect(result.requestCount).toBe(1);
    expect(result.items).toHaveLength(1);
    // The shared normalizer prefixes the raw element id with the
    // connector id (the same shape every other connector emits);
    // the parser-level `epic-free:<id>` sourceId is what the
    // watchlist refresh layer keys free-game entries on.
    expect(result.items[0]?.externalId).toBe('epic-free-games:hollow-knight-offer');
    expect(result.items[0]?.canonicalUrl).toBe('https://store.epicgames.com/en-US/p/hollow-knight');
    expect(result.items[0]?.title).toBe('Hollow Knight');
  });

  it('reports rate_limited with the Retry-After bound on 429', async () => {
    const mock = createFetchMock([
      { status: 429, headers: { 'retry-after': '120' }, bodyText: '' },
    ]);
    const connector = createEpicFreeGamesConnector();
    const result = await connector.fetch({
      sourceId: 'epic_free_games',
      config: {},
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('rate_limited');
    expect(result.items).toEqual([]);
    expect(result.retryAfterSeconds).toBe(120);
  });

  it('fails safe on malformed JSON and on a non-JSON content type', async () => {
    const connector = createEpicFreeGamesConnector();
    const badJson = createFetchMock([
      { status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{nope' },
    ]);
    const badJsonResult = await connector.fetch({
      sourceId: 'epic_free_games',
      config: {},
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(badJson.fetchFn),
    });
    expect(badJsonResult.status).toBe('failed');
    expect(badJsonResult.failureReason).toBe('response_malformed');

    const badType = createFetchMock([
      { status: 200, headers: { 'content-type': 'text/html' }, bodyText: '<html/>' },
    ]);
    const badTypeResult = await connector.fetch({
      sourceId: 'epic_free_games',
      config: {},
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(badType.fetchFn),
    });
    expect(badTypeResult.status).toBe('failed');
    expect(badTypeResult.failureReason).toBe('unexpected_content_type');
  });
});
