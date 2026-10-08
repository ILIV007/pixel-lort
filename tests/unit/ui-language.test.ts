import { describe, expect, it } from 'vitest';
import {
  ADMIN_UI_DENIAL_TEXT,
  ADMIN_UI_LANGUAGES,
  ADMIN_UI_STRINGS,
  ADMIN_UI_LANGUAGE_SETTINGS_KEY_PREFIX,
  DEFAULT_ADMIN_UI_LANGUAGE,
  LANGUAGE_SAVED_TEXT,
  LANGUAGE_STALE_TEXT,
  adminUiLanguageSettingsKey,
  isAdminUiLanguage,
  normalizeAdminUiLanguage,
} from '../../src/admin/ui-language';
import { isSafeTelegramHtml } from '../../src/admin/telegram-html';

/**
 * Admin UI language contract tests (v1.2.5, ADR-0034): English default,
 * explicit per-admin selection, strict separation from the editorial
 * language, and namespaced storage keys.
 */

describe('language type and default', () => {
  it('offers exactly English and Persian', () => {
    expect(ADMIN_UI_LANGUAGES).toEqual(['en', 'fa']);
  });

  it('defaults to ENGLISH', () => {
    expect(DEFAULT_ADMIN_UI_LANGUAGE).toBe('en');
  });

  it('guards stored values by exact match only', () => {
    expect(isAdminUiLanguage('en')).toBe(true);
    expect(isAdminUiLanguage('fa')).toBe(true);
    expect(isAdminUiLanguage('EN')).toBe(false);
    expect(isAdminUiLanguage('fr')).toBe(false);
    expect(isAdminUiLanguage('')).toBe(false);
  });

  it('normalizes user-supplied arguments (trim + lowercase)', () => {
    expect(normalizeAdminUiLanguage('EN')).toBe('en');
    expect(normalizeAdminUiLanguage('  Fa ')).toBe('fa');
    expect(normalizeAdminUiLanguage('fa')).toBe('fa');
    expect(normalizeAdminUiLanguage('fr')).toBeUndefined();
    expect(normalizeAdminUiLanguage('')).toBeUndefined();
    expect(normalizeAdminUiLanguage('english')).toBeUndefined();
    expect(normalizeAdminUiLanguage('fa extra')).toBeUndefined();
  });
});

describe('storage key namespace (strict separation)', () => {
  it('namespaces every preference under the dedicated prefix', () => {
    expect(adminUiLanguageSettingsKey(1000000001)).toBe('admin_ui_language:1000000001');
    expect(ADMIN_UI_LANGUAGE_SETTINGS_KEY_PREFIX).toBe('admin_ui_language:');
  });

  it('keeps per-admin keys fully isolated by numeric user id', () => {
    expect(adminUiLanguageSettingsKey(1)).not.toBe(adminUiLanguageSettingsKey(2));
    expect(adminUiLanguageSettingsKey(1000000001)).not.toContain('editorial');
  });
});

describe('admin UI string tables', () => {
  it('provides complete string tables for every supported language', () => {
    for (const language of ADMIN_UI_LANGUAGES) {
      const strings = ADMIN_UI_STRINGS[language] as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(strings)) {
        if (key === 'languageNames') continue;
        expect(typeof (strings as Record<string, unknown>)[key]).toBe('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('names both selectable languages inside each UI language', () => {
    expect(ADMIN_UI_STRINGS.en.languageNames.en).toBe('English');
    expect(ADMIN_UI_STRINGS.en.languageNames.fa).toBe('Persian');
    expect(ADMIN_UI_STRINGS.fa.languageNames.en).toBe('انگلیسی');
    expect(ADMIN_UI_STRINGS.fa.languageNames.fa).toBe('فارسی');
  });

  it('provides saved and stale confirmations for every target/current language', () => {
    for (const language of ADMIN_UI_LANGUAGES) {
      expect(LANGUAGE_SAVED_TEXT[language].length).toBeGreaterThan(0);
      expect(LANGUAGE_STALE_TEXT[language].length).toBeGreaterThan(0);
    }
    // The stale text is honest: it never claims the change was applied.
    expect(LANGUAGE_STALE_TEXT.en).toContain('Not applied');
    expect(LANGUAGE_STALE_TEXT.fa).toContain('اعمال نشد');
  });

  it('keeps the minimal denial in ENGLISH for every unauthorized sender', () => {
    expect(ADMIN_UI_DENIAL_TEXT).toBe('Access denied.');
  });
});

describe('Telegram HTML safety of admin UI strings', () => {
  it('renders every admin surface string as safe Telegram HTML when escaped', () => {
    const fragments: string[] = [];
    for (const language of ADMIN_UI_LANGUAGES) {
      const strings = ADMIN_UI_STRINGS[language] as unknown as Record<string, unknown>;
      for (const value of Object.values(strings)) {
        if (typeof value === 'string') fragments.push(value);
        if (typeof value === 'object' && value !== null) {
          for (const nested of Object.values(value as Record<string, string>)) {
            fragments.push(nested);
          }
        }
      }
    }
    fragments.push(ADMIN_UI_DENIAL_TEXT);
    fragments.push(...Object.values(LANGUAGE_SAVED_TEXT));
    fragments.push(...Object.values(LANGUAGE_STALE_TEXT));
    for (const fragment of fragments) {
      // Persian/RTL text and emoji are inert; no string may smuggle markup.
      const escaped = fragment
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
      expect(isSafeTelegramHtml(escaped)).toBe(true);
    }
  });
});
