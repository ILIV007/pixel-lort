import { describe, expect, it } from 'vitest';
import {
  canonicalizeItemUrl,
  htmlToPlainText,
  truncateBounded,
  parsePublishedTimestamp,
  computeContentHash,
  synthesizedExternalId,
  stripDownloadLinks,
  buildRawProvenance,
  normalizeRawItem,
} from '../../src/connectors/normalize';

/**
 * Normalization contracts (Phase 4 — ADR-0039 §5): deterministic
 * conservative canonicalization, safe plain text, bounded content,
 * download-link policy, provenance bounds.
 */

const NOW = 1_770_000_000_000; // 2026-02-02 — after all fixture timestamps

describe('canonicalizeItemUrl', () => {
  it('lowercases host, preserves path case, drops fragment', () => {
    expect(canonicalizeItemUrl('https://Example.com/News/A#afrag')).toEqual({
      ok: true,
      canonical: 'https://example.com/News/A',
    });
  });

  it('strips ONLY reviewed tracking parameters', () => {
    const result = canonicalizeItemUrl(
      'https://example.com/a?utm_source=rss&fbclid=x&id=7&keepme=1&utm_content=y',
    );
    expect(result.ok && result.canonical).toBe('https://example.com/a?id=7&keepme=1');
  });

  it('sorts query parameters deterministically', () => {
    const a = canonicalizeItemUrl('https://example.com/a?b=2&a=1');
    const b = canonicalizeItemUrl('https://example.com/a?a=1&b=2');
    expect(a).toEqual(b);
  });

  it('keeps provider-meaningful parameters (no over-stripping)', () => {
    const result = canonicalizeItemUrl('https://www.youtube.com/watch?v=abc123&si=trackme');
    expect(result.ok && result.canonical).toBe('https://www.youtube.com/watch?v=abc123');
    // Distinct videos never collapse:
    const other = canonicalizeItemUrl('https://www.youtube.com/watch?v=xyz789');
    expect(other.ok && other.canonical).toBe('https://www.youtube.com/watch?v=xyz789');
  });

  it('rejects unsafe URLs (http, credentials, ports, IP literals)', () => {
    expect(canonicalizeItemUrl('http://example.com/a').ok).toBe(false);
    expect(canonicalizeItemUrl('https://user:pass@example.com/a').ok).toBe(false);
    expect(canonicalizeItemUrl('https://example.com:8443/a').ok).toBe(false);
    expect(canonicalizeItemUrl('https://127.0.0.1/a').ok).toBe(false);
    expect(canonicalizeItemUrl('not a url').ok).toBe(false);
  });
});

describe('htmlToPlainText', () => {
  it('strips tags and decodes bounded entities', () => {
    expect(htmlToPlainText('<p>Hello <b>world</b> &amp; friends</p>')).toBe('Hello world & friends');
  });

  it('removes script and style content entirely', () => {
    expect(htmlToPlainText('<script>alert(1)</script>text<style>a{}</style>end')).toBe('text end');
  });

  it('leaves unknown named entities literal (no expansion tables)', () => {
    expect(htmlToPlainText('a &bogus; b')).toBe('a &bogus; b');
  });

  it('collapses whitespace and strips control characters', () => {
    expect(htmlToPlainText('a\u0000\u0007b\t c')).toBe('ab c');
  });

  it('external HTML never survives as markup', () => {
    const text = htmlToPlainText('<img src=x onerror=alert(1)>caption');
    expect(text).toBe('caption');
    expect(text).not.toContain('<');
  });
});

describe('truncateBounded', () => {
  it('truncates at a char boundary without splitting surrogate pairs', () => {
    const input = '🎮'.repeat(10); // 20 UTF-16 units
    const cut = truncateBounded(input, 5);
    // 5 UTF-16 units hold 2 full emoji (a third would orphan a high surrogate).
    expect(cut).toBe('🎮'.repeat(2));
    expect([...cut]).toHaveLength(2);
  });

  it('returns the input unchanged under the bound', () => {
    expect(truncateBounded('abc', 10)).toBe('abc');
  });
});

describe('parsePublishedTimestamp', () => {
  it('parses RFC-822 and ISO-8601 forms', () => {
    expect(parsePublishedTimestamp('Mon, 06 Oct 2025 10:00:00 +0000', NOW)).not.toBeNull();
    expect(parsePublishedTimestamp('2025-10-06T10:00:00Z', NOW)).not.toBeNull();
  });

  it('returns null for malformed and absurd values', () => {
    expect(parsePublishedTimestamp('not-a-date', NOW)).toBeNull();
    expect(parsePublishedTimestamp(null, NOW)).toBeNull();
    expect(parsePublishedTimestamp('9999-12-31T00:00:00Z', NOW)).toBeNull(); // future outlier
    expect(parsePublishedTimestamp('1969-12-31T23:59:59Z', NOW)).toBeNull();
  });

  it('allows a one-day future slack (clock skew)', () => {
    const soon = NOW + 60 * 60 * 1000;
    expect(parsePublishedTimestamp(new Date(soon).toISOString(), NOW)).toBe(soon);
  });
});

describe('computeContentHash / synthesizedExternalId', () => {
  it('is deterministic across polls', async () => {
    const a = await computeContentHash({
      title: 'T',
      excerpt: 'E',
      publishedAtMs: 5,
      canonicalUrl: 'https://x/a',
    });
    const b = await computeContentHash({
      title: 'T',
      excerpt: 'E',
      publishedAtMs: 5,
      canonicalUrl: 'https://x/a',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs when semantic content differs', async () => {
    const a = await computeContentHash({ title: 'T', excerpt: 'E', publishedAtMs: 5, canonicalUrl: 'https://x/a' });
    const b = await computeContentHash({ title: 'T2', excerpt: 'E', publishedAtMs: 5, canonicalUrl: 'https://x/a' });
    expect(a).not.toBe(b);
  });

  it('synthesizes a bounded deterministic external id', async () => {
    const hash = await computeContentHash({ title: 'T', excerpt: null, publishedAtMs: null, canonicalUrl: null });
    const id = synthesizedExternalId('rss', hash);
    expect(id).toMatch(/^rss:c:[0-9a-f]{16}$/);
  });
});

describe('stripDownloadLinks', () => {
  it('strips magnet and piracy-shaped links, counts them', () => {
    const { text, count } = stripDownloadLinks(
      'get it here magnet:?xt=urn:btih:XYZ or https://piracy.example/game.torrent thanks',
    );
    expect(count).toBe(2);
    expect(text).toBe('get it here or thanks');
  });

  it('keeps ordinary links', () => {
    const { text, count } = stripDownloadLinks('read more https://example.com/post');
    expect(count).toBe(0);
    expect(text).toContain('https://example.com/post');
  });
});

describe('buildRawProvenance', () => {
  it('stays under the byte bound with selected fields only', () => {
    const provenance = buildRawProvenance({
      connector: 'rss',
      sourceId: 'playstation_blog',
      itemId: 'ps-1',
      link: 'https://blog.playstation.com/a',
      publishedRaw: 'Mon, 06 Oct 2025 10:00:00 +0000',
      fetchedAtMs: NOW,
      originLabel: 'https://blog.playstation.com/feed/',
    });
    const serialized = JSON.stringify(provenance);
    expect(serialized.length).toBeLessThanOrEqual(8 * 1024);
    expect(provenance['connector']).toBe('rss');
    expect(provenance['itemId']).toBe('ps-1');
  });

  it('carries NO raw payloads (bounded selected fields only)', () => {
    const provenance = buildRawProvenance({
      connector: 'rss',
      sourceId: 's',
      itemId: 'x'.repeat(300),
      link: null,
      publishedRaw: null,
      fetchedAtMs: NOW,
      originLabel: 'feed',
    });
    expect((provenance['itemId'] as string).length).toBe(256);
  });
});

describe('normalizeRawItem', () => {
  it('normalizes an RSS item end-to-end', async () => {
    const result = await normalizeRawItem({
      connector: 'rss',
      sourceId: 'playstation_blog',
      originLabel: 'https://blog.playstation.com/feed/',
      raw: {
        id: 'ps-1',
        link: 'https://blog.playstation.com/article/one?utm_source=rss',
        title: '<b>Title</b> with markup',
        bodyText: '<p>Body &amp; text</p>',
        author: 'Auth Or',
        publishedRaw: 'Mon, 06 Oct 2025 10:00:00 +0000',
        guidPermalink: null,
      },
      stripDownloads: false,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.externalId).toBe('rss:ps-1');
      expect(result.item.canonicalUrl).toBe('https://blog.playstation.com/article/one');
      expect(result.item.title).toBe('Title with markup');
      expect(result.item.excerpt).toBe('Body & text');
      expect(result.item.publishedAtMs).not.toBeNull();
    }
  });

  it('synthesizes an external id when the feed has none', async () => {
    const result = await normalizeRawItem({
      connector: 'rss',
      sourceId: 's',
      originLabel: 'feed',
      raw: {
        id: null,
        link: null,
        title: 'Only a title',
        bodyText: null,
        author: null,
        publishedRaw: null,
      },
      stripDownloads: false,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.externalId).toMatch(/^rss:c:[0-9a-f]{16}$/);
      expect(result.item.canonicalUrl).toBeNull();
    }
  });

  it('fails safe when there is no title at all', async () => {
    const result = await normalizeRawItem({
      connector: 'rss',
      sourceId: 's',
      originLabel: 'feed',
      raw: { id: 'x', link: null, title: null, bodyText: 'body', author: null, publishedRaw: null },
      stripDownloads: false,
      nowMs: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'title_missing' });
  });

  it('honors stripDownloadLinks on body text', async () => {
    const result = await normalizeRawItem({
      connector: 'reddit-oauth',
      sourceId: 'reddit_crack_signals',
      originLabel: 'reddit-CrackWatch',
      raw: {
        id: 't3_abc',
        link: 'https://www.reddit.com/r/CrackWatch/comments/abc/x/',
        title: 'Status update',
        bodyText: 'crack magnet:?xt=urn:btih:Q no links',
        author: 'u1',
        publishedRaw: null,
      },
      stripDownloads: true,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.item.excerpt).not.toContain('magnet');
      expect(result.strippedDownloadLinkCount).toBe(1);
    }
  });
});
