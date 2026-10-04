import { describe, expect, it } from 'vitest';
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  isSafeTelegramHtml,
  MAX_TELEGRAM_HTML_LENGTH,
  telegramBold,
  telegramCode,
  telegramLink,
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

  it('composes fragments and every composed output passes the validator', () => {
    const composed = composeTelegramHtml([
      telegramBold('وضعیت'),
      escapeTelegramHtml('سیستم: فعال'),
      telegramCode('1.2.0'),
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
