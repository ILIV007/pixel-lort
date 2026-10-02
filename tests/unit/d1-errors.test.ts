import { describe, expect, it } from 'vitest';
import { classifyD1Error, toDbAppError } from '../../src/adapters/db/d1-errors';
import { toPublicErrorBody } from '../../src/shared/errors/serialize';

/**
 * Unit tests for the safe D1 error mapping (Phase 1A).
 * Proves stable classification and that raw driver messages never reach the
 * serialized error surface.
 */

describe('classifyD1Error', () => {
  it('maps constraint violations to db_constraint_violation', () => {
    expect(classifyD1Error(new Error('UNIQUE constraint failed: jobs.idempotency_key'))).toBe(
      'db_constraint_violation',
    );
    expect(classifyD1Error(new Error('FOREIGN KEY constraint failed'))).toBe(
      'db_constraint_violation',
    );
    expect(classifyD1Error(new Error('CHECK constraint failed: sources.trust_tier'))).toBe(
      'db_constraint_violation',
    );
    expect(classifyD1Error(new Error('NOT NULL constraint failed: stories.status'))).toBe(
      'db_constraint_violation',
    );
    expect(classifyD1Error(new Error('PRIMARY KEY must be unique'))).toBe(
      'db_constraint_violation',
    );
  });

  it('maps missing schema objects to db_schema_invalid', () => {
    expect(classifyD1Error(new Error('no such table: schema_metadata'))).toBe('db_schema_invalid');
    expect(classifyD1Error(new Error('no such column: stories.bogus'))).toBe('db_schema_invalid');
  });

  it('maps unknown and non-Error shapes to db_query_failed (fail-safe default)', () => {
    expect(classifyD1Error(new Error('SQLITE_ERROR: near "FROMM": syntax error'))).toBe(
      'db_query_failed',
    );
    expect(classifyD1Error(new Error('D1_ERROR: something unexpected'))).toBe('db_query_failed');
    expect(classifyD1Error(undefined)).toBe('db_query_failed');
    expect(classifyD1Error(null)).toBe('db_query_failed');
    expect(classifyD1Error(42)).toBe('db_query_failed');
    expect(classifyD1Error({ message: 123 })).toBe('db_query_failed');
    expect(classifyD1Error(new Error())).toBe('db_query_failed');
  });
});

describe('toDbAppError', () => {
  it('carries a stable safe message and HTTP status, never the raw message', () => {
    const raw = new Error('UNIQUE constraint failed: publications.idempotency_key');
    const mapped = toDbAppError(raw);
    expect(mapped.code).toBe('db_constraint_violation');
    expect(mapped.message).toBe('Database Constraint Violation');
    expect(mapped.status).toBe(409);
    expect(mapped.details).toEqual({});
    expect(mapped.cause).toBe(raw);
  });

  it('serializes to the safe public body without raw internals', () => {
    const raw = new Error('no such table: secret_internal_name');
    const body = toPublicErrorBody(toDbAppError(raw), 'req-db-1');
    const serialized = JSON.stringify(body);
    expect(body.error.code).toBe('db_schema_invalid');
    expect(body.error.message).toBe('Database Schema Invalid');
    expect(serialized).not.toContain('secret_internal_name');
    expect(serialized).not.toContain('no such table');
    expect(serialized).not.toContain('stack');
    expect(serialized).not.toContain('cause');
  });

  it('maps query failures to a 500-class stable code', () => {
    const mapped = toDbAppError(new Error('D1_ERROR: path not found'));
    expect(mapped.code).toBe('db_query_failed');
    expect(mapped.message).toBe('Database Query Failed');
    expect(mapped.status).toBe(500);
  });
});
