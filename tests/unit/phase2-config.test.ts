import { describe, expect, it } from 'vitest';
import {
  BOT_TOKEN_PATTERN,
  OWNER_TELEGRAM_ID_PATTERN,
  TARGET_CHANNEL_PATTERN,
  WEBHOOK_SECRET_MIN_LENGTH,
  WEBHOOK_SECRET_PATTERN,
  parseTelegramPhase2Config,
} from '../../src/shared/config/phase2';

/**
 * Phase 2 configuration contract tests (ADR-0024).
 *
 * All fixture values are obviously-fake shapes that satisfy the documented
 * formats — never realistic credentials (docs/SECURITY_MODEL.md).
 */

const FAKE_BOT_TOKEN = '0000000000:FAKE-FAKE-FAKE-FAKE-FAKE-FAKE-000000';
const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret-0000000000000000000000';
const FAKE_OWNER_ID = '1000000001';
const FAKE_CHANNEL = '@pixel_admin_test_channel';

describe('Phase 2 format patterns', () => {
  it('accepts structurally valid fake bot tokens and rejects malformed shapes', () => {
    expect(BOT_TOKEN_PATTERN.test(FAKE_BOT_TOKEN)).toBe(true);
    expect(BOT_TOKEN_PATTERN.test('12345')).toBe(false);
    expect(BOT_TOKEN_PATTERN.test('abc:defghi')).toBe(false);
    expect(BOT_TOKEN_PATTERN.test('0000000000:short')).toBe(false);
    expect(BOT_TOKEN_PATTERN.test('0000000000:has space in it aaaaaaaaaaaa')).toBe(false);
  });

  it('enforces the documented WEBHOOK_SECRET minimum strength', () => {
    expect(WEBHOOK_SECRET_MIN_LENGTH).toBe(32);
    expect(WEBHOOK_SECRET_PATTERN.test(FAKE_WEBHOOK_SECRET)).toBe(true);
    expect(WEBHOOK_SECRET_PATTERN.test('a'.repeat(31))).toBe(false);
    expect(WEBHOOK_SECRET_PATTERN.test('a'.repeat(32))).toBe(true);
    expect(WEBHOOK_SECRET_PATTERN.test('a'.repeat(257))).toBe(false);
    expect(WEBHOOK_SECRET_PATTERN.test('has whitespace aaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(WEBHOOK_SECRET_PATTERN.test('unicode-éééééééééééééééééééééééééééé')).toBe(false);
  });

  it('enforces the OWNER_TELEGRAM_ID positive safe-integer shape', () => {
    expect(OWNER_TELEGRAM_ID_PATTERN.test(FAKE_OWNER_ID)).toBe(true);
    expect(OWNER_TELEGRAM_ID_PATTERN.test('0')).toBe(false);
    expect(OWNER_TELEGRAM_ID_PATTERN.test('-5')).toBe(false);
    expect(OWNER_TELEGRAM_ID_PATTERN.test('007')).toBe(false);
    expect(OWNER_TELEGRAM_ID_PATTERN.test('abc')).toBe(false);
    expect(OWNER_TELEGRAM_ID_PATTERN.test('1'.repeat(17))).toBe(false);
  });

  it('enforces the safe public-channel username format', () => {
    expect(TARGET_CHANNEL_PATTERN.test(FAKE_CHANNEL)).toBe(true);
    expect(TARGET_CHANNEL_PATTERN.test('pixellort')).toBe(false);
    expect(TARGET_CHANNEL_PATTERN.test('@abc')).toBe(false);
    expect(TARGET_CHANNEL_PATTERN.test('@1abc')).toBe(false);
    expect(TARGET_CHANNEL_PATTERN.test('@bad space')).toBe(false);
    expect(TARGET_CHANNEL_PATTERN.test('@ends_with_underscore_')).toBe(false);
  });
});

describe('parseTelegramPhase2Config — flag semantics', () => {
  it('defaults the ingress flag to disabled when absent', () => {
    const { config, result } = parseTelegramPhase2Config({});
    expect(result.ok).toBe(true);
    expect(config?.ingressEnabled).toBe(false);
  });

  it('treats an invalid flag value as a validation failure (fail closed)', () => {
    const { config, result } = parseTelegramPhase2Config({ TELEGRAM_INGRESS_ENABLED: 'maybe' });
    expect(config).toBeNull();
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.field === 'TELEGRAM_INGRESS_ENABLED')).toBe(true);
  });

  it('enables ingress only for the exact "true" value', () => {
    const enabled = parseTelegramPhase2Config({
      TELEGRAM_INGRESS_ENABLED: 'true',
      BOT_TOKEN: FAKE_BOT_TOKEN,
      WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
      OWNER_TELEGRAM_ID: FAKE_OWNER_ID,
    });
    expect(enabled.result.ok).toBe(true);
    expect(enabled.config?.ingressEnabled).toBe(true);
  });
});

describe('parseTelegramPhase2Config — fail-closed gating', () => {
  const baseEnabled = { TELEGRAM_INGRESS_ENABLED: 'true' };

  it('fails closed when ingress is enabled and secrets are absent', () => {
    const { config, result } = parseTelegramPhase2Config(baseEnabled);
    expect(config).toBeNull();
    expect(result.ok).toBe(false);
    const fields = result.issues.map((i) => i.field).sort();
    expect(fields).toEqual(['BOT_TOKEN', 'OWNER_TELEGRAM_ID', 'WEBHOOK_SECRET']);
  });

  it('fails closed when a required secret is present but invalid while enabled', () => {
    const { config, result } = parseTelegramPhase2Config({
      ...baseEnabled,
      BOT_TOKEN: 'not-a-token',
      WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
      OWNER_TELEGRAM_ID: FAKE_OWNER_ID,
    });
    expect(config).toBeNull();
    expect(
      result.issues.some((i) => i.field === 'BOT_TOKEN' && i.reason === 'invalid_format'),
    ).toBe(true);
  });

  it('rejects an OWNER_TELEGRAM_ID beyond the safe integer range', () => {
    const { config, result } = parseTelegramPhase2Config({
      ...baseEnabled,
      BOT_TOKEN: FAKE_BOT_TOKEN,
      WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET,
      OWNER_TELEGRAM_ID: '9999999999999999', // exceeds Number.MAX_SAFE_INTEGER
    });
    expect(config).toBeNull();
    expect(
      result.issues.some((i) => i.field === 'OWNER_TELEGRAM_ID' && i.reason === 'invalid_value'),
    ).toBe(true);
  });

  it('does not require secrets when the flag is disabled', () => {
    const { config, result } = parseTelegramPhase2Config({});
    expect(result.ok).toBe(true);
    expect(config?.ingressEnabled).toBe(false);
    expect(config?.botToken).toBeUndefined();
  });
});

describe('parseTelegramPhase2Config — value-never-echoed guarantee', () => {
  it('carries field names and reason codes only — never values', () => {
    const { result } = parseTelegramPhase2Config({
      TELEGRAM_INGRESS_ENABLED: 'true',
      BOT_TOKEN: FAKE_BOT_TOKEN.replace('0000000000', 'bad-value!!'),
      WEBHOOK_SECRET: 'short',
      OWNER_TELEGRAM_ID: 'not-numeric',
      TARGET_CHANNEL: 'no-at-sign',
    });
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result.issues);
    expect(serialized).not.toContain(FAKE_BOT_TOKEN);
    expect(serialized).not.toContain('bad-value');
    expect(serialized).not.toContain('no-at-sign');
    for (const issue of result.issues) {
      expect(['missing_required', 'invalid_format', 'invalid_value', 'invalid_enum']).toContain(
        issue.reason,
      );
      expect(issue.field.length).toBeGreaterThan(0);
    }
  });

  it('validates present-but-invalid TARGET_CHANNEL even while disabled', () => {
    const { config, result } = parseTelegramPhase2Config({ TARGET_CHANNEL: 'missing-at' });
    expect(config).toBeNull();
    expect(result.issues.some((i) => i.field === 'TARGET_CHANNEL')).toBe(true);
  });

  it('keeps valid TARGET_CHANNEL in the parsed config', () => {
    const { config, result } = parseTelegramPhase2Config({ TARGET_CHANNEL: FAKE_CHANNEL });
    expect(result.ok).toBe(true);
    expect(config?.targetChannel).toBe(FAKE_CHANNEL);
  });
});
