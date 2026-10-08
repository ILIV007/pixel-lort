import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../../src/entrypoints/worker';
import { applyMigrations } from '../helpers/migrations';
import {
  claimTelegramUpdate,
  markTelegramUpdateFailed,
  markTelegramUpdateProcessed,
  TELEGRAM_UPDATE_CLAIM_LEASE_MS,
} from '../../src/adapters/telegram/update-claims';
import { createDbExecutor, type DbExecutor } from '../../src/adapters/db/db-executor';
import { createTelegramIngress } from '../../src/application/telegram-ingress';
import type { TelegramIngressDeps } from '../../src/application/telegram-ingress';
import { createAuthorizationService } from '../../src/admin/authorization';
import { createCommandRouter } from '../../src/admin/command-router';
import { createAdminRoleLookup } from '../../src/adapters/telegram/admin-lookup';
import type {
  TelegramBotApiClient,
  TelegramSentMessage,
} from '../../src/adapters/telegram/bot-api-client';
import { TelegramApiError } from '../../src/adapters/telegram/bot-api-client';
import type { ParsedUpdate } from '../../src/adapters/telegram/update-parser';
import { fixedClock } from '../../src/shared/time/clock';
import { createLogger, type LogSink } from '../../src/observability/logger';

/**
 * Update lifecycle recovery semantics (Phase 2A second correction round —
 * ADR-0027, completed by ADR-0030/0031/0032; schema v2 via migration 0002).
 *
 * Proves the FULL lifecycle:
 * - a retryable failure never answers 200; the row is failed with
 *   failure_class='retryable' and is atomically reclaimable on redelivery;
 * - a claim LEASE makes abandoned claims recoverable: an active lease is
 *   honored (in-flight -> safe 503, never a false-success 200), an expired
 *   lease is atomically reclaimed by exactly one winner;
 * - a PERMANENT failure is terminal: executed at most once, later
 *   deliveries answer 200 without executing (never reclaimable);
 * - marking-failure sequences still recover through lease expiry;
 * - the documented AMBIGUOUS WINDOW (ADR-0032): a failure after an outbound
 *   success but before the processed transition can re-send the message on
 *   recovery — durable at-least-once processing with bounded duplicate risk,
 *   NOT exactly-once delivery.
 * All offline — fake clients and the local workerd D1 binding only.
 */

const OWNER_ID = 1000000001;
const NOW = 1_700_000_000_000;
const LEASE = TELEGRAM_UPDATE_CLAIM_LEASE_MS;
const WEBHOOK_SECRET = 'test-webhook-secret-0000000000000000';

function testCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

const ENABLED_ENV = {
  TELEGRAM_INGRESS_ENABLED: 'true',
  WEBHOOK_SECRET,
  OWNER_TELEGRAM_ID: String(OWNER_ID),
  // No BOT_TOKEN: offline mode — outbound actions fail RETRYABLY (503),
  // which is exactly the behavior under test at the webhook edge.
  DB: env.DB,
};

beforeEach(async () => {
  await applyMigrations(env.DB);
  const executor = createDbExecutor(env.DB);
  await executor.run({ sql: 'DELETE FROM telegram_updates' });
});

function ownerStatusBody(updateId: number): string {
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: OWNER_ID },
      from: { id: OWNER_ID },
      text: '/status',
    },
  });
}

function webhookRequest(body: string): Request {
  return new Request('https://example.com/telegram/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
    },
    body,
  });
}

interface LifecycleRow {
  status: string;
  claim_expires_at: number | null;
  failure_class: string | null;
  attempt_count: number;
  processed_at: number | null;
}

async function readRow(updateId: number): Promise<LifecycleRow | null> {
  const executor = createDbExecutor(env.DB);
  return executor.first<LifecycleRow>({
    sql: `SELECT status, claim_expires_at, failure_class, attempt_count, processed_at
          FROM telegram_updates WHERE update_id = ?`,
    params: [updateId],
  });
}

/** Flaky fake client: fails the first N sendMessage CALLS with `error`. */
function flakyClient(
  error: TelegramApiError | undefined,
  failuresBeforeSuccess = 0,
): {
  client: TelegramBotApiClient;
  sends: { chatId: number; text: string }[];
  calls: () => number;
} {
  const sends: { chatId: number; text: string }[] = [];
  let calls = 0;
  const client: TelegramBotApiClient = {
    async getMe() {
      return { id: 42, username: 'pixel_admin_bot' };
    },
    async sendMessage(input) {
      calls += 1;
      if (error !== undefined && calls <= failuresBeforeSuccess) {
        throw error;
      }
      sends.push({ chatId: input.chatId, text: input.text });
      const message: TelegramSentMessage = { messageId: sends.length };
      return message;
    },
    async editMessageText() {
      return true;
    },
    async answerCallbackQuery() {},
  };
  return { client, sends, calls: () => calls };
}

/** Wrap the real executor to reject terminal-state transitions while armed. */
function interceptingExecutor(shouldReject: (statement: { sql: string }) => boolean): {
  executor: DbExecutor;
  setArmed: (armed: boolean) => void;
} {
  const delegate = createDbExecutor(env.DB);
  let armed = true;
  const executor: DbExecutor = {
    query: (statement) => delegate.query(statement),
    first: (statement) => delegate.first(statement),
    run: (statement) => {
      if (armed && shouldReject(statement)) {
        return Promise.reject(new Error('simulated D1 outage during terminal transition'));
      }
      return delegate.run(statement);
    },
    batch: (statements) => delegate.batch(statements),
  };
  return { executor, setArmed: (value) => (armed = value) };
}

function buildDeps(overrides: Partial<TelegramIngressDeps> = {}): TelegramIngressDeps {
  const executor = overrides.executor ?? createDbExecutor(env.DB);
  return {
    executor,
    authorization:
      overrides.authorization ??
      createAuthorizationService({
        ownerTelegramId: OWNER_ID,
        lookup: createAdminRoleLookup(executor),
      }),
    commandRouter: overrides.commandRouter ?? createCommandRouter({ applicationVersion: '1.2.3' }),
    botApi: overrides.botApi,
    clock: overrides.clock ?? fixedClock(NOW),
    logger: overrides.logger ?? createLogger({ level: 'error', sink: () => {} }),
  };
}

function ownerCommand(updateId: number): ParsedUpdate {
  return {
    kind: 'message',
    updateId,
    messageId: updateId,
    chatId: OWNER_ID,
    fromUserId: OWNER_ID,
    text: '/status',
    command: 'status',
  };
}

describe('webhook edge — retryable failure is never falsely acknowledged', () => {
  it('answers 503 (service_unavailable) when an outbound action has no client', async () => {
    const res = await worker.fetch(webhookRequest(ownerStatusBody(8600)), ENABLED_ENV, testCtx());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('service_unavailable');
    // The update is NOT processed — it is failed (retryable) and reclaimable.
    const row = await readRow(8600);
    expect(row?.status).toBe('failed');
    expect(row?.failure_class).toBe('retryable');
    expect(row?.claim_expires_at).toBeNull();
  });

  it('completes a noop update safely without a client (200, processed)', async () => {
    const res = await worker.fetch(
      webhookRequest(JSON.stringify({ update_id: 8601, channel_post: { message_id: 1 } })),
      ENABLED_ENV,
      testCtx(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await readRow(8601))?.status).toBe('processed');
  });

  it('redelivers after the 503 and the reclaim path re-claims the same update', async () => {
    const body = ownerStatusBody(8602);
    const first = await worker.fetch(webhookRequest(body), ENABLED_ENV, testCtx());
    expect(first.status).toBe(503);
    expect((await readRow(8602))?.status).toBe('failed');

    // Telegram redelivers the same update_id. The retry STILL cannot send
    // (still offline), so it fails again — but via the RECLAIM path, not a
    // duplicate ack: the redelivery must be re-claimed, not acknowledged as
    // already processed.
    const executor = createDbExecutor(env.DB);
    const reclaim = await claimTelegramUpdate(executor, 8602, NOW + 1_000);
    expect(reclaim).toEqual({ kind: 'reclaimed_retryable', attemptCount: 2 });
  });

  it('answers safe 503 for an IN-FLIGHT update and recovers it after lease expiry', async () => {
    // FIX 1.4 (ADR-0030): an update under an ACTIVE lease owned by another
    // delivery must NOT be acknowledged as a successful duplicate — Telegram
    // would stop redelivering before an abandoned claim becomes stale.
    // The worker webhook runs on the real system clock, so the seeded claim
    // must be based on the real current time for its lease to be ACTIVE.
    const executor = createDbExecutor(env.DB);
    const realNow = Date.now();
    const claim = await claimTelegramUpdate(executor, 8603, realNow);
    expect(claim).toEqual({ kind: 'claimed', attemptCount: 1 });

    const body = JSON.stringify({ update_id: 8603, channel_post: { message_id: 1 } });
    const inFlight = await worker.fetch(webhookRequest(body), ENABLED_ENV, testCtx());
    expect(inFlight.status).toBe(503);
    expect((await inFlight.json()) as { error: Record<string, unknown> }).toMatchObject({
      error: { code: 'service_unavailable' },
    });
    // Still claimed, still under the original lease.
    expect((await readRow(8603))?.status).toBe('claimed');
    expect((await readRow(8603))?.attempt_count).toBe(1);

    // Simulate lease expiry (the other Worker died after claiming).
    await executor.run({
      sql: 'UPDATE telegram_updates SET claim_expires_at = ? WHERE update_id = ?',
      params: [Date.now() - 1_000, 8603],
    });

    // The next delivery reclaims the abandoned claim and processes it.
    const recovered = await worker.fetch(webhookRequest(body), ENABLED_ENV, testCtx());
    expect(recovered.status).toBe(200);
    const row = await readRow(8603);
    expect(row?.status).toBe('processed');
    expect(row?.attempt_count).toBe(2);
  });

  it('answers 200 without executing for a TERMINAL permanently-failed update', async () => {
    // FIX 2 (ADR-0031): seed a permanent failure, then deliver again.
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 8604, NOW);
    await markTelegramUpdateFailed(executor, 8604, 1, NOW + 10, 'permanent');

    const res = await worker.fetch(webhookRequest(ownerStatusBody(8604)), ENABLED_ENV, testCtx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Row untouched: still failed/permanent, no reclaim, no re-execution.
    const row = await readRow(8604);
    expect(row?.status).toBe('failed');
    expect(row?.failure_class).toBe('permanent');
    expect(row?.attempt_count).toBe(1);
  });
});

describe('claim boundary — reclaim semantics (ADR-0030/0031)', () => {
  it('reclaims a failed retryable update exactly once and records the claimed state', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 8610, NOW);
    await markTelegramUpdateFailed(executor, 8610, 1, NOW + 10, 'retryable');

    const reclaim = await claimTelegramUpdate(executor, 8610, NOW + 20_000);
    expect(reclaim).toEqual({ kind: 'reclaimed_retryable', attemptCount: 2 });

    const row = await executor.first<{ status: string; processed_at: number | null }>({
      sql: 'SELECT status, processed_at FROM telegram_updates WHERE update_id = ?',
      params: [8610],
    });
    expect(row?.status).toBe('claimed');
    expect(row?.processed_at).toBeNull();
  });

  it('never reclaims a processed update (terminal)', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 8611, NOW);
    await markTelegramUpdateProcessed(executor, 8611, 1, NOW + 10);

    const redelivery = await claimTelegramUpdate(executor, 8611, NOW + 20_000);
    expect(redelivery).toEqual({ kind: 'already_processed' });
  });

  it('never reclaims a permanent failed update (terminal)', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 8612, NOW);
    await markTelegramUpdateFailed(executor, 8612, 1, NOW + 10, 'permanent');

    const redelivery = await claimTelegramUpdate(executor, 8612, NOW + 20_000);
    expect(redelivery).toEqual({ kind: 'permanently_failed' });
  });

  it('acknowledges an active-lease claim as in_flight (not a successful duplicate)', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 8613, NOW);
    const second = await claimTelegramUpdate(executor, 8613, NOW + 1_000);
    expect(second).toEqual({ kind: 'in_flight' });
  });

  it('reclaims an expired-lease claim as reclaimed_stale', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 8614, NOW);
    // Lease is active one millisecond before expiry...
    await expect(claimTelegramUpdate(executor, 8614, NOW + LEASE - 1)).resolves.toEqual({
      kind: 'in_flight',
    });
    // ...stale at exact expiry...
    await expect(claimTelegramUpdate(executor, 8614, NOW + LEASE)).resolves.toEqual({
      kind: 'reclaimed_stale',
      attemptCount: 2,
    });
  });

  it('produces exactly one winner for concurrent retryable-failed reclaims', async () => {
    const executor = createDbExecutor(env.DB);
    await claimTelegramUpdate(executor, 8615, NOW);
    await markTelegramUpdateFailed(executor, 8615, 1, NOW + 10, 'retryable');

    const results = await Promise.all([
      claimTelegramUpdate(executor, 8615, NOW + 20_000),
      claimTelegramUpdate(executor, 8615, NOW + 20_000),
      claimTelegramUpdate(executor, 8615, NOW + 20_000),
    ]);

    const reclaims = results.filter((r) => r.kind === 'reclaimed_retryable');
    const inFlight = results.filter((r) => r.kind === 'in_flight');
    expect(reclaims).toHaveLength(1);
    expect(inFlight).toHaveLength(2);
  });

  it('produces exactly one winner for concurrent stale-claim reclaims', async () => {
    const executor = createDbExecutor(env.DB);
    // Abandoned claim: written in the past, lease long expired.
    await claimTelegramUpdate(executor, 8616, NOW - 3 * LEASE);

    const results = await Promise.all([
      claimTelegramUpdate(executor, 8616, NOW),
      claimTelegramUpdate(executor, 8616, NOW),
      claimTelegramUpdate(executor, 8616, NOW),
    ]);

    const reclaims = results.filter((r) => r.kind === 'reclaimed_stale');
    const inFlight = results.filter((r) => r.kind === 'in_flight');
    expect(reclaims).toHaveLength(1);
    expect(inFlight).toHaveLength(2);
  });
});

describe('ingress pipeline — retryable vs permanent failures', () => {
  it('propagates 503 semantics for a retryable Bot API failure and marks failed', async () => {
    const { client } = flakyClient(
      new TelegramApiError('telegram_rate_limited', { retryAfterMs: 5_000 }),
      10_000,
    );
    const executor = createDbExecutor(env.DB);
    const ingress = createTelegramIngress(buildDeps({ executor, botApi: client }));

    await expect(ingress.processUpdate(ownerCommand(8620))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    const row = await readRow(8620);
    expect(row?.status).toBe('failed');
    expect(row?.failure_class).toBe('retryable');
  });

  it('reclaims on redelivery and the retry ends as processed (executes once)', async () => {
    const { client, sends } = flakyClient(new TelegramApiError('telegram_timeout'), 1);
    const ingress = createTelegramIngress(buildDeps({ botApi: client }));

    // First delivery: retryable timeout -> 503 propagation, row failed.
    await expect(ingress.processUpdate(ownerCommand(8621))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect((await readRow(8621))?.status).toBe('failed');

    // Redelivery reclaims the failed row and succeeds.
    await expect(ingress.processUpdate(ownerCommand(8621))).resolves.toBe('processed');
    expect((await readRow(8621))?.status).toBe('processed');
    // Exactly ONE outbound execution across both deliveries.
    expect(sends).toHaveLength(1);

    // A third delivery is a duplicate of the processed (terminal) row.
    await expect(ingress.processUpdate(ownerCommand(8621))).resolves.toBe('duplicate');
    expect(sends).toHaveLength(1);
  });

  it('executes a permanent failure AT MOST ONCE and never re-executes it', async () => {
    const { client, sends, calls } = flakyClient(
      new TelegramApiError('telegram_bad_request'),
      10_000,
    );
    const ingress = createTelegramIngress(buildDeps({ botApi: client }));

    // Permanent: resolves (200 semantics — Telegram does NOT redeliver after
    // a 200, so there is no retry loop), marked failed(permanent), NOT
    // re-executed.
    await expect(ingress.processUpdate(ownerCommand(8622))).resolves.toBe('failed');
    const row = await readRow(8622);
    expect(row?.status).toBe('failed');
    expect(row?.failure_class).toBe('permanent');
    expect(calls()).toBe(1);
    expect(sends).toHaveLength(0);

    // Every later delivery (manual/operative or Telegram redelivery) observes
    // the TERMINAL permanently_failed outcome: acknowledged without executing.
    await expect(ingress.processUpdate(ownerCommand(8622))).resolves.toBe('failed');
    await expect(ingress.processUpdate(ownerCommand(8622))).resolves.toBe('failed');
    expect(calls()).toBe(1);
    expect(sends).toHaveLength(0);
    expect((await readRow(8622))?.attempt_count).toBe(1);
  });

  it('propagates 503 for database/service unavailability during processing', async () => {
    const { client } = flakyClient(new TelegramApiError('telegram_network_error'));
    const failingAuthorization = {
      resolveActor: async () => {
        throw new Error('simulated transient D1 outage');
      },
    };
    const executor = createDbExecutor(env.DB);
    const ingress = createTelegramIngress(
      buildDeps({ executor, authorization: failingAuthorization, botApi: client }),
    );

    await expect(ingress.processUpdate(ownerCommand(8623))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect((await readRow(8623))?.status).toBe('failed');
  });

  it('never marks an outbound update processed when the client is missing', async () => {
    const executor = createDbExecutor(env.DB);
    const ingress = createTelegramIngress(buildDeps({ executor, botApi: undefined }));

    await expect(ingress.processUpdate(ownerCommand(8624))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect((await readRow(8624))?.status).toBe('failed');
  });

  it('completes a noop update without a client (offline-safe)', async () => {
    const executor = createDbExecutor(env.DB);
    const ingress = createTelegramIngress(buildDeps({ executor, botApi: undefined }));

    await expect(ingress.processUpdate({ kind: 'unsupported', updateId: 8625 })).resolves.toBe(
      'processed',
    );
    expect((await readRow(8625))?.status).toBe('processed');
  });
});

describe('lease recovery — the row stays claimed when even the failure marking fails', () => {
  it('recovers the whole sequence: 503 -> in-flight 503 -> lease expiry -> reclaim -> processed', async () => {
    // FIX 1.5 (ADR-0030): the full abandonment-and-recovery sequence.
    const { executor, setArmed } = interceptingExecutor((statement) =>
      // Reject ONLY terminal-state transitions (processed/failed marking);
      // the claim INSERT and the guarded reclaims must keep working.
      /UPDATE telegram_updates\s+SET status = '(processed|failed)'/s.test(statement.sql),
    );
    const { client, sends } = flakyClient(new TelegramApiError('telegram_timeout'), 1);
    const ingress = createTelegramIngress(buildDeps({ executor, botApi: client }));

    // 1. Processing fails retryably AND marking the failure fails -> 503,
    //    the row remains claimed under its lease.
    await expect(ingress.processUpdate(ownerCommand(8630))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    const stranded = await readRow(8630);
    expect(stranded?.status).toBe('claimed');
    expect(stranded?.claim_expires_at).toBe(NOW + LEASE);
    expect(stranded?.attempt_count).toBe(1);

    // 2. The next delivery is in-flight (active lease) -> safe 503 again,
    //    never a false-success 200.
    await expect(ingress.processUpdate(ownerCommand(8630))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect((await readRow(8630))?.attempt_count).toBe(1);

    // 3. The lease expires (simulated time passage) and the terminal
    //    transitions recover — a later delivery atomically reclaims the
    //    abandoned claim, executes the action, and completes.
    const realExecutor = createDbExecutor(env.DB);
    await realExecutor.run({
      sql: 'UPDATE telegram_updates SET claim_expires_at = ? WHERE update_id = ?',
      params: [NOW - 1, 8630],
    });
    setArmed(false);

    await expect(ingress.processUpdate(ownerCommand(8630))).resolves.toBe('processed');
    const row = await readRow(8630);
    expect(row?.status).toBe('processed');
    expect(row?.attempt_count).toBe(2);
    // Exactly one outbound execution across the whole recovery sequence.
    expect(sends).toHaveLength(1);
  });
});

describe('honest side-effect semantics — the ambiguous window (ADR-0032)', () => {
  it('a failure after an outbound success but before the processed transition re-sends on recovery', async () => {
    // DOCUMENTED SCENARIO (FIX 3): Telegram accepts sendMessage; the Worker
    // then loses the processed transition (D1 failure). The delivery is
    // ambiguous: the message WAS sent, but the durable row can never know.
    // After lease expiry the next delivery re-executes the action — the
    // message is delivered AGAIN. This is durable at-least-once processing
    // with duplicate suppression before execution plus BOUNDED DUPLICATE
    // RISK for ambiguous external side effects — NOT exactly-once delivery.
    const { executor, setArmed } = interceptingExecutor((statement) =>
      /UPDATE telegram_updates\s+SET status = '(processed|failed)'/s.test(statement.sql),
    );
    const { client, sends } = flakyClient(undefined); // every send SUCCEEDS
    const ingress = createTelegramIngress(buildDeps({ executor, botApi: client }));

    // Delivery 1: the outbound side effect succeeds (sends = 1), then the
    // processed transition fails, and even the failure marking fails -> 503;
    // the row remains claimed (ambiguous state).
    await expect(ingress.processUpdate(ownerCommand(8640))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(sends).toHaveLength(1); // the message WAS delivered to Telegram
    expect((await readRow(8640))?.status).toBe('claimed');

    // The lease expires; recovery re-executes the action.
    const realExecutor = createDbExecutor(env.DB);
    await realExecutor.run({
      sql: 'UPDATE telegram_updates SET claim_expires_at = ? WHERE update_id = ?',
      params: [NOW - 1, 8640],
    });
    setArmed(false);

    // Delivery 2: the reclaimed update is processed — and the message is
    // sent a SECOND time. Bounded duplicate risk, honestly modeled.
    await expect(ingress.processUpdate(ownerCommand(8640))).resolves.toBe('processed');
    expect(sends).toHaveLength(2);
    expect((await readRow(8640))?.status).toBe('processed');

    // After processing, duplicate suppression holds again: no third send.
    await expect(ingress.processUpdate(ownerCommand(8640))).resolves.toBe('duplicate');
    expect(sends).toHaveLength(2);
  });
});

/**
 * Final correction round (v1.2.3) — terminal transitions are FENCED by the
 * claim generation and NEVER falsely acknowledged:
 * - a terminal transition rejected by the attempt_count fence (stale owner)
 *   or hit by a storage error answers safe retryable 503 — never 200 — even
 *   though the outbound action may already have executed;
 * - HTTP 200 for a permanent failure happens ONLY after
 *   failure_class='permanent' is durably persisted;
 * - an old generation can never terminate a newer owner's claim.
 * The simulated interleavings use the SAME guarded statement shapes as the
 * real stale reclaim, so the fencing WHERE clause is exercised for real.
 */
describe('terminal transitions are fenced and never falsely acknowledged (v1.2.3)', () => {
  function captureLogger() {
    const lines: string[] = [];
    const sink: LogSink = (_level, line) => {
      lines.push(line);
    };
    return { lines, logger: createLogger({ level: 'debug', sink }) };
  }

  /**
   * Simulate the stale-owner interleaving at the pipeline boundary: at the
   * moment the pipeline under test executes ITS terminal transition, a newer
   * claim generation has already won the row (its lease had expired and a
   * concurrent redelivery reclaimed it with the same guarded statement shape
   * as the real stale reclaim). The pipeline's fenced UPDATE therefore
   * matches zero rows — the stale owner is rejected by the attempt_count
   * fence. When `completeNewOwner` is true, the newer generation also
   * completes its own terminal transition (through the REAL fenced function)
   * before the stale statement runs.
   */
  function racingNewerGenerationExecutor(
    updateId: number,
    intercept: 'processed' | 'failed',
    completeNewOwner: boolean,
  ): DbExecutor {
    const delegate = createDbExecutor(env.DB);
    let fired = false;
    return {
      query: (statement) => delegate.query(statement),
      first: (statement) => delegate.first(statement),
      run: (statement) => {
        const isTarget =
          !fired &&
          (intercept === 'processed'
            ? /UPDATE telegram_updates\s+SET status = 'processed'/s.test(statement.sql)
            : /UPDATE telegram_updates\s+SET status = 'failed'/s.test(statement.sql));
        if (!isTarget) {
          return delegate.run(statement);
        }
        fired = true;
        // A concurrent redelivery atomically reclaims the expired lease to
        // the NEXT generation (exactly the guarded shape of the real stale
        // reclaim — one winner, attempt_count incremented).
        const reclaim = delegate.run({
          sql: `UPDATE telegram_updates
                SET status = 'claimed', claim_expires_at = ?, attempt_count = attempt_count + 1
                WHERE update_id = ? AND status = 'claimed' AND attempt_count = 1`,
          params: [NOW + 2 * LEASE, updateId],
        });
        const runStale = () => delegate.run(statement);
        if (!completeNewOwner) {
          return reclaim.then(runStale);
        }
        return reclaim.then(() =>
          markTelegramUpdateProcessed(delegate, updateId, 2, NOW + LEASE + 1).then(runStale),
        );
      },
      batch: (statements) => delegate.batch(statements),
    };
  }

  it('answers 503 (never 200) when the processed transition is REJECTED by the fence', async () => {
    // The outbound action MAY already have executed: the send succeeds, then
    // a newer generation wins the row before the processed transition — the
    // pipeline must still answer safe 503 and must NEVER emit the processed
    // success log.
    const { client, sends } = flakyClient(undefined); // every send SUCCEEDS
    const { lines, logger } = captureLogger();
    const executor = racingNewerGenerationExecutor(8650, 'processed', false);
    const ingress = createTelegramIngress(
      buildDeps({ executor, botApi: client, logger, clock: fixedClock(NOW) }),
    );

    await expect(ingress.processUpdate(ownerCommand(8650))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    // The outbound action executed before the transition was attempted.
    expect(sends).toHaveLength(1);
    // The row is owned by the newer generation (2), still claimed.
    const row = await readRow(8650);
    expect(row?.status).toBe('claimed');
    expect(row?.attempt_count).toBe(2);
    expect(row?.claim_expires_at).toBe(NOW + 2 * LEASE);

    const everything = lines.join('\n');
    expect(everything).toContain('terminal_transition_rejected');
    expect(everything).toContain('stale_owner');
    // NO processed success log — the transition never returned true.
    expect(everything).not.toContain('telegram.update.processed');
  });

  it('answers 503 (never 200) when the processed transition THROWS (storage error)', async () => {
    const { client, sends } = flakyClient(undefined);
    const { lines, logger } = captureLogger();
    const { executor: failingExecutor } = interceptingExecutor((statement) =>
      /UPDATE telegram_updates\s+SET status = 'processed'/s.test(statement.sql),
    );
    const ingress = createTelegramIngress(
      buildDeps({ executor: failingExecutor, botApi: client, logger, clock: fixedClock(NOW) }),
    );

    await expect(ingress.processUpdate(ownerCommand(8651))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    // The outbound action executed; the terminal state is UNKNOWN (storage
    // error) — the row stays claimed under its lease, recoverable after
    // expiry (ADR-0030).
    expect(sends).toHaveLength(1);
    const row = await readRow(8651);
    expect(row?.status).toBe('claimed');
    expect(row?.attempt_count).toBe(1);
    expect(row?.claim_expires_at).toBe(NOW + LEASE);

    const everything = lines.join('\n');
    expect(everything).toContain('terminal_transition_failed');
    expect(everything).toContain('storage_error');
    // NO false processed acknowledgement in the logs.
    expect(everything).not.toContain('telegram.update.processed');
  });

  it('answers 503 (never 200) when PERMANENT failure persistence is REJECTED by the fence', async () => {
    const { client, sends, calls } = flakyClient(
      new TelegramApiError('telegram_bad_request'),
      10_000,
    );
    const { lines, logger } = captureLogger();
    const executor = racingNewerGenerationExecutor(8652, 'failed', false);
    const ingress = createTelegramIngress(
      buildDeps({ executor, botApi: client, logger, clock: fixedClock(NOW) }),
    );

    // Permanent failure, but persisting the terminal classification did NOT
    // happen (fence rejected) -> safe 503, NEVER the 200 acknowledgement.
    await expect(ingress.processUpdate(ownerCommand(8652))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(calls()).toBe(1);
    expect(sends).toHaveLength(0);
    const row = await readRow(8652);
    expect(row?.status).toBe('claimed');
    expect(row?.attempt_count).toBe(2);
    expect(row?.failure_class).toBeNull();
    expect(lines.join('\n')).toContain('terminal_transition_rejected');
  });

  it('recovers the full permanent-persistence-throw sequence: 503 -> expiry -> reclaim -> durable terminal -> never re-executes', async () => {
    const { client, sends, calls } = flakyClient(
      new TelegramApiError('telegram_bad_request'),
      10_000,
    );
    const { executor, setArmed } = interceptingExecutor((statement) =>
      /UPDATE telegram_updates\s+SET status = 'failed'/s.test(statement.sql),
    );
    const ingress = createTelegramIngress(
      buildDeps({ executor, botApi: client, clock: fixedClock(NOW) }),
    );

    // 1. Permanent processing failure AND persistence throws -> 503; the row
    //    remains claimed under its lease (NOT failed, NOT processed).
    await expect(ingress.processUpdate(ownerCommand(8653))).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect(calls()).toBe(1);
    const stranded = await readRow(8653);
    expect(stranded?.status).toBe('claimed');
    expect(stranded?.attempt_count).toBe(1);
    expect(stranded?.claim_expires_at).toBe(NOW + LEASE);

    // 2. The lease expires and persistence recovers: the next delivery
    //    reclaims (generation 2), the action fails permanently again, and
    //    the terminal classification is now DURABLY stored.
    const realExecutor = createDbExecutor(env.DB);
    await realExecutor.run({
      sql: 'UPDATE telegram_updates SET claim_expires_at = ? WHERE update_id = ?',
      params: [NOW - 1, 8653],
    });
    setArmed(false);

    await expect(ingress.processUpdate(ownerCommand(8653))).resolves.toBe('failed');
    expect(calls()).toBe(2);
    const terminal = await readRow(8653);
    expect(terminal?.status).toBe('failed');
    expect(terminal?.failure_class).toBe('permanent');
    expect(terminal?.attempt_count).toBe(2);
    expect(terminal?.claim_expires_at).toBeNull();

    // 3. Later deliveries observe the TERMINAL permanently_failed outcome:
    //    acknowledged without executing — the action never runs again.
    await expect(ingress.processUpdate(ownerCommand(8653))).resolves.toBe('failed');
    await expect(ingress.processUpdate(ownerCommand(8653))).resolves.toBe('failed');
    expect(calls()).toBe(2);
    expect((await readRow(8653))?.attempt_count).toBe(2);
    // No message was EVER delivered: every attempt failed permanently.
    expect(sends).toHaveLength(0);
  });

  it('an old generation cannot terminate the new one even if it resumes after the new owner completed', async () => {
    // Worker A (generation 1) stalls past its lease; Worker B reclaims to
    // generation 2 and COMPLETES. Worker A then resumes and attempts its
    // processed transition — the fence rejects it, A answers 503 (never a
    // false ack), and B's terminal state is untouched.
    const { client, sends } = flakyClient(undefined);
    const { lines, logger } = captureLogger();
    const executor = racingNewerGenerationExecutor(8654, 'processed', true);
    const ingress = createTelegramIngress(
      buildDeps({ executor, botApi: client, logger, clock: fixedClock(NOW) }),
    );

    await expect(ingress.processUpdate(ownerCommand(8654))).rejects.toMatchObject({
      code: 'service_unavailable',
    });

    // The NEW generation durably completed; the stale owner did not corrupt it.
    const row = await readRow(8654);
    expect(row?.status).toBe('processed');
    expect(row?.attempt_count).toBe(2);
    expect(row?.processed_at).toBe(NOW + LEASE + 1);
    // The stale owner's rejection was observable, its success log never was.
    expect(lines.join('\n')).toContain('terminal_transition_rejected');
    expect(lines.join('\n')).not.toContain('telegram.update.processed');

    // The durable terminal state suppresses all later execution.
    await expect(ingress.processUpdate(ownerCommand(8654))).resolves.toBe('duplicate');
    expect(sends).toHaveLength(1);
  });
});
