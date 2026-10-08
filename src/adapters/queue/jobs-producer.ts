/**
 * Queue producer ports and Cloudflare adapter (Phase 3 — ADR-0036 §3).
 *
 * The application engine depends on these minimal PORTS — never on the
 * Cloudflare `Queue` type directly — so dispatch/consume logic is testable
 * with controlled fakes (blueprint §3: infrastructure adapters wrap SDK
 * types; domain/application stay clean).
 *
 * The adapters are deliberately thin: they serialize the bounded reference
 * and delegate the send. NO payload, secret, source text, or provider
 * response ever enters a queue message (blueprint §7; AGENTS.md §3).
 */
import type { QueueEnvelope } from '../../domain/jobs/envelope';
import { serializeQueueEnvelope } from '../../domain/jobs/envelope';

/** Port: send a durable job reference to the jobs queue. */
export interface JobsQueueProducerPort {
  send(envelope: QueueEnvelope): Promise<void>;
}

/**
 * Bounded, SAFE dead-letter reference (ADR-0036 §4): identifiers, counts,
 * and AUTHORED error codes only — no payload, no raw provider errors, no
 * source text, no credentials.
 */
export interface DlqReference {
  readonly jobId: string;
  readonly type: string;
  readonly attempts: number;
  readonly errorCode: string;
  readonly failedAtMs: number;
}

/** Port: deliver a safe dead-letter reference to the DLQ queue. */
export interface DlqProducerPort {
  send(reference: DlqReference): Promise<void>;
}

/**
 * Cloudflare Queues adapter for the `JOBS` producer binding. The generic
 * parameter is the envelope; the wire body is the serialized bounded
 * reference (strings only at the boundary).
 */
export function createJobsQueueProducer(queue: Queue<unknown>): JobsQueueProducerPort {
  return {
    async send(envelope: QueueEnvelope): Promise<void> {
      await queue.send(serializeQueueEnvelope(envelope));
    },
  };
}

/** Cloudflare Queues adapter for the `DLQ` producer binding. */
export function createDlqQueueProducer(queue: Queue<unknown>): DlqProducerPort {
  return {
    async send(reference: DlqReference): Promise<void> {
      // Bounded serialization: authored fields only, key order stable.
      await queue.send(
        JSON.stringify({
          jobId: reference.jobId,
          type: reference.type,
          attempts: reference.attempts,
          errorCode: reference.errorCode,
          failedAtMs: reference.failedAtMs,
        }),
      );
    },
  };
}
