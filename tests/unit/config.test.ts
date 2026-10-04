import { describe, expect, it } from 'vitest';
import {
  PHASE_0_CONFIG_SPEC,
  parseWorkerConfig,
  FUTURE_SECRET_CATALOG,
} from '../../src/shared/config/phase0';
import { validateConfig } from '../../src/shared/config/validate';
import { defineConfigSpec } from '../../src/shared/config/spec';

describe('validateConfig — Phase 0 subset', () => {
  it('applies safe defaults for an empty environment', () => {
    const result = validateConfig({}, PHASE_0_CONFIG_SPEC);
    expect(result.ok).toBe(true);
    expect(result.config['ENVIRONMENT']).toBe('development');
    expect(result.config['LOG_LEVEL']).toBe('info');
    expect(result.config['APP_VERSION']).toBe('1.2.1');
  });

  it('accepts valid enum values', () => {
    const result = validateConfig(
      { ENVIRONMENT: 'production', LOG_LEVEL: 'warn' },
      PHASE_0_CONFIG_SPEC,
    );
    expect(result.ok).toBe(true);
    expect(result.config['ENVIRONMENT']).toBe('production');
    expect(result.config['LOG_LEVEL']).toBe('warn');
  });

  it('fails on invalid enum values without echoing the value', () => {
    const result = validateConfig({ LOG_LEVEL: 'chatty-value' }, PHASE_0_CONFIG_SPEC);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.field).toBe('LOG_LEVEL');
    expect(result.issues[0]!.reason).toBe('invalid_enum');
    expect(JSON.stringify(result.issues)).not.toContain('chatty-value');
  });

  it('treats empty strings as missing', () => {
    const spec = defineConfigSpec([
      {
        name: 'REQUIRED_VALUE',
        type: 'string',
        required: true,
        secret: false,
        description: 'x',
        phase: 0,
      },
    ]);
    const result = validateConfig({ REQUIRED_VALUE: '' }, spec);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.reason).toBe('missing_required');
  });
});

describe('config errors do not leak secrets', () => {
  const secretSpec = defineConfigSpec([
    { name: 'BOT_TOKEN', type: 'string', required: true, secret: true, description: 't', phase: 2 },
    {
      name: 'LOG_LEVEL',
      type: 'enum',
      required: false,
      secret: false,
      allowed: ['info'],
      description: 'l',
      phase: 0,
    },
  ]);

  it('reports missing required secrets by name only', () => {
    const result = validateConfig({}, secretSpec);
    expect(result.ok).toBe(false);
    expect(result.issues[0]!.field).toBe('BOT_TOKEN');
    expect(result.issues[0]!.reason).toBe('missing_required');
    expect(result.issues[0]!.note).toBe('required secret value is not set (phase 2)');
    // No values exist in the environment, so there is nothing to leak; assert
    // the issue contains only field metadata.
    expect(Object.keys(result.issues[0]!).sort()).toEqual(['field', 'note', 'reason']);
  });

  it('never echoes provided secret values in issues', () => {
    const result = validateConfig(
      { BOT_TOKEN: 'clearly-not-a-real-credential-string', LOG_LEVEL: 'nope' },
      secretSpec,
    );
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result.issues);
    expect(serialized).toContain('LOG_LEVEL');
    expect(serialized).not.toContain('clearly-not-a-real-credential-string');
  });

  it('parseWorkerConfig falls back to safe defaults on invalid input', () => {
    const { config, result } = parseWorkerConfig({ LOG_LEVEL: 42, ENVIRONMENT: 'staging' });
    expect(result.ok).toBe(false);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.ENVIRONMENT).toBe('development');
    expect(config.APP_VERSION).toBe('1.2.1');
  });

  it('parseWorkerConfig accepts well-formed environments', () => {
    const { config, result } = parseWorkerConfig({
      ENVIRONMENT: 'preview',
      LOG_LEVEL: 'debug',
      APP_VERSION: '9.9.9-test',
    });
    expect(result.ok).toBe(true);
    expect(config.ENVIRONMENT).toBe('preview');
    expect(config.LOG_LEVEL).toBe('debug');
    expect(config.APP_VERSION).toBe('9.9.9-test');
  });
});

describe('future secret catalog', () => {
  it('documents the blueprint secret contract without values', () => {
    const names = FUTURE_SECRET_CATALOG.map((s) => s.name);
    for (const expected of [
      'BOT_TOKEN',
      'WEBHOOK_SECRET',
      'OWNER_TELEGRAM_ID',
      'GEMINI_API_KEY',
      'GROQ_API_KEY',
      'YOUTUBE_API_KEY',
      'REDDIT_CLIENT_ID',
      'REDDIT_CLIENT_SECRET',
      'IGDB_CLIENT_ID',
      'IGDB_CLIENT_SECRET',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('rejects duplicate field names in a spec', () => {
    expect(() =>
      defineConfigSpec([
        { name: 'A', type: 'string', required: false, secret: false, description: '', phase: 0 },
        { name: 'A', type: 'string', required: false, secret: false, description: '', phase: 0 },
      ]),
    ).toThrow(/duplicate/);
  });
});
