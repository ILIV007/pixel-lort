import { describe, expect, it } from 'vitest';
import { createLogger, type LogFields } from '../../src/observability/logger';
import { toSafeErrorFields } from '../../src/observability/safe-error';
import { REDACTED_MARKER } from '../../src/observability/redaction';
import { AppError } from '../../src/shared/errors/app-error';
import { fixedClock } from '../../src/shared/time/clock';

interface CapturedLine {
  readonly level: string;
  readonly parsed: Record<string, unknown>;
}

function capture(): { lines: CapturedLine[]; sink: (level: string, line: string) => void } {
  const lines: CapturedLine[] = [];
  return {
    lines,
    sink: (level, line) => {
      lines.push({ level, parsed: JSON.parse(line) as Record<string, unknown> });
    },
  };
}

describe('logger redaction behavior', () => {
  it('redacts the required sensitive keys', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'debug', clock: fixedClock(), sink });

    logger.info('sensitive-fields', {
      authorization: 'Bearer something-long',
      cookie: 'session=value',
      token: 'abc123',
      apiKey: 'key-value',
      api_key: 'key-value-2',
      secret: 's3cr3t',
      password: 'hunter2',
      telegramBotToken: 'plainly-not-a-real-credential',
    });

    expect(lines).toHaveLength(1);
    const parsed = lines[0]!.parsed;
    for (const key of [
      'authorization',
      'cookie',
      'token',
      'apiKey',
      'api_key',
      'secret',
      'password',
      'telegramBotToken',
    ]) {
      expect(parsed[key]).toBe(REDACTED_MARKER);
    }
    expect(JSON.stringify(parsed)).not.toContain('Bearer something-long');
    expect(JSON.stringify(parsed)).not.toContain('hunter2');
  });

  it('redacts sensitive keys nested inside objects and arrays', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'debug', clock: fixedClock(), sink });

    logger.info('nested', {
      context: {
        headers: { Authorization: 'Bearer zzz' },
        meta: { webhookSecret: 'nope' },
      },
      list: [{ password: 'p' }, { safe: 'value' }],
    });

    const parsed = lines[0]!.parsed;
    const context = parsed['context'] as Record<string, unknown>;
    const headers = (context['headers'] as Record<string, unknown>)['Authorization'];
    expect(headers).toBe(REDACTED_MARKER);
    expect((context['meta'] as Record<string, unknown>)['webhookSecret']).toBe(REDACTED_MARKER);
    const list = parsed['list'] as Array<Record<string, unknown>>;
    expect(list[0]!['password']).toBe(REDACTED_MARKER);
    expect(list[1]!['safe']).toBe('value');
  });

  it('does not over-redact innocent keys', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'debug', clock: fixedClock(), sink });

    logger.info('safe-fields', {
      requestId: 'req-1',
      path: '/health',
      status: 200,
      durationMs: 12,
      layoutKey: 'structured_update',
    });

    const parsed = lines[0]!.parsed as LogFields;
    expect(parsed['requestId']).toBe('req-1');
    expect(parsed['path']).toBe('/health');
    expect(parsed['layoutKey']).toBe('structured_update');
  });
});

describe('logger behavior', () => {
  it('emits structured JSON lines with ts, level, msg', () => {
    const { lines, sink } = capture();
    const clock = fixedClock(1_700_000_000_000);
    const logger = createLogger({ level: 'info', clock, sink });

    logger.info('hello', { requestId: 'r-1' });

    const line = lines[0]!;
    expect(line.level).toBe('info');
    expect(line.parsed['ts']).toBe(new Date(1_700_000_000_000).toISOString());
    expect(line.parsed['msg']).toBe('hello');
    expect(line.parsed['requestId']).toBe('r-1');
  });

  it('drops lines below the configured minimum level', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'warn', clock: fixedClock(), sink });

    logger.debug('too chatty');
    logger.info('also filtered');
    logger.warn('kept');
    logger.error('kept too');

    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('merges child logger base fields', () => {
    const { lines, sink } = capture();
    const root = createLogger({ level: 'info', clock: fixedClock(), sink });
    const child = root.child({ requestId: 'req-42', evt: 'fetch' });

    child.info('with-context', { extra: 'value' });

    const parsed = lines[0]!.parsed;
    expect(parsed['requestId']).toBe('req-42');
    expect(parsed['evt']).toBe('fetch');
    expect(parsed['extra']).toBe('value');
  });

  it('redacts sensitive keys placed next to error fields', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'debug', clock: fixedClock(), sink });

    logger.error('failed', { error: new Error('boom'), botToken: 'should-not-appear' });

    const parsed = lines[0]!.parsed;
    expect(parsed['botToken']).toBe(REDACTED_MARKER);
    expect(JSON.stringify(parsed)).not.toContain('should-not-appear');
  });

  it('caps deeply nested structures with a truncation marker', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'debug', clock: fixedClock(), sink });

    const deep: Record<string, unknown> = { leaf: 'value' };
    let cursor = deep;
    for (let i = 0; i < 20; i++) {
      const next: Record<string, unknown> = { child: cursor };
      cursor = next;
    }

    logger.info('deep', { tree: cursor });
    const serialized = JSON.stringify(lines[0]!.parsed);
    expect(serialized).toContain('[TRUNCATED]');
  });
});

describe('fail-safe error logging (ADR-0017)', () => {
  /** Marker embedded inside error strings. Deliberately NOT token-shaped. */
  const EMBEDDED = 'SECRET-VALUE-embedded-in-error';

  it('never emits a raw Error message', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'debug', clock: fixedClock(), sink });

    logger.error('failed', { error: new Error(`provider request failed using ${EMBEDDED}`) });

    const line = lines[0]!;
    const serialized = JSON.stringify(line.parsed);
    expect(serialized).not.toContain(EMBEDDED);
    const errFields = line.parsed['error'] as Record<string, unknown>;
    expect(errFields['errorKind']).toBe('error');
    expect(errFields['name']).toBe('Error');
    expect(errFields['message']).toBeUndefined();
    expect(errFields['stack']).toBeUndefined();
    expect(errFields['cause']).toBeUndefined();
  });

  it('never emits Error stacks, even when the stack contains a secret', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'debug', clock: fixedClock(), sink });
    const error = new Error('failure');
    error.stack = `Error: failure\n    at handler (${EMBEDDED}:1:1)`;

    logger.error('failed', { error });

    const serialized = JSON.stringify(lines[0]!.parsed);
    expect(serialized).not.toContain(EMBEDDED);
    expect(serialized).not.toContain('at handler');
    const errFields = lines[0]!.parsed['error'] as Record<string, unknown>;
    expect(errFields['stack']).toBeUndefined();
  });

  it('never emits Error.cause chains', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'debug', clock: fixedClock(), sink });
    const inner = new Error(`inner failure with ${EMBEDDED}`);
    const outer = new Error(`outer failure with ${EMBEDDED}`, { cause: inner });

    logger.error('failed', { error: outer });

    const serialized = JSON.stringify(lines[0]!.parsed);
    expect(serialized).not.toContain(EMBEDDED);
    expect(serialized).not.toContain('cause');
    expect(serialized).not.toContain('inner failure');
  });

  it('reduces AppError to kind, name, code, and HTTP status only', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'debug', clock: fixedClock(), sink });
    const error = new AppError('service_unavailable', {
      message: `custom override with ${EMBEDDED}`,
      details: { provider: 'primary' },
    });

    logger.error('failed', { error });

    const errFields = lines[0]!.parsed['error'] as Record<string, unknown>;
    expect(errFields).toEqual({
      errorKind: 'app_error',
      name: 'AppError',
      code: 'service_unavailable',
      httpStatus: 503,
    });
    // Custom message and details are dropped: fail-safe by default.
    expect(JSON.stringify(lines[0]!.parsed)).not.toContain(EMBEDDED);
    expect(JSON.stringify(lines[0]!.parsed)).not.toContain('primary');
  });

  it('neutralizes Error instances nested at ANY depth', () => {
    const { lines, sink } = capture();
    const logger = createLogger({ level: 'debug', clock: fixedClock(), sink });

    logger.error('failed', {
      wrapper: { list: [new Error(`deep failure with ${EMBEDDED}`)] },
    });

    const serialized = JSON.stringify(lines[0]!.parsed);
    expect(serialized).not.toContain(EMBEDDED);
    const wrapper = lines[0]!.parsed['wrapper'] as Record<string, unknown>;
    const item = (wrapper['list'] as Array<Record<string, unknown>>)[0]!;
    expect(item['errorKind']).toBe('error');
    expect(item['message']).toBeUndefined();
  });

  it('toSafeErrorFields never stringifies non-Error thrown values', () => {
    expect(toSafeErrorFields(`raw thrown string with ${EMBEDDED}`)).toEqual({
      errorKind: 'unexpected',
      name: 'UnknownThrownValue',
      typeName: '[object String]',
    });
    expect(JSON.stringify(toSafeErrorFields({ hidden: EMBEDDED }))).not.toContain(EMBEDDED);
    expect(toSafeErrorFields(42)).toMatchObject({ errorKind: 'unexpected' });
  });
});
