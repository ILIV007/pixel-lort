import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/observability/logger';
import { logRequestError } from '../../src/entrypoints/http/request-errors';
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

function testLogger(sink: (level: string, line: string) => void) {
  return createLogger({ level: 'debug', clock: fixedClock(), sink }).child({
    requestId: 'req-policy-0001',
  });
}

/**
 * Observability policy for failed requests (ADR-0017):
 * expected 4xx => concise warn; unexpected 5xx => error level; neither path
 * exposes raw stacks or arbitrary thrown values.
 */
describe('request error observability policy (ADR-0017)', () => {
  it('expected 4xx (not_found) logs ONE concise warn event with correlation id', () => {
    const { lines, sink } = capture();
    const logger = testLogger(sink);

    const appError = logRequestError(logger, new AppError('not_found'));

    expect(appError.code).toBe('not_found');
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.level).toBe('warn');
    expect(line.parsed['msg']).toBe('http.request.client_error');
    expect(line.parsed['code']).toBe('not_found');
    expect(line.parsed['httpStatus']).toBe(404);
    expect(line.parsed['requestId']).toBe('req-policy-0001');
    // No raw error object attached at all on the expected-4xx path.
    expect(line.parsed['error']).toBeUndefined();
    expect(JSON.stringify(line.parsed)).not.toContain('stack');
  });

  it('expected 4xx (method_not_allowed) uses the same concise warn path', () => {
    const { lines, sink } = capture();
    const logger = testLogger(sink);

    logRequestError(logger, new AppError('method_not_allowed'));

    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(lines[0]!.parsed['httpStatus']).toBe(405);
  });

  it('unexpected 5xx logs at error level with FAIL-SAFE fields only', () => {
    const { lines, sink } = capture();
    const logger = testLogger(sink);
    // Marker embedded in message + stack; deliberately NOT token-shaped.
    const embedded = 'SECRET-VALUE-in-raw-error';

    const raw = new Error(`db connection failed using ${embedded}`);
    raw.stack = `Error: db connection failed using ${embedded}\n    at handler.js:1:1`;

    const appError = logRequestError(logger, raw);

    expect(appError.code).toBe('internal_error');
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.level).toBe('error');
    expect(line.parsed['msg']).toBe('http.request.failed');
    expect(line.parsed['code']).toBe('internal_error');
    expect(line.parsed['httpStatus']).toBe(500);
    // The RAW thrown value never reaches the logger: logRequestError logs the
    // normalized AppError, which fail-safe collapses to code + status.
    const errFields = line.parsed['error'] as Record<string, unknown>;
    expect(errFields).toEqual({
      errorKind: 'app_error',
      name: 'AppError',
      code: 'internal_error',
      httpStatus: 500,
    });
    const serialized = JSON.stringify(line.parsed);
    expect(serialized).not.toContain(embedded);
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('at handler');
  });

  it('known AppError 5xx keeps the stable code without raw message or details', () => {
    const { lines, sink } = capture();
    const logger = testLogger(sink);

    const thrown = new AppError('service_unavailable', {
      message: 'custom unsafe override',
      details: { provider: 'primary' },
    });
    logRequestError(logger, thrown);

    const line = lines[0]!;
    expect(line.level).toBe('error');
    expect(line.parsed['code']).toBe('service_unavailable');
    expect(line.parsed['httpStatus']).toBe(503);
    const errFields = line.parsed['error'] as Record<string, unknown>;
    expect(errFields).toEqual({
      errorKind: 'app_error',
      name: 'AppError',
      code: 'service_unavailable',
      httpStatus: 503,
    });
    const serialized = JSON.stringify(line.parsed);
    expect(serialized).not.toContain('custom unsafe override');
    expect(serialized).not.toContain('primary');
  });

  it('never stringifies arbitrary non-Error thrown values', () => {
    const { lines, sink } = capture();
    const logger = testLogger(sink);

    const appError = logRequestError(logger, { sneaky: 'SECRET-OBJECT-VALUE' });

    expect(appError.code).toBe('internal_error');
    const line = lines[0]!;
    expect(line.level).toBe('error');
    const errFields = line.parsed['error'] as Record<string, unknown>;
    expect(errFields).toEqual({
      errorKind: 'app_error',
      name: 'AppError',
      code: 'internal_error',
      httpStatus: 500,
    });
    expect(JSON.stringify(line.parsed)).not.toContain('SECRET-OBJECT-VALUE');
  });
});
