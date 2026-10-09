/**
 * Due-source scheduling (Phase 4 — ADR-0038 §3).
 *
 * Cron calls this when the ingestion gate is on: ONE bounded, indexed
 * due-source scan; per source, in order:
 *   1. pre-flight (connector implemented? config complete? credentials
 *      present?) — blocked sources are skipped with a guarded state
 *      write (stable reason, next_poll_at = now + interval): NO job,
 *      NO network, NO budget spend, no hot loop;
 *   2. durable poll job FIRST with the deterministic window key
 *      `sources.poll:<sha256(sourceId ‖ scheduledForMs)>` — overlapping
 *      crons derive the SAME key and the idempotent create absorbs
 *      duplicates; a later legitimate poll advances next_poll_at and
 *      derives a FRESH key;
 *   3. atomic reservation (guarded advance to hold) — exactly one
 *      scheduler wins; a crash between job creation and reservation
 *      self-heals (the job's claim fencing + a later scan converge).
 *
 * Seeding: on the first pass with an EMPTY sources table the validated
 * registry is seeded (idempotent, enabled = 0 everywhere).
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import type { JobsEngine } from '../jobs/engine';
import type { Logger } from '../../observability/logger';
import { parseEmbeddedRegistry } from '../../domain/source/source-registry';
import { seedSourcesFromRegistry } from '../../adapters/db/source-registry-store';
import {
  scanDueSources,
  reserveSourcePoll,
  recordBlockedSourceSkip,
} from '../../adapters/db/source-ingest-store';
import { formatIdempotencyKey } from '../../shared/ids/idempotency-key';
import type { ConnectorRegistry } from '../../connectors/registry';
import { isImplementedConnector } from '../../domain/source/types';
import type { SecretReader } from '../../connectors/contract';

export interface ScheduleDueSourcesDeps {
  readonly executor: DbExecutor;
  readonly engine: JobsEngine;
  readonly connectors: ConnectorRegistry;
  readonly secrets: SecretReader;
  readonly nowMs: number;
  readonly logger?: Logger;
}

export type ScheduleOutcome =
  | { readonly kind: 'scheduled'; readonly jobsCreated: number; readonly blockedSkipped: number; readonly seeded: boolean }
  | { readonly kind: 'registry_invalid' }
  | { readonly kind: 'failed'; readonly errorCode: 'internal_error' };

/**
 * One bounded scheduling pass. Never throws for domain conditions — the
 * cron entrypoint wraps storage failures with a stable code.
 */
export async function scheduleDueSources(
  deps: ScheduleDueSourcesDeps,
): Promise<ScheduleOutcome> {
  const { executor, engine, connectors, secrets, nowMs, logger } = deps;

  // Registry validation (fail safe — an invalid catalog disables the pass).
  const registry = parseEmbeddedRegistry();
  if (!registry.ok) {
    logger?.warn('ingestion.schedule.registry_invalid');
    return { kind: 'registry_invalid' };
  }

  // First-pass seeding: only when the sources table is EMPTY (one cheap
  // indexed probe); repeated passes never re-run the seed loop.
  let seeded = false;
  const anySource = await executor.first<{ id: string }>({
    sql: 'SELECT id FROM sources LIMIT 1',
  });
  if (anySource === null) {
    await seedSourcesFromRegistry(executor, registry.registry, nowMs);
    seeded = true;
    logger?.debug('ingestion.schedule.seeded', { count: registry.registry.sources.length });
  }

  const due = await scanDueSources(executor, nowMs);
  let jobsCreated = 0;
  let blockedSkipped = 0;

  for (const source of due) {
    if (!isImplementedConnector(source.connector)) {
      // Catalog-only connector (bluesky/igdb) somehow enabled: skip with
      // a stable reason, no job (defense in depth — seeding leaves these
      // disabled and the runbook forbids enabling them this phase).
      const skipped = await recordBlockedSourceSkip(executor, {
        sourceId: source.id,
        scheduledForMs: source.next_poll_at,
        reason: 'connector_not_implemented',
        intervalSeconds: source.interval_seconds,
        nowMs,
      });
      if (skipped) {
        blockedSkipped += 1;
      }
      continue;
    }
    const connector = connectors.get(source.connector);
    if (connector === undefined) {
      const skipped = await recordBlockedSourceSkip(executor, {
        sourceId: source.id,
        scheduledForMs: source.next_poll_at,
        reason: 'connector_not_implemented',
        intervalSeconds: source.interval_seconds,
        nowMs,
      });
      if (skipped) {
        blockedSkipped += 1;
      }
      continue;
    }

    // Pre-flight: parse runtime config + connector preconditions.
    let config: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(source.config_json);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
    const preflight = connector.preflight(config, secrets);
    if (!preflight.ok) {
      const skipped = await recordBlockedSourceSkip(executor, {
        sourceId: source.id,
        scheduledForMs: source.next_poll_at,
        reason: preflight.reason,
        intervalSeconds: source.interval_seconds,
        nowMs,
      });
      if (skipped) {
        blockedSkipped += 1;
      }
      continue;
    }

    // Durable job FIRST (deterministic window key).
    const idempotencyKey = await formatIdempotencyKey('sources.poll', [
      source.id,
      String(source.next_poll_at),
    ]);
    const created = await engine.createDurableJob({
      type: 'sources.fetch_poll',
      idempotencyKey,
      payload: { sourceId: source.id, scheduledForMs: source.next_poll_at },
      priority: 40,
      maxAttempts: 3,
      aggregateType: 'source',
      aggregateId: source.id,
    });
    if (created.kind === 'created') {
      jobsCreated += 1;
    }

    // Atomic reservation (guarded advance to the hold window).
    const reservation = await reserveSourcePoll(executor, {
      sourceId: source.id,
      scheduledForMs: source.next_poll_at,
      nowMs,
    });
    void reservation; // not_owner: another scheduler won; job fencing absorbs
  }

  logger?.debug('ingestion.schedule.pass', {
    due: due.length,
    jobsCreated,
    blockedSkipped,
    seeded,
  });
  return { kind: 'scheduled', jobsCreated, blockedSkipped, seeded };
}
