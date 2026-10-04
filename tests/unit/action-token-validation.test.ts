import { describe, expect, it } from 'vitest';
import {
  consumeActionToken,
  issueActionToken,
  type IssueActionTokenInput,
} from '../../src/adapters/telegram/action-tokens';
import type { DbExecutor, DbStatement } from '../../src/adapters/db/db-executor';

/**
 * Action-token input validation (Phase 2A correction).
 * Every invalid input must fail BEFORE any database access, and the error
 * message must never echo the rejected value. The DB stub throws if it is
 * touched in any way.
 */

const NOW = 1_700_000_000_000;

/** A DbExecutor whose every method FAILS the test if reached. */
function untouchedExecutor(): DbExecutor {
  const forbidden = (statement: DbStatement): never => {
    throw new Error(`database touched for: ${statement.sql.slice(0, 24)}`);
  };
  const forbiddenBatch = (statements: readonly DbStatement[]): never => {
    throw new Error(`database batch touched for: ${String(statements.length)} statements`);
  };
  return {
    query: forbidden,
    first: forbidden,
    run: forbidden,
    batch: forbiddenBatch,
  };
}

function validIssueInput(overrides: Partial<IssueActionTokenInput> = {}): IssueActionTokenInput {
  return {
    token: 'AAAbbCCCdddEEEff',
    telegramUserId: 2000000002,
    permission: 'draft.approve',
    action: 'draft.approve',
    expiresAtMs: NOW + 60_000,
    nowMs: NOW,
    ...overrides,
  };
}

describe('issueActionToken — input validated before D1 access', () => {
  it('rejects an invalid telegram user id without touching the database', async () => {
    const executor = untouchedExecutor();
    for (const bad of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, '7']) {
      await expect(
        issueActionToken(executor, validIssueInput({ telegramUserId: bad as number })),
      ).rejects.toThrow('action token rejected: invalid telegram user id');
    }
  });

  it('rejects invalid timestamps without touching the database', async () => {
    const executor = untouchedExecutor();
    await expect(issueActionToken(executor, validIssueInput({ nowMs: 0 }))).rejects.toThrow(
      'action token rejected: invalid timestamp',
    );
    await expect(issueActionToken(executor, validIssueInput({ nowMs: -1 }))).rejects.toThrow(
      'action token rejected: invalid timestamp',
    );
    await expect(issueActionToken(executor, validIssueInput({ expiresAtMs: 0 }))).rejects.toThrow(
      'action token rejected: invalid expiry timestamp',
    );
    await expect(
      issueActionToken(executor, validIssueInput({ expiresAtMs: Number.NaN })),
    ).rejects.toThrow('action token rejected: invalid expiry timestamp');
  });

  it('rejects an expiry not later than the current time', async () => {
    const executor = untouchedExecutor();
    await expect(issueActionToken(executor, validIssueInput({ expiresAtMs: NOW }))).rejects.toThrow(
      'action token rejected: expiry must be after the current time',
    );
    await expect(
      issueActionToken(executor, validIssueInput({ expiresAtMs: NOW - 1 })),
    ).rejects.toThrow('action token rejected: expiry must be after the current time');
  });

  it('rejects a token outside the approved callback contract', async () => {
    const executor = untouchedExecutor();
    for (const bad of ['short', 'with space padding padding!', 'invalid!characters!!', '']) {
      await expect(issueActionToken(executor, validIssueInput({ token: bad }))).rejects.toThrow(
        'action token rejected: invalid token format',
      );
    }
  });

  it('rejects a permission outside the approved admin map', async () => {
    const executor = untouchedExecutor();
    for (const bad of ['draft.publish', 'owner.all', 'DROP TABLE', '', 'dashboard.view ']) {
      await expect(
        issueActionToken(executor, validIssueInput({ permission: bad })),
      ).rejects.toThrow('action token rejected: unknown permission');
    }
  });

  it("accepts approved permissions and the owner wildcard ('validation opens' = DB reached)", async () => {
    // The DB stub throws the moment it is touched, so a 'database touched'
    // rejection proves the validation gate OPENED for an approved value.
    const executor = untouchedExecutor();
    for (const permission of ['draft.approve', 'dashboard.view', '*']) {
      await expect(issueActionToken(executor, validIssueInput({ permission }))).rejects.toThrow(
        'database touched',
      );
    }
  });

  it('rejects an invalid action descriptor', async () => {
    const executor = untouchedExecutor();
    for (const bad of ['', 'UPPER', 'has space', 'a'.repeat(65), 'ctrl\u0000char']) {
      await expect(issueActionToken(executor, validIssueInput({ action: bad }))).rejects.toThrow(
        'action token rejected: invalid action descriptor',
      );
    }
  });

  it('rejects oversized, malformed, or non-object payloads', async () => {
    const executor = untouchedExecutor();
    // 300 repeats = 1500 chars > the 1024-byte payload bound (length check
    // fires before JSON parsing).
    await expect(
      issueActionToken(executor, validIssueInput({ payloadJson: '{"x":'.repeat(300) })),
    ).rejects.toThrow('action token rejected: payload too large');
    await expect(
      issueActionToken(executor, validIssueInput({ payloadJson: 'not-json' })),
    ).rejects.toThrow('action token rejected: payload is not valid JSON');
    await expect(
      issueActionToken(executor, validIssueInput({ payloadJson: '[1,2,3]' })),
    ).rejects.toThrow('action token rejected: payload must be a JSON object');
    await expect(
      issueActionToken(executor, validIssueInput({ payloadJson: '42' })),
    ).rejects.toThrow('action token rejected: payload must be a JSON object');
    await expect(
      issueActionToken(executor, validIssueInput({ payloadJson: 'null' })),
    ).rejects.toThrow('action token rejected: payload must be a JSON object');
  });

  it('never echoes the rejected input value in the error', async () => {
    const executor = untouchedExecutor();
    const SECRET_VALUE = 'sensitive-token-value-ABCDEF';
    const error = await issueActionToken(executor, validIssueInput({ token: SECRET_VALUE })).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(SECRET_VALUE);
  });
});

describe('consumeActionToken — input validated before D1 access', () => {
  it('rejects an invalid user id, timestamp, or token without touching the database', async () => {
    const executor = untouchedExecutor();
    await expect(
      consumeActionToken(executor, { token: 'AAAbbCCCdddEEEff', telegramUserId: -1, nowMs: NOW }),
    ).rejects.toThrow('action token rejected');
    await expect(
      consumeActionToken(executor, { token: 'AAAbbCCCdddEEEff', telegramUserId: 5, nowMs: 0 }),
    ).rejects.toThrow('action token rejected');
    await expect(
      consumeActionToken(executor, { token: 'BAD TOKEN SHAPE!', telegramUserId: 5, nowMs: NOW }),
    ).rejects.toThrow('action token rejected: invalid token format');
  });
});
