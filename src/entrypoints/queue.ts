/**
 * Queue consumer entrypoint — durable job dispatch (Phase 3, ADR-0036;
 * replaces the Phase-0 ack-all skeleton per ADR-0011).
 *
 * Per delivered message the engine resolves ONE action from the durable D1
 * state (never from the message body): ack only after a durable terminal
 * decision or for poison shapes that can never parse/execute; retry for
 * every uncertain or transient situation (active lease, not-yet-due,
 * storage failure, lost fence). No message body, envelope, or payload is
 * ever logged — only stable outcome codes and counts (ADR-0017/0022).
 *
 * Fail-closed activation (ADR-0036 §7): while `JOBS_ENABLED` is off (or the
 * engine is misconfigured) messages are RETRIED, never acknowledged — the
 * platform retry budget and DLQ bound the loop, and no work is dropped by
 * a disabled deployment.
 */
import { createLogger } from '../observability/logger';
import type { WorkerEnv } from '../shared/types/env';
import { resolveJobsEngine } from '../application/jobs/engine-env';

export async function handleQueue(
  batch: MessageBatch<unknown>,
  env: WorkerEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  const logger = createLogger({ base: { evt: 'queue' } });
  const resolution = resolveJobsEngine(env, logger);

  if (resolution.kind !== 'ready') {
    // Fail closed: never acknowledge work this deployment cannot safely
    // execute. The platform retry budget and DLQ bound redelivery.
    logger.warn('queue.consumer_inactive', { reason: resolution.kind });
    for (const message of batch.messages) {
      message.retry();
    }
    return;
  }

  logger.info('queue.batch.received', {
    queue: batch.queue,
    messageCount: batch.messages.length,
  });

  let acked = 0;
  let retried = 0;
  for (const message of batch.messages) {
    let action;
    try {
      action = await resolution.engine.consumeMessage(message.id, message.body);
    } catch {
      // consumeMessage is designed not to throw; this backstop keeps one
      // pathological message from aborting the whole batch.
      logger.warn('queue.message.backstop_retry', { errorCode: 'internal_error' });
      action = { action: 'retry' as const, outcome: 'backstop' };
    }
    if (action.action === 'ack') {
      message.ack();
      acked += 1;
    } else {
      if (action.delaySeconds !== undefined) {
        message.retry({ delaySeconds: action.delaySeconds });
      } else {
        message.retry();
      }
      retried += 1;
    }
  }
  logger.info('queue.batch.completed', { acked, retried });
}
