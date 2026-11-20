/**
 * Game-page links as a first-class element (slice 5; DESIGN §10.3).
 *
 * A game-page link is an INFORMATIONAL link to an official store page —
 * never a purchase link, never a discount/sale post. In a rich message it
 * renders as a button; in a classic HTML post it renders as an inline
 * link. Any URL outside the store-domain allowlist is HELD FOR REVIEW
 * and must never auto-publish.
 *
 * Pure domain module: no I/O, no network, no storage. Every failure is a
 * typed reason, never a thrown exception.
 */

/** The exact store hosts a game-page link may point at (no subdomains beyond these). */
export const GAME_PAGE_STORE_HOSTS: Readonly<Record<string, string>> = {
  'store.steampowered.com': 'steam',
  'store.epicgames.com': 'epic',
  'www.epicgames.com': 'epic',
  'store.playstation.com': 'playstation',
  'www.playstation.com': 'playstation',
  'www.xbox.com': 'xbox',
  'xbox.com': 'xbox',
  'www.gog.com': 'gog',
  'gog.com': 'gog',
  'itch.io': 'itch',
  'www.itch.io': 'itch',
} as const;

export type GamePageStore = (typeof GAME_PAGE_STORE_HOSTS)[keyof typeof GAME_PAGE_STORE_HOSTS];

export type GamePageLinkFailureReason =
  | 'not_a_string'
  | 'empty_url'
  | 'not_a_url'
  | 'not_https'
  | 'has_credentials'
  | 'has_port'
  | 'not_allowlisted';

export type GamePageLinkClassification =
  | {
      readonly ok: true;
      /** The URL exactly as supplied (never rewritten). */
      readonly url: string;
      readonly host: string;
      readonly store: GamePageStore;
    }
  | { readonly ok: false; readonly reason: GamePageLinkFailureReason };

/**
 * Classify ONE candidate game-page URL against the store allowlist.
 * https only; credentials and explicit ports are rejected (a store page
 * never needs either); the host must match the allowlist EXACTLY.
 */
export function classifyGamePageUrl(rawUrl: unknown): GamePageLinkClassification {
  if (typeof rawUrl !== 'string') {
    return { ok: false, reason: 'not_a_string' };
  }
  if (rawUrl.length === 0) {
    return { ok: false, reason: 'empty_url' };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'not_https' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'has_credentials' };
  }
  if (parsed.port !== '') {
    return { ok: false, reason: 'has_port' };
  }
  const host = parsed.hostname.toLowerCase();
  const store = GAME_PAGE_STORE_HOSTS[host];
  if (store === undefined) {
    return { ok: false, reason: 'not_allowlisted' };
  }
  return { ok: true, url: rawUrl, host, store };
}

/** Split a candidate list into allowlisted links and held-for-review links. */
export function partitionGamePageLinks(rawUrls: readonly unknown[]): {
  readonly allowed: readonly Extract<GamePageLinkClassification, { ok: true }>[];
  readonly held: readonly {
    readonly url: unknown;
    readonly reason: GamePageLinkFailureReason;
  }[];
} {
  const allowed: Extract<GamePageLinkClassification, { ok: true }>[] = [];
  const held: { readonly url: unknown; readonly reason: GamePageLinkFailureReason }[] = [];
  for (const rawUrl of rawUrls) {
    const classified = classifyGamePageUrl(rawUrl);
    if (classified.ok) {
      allowed.push(classified);
    } else {
      held.push({ url: rawUrl, reason: classified.reason });
    }
  }
  return { allowed, held };
}

/** The rich-message button for an allowlisted game-page link. */
export interface GamePageButton {
  readonly text: string;
  readonly url: string;
  readonly store: GamePageStore;
}

export type GamePageButtonOutcome =
  | { readonly ok: true; readonly button: GamePageButton }
  | { readonly ok: false; readonly reason: GamePageLinkFailureReason };

/**
 * Build the rich button for a game-page link. A non-allowlisted URL has
 * NO button — the caller must hold it for review instead.
 */
export function gamePageButton(rawUrl: unknown): GamePageButtonOutcome {
  const classified = classifyGamePageUrl(rawUrl);
  if (!classified.ok) {
    return { ok: false, reason: classified.reason };
  }
  return {
    ok: true,
    button: { text: '🎮 صفحهٔ بازی', url: classified.url, store: classified.store },
  };
}

/** Escape a URL for safe embedding inside a classic-HTML href attribute. */
function escapeHrefAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export type ClassicGamePageLinkOutcome =
  | { readonly ok: true; readonly html: string }
  | { readonly ok: false; readonly reason: GamePageLinkFailureReason };

/**
 * Render an allowlisted game-page link as an inline link for a classic
 * HTML post (buttons exist only in rich messages). A non-allowlisted URL
 * renders as NOTHING — the caller holds it for review instead.
 */
export function classicGamePageLink(rawUrl: unknown): ClassicGamePageLinkOutcome {
  const classified = classifyGamePageUrl(rawUrl);
  if (!classified.ok) {
    return { ok: false, reason: classified.reason };
  }
  return {
    ok: true,
    html: `<a href="${escapeHrefAttribute(classified.url)}">🎮 صفحهٔ بازی</a>`,
  };
}

/**
 * Offer-kind guard (DESIGN §10.3: free-game announcements YES,
 * discount/sale posts NO). An Epic-style `discountPercentage` of exactly
 * 0 is a FREE offer; any other number is a discount, never a free-game
 * announcement — the pipeline must not turn it into a post.
 */
export function classifyOfferKind(discountPercentage: unknown): 'free' | 'discount' | 'unknown' {
  if (typeof discountPercentage !== 'number' || !Number.isFinite(discountPercentage)) {
    return 'unknown';
  }
  return discountPercentage === 0 ? 'free' : 'discount';
}
