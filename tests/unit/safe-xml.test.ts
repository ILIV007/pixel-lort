import { describe, expect, it } from 'vitest';
import { scanXmlDocument, decodeXmlEntities } from '../../src/connectors/xml/safe-xml';
import { parseFeedDocument } from '../../src/connectors/xml/feed-reader';

/**
 * Safe XML scanner + feed reader (Phase 4 — ADR-0039 §3): entity safety,
 * bounded structures, malformed feeds fail safe, deterministic field
 * selection for RSS 2.0 and Atom.
 */

describe('scanXmlDocument — entity/structure safety', () => {
  it('rejects DOCTYPE outright', () => {
    const result = scanXmlDocument(
      '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "b">]><rss><channel/></rss>',
    );
    expect(result).toMatchObject({ ok: false, error: { reason: 'doctype_rejected' } });
  });

  it('rejects standalone ENTITY declarations', () => {
    const result = scanXmlDocument('<rss><!ENTITY xxe "value"><channel/></rss>');
    expect(result).toMatchObject({ ok: false, error: { reason: 'entity_decl_rejected' } });
  });

  it('rejects conditional sections', () => {
    const result = scanXmlDocument('<rss><![INCLUDE[<!ENTITY a "b">]]><channel/></rss>');
    expect(result).toMatchObject({ ok: false, error: { reason: 'conditional_section_rejected' } });
  });

  it('decodes the five predefined entities and numeric references', () => {
    expect(decodeXmlEntities('a &amp; b &lt;tag&gt; &quot;q&quot; &apos;p&apos;')).toEqual({
      ok: true,
      text: 'a & b <tag> "q" \'p\'',
    });
    expect(decodeXmlEntities('&#65;&#x42;')).toEqual({ ok: true, text: 'AB' });
  });

  it('rejects unknown named entities (no expansion tables)', () => {
    expect(decodeXmlEntities('&bogus;')).toMatchObject({ ok: false, reason: 'unknown_entity' });
  });

  it('supports CDATA as literal text (first ]]> terminates)', () => {
    const result = scanXmlDocument('<title><![CDATA[Game & <stuff>]]></title>');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const text = result.events.filter((e) => e.kind === 'text');
      expect(text).toHaveLength(1);
      expect((text[0] as { kind: 'text'; text: string }).text).toBe('Game & <stuff>');
    }
  });

  it('enforces the depth bound', () => {
    let deep = '';
    for (let i = 0; i < 100; i++) {
      deep += '<a>';
    }
    const result = scanXmlDocument(`${deep}x`);
    expect(result).toMatchObject({ ok: false, error: { reason: 'depth_exceeded' } });
  });

  it('detects tag mismatch and truncation', () => {
    expect(scanXmlDocument('<a><b></a></b>')).toMatchObject({
      ok: false,
      error: { reason: 'tag_mismatch' },
    });
    expect(scanXmlDocument('<a>unterminated')).toMatchObject({
      ok: false,
      error: { reason: 'tag_mismatch' },
    });
    expect(scanXmlDocument('<a href="unterminated>')).toMatchObject({
      ok: false,
      error: { reason: 'truncated_input' },
    });
  });

  it('skips comments and processing instructions', () => {
    const result = scanXmlDocument(
      '<?xml version="1.0"?><!-- comment --><rss><!--x--><?pi y?><channel/></rss>',
    );
    expect(result.ok).toBe(true);
  });
});

describe('parseFeedDocument — RSS 2.0', () => {
  const rssFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>PlayStation Blog</title>
    <item>
      <title>First &amp; Foremost</title>
      <link>https://blog.playstation.com/article/one</link>
      <guid isPermaLink="false">ps-1</guid>
      <pubDate>Mon, 06 Oct 2025 10:00:00 +0000</pubDate>
      <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
    </item>
    <item>
      <title>Second</title>
      <link>https://blog.playstation.com/article/two?utm_source=rss&amp;id=keep</link>
      <guid>ps-2</guid>
      <dc:creator>Author Name</dc:creator>
      <content:encoded><![CDATA[<p>Body 2</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

  it('extracts bounded items with deterministic field order', async () => {
    const parsed = parseFeedDocument(rssFeed);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.feed.kind).toBe('rss');
      expect(parsed.feed.title).toBe('PlayStation Blog');
      expect(parsed.feed.items).toHaveLength(2);
      expect(parsed.feed.items[0]?.id).toBe('ps-1');
      expect(parsed.feed.items[0]?.link).toBe('https://blog.playstation.com/article/one');
      expect(parsed.feed.items[0]?.title).toBe('First & Foremost');
      expect(parsed.feed.items[0]?.bodyText).toContain('<p>');
      expect(parsed.feed.items[1]?.author).toBe('Author Name');
      expect(parsed.feed.items[1]?.bodyText).toContain('Body 2');
    }
  });

  it('captures guid permalink fallback for isPermaLink="true"', () => {
    const parsed = parseFeedDocument(
      '<rss><channel><item><guid isPermaLink="true">https://example.com/a</guid><title>T</title></item></channel></rss>',
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.feed.items[0]?.guidPermalink).toBe('https://example.com/a');
      expect(parsed.feed.items[0]?.id).toBe('https://example.com/a');
    }
  });

  it('fails safely on a malformed feed', () => {
    expect(parseFeedDocument('<rss><channel><item><title>x</title>')).toMatchObject({
      ok: false,
      reason: 'feed_malformed',
    });
    expect(parseFeedDocument('plain text, no xml')).toMatchObject({
      ok: false,
      reason: 'feed_malformed',
    });
    expect(parseFeedDocument('<html><body>not a feed</body></html>')).toMatchObject({
      ok: false,
      reason: 'feed_malformed',
    });
  });

  it('rejects a feed carrying a DOCTYPE (billion-laughs surface)', () => {
    const hostile =
      '<?xml version="1.0"?><!DOCTYPE bomb [<!ENTITY a "aaaaaaaaaa">]><rss><channel><item><title>&a;</title></item></channel></rss>';
    expect(parseFeedDocument(hostile)).toMatchObject({ ok: false, reason: 'feed_malformed' });
  });
});

describe('parseFeedDocument — Atom', () => {
  const atomFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Eurogamer News</title>
  <entry>
    <id>tag:eurogamer.net,2025:news-1</id>
    <title>Atom Entry</title>
    <link rel="alternate" href="https://www.eurogamer.net/article-1"/>
    <link rel="self" href="https://www.eurogamer.net/feed"/>
    <published>2025-10-06T10:00:00Z</published>
    <updated>2025-10-06T11:00:00Z</updated>
    <summary>Short text</summary>
    <author><name>Jane Writer</name></author>
  </entry>
</feed>`;

  it('selects the alternate link, published time and author name', () => {
    const parsed = parseFeedDocument(atomFeed);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.feed.kind).toBe('atom');
      expect(parsed.feed.items[0]?.id).toBe('tag:eurogamer.net,2025:news-1');
      expect(parsed.feed.items[0]?.link).toBe('https://www.eurogamer.net/article-1');
      expect(parsed.feed.items[0]?.publishedRaw).toBe('2025-10-06T10:00:00Z');
      expect(parsed.feed.items[0]?.author).toBe('Jane Writer');
      expect(parsed.feed.items[0]?.bodyText).toBe('Short text');
    }
  });
});

describe('parseFeedDocument — bounds', () => {
  it('caps items per feed at the bounded limit (keeps newest, no error)', () => {
    const items = Array.from({ length: 130 }, (_, i) => `<item><title>t${i}</title></item>`).join(
      '',
    );
    const feed = `<rss><channel>${items}</channel></rss>`;
    const parsed = parseFeedDocument(feed);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.feed.items).toHaveLength(100);
      expect(parsed.feed.items[0]?.title).toBe('t0');
    }
  });
});
