import { describe, expect, it } from 'vitest';
import { classifyGaming, isSignalOnlyCategory } from '../../src/domain/inbound/classifier';

/**
 * Slice 4 — gaming classifier (MERGE_MAP §7 step 3, DESIGN §10.1): the
 * deterministic, keyword/signal-based classification of a cleaned inbound
 * post into gaming categories. Leak/rumor/crack are signal-only: in
 * `safe-auto` mode they route to approval instead of direct publish.
 */
describe('inbound gaming classifier', () => {
  it('classifies a trailer post', () => {
    const result = classifyGaming('تریلر رسمی بازی GTA VI منتشر شد! تماشا کنید.');
    expect(result.category).toBe('trailer');
    expect(result.confidence).toBe('high');
  });

  it('classifies a patch-notes post', () => {
    const result = classifyGaming('Patch 1.4.2 منتشر شد: باگ‌های بخش آنلاین رفع شدند.');
    expect(result.category).toBe('patch');
  });

  it('classifies a leak as signal-only', () => {
    const result = classifyGaming('لیک جدید: اطلاعات لو‌رفته از بازی بعدی استودیو منتشر شد.');
    expect(result.category).toBe('leak');
    expect(result.signalOnly).toBe(true);
    expect(isSignalOnlyCategory(result.category)).toBe(true);
  });

  it('classifies a rumor as signal-only', () => {
    const result = classifyGaming('شایعه: نسخه ریمیک بازی قدیمی در دست ساخت است.');
    expect(result.category).toBe('rumor');
    expect(result.signalOnly).toBe(true);
  });

  it('classifies a crack-status report as signal-only', () => {
    const result = classifyGaming(
      'Crack Status: بازی توسط گروه EMPRESS کرک شد، قفل Denuvo شکسته شد.',
    );
    expect(result.category).toBe('crack');
    expect(result.signalOnly).toBe(true);
  });

  it('classifies a mod post', () => {
    const result = classifyGaming('ماد جدید برای Skyrim منتشر شد: گرافیک بازی را متحول می‌کند.');
    expect(result.category).toBe('mod');
  });

  it('classifies an esports post', () => {
    const result = classifyGaming('فینال مسابقات جهانی Valorant امشب برگزار می‌شود.');
    expect(result.category).toBe('esports');
  });

  it('classifies a free-game announcement', () => {
    const result = classifyGaming('بازی GTA V این هفته در اپیک گیمز رایگان شد!');
    expect(result.category).toBe('free_game');
  });

  it('classifies a DLC announcement', () => {
    const result = classifyGaming(
      'DLC جدید بازی Elden Ring با نام Shadow of the Erdtree معرفی شد.',
    );
    expect(result.category).toBe('dlc');
  });

  it('falls back to general with low confidence when nothing matches', () => {
    const result = classifyGaming('سلام به همه، امروز هوا خوب است.');
    expect(result.category).toBe('general');
    expect(result.confidence).toBe('low');
    expect(result.signalOnly).toBe(false);
  });

  it('prefers leak over trailer when both signals are present', () => {
    const result = classifyGaming('لیک تریلر بازی جدید لو رفت.');
    expect(result.category).toBe('leak');
  });
});
