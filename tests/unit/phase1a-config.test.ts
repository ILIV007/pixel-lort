import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_COMMIT,
  EXPECTED_SCHEMA_VERSION,
  parseDataFoundationConfig,
} from '../../src/shared/config/phase1a';

/**
 * Unit tests for the Phase 1A build/schema metadata configuration
 * (APP_COMMIT / SCHEMA_VERSION — ADR-0020).
 *
 * Guarantees under test:
 * - SCHEMA_VERSION is validated as a STRICT positive decimal integer string;
 * - invalid values NEVER coerce to the default (config is null -> fail closed);
 * - local development defaults are documented and applied when fields are
 *   absent;
 * - the local APP_COMMIT placeholder is invalid in preview AND production;
 * - every non-placeholder commit identifier must match the safe hex format in
 *   all environments (never an arbitrary uncontrolled string);
 * - issues carry field names/reasons only, never values.
 */

const DEVELOPMENT = 'development' as const;
const PREVIEW = 'preview' as const;
const PRODUCTION = 'production' as const;

describe('parseDataFoundationConfig — development defaults', () => {
  it('applies documented local defaults when fields are absent', () => {
    const { config, result } = parseDataFoundationConfig({}, DEVELOPMENT);
    expect(result.ok).toBe(true);
    expect(config).not.toBeNull();
    expect(config?.APP_COMMIT).toBe(DEFAULT_APP_COMMIT);
    expect(config?.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(EXPECTED_SCHEMA_VERSION).toBe(3);
  });

  it('accepts an explicit valid commit identifier and schema version', () => {
    const { config, result } = parseDataFoundationConfig(
      { APP_COMMIT: 'abc1234', SCHEMA_VERSION: '3' },
      DEVELOPMENT,
    );
    expect(result.ok).toBe(true);
    expect(config).toEqual({ APP_COMMIT: 'abc1234', schemaVersion: 3 });
  });
});

describe('parseDataFoundationConfig — strict SCHEMA_VERSION validation', () => {
  it.each(['not-a-number', 'zero', '0', '-1', '01', '1.5', ' 1', '1 ', '+1', '0x10'])(
    'rejects SCHEMA_VERSION %p without coercion (fail closed)',
    (value) => {
      const { config, result } = parseDataFoundationConfig({ SCHEMA_VERSION: value }, DEVELOPMENT);
      expect(result.ok).toBe(false);
      expect(config).toBeNull();
      expect(result.issues.some((issue) => issue.field === 'SCHEMA_VERSION')).toBe(true);
    },
  );

  it('treats an EMPTY SCHEMA_VERSION as absent (documented default applies)', () => {
    // The shared validator treats absent-or-empty uniformly; the local
    // default is then applied — documented behavior, not silent coercion of
    // an INVALID value.
    const { config, result } = parseDataFoundationConfig({ SCHEMA_VERSION: '' }, DEVELOPMENT);
    expect(result.ok).toBe(true);
    expect(config?.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
  });

  it('reports invalid_format issues without echoing the offending value', () => {
    const marker = 'not-an-integer-value';
    const { result } = parseDataFoundationConfig({ SCHEMA_VERSION: marker }, DEVELOPMENT);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.issues)).not.toContain(marker);
    const issue = result.issues.find((entry) => entry.field === 'SCHEMA_VERSION');
    expect(issue?.reason).toBe('invalid_format');
  });
});

describe('parseDataFoundationConfig — APP_COMMIT environment trust rules', () => {
  it('accepts the local placeholder in development (documented default)', () => {
    const { config, result } = parseDataFoundationConfig({}, DEVELOPMENT);
    expect(result.ok).toBe(true);
    expect(config?.APP_COMMIT).toBe(DEFAULT_APP_COMMIT);
  });

  it('accepts a hexadecimal commit identifier in development', () => {
    const { config, result } = parseDataFoundationConfig({ APP_COMMIT: 'abc1234' }, DEVELOPMENT);
    expect(result.ok).toBe(true);
    expect(config?.APP_COMMIT).toBe('abc1234');
  });

  it('rejects an arbitrary uncontrolled commit string even in development', () => {
    const marker = 'not-a-commit-value!';
    const { config, result } = parseDataFoundationConfig({ APP_COMMIT: marker }, DEVELOPMENT);
    expect(result.ok).toBe(false);
    expect(config).toBeNull();
    const issue = result.issues.find((entry) => entry.field === 'APP_COMMIT');
    expect(issue?.reason).toBe('invalid_format');
    expect(JSON.stringify(result.issues)).not.toContain(marker);
  });

  it('rejects the local placeholder in preview', () => {
    const { config, result } = parseDataFoundationConfig(
      { APP_COMMIT: DEFAULT_APP_COMMIT },
      PREVIEW,
    );
    expect(result.ok).toBe(false);
    expect(config).toBeNull();
    const issue = result.issues.find((entry) => entry.field === 'APP_COMMIT');
    expect(issue?.reason).toBe('invalid_value');
  });

  it('rejects the local placeholder in production', () => {
    const { config, result } = parseDataFoundationConfig({}, PRODUCTION);
    expect(result.ok).toBe(false);
    expect(config).toBeNull();
    const issue = result.issues.find((entry) => entry.field === 'APP_COMMIT');
    expect(issue?.reason).toBe('invalid_value');
  });

  it('rejects an explicit local placeholder commit in production', () => {
    const { config, result } = parseDataFoundationConfig(
      { APP_COMMIT: DEFAULT_APP_COMMIT },
      PRODUCTION,
    );
    expect(result.ok).toBe(false);
    expect(config).toBeNull();
  });

  it('accepts a real hexadecimal commit identifier in preview', () => {
    const { config, result } = parseDataFoundationConfig(
      { APP_COMMIT: '322d162b2384c8f1f765470b22194845d1f2bab6' },
      PREVIEW,
    );
    expect(result.ok).toBe(true);
    expect(config?.APP_COMMIT).toBe('322d162b2384c8f1f765470b22194845d1f2bab6');
  });

  it('accepts a real hexadecimal commit identifier in production', () => {
    const { config, result } = parseDataFoundationConfig(
      { APP_COMMIT: '1a2b3c4', SCHEMA_VERSION: '1' },
      PRODUCTION,
    );
    expect(result.ok).toBe(true);
    expect(config).toEqual({ APP_COMMIT: '1a2b3c4', schemaVersion: 1 });
  });

  it('accepts uppercase hexadecimal commit identifiers (case-insensitive format)', () => {
    const { config, result } = parseDataFoundationConfig({ APP_COMMIT: 'ABC1234' }, PRODUCTION);
    expect(result.ok).toBe(true);
    expect(config?.APP_COMMIT).toBe('ABC1234');
  });

  it('accepts a 64-character hexadecimal commit identifier (upper length bound)', () => {
    const full = 'a'.repeat(64);
    const { config, result } = parseDataFoundationConfig({ APP_COMMIT: full }, PRODUCTION);
    expect(result.ok).toBe(true);
    expect(config?.APP_COMMIT).toBe(full);
  });

  it.each([
    'abc123',
    '123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01',
    'xyz1234',
    '1a2b3c4 ',
    '1a2b-3c4',
  ])('rejects unsafe commit format %p outside the 7-64 hex rule (preview)', (value) => {
    const { config, result } = parseDataFoundationConfig({ APP_COMMIT: value }, PREVIEW);
    expect(result.ok).toBe(false);
    expect(config).toBeNull();
    const issue = result.issues.find((entry) => entry.field === 'APP_COMMIT');
    expect(issue?.reason).toBe('invalid_format');
  });

  it('reports placeholder/format issues without echoing the offending value', () => {
    const marker = 'definitely-not-a-commit';
    const { result } = parseDataFoundationConfig({ APP_COMMIT: marker }, PRODUCTION);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.issues)).not.toContain(marker);
  });
});
