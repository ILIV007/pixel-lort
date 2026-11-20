import { describe, expect, it } from 'vitest';
import {
  classifyGamePageUrl,
  classifyOfferKind,
  classicGamePageLink,
  gamePageButton,
  partitionGamePageLinks,
} from '../../src/domain/game-links/game-page-links';

/**
 * Slice 5 — game-page links (DESIGN §10.3): a store-domain allowlist
 * enforced in the renderer. Rich = button, classic = inline link. Any
 * URL outside the allowlist is held for review and NEVER auto-published.
 * Links are informational, NOT purchase links. Free YES, discount NO.
 */

describe('game-page links — store allowlist', () => {
  it('allows the six official stores (exact hosts only)', () => {
    const allowed = [
      'https://store.steampowered.com/app/730/Counter-Strike_2/',
      'https://store.epicgames.com/en-US/p/fortnite',
      'https://www.epicgames.com/store/en-US/p/fortnite',
      'https://store.playstation.com/en-us/product/UP9000-PPSA12345_00-0000000000000000',
      'https://www.playstation.com/en-us/games/god-of-war-ragnarok/',
      'https://www.xbox.com/en-US/games/store/halo-infinite/bn1t8qvqk6mz',
      'https://xbox.com/en-US/games/store/halo-infinite/bn1t8qvqk6mz',
      'https://www.gog.com/game/the_witcher_3_wild_hunt',
      'https://gog.com/game/the_witcher_3_wild_hunt',
      'https://itch.io/games/free',
      'https://www.itch.io/games/free',
    ];
    for (const url of allowed) {
      expect(classifyGamePageUrl(url).ok).toBe(true);
    }
  });

  it('rejects lookalike hosts, subdomains, and non-store domains', () => {
    const held = [
      'https://store.steampowered.com.evil.example/app/730/',
      'https://evil.store.steampowered.com/app/730/',
      'https://steamcommunity.com/app/730/',
      'https://www.g2a.com/game',
      'https://cheapshark.com/redirect?dealID=abc',
      'https://example.com/game',
      'https://store.epicgames.com.evil.example/p/x',
    ];
    for (const url of held) {
      const classified = classifyGamePageUrl(url);
      expect(classified.ok).toBe(false);
      if (!classified.ok) {
        expect(classified.reason).toBe('not_allowlisted');
      }
    }
  });

  it('rejects http, credentials, ports, and non-URLs', () => {
    expect(classifyGamePageUrl('http://store.steampowered.com/app/730/')).toMatchObject({
      ok: false,
      reason: 'not_https',
    });
    expect(classifyGamePageUrl('https://user:pass@store.steampowered.com/app/730/')).toMatchObject({
      ok: false,
      reason: 'has_credentials',
    });
    expect(classifyGamePageUrl('https://store.steampowered.com:8443/app/730/')).toMatchObject({
      ok: false,
      reason: 'has_port',
    });
    expect(classifyGamePageUrl('not a url')).toMatchObject({ ok: false, reason: 'not_a_url' });
    expect(classifyGamePageUrl('')).toMatchObject({ ok: false, reason: 'empty_url' });
    expect(classifyGamePageUrl(42)).toMatchObject({ ok: false, reason: 'not_a_string' });
  });

  it('partitions a mixed list into allowed and held-for-review', () => {
    const { allowed, held } = partitionGamePageLinks([
      'https://store.steampowered.com/app/730/',
      'https://store.epicgames.com/en-US/p/x',
      'https://key-reseller.example/game',
      'http://store.steampowered.com/app/730/',
    ]);
    expect(allowed).toHaveLength(2);
    expect(allowed.map((entry) => entry.store)).toEqual(['steam', 'epic']);
    expect(held).toHaveLength(2);
    expect(held.map((entry) => entry.reason)).toEqual(['not_allowlisted', 'not_https']);
  });
});

describe('game-page links — rendering', () => {
  it('renders a rich button for an allowlisted link and nothing for a held one', () => {
    const button = gamePageButton('https://store.epicgames.com/en-US/p/fortnite');
    expect(button.ok).toBe(true);
    if (button.ok) {
      expect(button.button.store).toBe('epic');
      expect(button.button.url).toBe('https://store.epicgames.com/en-US/p/fortnite');
    }
    expect(gamePageButton('https://key-reseller.example/game')).toMatchObject({
      ok: false,
      reason: 'not_allowlisted',
    });
  });

  it('renders a classic inline link for an allowlisted link and nothing for a held one', () => {
    const link = classicGamePageLink('https://store.steampowered.com/app/730/');
    expect(link.ok).toBe(true);
    if (link.ok) {
      expect(link.html).toBe('<a href="https://store.steampowered.com/app/730/">🎮 صفحهٔ بازی</a>');
    }
    expect(classicGamePageLink('https://example.com/game')).toMatchObject({
      ok: false,
      reason: 'not_allowlisted',
    });
  });

  it('escapes the href attribute (no attribute injection through the URL)', () => {
    const link = classicGamePageLink('https://store.steampowered.com/app/730/?x=1&y=2');
    expect(link.ok).toBe(true);
    if (link.ok) {
      expect(link.html).toContain('?x=1&amp;y=2');
    }
  });
});

describe('game-page links — free vs discount', () => {
  it('only discountPercentage == 0 is a free offer', () => {
    expect(classifyOfferKind(0)).toBe('free');
    expect(classifyOfferKind(50)).toBe('discount');
    expect(classifyOfferKind(100)).toBe('discount');
    expect(classifyOfferKind('0')).toBe('unknown');
    expect(classifyOfferKind(undefined)).toBe('unknown');
    expect(classifyOfferKind(Number.NaN)).toBe('unknown');
  });
});
