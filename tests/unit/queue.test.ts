import { describe, expect, it, vi } from 'vitest';
import worker from '../../src/entrypoints/worker';
import { createTestEnv, createTestExecutionContext } from '../helpers/test-env';

/**
 * Queue handler smoke test (Phase 0: typed no-op foundation).
 * The handler must acknowledge every message without processing payloads and
 * without ever logging message bodies.
 */

interface MockQueueMessage {
  readonly id: string;
  readonly body: unknown;
  readonly ack: ReturnType<typeof vi.fn>;
  readonly retry: ReturnType<typeof vi.fn>;
}

function createMockMessage(id: string, body: unknown): MockQueueMessage {
  return {
    id,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createMockBatch(messages: MockQueueMessage[]): MessageBatch<unknown> {
  return {
    queue: 'pixel-jobs',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

describe('queue handler', () => {
  it('acknowledges every message in the batch', async () => {
    const batch = createMockBatch([
      createMockMessage('m1', {
        version: 1,
        jobId: 'job-1',
        type: 'unknown',
        attempt: 1,
        traceId: 't1',
      }),
      createMockMessage('m2', {
        version: 1,
        jobId: 'job-2',
        type: 'unknown',
        attempt: 1,
        traceId: 't2',
      }),
      createMockMessage('m3', 'plain-payload'),
    ]);
    const env = createTestEnv();
    const ctx = createTestExecutionContext();

    await expect(worker.queue(batch, env, ctx)).resolves.toBeUndefined();

    for (const message of batch.messages as unknown as MockQueueMessage[]) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
    }
  });

  it('resolves for an empty batch', async () => {
    const batch = createMockBatch([]);
    const env = createTestEnv();
    const ctx = createTestExecutionContext();

    await expect(worker.queue(batch, env, ctx)).resolves.toBeUndefined();
  });

  it('does not mutate or inspect message bodies', async () => {
    const payload = { version: 1, jobId: 'job-9', type: 'whatever', attempt: 2, traceId: 't9' };
    const message = createMockMessage('m9', payload);
    const batch = createMockBatch([message]);
    const env = createTestEnv();
    const ctx = createTestExecutionContext();

    await worker.queue(batch, env, ctx);

    expect(message.body).toEqual(payload);
  });
});
