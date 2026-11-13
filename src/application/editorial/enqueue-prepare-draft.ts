/**
 * Editorial enqueue boundary (Phase 5A — ADR-0042 §2): the ONLY way an
 * `editorial.prepare_draft` durable job is created. Programmatic,
 * application-level, NOT auto-scheduled by cron, NOT reachable through any
 * public endpoint or command (R1.11 — stable execution): the integration
 * suite and the demo runner are the sanctioned callers this round.
 *
 * Input discipline (Posidon R1.11 §1): the caller supplies ONLY the
 * `sourceItemId` reference. The snapshot identity is read from the DURABLE
 * item itself (`content_hash`) — the authoritative stored hash — so the
 * durable payload carries references and identity only: NO news text, NO
 * raw payload, NO secret ever enters the job envelope.
 *
 * Idempotency: the durable idempotency key is deterministic per
 * (sourceItemId, snapshotHash) (ADR-0042 §2) — replaying the same enqueue
 * resolves the SAME job row (`jobs.idempotency_key UNIQUE`); an
 * incompatible re-use of the same key for different inputs is the
 * engine's `conflict` outcome, surfaced verbatim, never swallowed.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import { findEditorialSourceItem } from '../../adapters/db/editorial-store';
import type { JobsEngine, CreateDurableJobResult } from '../jobs/engine';
import { editorialPrepareDraftIdempotencyKey } from '../../domain/editorial/identity';

export interface EnqueueEditorialPrepareDraftInput {
  readonly engine: JobsEngine;
  readonly executor: DbExecutor;
  readonly sourceItemId: string;
}

export type EnqueueEditorialPrepareDraftResult =
  | { readonly kind: 'created' | 'existing' | 'conflict'; readonly jobId: string }
  | { readonly kind: 'rejected'; readonly reason: 'source_item_missing' | 'invalid_input' };

export async function enqueueEditorialPrepareDraft(
  input: EnqueueEditorialPrepareDraftInput,
): Promise<EnqueueEditorialPrepareDraftResult> {
  // The stored item is the identity authority: its durable content_hash IS
  // the snapshot identity this pipeline prepares.
  const item = await findEditorialSourceItem(input.executor, input.sourceItemId);
  if (item === null) {
    return { kind: 'rejected', reason: 'source_item_missing' };
  }
  const idempotencyKey = await editorialPrepareDraftIdempotencyKey(item.id, item.content_hash);
  const result: CreateDurableJobResult = await input.engine.createDurableJob({
    type: 'editorial.prepare_draft',
    idempotencyKey,
    payload: {
      sourceItemId: item.id,
      snapshotHash: item.content_hash,
    },
    aggregateType: 'source_item',
    aggregateId: item.id,
  });
  switch (result.kind) {
    case 'created':
    case 'existing':
    case 'conflict':
      return { kind: result.kind, jobId: result.jobId };
    case 'rejected':
      return { kind: 'rejected', reason: 'invalid_input' };
  }
}
