import { describe, expect, it, vi } from 'vitest';
import worker from '../../src/entrypoints/worker';
import { createTestEnv, createTestExecutionContext } from '../helpers/test-env';

/**
 * Queue handler unit tests — fail-closed activation (ADR-0036 §7).
 * The default test environment has NO JOBS_ENABLED flag: the engine is
 * disabled, so a delivered message MUST be retried, never acknowledged
 * (ack-all is forbidden outside the never-deployed Phase 0 skeleton,
 * ADR-0011). Enabled-path behavior is covered by the integration suite.
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
    queue: 'pixel-jobs-preview',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<unknown>;
}

describe('queue handler (engine disabled — default environment)', () => {
  it('retries every message instead of acknowledging uncertain work', async () => {
    const batch = createMockBatch([
      createMockMessage('m1', {
        version: 1,
        jobId: 'job-1',
        type: 'jobs.maintenance_heartbeat',
        attempt: 1,
        traceId: 't1',
      }),
      createMockMessage('m2', 'plain-payload'),
    ]);
    await expect(
      worker.queue(batch, createTestEnv(), createTestExecutionContext()),
    ).resolves.toBeUndefined();

    for (const message of batch.messages as unknown as MockQueueMessage[]) {
      expect(message.retry).toHaveBeenCalledTimes(1);
      expect(message.ack).not.toHaveBeenCalled();
    }
  });

  it('resolves for an empty batch', async () => {
    const batch = createMockBatch([]);
    await expect(
      worker.queue(batch, createTestEnv(), createTestExecutionContext()),
    ).resolves.toBeUndefined();
  });

  it('does not mutate or inspect message bodies', async () => {
    const payload = {
      version: 1,
      jobId: 'job-9',
      type: 'jobs.maintenance_heartbeat',
      attempt: 2,
      traceId: 't9',
    };
    const message = createMockMessage('m9', payload);
    const batch = createMockBatch([message]);

    await worker.queue(batch, createTestEnv(), createTestExecutionContext());

    expect(message.body).toEqual(payload);
  });
});
