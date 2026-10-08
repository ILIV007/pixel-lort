import { describe, expect, it } from 'vitest';
import { parseJobsConfig } from '../../src/shared/config/phase3';

/**
 * Phase 3 configuration tests (ADR-0036 §7): the engine flag is fail-closed
 * — absent/empty defaults to disabled; a present-but-invalid value is an
 * issue, never silently coerced; issue notes never carry values.
 */
describe('phase 3 jobs configuration', () => {
  it('defaults to disabled when the flag is absent', () => {
    const { config, result } = parseJobsConfig({});
    expect(config.JOBS_ENABLED).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('parses the enabled flag', () => {
    const { config } = parseJobsConfig({ JOBS_ENABLED: 'true' });
    expect(config.JOBS_ENABLED).toBe(true);
  });

  it('parses the explicit disabled flag', () => {
    const { config } = parseJobsConfig({ JOBS_ENABLED: 'false' });
    expect(config.JOBS_ENABLED).toBe(false);
  });

  it('rejects an invalid flag value without echoing it', () => {
    const { config, result } = parseJobsConfig({ JOBS_ENABLED: 'YES' });
    expect(config.JOBS_ENABLED).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.field).toBe('JOBS_ENABLED');
      expect(result.issues[0]?.reason).toBe('invalid_enum');
      expect(JSON.stringify(result.issues)).not.toContain('YES');
    }
  });
});
