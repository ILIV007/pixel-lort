import { describe, expect, it } from 'vitest';
import { cleanInboundText } from '../../src/domain/inbound/cleaner';

/**
 * Slice 4 — inbound cleaner (MERGE_MAP §7 steps 2, DESIGN §10.1): the
 * deterministic clean step before classify/rewrite. Spam, ads, channel
 * mentions, join/follow lines, attribution-only lines, decorative
 * emoji-only lines and AI clichés are stripped; every URL, code fence,
 * version, price, platform and date survives verbatim.
 */
describe('inbound cleaner', () => {
  it('strips join/follow/channel-mention lines but keeps the post body', () => {
    const cleaned = cleanInboundText(
      'تریلر جدید بازی Elden Ring منتشر شد!\nبرای عضویت در کانال ما را دنبال کنید @somechannel\nhttps://example.com/trailer',
    );
    expect(cleaned).toContain('تریلر جدید بازی Elden Ring منتشر شد!');
    expect(cleaned).toContain('https://example.com/trailer');
    expect(cleaned).not.toContain('دنبال کنید');
    expect(cleaned).not.toContain('@somechannel');
  });

  it('strips a bare channel-mention-only line', () => {
    const cleaned = cleanInboundText('پچ 1.4 بازی منتشر شد\n@pixellores');
    expect(cleaned).toContain('پچ 1.4 بازی منتشر شد');
    expect(cleaned).not.toContain('@pixellores');
  });

  it('strips decorative emoji-only lines and AI clichés', () => {
    const cleaned = cleanInboundText(
      '🎉✨🔥🔥🔥\nدر دنیای هیجان‌انگیز بازی‌های ویدیویی، خبر خوش برای گیمرها رسید.\nبازی جدید معرفی شد.',
    );
    expect(cleaned).toContain('بازی جدید معرفی شد.');
    expect(cleaned).not.toContain('🎉✨🔥🔥🔥');
    expect(cleaned).not.toContain('در دنیای هیجان‌انگیز بازی‌های ویدیویی');
    expect(cleaned).not.toContain('خبر خوش برای گیمرها');
  });

  it('strips an as-an-AI disclaimer line', () => {
    const cleaned = cleanInboundText(
      'As an AI language model, I cannot play games.\nتریلر بازی منتشر شد.',
    );
    expect(cleaned).toContain('تریلر بازی منتشر شد.');
    expect(cleaned).not.toContain('As an AI');
  });

  it('preserves code fences, versions, prices, platforms and dates', () => {
    const raw =
      '```\nnpm install pixel@1.4.2\n```\nنسخه 2.0.1 برای PS5 و PC با قیمت $59.99 در 2026-11-20 منتشر می‌شود.';
    const cleaned = cleanInboundText(raw);
    expect(cleaned).toContain('```\nnpm install pixel@1.4.2\n```');
    expect(cleaned).toContain('2.0.1');
    expect(cleaned).toContain('$59.99');
    expect(cleaned).toContain('PS5');
    expect(cleaned).toContain('2026-11-20');
  });

  it('collapses runs of blank lines and trims', () => {
    expect(cleanInboundText('\n\n\nمتن پست\n\n\n\nپاراگراف دوم\n\n')).toBe(
      'متن پست\n\nپاراگراف دوم',
    );
  });

  it('returns an empty string when everything is stripped', () => {
    expect(cleanInboundText('🎉✨🔥\n@somechannel')).toBe('');
  });
});
