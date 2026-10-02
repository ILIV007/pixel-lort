/**
 * Queue message envelope contract (blueprint §7).
 *
 * Queues carry only durable job references — never full business records.
 * D1 remains the source of truth; a queue message is enough to locate and
 * claim the referenced job.
 *
 * NOTE (Phase 0): this is a TYPE-ONLY contract shared by future producers and
 * consumers. No queue is bound in wrangler.jsonc yet and no job types exist.
 * The concrete `JobType` union is introduced with the job/queue framework
 * phase; it is intentionally not invented here.
 */
export interface QueueEnvelope {
  /** Envelope schema version for forward compatibility. */
  version: 1;
  /** D1 jobs.id reference. */
  jobId: string;
  /** Job type discriminator (union defined by the job framework phase). */
  type: string;
  /** Delivery attempt counter, starting at 1. */
  attempt: number;
  /** Correlation/trace ID propagated from the original trigger. */
  traceId: string;
}
