/**
 * Queue consumer entrypoint — typed no-op foundation for Phase 0.
 *
 * Blueprint §1.3: Queues is at-least-once, so the real consumer (job/queue
 * framework phase) must be idempotent and claim jobs via conditional D1
 * state transitions. Phase 0 implements no business logic: it logs the batch
 * shape and acknowledges each message so a skeleton deployment cannot cause
 * unbounded redelivery.
 *
 * Logging rules: message bodies/envelopes are NEVER logged — only the queue
 * name and message count.
 */
import { createLogger } from '../observability/logger';
import type { WorkerEnv } from '../shared/types/env';

export async function handleQueue(
  batch: MessageBatch<unknown>,
  _env: WorkerEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const logger = createLogger({ base: { evt: 'queue' } });
  logger.info('queue.batch.received', {
    queue: batch.queue,
    messageCount: batch.messages.length,
  });

  for (const message of batch.messages) {
    // Phase 0: acknowledge immediately. Claim/lease/idempotent processing
    // replaces this in the job framework phase (docs/ROADMAP.md phase 3).
    message.ack();
  }
}
