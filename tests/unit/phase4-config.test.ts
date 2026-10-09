import { describe, expect, it } from 'vitest';
import { parseIngestionConfig, PHASE_4_CONFIG_SPEC } from '../../src/shared/config/phase4';
import { resolveJobsEngine } from '../../src/application/jobs/engine-env';

/**
 * Phase 4 configuration + activation gating (ADR-0038 §1): the flag is
 * non-secret, default-disabled, validated whenever present, and the gate
 * never touches the existing jobs engine.
 */

describe('SOURCE_INGESTION_ENABLED flag', () => {
  it('defaults to false when absent', () => {
    const { config, result } = parseIngestionConfig({});
    expect(result.ok).toBe(true);
    expect(config.SOURCE_INGESTION_ENABLED).toBe(false);
  });

  it('accepts explicit true/false', () => {
    expect(parseIngestionConfig({ SOURCE_INGESTION_ENABLED: 'true' }).config.SOURCE_INGESTION_ENABLED).toBe(true);
    expect(parseIngestionConfig({ SOURCE_INGESTION_ENABLED: 'false' }).config.SOURCE_INGESTION_ENABLED).toBe(false);
  });

  it('fails any present-but-invalid value (never silently ignored)', () => {
    const { result } = parseIngestionConfig({ SOURCE_INGESTION_ENABLED: 'maybe' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.field).toBe('SOURCE_INGESTION_ENABLED');
      expect(JSON.stringify(result.issues)).not.toContain('maybe');
    }
  });

  it('is declared non-secret in the spec', () => {
    const field = PHASE_4_CONFIG_SPEC.fields.find((f) => f.name === 'SOURCE_INGESTION_ENABLED');
    expect(field?.secret).toBe(false);
    expect(field?.phase).toBe(4);
  });
});

describe('engine resolution with the ingestion gate (no bindings present)', () => {
  it('stays disabled when both flags are absent (Phase 3 default)', () => {
    const resolution = resolveJobsEngine({});
    expect(resolution.kind).toBe('disabled');
  });

  it('fails closed when ingestion is enabled without the jobs engine', () => {
    const resolution = resolveJobsEngine({ SOURCE_INGESTION_ENABLED: 'true' });
    expect(resolution.kind).toBe('config_invalid');
    if (resolution.kind === 'config_invalid') {
      expect(resolution.issues).toContain('ingestion_requires_jobs');
    }
  });

  it('reports config_invalid for an invalid ingestion flag even when jobs are disabled', () => {
    const resolution = resolveJobsEngine({ SOURCE_INGESTION_ENABLED: 'invalid' });
    expect(resolution.kind).toBe('config_invalid');
  });

  it('preserves the jobs-only enabled path (Phase 3 behavior unchanged)', () => {
    // Enabled jobs WITHOUT bindings → binding config_invalid (ADR-0037),
    // NOT an ingestion issue.
    const resolution = resolveJobsEngine({ JOBS_ENABLED: 'true' });
    expect(resolution.kind).toBe('config_invalid');
    if (resolution.kind === 'config_invalid') {
      expect(resolution.issues).toContain('DB:missing_binding');
      expect(resolution.issues).not.toContain('ingestion_requires_jobs');
    }
    // With a (non-functional) DB binding present, the queue bindings fire.
    const withDb = resolveJobsEngine({
      JOBS_ENABLED: 'true',
      DB: {} as unknown as D1Database,
    });
    expect(withDb.kind).toBe('config_invalid');
    if (withDb.kind === 'config_invalid') {
      expect(withDb.issues).toContain('JOBS:missing_binding');
      expect(withDb.issues).toContain('DLQ:missing_binding');
    }
  });
});
