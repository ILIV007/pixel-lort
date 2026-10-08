import { describe, expect, it } from 'vitest';
import {
  createJobsQueueProducer,
  createDlqQueueProducer,
} from '../../src/adapters/queue/jobs-producer';

/**
 * Queue producer adapter tests (wire transfer contract — ADR-0037): the
 * wire body is the validated STRUCTURED OBJECT end to end. The v1.3.0
 * review caught a producer that pre-stringified while the consumer expected
 * an object, so the canonical form is pinned HERE at the adapter boundary —
 * no test-visible manual JSON round trip may ever be required again.
 */
describe('queue producer adapters (wire contract — ADR-0037)', () => {
  it('sends the validated envelope OBJECT to the jobs queue (no stringification)', async () => {
    const sent: unknown[] = [];
    const producer = createJobsQueueProducer({
      send: async (body: unknown) => {
        sent.push(body);
      },
    } as unknown as Queue);

    const envelope = {
      version: 1 as const,
      jobId: 'job-1',
      type: 'jobs.maintenance_heartbeat',
      attempt: 1,
      traceId: 't1',
    };
    await producer.send(envelope);

    expect(sent).toEqual([envelope]);
    expect(typeof sent[0]).toBe('object');
    expect(Object.keys(sent[0] as Record<string, unknown>).sort()).toEqual([
      'attempt',
      'jobId',
      'traceId',
      'type',
      'version',
    ]);
  });

  it('fails the send when the envelope violates the contract (recoverable enqueue failure)', async () => {
    const producer = createJobsQueueProducer({
      send: async () => {},
    } as unknown as Queue);
    const malformed = {
      version: 2,
      jobId: 'job-1',
      type: 'jobs.maintenance_heartbeat',
      attempt: 1,
      traceId: 't1',
    };
    await expect(producer.send(malformed as never)).rejects.toThrow();
  });

  it('sends the bounded DLQ reference as a structured object', async () => {
    const sent: unknown[] = [];
    const producer = createDlqQueueProducer({
      send: async (body: unknown) => {
        sent.push(body);
      },
    } as unknown as Queue);

    const reference = {
      jobId: 'job-1',
      type: 'jobs.maintenance_heartbeat',
      attempts: 3,
      errorCode: 'job_exhausted',
      failedAtMs: 1_700_000_000_000,
    };
    await producer.send(reference);

    expect(sent).toEqual([reference]);
    expect(typeof sent[0]).toBe('object');
  });
});
