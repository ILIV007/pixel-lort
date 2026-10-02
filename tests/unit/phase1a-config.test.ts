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
 * - the local APP_COMMIT placeholder is invalid in production;
 * - issues carry field names/reasons only, never values.
 */

const DEVELOPMENT = 'development' as const;
const PRODUCTION = 'production' as const;

describe('parseDataFoundationConfig — development defaults', () => {
  it('applies documented local defaults when fields are absent', () => {
    const { config, result } = parseDataFoundationConfig({}, DEVELOPMENT);
    expect(result.ok).toBe(true);
    expect(config).not.toBeNull();
    expect(config?.APP_COMMIT).toBe(DEFAULT_APP_COMMIT);
    expect(config?.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(EXPECTED_SCHEMA_VERSION).toBe(1);
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

describe('parseDataFoundationConfig — production guard', () => {
  it('rejects the local development placeholder commit in production', () => {
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

  it('accepts a real commit identifier in production', () => {
    const { config, result } = parseDataFoundationConfig(
      { APP_COMMIT: '1a2b3c4', SCHEMA_VERSION: '1' },
      PRODUCTION,
    );
    expect(result.ok).toBe(true);
    expect(config).toEqual({ APP_COMMIT: '1a2b3c4', schemaVersion: 1 });
  });
});
