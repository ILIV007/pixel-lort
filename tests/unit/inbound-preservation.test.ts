import { describe, expect, it } from 'vitest';
import {
  checkPreservation,
  extractFacts,
  findUnsafeLinks,
} from '../../src/domain/inbound/preservation';

/**
 * Slice 4 — preservation guard (MERGE_MAP §7 step 5, DESIGN §10.1): every
 * URL, game name, version, price, platform and date in the cleaned original
 * MUST survive the AI rewrite, else the pipeline falls back to the cleaned
 * text. Magnet links are never publishable.
 */
describe('inbound preservation', () => {
  const ORIGINAL =
    'تریلر بازی «Elden Ring» منتشر شد. نسخه 1.4.2 برای PS5 و PC با قیمت $59.99 در 2026-11-20 می‌آید: https://example.com/trailer';

  it('extracts urls, versions, prices, platforms, dates and quoted names', () => {
    const facts = extractFacts(ORIGINAL);
    expect(facts.urls).toEqual(['https://example.com/trailer']);
    expect(facts.versions).toContain('1.4.2');
    expect(facts.prices).toContain('$59.99');
    expect(facts.platforms).toContain('PS5');
    expect(facts.platforms).toContain('PC');
    expect(facts.dates).toContain('2026-11-20');
    expect(facts.quotedNames).toContain('Elden Ring');
  });

  it('passes when the rewrite keeps every fact', () => {
    const rewritten =
      'تریلر رسمی «Elden Ring» رسید! نسخه 1.4.2 برای PS5 و PC با قیمت $59.99 از 2026-11-20 در دسترس است: https://example.com/trailer';
    expect(checkPreservation(extractFacts(ORIGINAL), rewritten)).toEqual({
      ok: true,
      missing: [],
    });
  });

  it('fails when the rewrite drops the URL', () => {
    const rewritten =
      'تریلر رسمی «Elden Ring» رسید! نسخه 1.4.2 برای PS5 و PC با قیمت $59.99 از 2026-11-20 در دسترس است.';
    const check = checkPreservation(extractFacts(ORIGINAL), rewritten);
    expect(check.ok).toBe(false);
    expect(check.missing).toContain('https://example.com/trailer');
  });

  it('fails when the rewrite changes the price or version', () => {
    const rewritten =
      'تریلر «Elden Ring» رسید. نسخه 1.5.0 برای PS5 و PC با قیمت $49.99 در 2026-11-20 می‌آید: https://example.com/trailer';
    const check = checkPreservation(extractFacts(ORIGINAL), rewritten);
    expect(check.ok).toBe(false);
    expect(check.missing).toContain('1.4.2');
    expect(check.missing).toContain('$59.99');
  });

  it('fails when the rewrite drops the quoted game name', () => {
    const rewritten =
      'تریلر بازی منتشر شد. نسخه 1.4.2 برای PS5 و PC با قیمت $59.99 در 2026-11-20 می‌آید: https://example.com/trailer';
    const check = checkPreservation(extractFacts(ORIGINAL), rewritten);
    expect(check.ok).toBe(false);
    expect(check.missing).toContain('Elden Ring');
  });

  it('passes for an original with no facts at all', () => {
    expect(checkPreservation(extractFacts('سلام به همه'), 'سلام به همه')).toEqual({
      ok: true,
      missing: [],
    });
  });

  it('finds magnet links as unsafe', () => {
    expect(findUnsafeLinks('دانلود بازی: magnet:?xt=urn:btih:abcdef0123456789')).toEqual([
      'magnet:?xt=urn:btih:abcdef0123456789',
    ]);
    expect(findUnsafeLinks(ORIGINAL)).toEqual([]);
  });
});
