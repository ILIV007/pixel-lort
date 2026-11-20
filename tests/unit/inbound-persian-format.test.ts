import { describe, expect, it } from 'vitest';
import {
  chunkPostText,
  formatInboundPost,
  normalizePersianText,
} from '../../src/domain/inbound/persian-format';

/**
 * Slice 4 — Persian format + normalization (blueprint persona §4, DESIGN
 * §10.1): the deterministic renderer-side normalization (Arabic ي/ك → ی/ک,
 * whitespace) and the chunking that never silently truncates. The footer
 * `👾 @pixellores` is rendered, never modeled.
 */
describe('inbound Persian format', () => {
  it('normalizes Arabic yeh/kaf', () => {
    expect(normalizePersianText('بازي جديد با قيمت عالي')).toBe('بازی جدید با قیمت عالی');
  });

  it('preserves ZWNJ and URLs while normalizing around them', () => {
    const text = 'نیم‌فاصله حفظ می‌شود: https://example.com/trail';
    expect(normalizePersianText(text)).toContain('نیم‌فاصله');
    expect(normalizePersianText(text)).toContain('https://example.com/trail');
  });

  it('collapses repeated blank lines and trims', () => {
    expect(normalizePersianText('  متن\n\n\n\nپاراگراف  ')).toBe('متن\n\nپاراگراف');
  });

  it('chunks a short post into one part with the footer', () => {
    const parts = formatInboundPost({ text: 'تریلر جدید منتشر شد.', media: 'none' });
    expect(parts).toHaveLength(1);
    expect(parts[0]?.text).toContain('تریلر جدید منتشر شد.');
    expect(parts[0]?.text).toContain('👾 @pixellores');
  });

  it('chunks long text on paragraph boundaries with page numbers, footer only on the last part', () => {
    const paragraph = 'متن پاراگراف تکراری برای تست تقسیم‌بندی پست بلند. ';
    const long = Array.from({ length: 200 }, () => paragraph).join('\n\n');
    const parts = formatInboundPost({ text: long, media: 'none' });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(4096);
    }
    expect(parts[0]?.text).toContain('1/');
    expect(parts[parts.length - 1]?.text).toContain('👾 @pixellores');
    expect(parts.slice(0, -1).every((part) => !part.text.includes('👾 @pixellores'))).toBe(true);
  });

  it('never silently truncates: chunkPostText covers the whole input', () => {
    const long = 'کلمه '.repeat(3000);
    const chunks = chunkPostText(long, 4096);
    expect(chunks.join('').replace(/\s+/g, ' ')).toContain('کلمه');
    expect(chunks.every((chunk) => chunk.length <= 4096)).toBe(true);
    // Every word of the input appears in exactly one chunk (no loss, no dup).
    const joinedWords = chunks.join(' ').split(/\s+/).filter(Boolean).length;
    expect(joinedWords).toBe(3000);
  });

  it('keeps a media caption within 1024 and moves the overflow to text parts', () => {
    const longCaption = 'کپشن بلند '.repeat(300);
    const parts = formatInboundPost({ text: longCaption, media: 'photo' });
    expect(parts[0]?.kind).toBe('caption');
    expect(parts[0]?.text.length).toBeLessThanOrEqual(1024);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.slice(1).every((part) => part.kind === 'text')).toBe(true);
    expect(parts[parts.length - 1]?.text).toContain('👾 @pixellores');
  });
});
