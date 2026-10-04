import { describe, expect, it } from 'vitest';
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  escapeHtmlAttribute,
  isSafeHref,
  isSafeTelegramHtml,
  MAX_TELEGRAM_HTML_LENGTH,
  telegramBold,
  telegramCode,
  telegramLink,
  unescapeHtmlAttribute,
} from '../../src/admin/telegram-html';

/**
 * Telegram-safe HTML formatter tests (Phase 2A).
 * Includes Persian, English, mixed RTL/LTR, emoji, and hostile markup cases.
 */

describe('escapeTelegramHtml', () => {
  it('escapes &, < and >', () => {
    expect(escapeTelegramHtml('a & b')).toBe('a &amp; b');
    expect(escapeTelegramHtml('<b>not bold</b>')).toBe('&lt;b&gt;not bold&lt;/b&gt;');
    expect(escapeTelegramHtml('x > y < z')).toBe('x &gt; y &lt; z');
  });

  it('escapes in entity-safe order (the & first)', () => {
    expect(escapeTelegramHtml('&amp;')).toBe('&amp;amp;');
    expect(escapeTelegramHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('round-trips attribute escaping for its exact entity set', () => {
    expect(escapeHtmlAttribute('a&b"c\'d<e>f')).toBe('a&amp;b&quot;c&#39;d&lt;e&gt;f');
    expect(unescapeHtmlAttribute('a&amp;b&quot;c&#39;d&lt;e&gt;f')).toBe('a&b"c\'d<e>f');
    // Non-canonical entities are left verbatim (validator relies on this).
    expect(unescapeHtmlAttribute('&#38;')).toBe('&#38;');
    expect(unescapeHtmlAttribute('&apos;')).toBe('&apos;');
  });

  it('keeps Persian, RTL marks, mixed RTL/LTR, and emoji intact', () => {
    const persian = 'سلام دنیا؛ وضعیت سیستم';
    expect(escapeTelegramHtml(persian)).toBe(persian);

    const mixed = 'پیکسل Pixel v۱.۲ — رابط کاربری';
    expect(escapeTelegramHtml(mixed)).toBe(mixed);

    const emoji = '🎮 گیمینگ 🕹️ رویداد ✨';
    expect(escapeTelegramHtml(emoji)).toBe(emoji);

    const rtl = '\u200fپیکسل\u200f با نشانه راست‌به‌چپ';
    expect(escapeTelegramHtml(rtl)).toBe(rtl);
  });
});

describe('builder helpers', () => {
  it('emits allowlisted tags with escaped content', () => {
    expect(telegramBold('وضعیت')).toBe('<b>وضعیت</b>');
    expect(telegramCode('<script>')).toBe('<code>&lt;script&gt;</code>');
  });

  it('accepts only https link targets and escapes the text', () => {
    expect(telegramLink('https://example.com/a?b=1', 'منبع > خبر')).toBe(
      '<a href="https://example.com/a?b=1">منبع &gt; خبر</a>',
    );
    expect(() => telegramLink('http://example.com', 'text')).toThrow();
    expect(() => telegramLink('javascript:alert(1)', 'text')).toThrow();
    expect(() => telegramLink('https://example.com/" onload="x', 'text')).toThrow();
  });

  it('accepts query parameters, fragments, and Unicode URLs safely', () => {
    // Raw ampersand in the query is canonical-escaped into the attribute.
    const ampersand = telegramLink('https://example.com/search?q=پیکسل&lang=fa', 'جستجو');
    expect(ampersand).toContain('href="https://example.com/search?q=');
    expect(ampersand).toContain('&amp;lang=fa');
    expect(isSafeTelegramHtml(ampersand)).toBe(true);

    const fragment = telegramLink('https://example.com/docs#section-2', 'مستندات');
    expect(isSafeTelegramHtml(fragment)).toBe(true);

    // Non-ASCII paths are percent-encoded by canonicalization before use.
    const unicode = telegramLink('https://example.com/سلام', 'سلام');
    expect(unicode).toContain('href="https://example.com/%D8%B3%D9%84%D8%A7%D9%85"');
    expect(isSafeTelegramHtml(unicode)).toBe(true);
  });

  it('composes fragments and every composed output passes the validator', () => {
    const composed = composeTelegramHtml([
      telegramBold('وضعیت'),
      escapeTelegramHtml('سیستم: فعال'),
      telegramCode('1.2.3'),
    ]);
    expect(isSafeTelegramHtml(composed)).toBe(true);
  });
});

describe('isSafeTelegramHtml — valid inputs', () => {
  it('accepts plain text, including Persian and emoji', () => {
    expect(isSafeTelegramHtml('سلام دنیا 🎮')).toBe(true);
    expect(isSafeTelegramHtml('Pixel — mixed متن')).toBe(true);
  });

  it('accepts balanced allowlisted tags', () => {
    expect(isSafeTelegramHtml('<b>bold</b> <i>italic</i>')).toBe(true);
    expect(isSafeTelegramHtml('<b><i>both</i></b>')).toBe(true);
    expect(isSafeTelegramHtml('<pre><code>x = 1</code></pre>')).toBe(true);
    expect(isSafeTelegramHtml('<blockquote>نقل</blockquote>')).toBe(true);
    expect(isSafeTelegramHtml('<a href="https://example.com/x">link</a>')).toBe(true);
    expect(isSafeTelegramHtml('<strong>strong</strong> <del>gone</del>')).toBe(true);
  });

  it('accepts escaped entities as inert text', () => {
    expect(isSafeTelegramHtml('&lt;b&gt;not markup&lt;/b&gt;')).toBe(true);
    expect(isSafeTelegramHtml('A &amp; B')).toBe(true);
  });
});

describe('isSafeTelegramHtml — hostile markup', () => {
  it('rejects disallowed and injected tags', () => {
    expect(isSafeTelegramHtml('<script>alert(1)</script>')).toBe(false);
    expect(isSafeTelegramHtml('<img src="x">')).toBe(false);
    expect(isSafeTelegramHtml('<span class="tg-spoiler">spoiler</span>')).toBe(false);
  });

  it('rejects attributes everywhere except a validated href on <a>', () => {
    expect(isSafeTelegramHtml('<b onclick="alert(1)">x</b>')).toBe(false);
    expect(isSafeTelegramHtml("<i class='x'>y</i>")).toBe(false);
    expect(isSafeTelegramHtml('<code lang="fa">x</code>')).toBe(false);
  });

  it('rejects unsafe hrefs on <a>', () => {
    expect(isSafeTelegramHtml('<a>no-href</a>')).toBe(false);
    expect(isSafeTelegramHtml('<a href="javascript:alert(1)">x</a>')).toBe(false);
    expect(isSafeTelegramHtml('<a href="http://example.com">x</a>')).toBe(false);
    expect(isSafeTelegramHtml('<a href="https://evil.com/" onclick="x">y</a>')).toBe(false);
    expect(isSafeTelegramHtml('<a href="https://a b.com">x</a>')).toBe(false);
  });

  it('rejects unbalanced and malformed structures', () => {
    expect(isSafeTelegramHtml('<b>unclosed')).toBe(false);
    expect(isSafeTelegramHtml('</b>stray')).toBe(false);
    expect(isSafeTelegramHtml('<b><i>wrong order</b></i>')).toBe(false);
    expect(isSafeTelegramHtml('<b/>self-closed</b>')).toBe(false);
    expect(isSafeTelegramHtml('<>')).toBe(false);
    expect(isSafeTelegramHtml('a < b and b > c')).toBe(false);
  });

  it('rejects oversized output beyond the message bound', () => {
    const oversized = 'x'.repeat(MAX_TELEGRAM_HTML_LENGTH + 1);
    expect(isSafeTelegramHtml(oversized)).toBe(false);
  });
});

describe('link safety — adversarial href cases (ADR-0029)', () => {
  it('rejects quote-based attribute injection attempts', () => {
    const attempts = [
      'https://example.com/" onmouseover="alert(1)',
      "https://example.com/' onmouseover='alert(1)",
      'https://example.com/x"/><script>alert(1)</script>',
      "https://example.com/'>onload='x",
    ];
    for (const href of attempts) {
      expect(() => telegramLink(href, 'text')).toThrow();
      expect(isSafeHref(href)).toBe(false);
    }
  });

  it('rejects injected extra attributes and tag smuggling', () => {
    const attempts = [
      'https://example.com/"><img src=x onerror=alert(1)>',
      'https://example.com/`onmouseover=`x',
    ];
    for (const href of attempts) {
      expect(() => telegramLink(href, 'text')).toThrow();
    }
  });

  it('rejects raw angle brackets and backticks in targets', () => {
    for (const href of [
      'https://example.com/<b>bold</b>',
      'https://example.com/x>y',
      'https://example.com/`x`',
    ]) {
      expect(isSafeHref(href)).toBe(false);
      expect(() => telegramLink(href, 'text')).toThrow();
    }
  });

  it('encodes raw ampersands into the attribute (never raw & in markup)', () => {
    const link = telegramLink('https://example.com/a?x=1&y=2', 'text');
    expect(link).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(link).not.toMatch(/href="[^"]*&(?!(amp|lt|gt|quot|#39);)[^"]*"/);
    expect(isSafeTelegramHtml(link)).toBe(true);
  });

  it('rejects credentials in URLs', () => {
    for (const href of [
      'https://user:pass@example.com/',
      'https://user@example.com/',
      'https://:pass@example.com/',
    ]) {
      expect(isSafeHref(href)).toBe(false);
      expect(() => telegramLink(href, 'text')).toThrow();
    }
  });

  it('rejects non-https schemes (http, javascript, data, protocol-relative)', () => {
    for (const href of [
      'http://example.com/',
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'ftp://example.com/file',
      '//example.com/path',
      'HTTPS://EXAMPLE.COM/UPPER-OK', // scheme is case-insensitive https — allowed
    ]) {
      if (href === 'HTTPS://EXAMPLE.COM/UPPER-OK') {
        expect(isSafeHref(href)).toBe(true); // canonicalizes to https:
        continue;
      }
      expect(isSafeHref(href)).toBe(false);
      expect(() => telegramLink(href, 'text')).toThrow();
    }
  });

  it('rejects malformed URLs and empty hosts', () => {
    for (const href of ['https://', 'not a url at all', 'https://exa mple.com/', 'ht tp://x']) {
      expect(isSafeHref(href)).toBe(false);
    }
  });

  it('rejects control characters in targets', () => {
    for (const href of [
      'https://example.com/\u0000',
      'https://example.com/\u0007',
      'https://example.com/\n',
      'https://example.com/\r',
      'https://example.com/\t',
    ]) {
      expect(isSafeHref(href)).toBe(false);
    }
  });

  it('keeps the validator and the builder consistent', () => {
    // Every builder output passes the validator...
    for (const href of [
      'https://example.com/',
      'https://example.com/a?b=1&c=2',
      'https://example.com/docs#x',
      'https://sub.domain.example.com/p?q=%D8%B3',
    ]) {
      expect(isSafeTelegramHtml(telegramLink(href, 'متن'))).toBe(true);
    }
    // ...and a forged attribute that the builder would never emit fails.
    for (const forged of [
      '<a href="https://example.com/">x</a><a href="https://x">y</a>',
      '<a href="https://example.com/a&b">x</a>', // raw & — builder emits &amp;
      '<a href="https://example.com/\'x\'">x</a>',
      '<a href="https://example.com/&quot;">x</a>', // decodes to " — hazard
      '<a href="https://example.com/#&lt;">x</a>', // decodes to < — hazard
    ]) {
      expect(isSafeTelegramHtml(forged)).toBe(false);
    }
  });
});
