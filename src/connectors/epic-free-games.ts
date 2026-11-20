/**
 * Epic free-games connector (slice 5; PROVIDER_RESEARCH §2b — NEW work,
 * not in the blueprint registry).
 *
 * Polls the PUBLIC Epic freeGamesPromotions API — JSON, NO key:
 *   GET https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US
 * Weekly swap is Thursday ~16:00 UTC; the watchlist polls daily + an
 * extra Thursday 20:00 Tehran pass (live-watchlists-design §2.2).
 *
 * Free detection (the ONLY rule that makes an item): a current
 * promotional offer whose `discountSetting.discountPercentage == 0`.
 * Anything with a non-zero discount is a DISCOUNT, never a free-game
 * announcement — it produces no item (DESIGN §10.3: free YES, discount
 * posts NO). Upcoming offers are counted, never emitted.
 *
 * Defensive parsing throughout: a missing/reshaped field skips that
 * element (counted as malformed) instead of crashing the poll; a missing
 * page slug yields an item WITHOUT a store URL (the game-page allowlist
 * renders no button without a URL — the item is held, never invented).
 * The endpoint is PINNED: no config endpoint is accepted.
 */
import { z } from 'zod';
import { INGESTION_LIMITS } from '../domain/source/source-registry';
import { classifyOfferKind } from '../domain/game-links/game-page-links';
import { normalizeRawItem, type NormalizedItemOut } from './normalize';
import {
  budgetDenialKindOf,
  budgetDeniedOutput,
  endpointHost,
  fetchWithObservedAttempts,
  isJsonContentType,
  parseRetryAfterSeconds,
  type ConnectorFetchInput,
  type ConnectorFetchOutput,
  type SourceConnector,
} from './contract';

export const EPIC_FREE_GAMES_ENDPOINT =
  'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
export const EPIC_STORE_PAGE_BASE = 'https://store.epicgames.com/en-US/p/';

/** No runtime config: the connector is keyless and the endpoint is pinned. */
export const EpicFreeGamesRuntimeConfigSchema = z.object({}).strict();

export interface EpicFreeOffer {
  /** Stable source id for dedup: `epic-free:<element id>`. */
  readonly sourceId: string;
  readonly offerId: string;
  readonly title: string;
  /** Store page slug, or null when the response carries none. */
  readonly pageSlug: string | null;
  /** Full store page URL, or null when there is no slug. */
  readonly storeUrl: string | null;
  readonly originalPrice: number | null;
  readonly currencyCode: string | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
}

export interface EpicFreeGamesParseResult {
  /** Currently-free offers (discountPercentage == 0, current window). */
  readonly offers: readonly EpicFreeOffer[];
  /** Upcoming free offers seen (counted, never emitted as items). */
  readonly upcomingCount: number;
  /** Elements skipped because their shape was unusable. */
  readonly malformedCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The first free (discountPercentage == 0) offer window in a list, if any. */
function firstFreeWindow(
  windows: unknown,
): { startDate: string | null; endDate: string | null } | null {
  if (!Array.isArray(windows)) {
    return null;
  }
  for (const window of windows) {
    if (!isPlainObject(window)) {
      continue;
    }
    const setting = window['discountSetting'];
    const percentage = isPlainObject(setting) ? setting['discountPercentage'] : undefined;
    if (classifyOfferKind(percentage) === 'free') {
      return {
        startDate: readString(window['startDate']),
        endDate: readString(window['endDate']),
      };
    }
  }
  return null;
}

/** Free windows live one level deeper: groups[].promotionalOffers[]. */
function firstFreeWindowInGroups(groups: unknown): {
  startDate: string | null;
  endDate: string | null;
} | null {
  if (!Array.isArray(groups)) {
    return null;
  }
  for (const group of groups) {
    if (!isPlainObject(group)) {
      continue;
    }
    const found = firstFreeWindow(group['promotionalOffers']);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function readPageSlug(element: Record<string, unknown>): string | null {
  const catalogNs = element['catalogNs'];
  if (isPlainObject(catalogNs)) {
    const mappings = catalogNs['mappings'];
    if (Array.isArray(mappings)) {
      for (const mapping of mappings) {
        if (isPlainObject(mapping)) {
          const slug = readString(mapping['pageSlug']);
          if (slug !== null) {
            return slug;
          }
        }
      }
    }
  }
  return readString(element['urlSlug']) ?? readString(element['productSlug']);
}

function parseElement(element: unknown): { offer: EpicFreeOffer | null; upcoming: boolean } {
  if (!isPlainObject(element)) {
    return { offer: null, upcoming: false };
  }
  const title = readString(element['title']);
  const offerId = readString(element['id']);
  if (title === null || offerId === null) {
    return { offer: null, upcoming: false };
  }
  const promotions = element['promotions'];
  if (!isPlainObject(promotions)) {
    return { offer: null, upcoming: false };
  }
  const current = firstFreeWindowInGroups(promotions['promotionalOffers']);
  const upcoming = firstFreeWindowInGroups(promotions['upcomingPromotionalOffers']) !== null;
  if (current === null) {
    return { offer: null, upcoming };
  }
  const pageSlug = readPageSlug(element);
  const price = element['price'];
  const totalPrice = isPlainObject(price) ? price['totalPrice'] : undefined;
  const originalPrice = isPlainObject(totalPrice) ? readNumber(totalPrice['originalPrice']) : null;
  const currencyCode = isPlainObject(totalPrice) ? readString(totalPrice['currencyCode']) : null;
  return {
    offer: {
      sourceId: `epic-free:${offerId}`,
      offerId,
      title,
      pageSlug,
      storeUrl: pageSlug === null ? null : `${EPIC_STORE_PAGE_BASE}${pageSlug}`,
      originalPrice,
      currencyCode,
      startDate: current.startDate,
      endDate: current.endDate,
    },
    upcoming,
  };
}

/** Parse one Epic freeGamesPromotions response body (already JSON-parsed). */
export function parseEpicFreeGamesResponse(body: unknown): EpicFreeGamesParseResult {
  const offers: EpicFreeOffer[] = [];
  let upcomingCount = 0;
  let malformedCount = 0;
  if (!isPlainObject(body)) {
    return { offers, upcomingCount, malformedCount: 1 };
  }
  const data = body['data'];
  if (!isPlainObject(data)) {
    return { offers, upcomingCount, malformedCount: 1 };
  }
  const catalog = data['Catalog'];
  if (!isPlainObject(catalog)) {
    return { offers, upcomingCount, malformedCount: 1 };
  }
  const searchStore = catalog['searchStore'];
  if (!isPlainObject(searchStore)) {
    return { offers, upcomingCount, malformedCount: 1 };
  }
  const elements = searchStore['elements'];
  if (!Array.isArray(elements)) {
    return { offers, upcomingCount, malformedCount: 1 };
  }
  for (const element of elements) {
    const parsed = parseElement(element);
    if (parsed.offer === null) {
      // An element with no usable title/id is malformed; an element that
      // is simply not free right now is not malformed — it is just not
      // an offer. Distinguish by whether the element was even readable.
      if (!isPlainObject(element) || readString(element['title']) === null) {
        malformedCount += 1;
      }
      if (parsed.upcoming) {
        upcomingCount += 1;
      }
      continue;
    }
    if (parsed.upcoming) {
      upcomingCount += 1;
    }
    offers.push(parsed.offer);
  }
  return { offers, upcomingCount, malformedCount };
}

export function createEpicFreeGamesConnector(): SourceConnector {
  return {
    id: 'epic-free-games',
    byteCap: 1_048_576, // JSON API — 1 MiB is ample for the weekly offer list
    plannedRequestCount(_config: Record<string, unknown>): number {
      return 1;
    },
    preflight(
      _config: Record<string, unknown>,
      _secrets: (name: string) => string | undefined,
    ): { ok: true } {
      // Keyless, no config: nothing can block the pre-flight.
      return { ok: true };
    },
    allowedHosts(): readonly string[] {
      return [
        endpointHost(EPIC_FREE_GAMES_ENDPOINT) ?? 'store-site-backend-static.ak.epicgames.com',
      ];
    },
    async fetch(input: ConnectorFetchInput): Promise<ConnectorFetchOutput> {
      const { effects, sourceId, state } = input;
      const response = await fetchWithObservedAttempts(0, () =>
        effects.safeFetch({
          url: EPIC_FREE_GAMES_ENDPOINT,
          headers: { accept: 'application/json' },
          byteCap: 1_048_576,
          timeoutMs: INGESTION_LIMITS.httpTimeoutMs,
          maxRedirects: INGESTION_LIMITS.maxRedirects,
          allowedHosts: ['store-site-backend-static.ak.epicgames.com'],
        }),
      );
      const requestCount = response.requestCount;
      const denial = response.ok ? null : budgetDenialKindOf(response.reason);
      if (denial !== null) {
        return budgetDeniedOutput({
          requestCount,
          cursor: state.cursor,
          etag: state.etag,
          lastModified: state.lastModified,
          retryAfterSeconds: null,
          denialKind: denial,
        });
      }
      if (!response.ok) {
        return failed('http_status_error', requestCount, state.cursor);
      }
      if (response.status === 429) {
        return {
          status: 'rate_limited',
          items: [],
          cursor: state.cursor,
          etag: null,
          lastModified: null,
          retryAfterSeconds: parseRetryAfterSeconds(
            response.headers.get('retry-after'),
            effects.nowMs(),
          ),
          requestCount,
          malformedCount: 0,
          failureReason: null,
        };
      }
      if (response.status < 200 || response.status >= 300) {
        return failed('http_status_error', requestCount, state.cursor);
      }
      if (!isJsonContentType(response.headers.get('content-type'))) {
        return failed('unexpected_content_type', requestCount, state.cursor);
      }
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(response.bodyText) as unknown;
      } catch {
        return failed('response_malformed', requestCount, state.cursor);
      }
      const parsed = parseEpicFreeGamesResponse(parsedBody);
      const items: NormalizedItemOut[] = [];
      let malformed = parsed.malformedCount;
      for (const offer of parsed.offers) {
        const normalized = await normalizeRawItem({
          connector: 'epic-free-games',
          sourceId,
          originLabel: 'epic-free-games',
          raw: {
            id: offer.offerId,
            link: offer.storeUrl,
            title: offer.title,
            bodyText:
              offer.endDate === null
                ? null
                : `Free on the Epic Games Store until ${offer.endDate}.`,
            author: null,
            publishedRaw: offer.startDate,
          },
          stripDownloads: true,
          nowMs: effects.nowMs(),
        });
        if (normalized.ok) {
          items.push(normalized.item);
        } else {
          malformed += 1;
        }
      }
      return {
        status: 'changed',
        items,
        cursor: state.cursor,
        etag: null,
        lastModified: null,
        retryAfterSeconds: null,
        requestCount,
        malformedCount: malformed,
        failureReason: null,
      };
    },
  };
}

function failed(
  reason: ConnectorFetchOutput['failureReason'],
  requestCount: number,
  cursor: string | null,
): ConnectorFetchOutput {
  return {
    status: 'failed',
    items: [],
    cursor,
    etag: null,
    lastModified: null,
    retryAfterSeconds: null,
    requestCount,
    malformedCount: 0,
    failureReason: reason,
  };
}
