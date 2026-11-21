/**
 * The ingestion→editorial drain (slice 9 — Link 2, the core break from
 * slice 8b).
 *
 * Until this slice the ONLY way an `editorial.prepare_draft` job was
 * created was programmatic (the integration suite and the demo runner):
 * the poll handler committed items and stopped, so ingested items sat in
 * `source_items` forever. This drain is the production trigger: each
 * bounded cron pass claims the oldest still-`new` items and enqueues one
 * prepare-draft job per item through the EXISTING
 * `enqueueEditorialPrepareDraft` boundary (the deterministic
 * (sourceItemId, snapshotHash) job key — a re-enqueue resolves the SAME
 * job row, never a duplicate).
 *
 * BOUNDARIES (the house pattern, kept):
 *  - BOUNDED work only: at most `limit` items per pass (default 10 — the
 *    queue consumer's own max batch size); the next tick picks up the
 *    rest. A flood of fresh items can never create an unbounded job
 *    burst in one pass.
 *  - OLDEST FIRST: `listFreshSourceItems` orders by published_at, so a
 *    fresh item is never starved behind a newer flood.
 *  - CLAIM AFTER ENQUEUE: an item flips `new` → `queued` only after its
 *    job exists (or already existed — the idempotent `existing`
 *    outcome). A crash between the enqueue and the flip is absorbed by
 *    the next tick's `existing` outcome; a `conflict` or `rejected`
 *    outcome leaves the item `new` for a later honest retry.
 *  - GATE: the caller (cron) runs this ONLY while EDITORIAL_ENABLED is
 *    on — the drain never implies the editorial gate itself, and it
 *    never touches AI, budgets, or publishing.
 *
 * Pure composition over the existing boundary + store: no SQL here, no
 * network, no clock side effects beyond the injected nowMs (unused —
 * kept for symmetry with the other cron steps).
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import { listFreshSourceItems, markSourceItemQueued } from '../../adapters/db/editorial-store';
import type { JobsEngine } from '../jobs/engine';
import { enqueueEditorialPrepareDraft } from './enqueue-prepare-draft';
import type { Logger } from '../../observability/logger';

/** One pass claims at most this many fresh items (the queue batch size). */
export const FRESH_ITEMS_DRAIN_LIMIT = 10;

export interface EnqueueFreshSourceItemsReport {
  /** Fresh items observed this pass (≤ limit). */
  readonly scanned: number;
  /** Jobs newly created. */
  readonly enqueued: number;
  /** Items whose job already existed (idempotent re-enqueue). */
  readonly alreadyQueued: number;
  /** Items whose enqueue was rejected (missing item — a race). */
  readonly rejected: number;
  /** Items whose deterministic job key conflicted (never expected). */
  readonly conflicts: number;
}

export async function enqueueFreshSourceItems(input: {
  readonly executor: DbExecutor;
  readonly engine: JobsEngine;
  readonly limit?: number;
  readonly logger?: Logger;
}): Promise<EnqueueFreshSourceItemsReport> {
  const fresh = await listFreshSourceItems(input.executor, {
    limit: input.limit ?? FRESH_ITEMS_DRAIN_LIMIT,
  });
  let enqueued = 0;
  let alreadyQueued = 0;
  let rejected = 0;
  let conflicts = 0;
  for (const item of fresh) {
    const outcome = await enqueueEditorialPrepareDraft({
      engine: input.engine,
      executor: input.executor,
      sourceItemId: item.id,
    });
    switch (outcome.kind) {
      case 'created':
        enqueued += 1;
        await markSourceItemQueued(input.executor, { sourceItemId: item.id });
        break;
      case 'existing':
        alreadyQueued += 1;
        await markSourceItemQueued(input.executor, { sourceItemId: item.id });
        break;
      case 'conflict':
        conflicts += 1;
        input.logger?.warn('editorial.drain.enqueue_conflict');
        break;
      case 'rejected':
        rejected += 1;
        input.logger?.warn('editorial.drain.enqueue_rejected', {
          reason: outcome.reason,
        });
        break;
    }
  }
  return { scanned: fresh.length, enqueued, alreadyQueued, rejected, conflicts };
}
