import { describe, expect, it } from 'vitest';
import {
  AppError,
  isAppError,
  toAppError,
  sanitizeDetails,
} from '../../src/shared/errors/app-error';
import { toPublicErrorBody } from '../../src/shared/errors/serialize';

describe('AppError', () => {
  it('maps codes to HTTP statuses', () => {
    expect(new AppError('not_found').status).toBe(404);
    expect(new AppError('bad_request').status).toBe(400);
    expect(new AppError('unauthorized').status).toBe(401);
    expect(new AppError('internal_error').status).toBe(500);
    expect(new AppError('config_invalid').status).toBe(503);
  });

  it('uses safe default messages', () => {
    expect(new AppError('not_found').message).toBe('Not Found');
    expect(new AppError('internal_error').message).toBe('Internal Server Error');
  });

  it('preserves AppError identity through toAppError', () => {
    const original = new AppError('not_found');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps unknown errors as internal_error', () => {
    const wrapped = toAppError(new Error('raw internals'));
    expect(wrapped.code).toBe('internal_error');
    expect(wrapped.message).toBe('Internal Server Error');
    expect(wrapped.cause).toBeInstanceOf(Error);
  });

  it('redacts sensitive keys from details', () => {
    const err = new AppError('bad_request', {
      details: { field: 'LOG_LEVEL', botToken: 'x', authorization: 'y' },
    });
    expect(err.details['field']).toBe('LOG_LEVEL');
    expect(err.details['botToken']).toBe('[REDACTED]');
    expect(err.details['authorization']).toBe('[REDACTED]');
  });

  it('drops non-string detail values', () => {
    const err = new AppError('bad_request', {
      details: { ok: 'yes', sneaky: { nested: 'object' } },
    });
    expect(err.details['ok']).toBe('yes');
    expect(err.details['sneaky']).toBeUndefined();
  });

  it('sanitizeDetails bounds entries and value length', () => {
    const details: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      details[`k${i}`] = 'v'.repeat(300);
    }
    const sanitized = sanitizeDetails(details);
    expect(Object.keys(sanitized).length).toBeLessThanOrEqual(25);
    for (const value of Object.values(sanitized)) {
      expect(value.length).toBeLessThanOrEqual(256);
    }
  });

  it('isAppError distinguishes AppError instances', () => {
    expect(isAppError(new AppError('not_found'))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError('string')).toBe(false);
  });
});

describe('toPublicErrorBody — safe serialization', () => {
  it('exposes only code/message/requestId for known errors', () => {
    const body = toPublicErrorBody(new AppError('not_found'), 'req-1');
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('Not Found');
    expect(body.error.requestId).toBe('req-1');
  });

  it('never includes stack, cause, or raw messages for unknown errors', () => {
    const raw = new Error('private internal detail with token=abc');
    const body = toPublicErrorBody(raw, 'req-2');
    const serialized = JSON.stringify(body);
    expect(body.error.code).toBe('internal_error');
    expect(serialized).not.toContain('private internal detail');
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('cause');
    expect(serialized).not.toContain('token=abc');
  });

  it('includes sanitized details when present', () => {
    const body = toPublicErrorBody(
      new AppError('bad_request', { details: { field: 'LOG_LEVEL' } }),
      'req-3',
    );
    expect(body.error.details).toEqual({ field: 'LOG_LEVEL' });
  });
});
