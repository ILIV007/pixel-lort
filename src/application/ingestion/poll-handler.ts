/**
 * `sources.fetch_poll` handler (Phase 4 — ADR-0038 §4/§5).
 *
 * Executes ONE bounded poll attempt for one source:
 *   load source+state → defense-in-depth pre-flight → ATOMIC budget
 *   reservation → connector fetch (safe HTTP) → normalize (inside the
 *   connector) → ATOMIC guarded commit (items + fenced state) →
 *   budget reconciliation of observed extra requests.
 *
 * Retry ownership (ADR-0038 §4): provider-side conditions (timeout, 5xx,
 * 429, malformed, auth) are owned by the SOURCE schedule — the handler
 * writes backoff/Retry-After/circuit into source_state and returns
 * SUCCESS ("one poll attempt durably recorded"). Only infrastructure
 * uncertainty stays on the Phase 3 job-retry path.
 *
 * The fenced terminal write uses the deterministic hold window from the
 * payload (`scheduledForMs + hold`): a stale worker's state write
 * changes 0 rows (visible in meta) and never overwrites a newer poll,
 * while its item inserts still land (dedup absorbs duplicates).
 */
import type { JobHandler, HandlerOutcome, JobExecutionContext } from '../../domain/jobs/handler';
import { SourcesPollPayloadSchema, type SourcesPollPayload } from '../../domain/jobs/payloads';
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  commitPollResults,
  type IngestItemRow,
  type PollCommitResult,
  type PollTerminalState,
} from '../../adapters/db/source-ingest-store';
import {
  reserveIngestionBudget,
  reconcileIngestionBudget,
  readIngestionBudget,
} from '../../adapters/db/ingestion-budget-store';
import type { ConnectorRegistry } from '../../connectors/registry';
import type { ConnectorFetchOutput } from '../../connectors/contract';
import type { SafeFetchExecutor } from '../../shared/http/safe-http';
import { tehranBudgetDay } from '../../shared/time/tehran-day';
import {
  INGESTION_BACKOFF_CAP_MS,
  INGESTION_BUDGET_RETRY_MS,
  INGESTION_CIRCUIT_MS,
  INGESTION_POLL_HOLD_MS,
} from '../../shared/config/phase4';
import { isImplementedConnector } from '../../domain/source/types';
import type { IdGenerator } from '../../shared/ids/id';
import type { Logger } from '../../observability/logger';

/** Handler dependencies (all injected — engine-env wiring, ADR-0038 §1). */
export interface SourcePollHandlerOptions {
  readonly executor: DbExecutor;
  readonly connectors: ConnectorRegistry;
  readonly safeFetch: SafeFetchExecutor;
  readonly idGenerator: IdGenerator;
  readonly secrets: (name: string) => string | undefined;
  readonly nowMs: () => number;
  readonly random: () => number;
  readonly logger?: Logger;
}

interface SourceWithState {
  readonly id: string;
  readonly connector: string;
  readonly enabled: number;
  readonly interval_seconds: number;
  readonly config_json: string;
  readonly next_poll_at: number;
  readonly etag: string | null;
  readonly last_modified: string | null;
  readonly cursor: string | null;
  readonly consecutive_failures: number;
}

const SOURCE_SELECT_SQL = `SELECT s.id, s.connector, s.enabled, s.interval_seconds,
                                  s.config_json, st.next_poll_at, st.etag,
                                  st.last_modified, st.cursor,
                                  st.consecutive_failures
                             FROM sources s
                             JOIN source_state st ON st.source_id = s.id
                            WHERE s.id = ?`;

export function createSourcePollHandler(
  options: SourcePollHandlerOptions,
): JobHandler<SourcesPollPayload> {
  return {
    type: 'sources.fetch_poll',
    async execute(context: JobExecutionContext<SourcesPollPayload>): Promise<HandlerOutcome> {
      // Defense in depth: the engine already validated the payload.
      const parsed = SourcesPollPayloadSchema.safeParse(context.payload);
      if (!parsed.success) {
        return { kind: 'permanent', reasonCode: 'job_payload_invalid' };
      }
      const { sourceId, scheduledForMs } = parsed.data;
      const holdUntilMs = scheduledForMs + INGESTION_POLL_HOLD_MS;
      const nowMs = options.nowMs();

      const source = await options.executor.first<SourceWithState>({
        sql: SOURCE_SELECT_SQL,
        params: [sourceId],
      });
      if (source === null) {
        return { kind: 'permanent', reasonCode: 'ingestion_source_missing' };
      }
      if (source.enabled !== 1) {
        // Disabled between scheduling and execution: skip (state owns pacing).
        return { kind: 'success' };
      }
      if (!isImplementedConnector(source.connector)) {
        return { kind: 'permanent', reasonCode: 'ingestion_connector_unavailable' };
      }
      const connector = options.connectors.get(source.connector);
      if (connector === undefined) {
        return { kind: 'permanent', reasonCode: 'ingestion_connector_unavailable' };
      }

      // Pre-flight re-check (payload carries IDs only; config comes from D1).
      let config: Record<string, unknown> = {};
      try {
        const parsedConfig: unknown = JSON.parse(source.config_json);
        if (parsedConfig !== null && typeof parsedConfig === 'object' && !Array.isArray(parsedConfig)) {
          config = parsedConfig as Record<string, unknown>;
        }
      } catch {
        config = {};
      }
      const preflight = connector.preflight(config, options.secrets);
      if (!preflight.ok) {
        await commitTerminalState(options, source, holdUntilMs, {
          status: 'failed',
          items: [],
          cursor: source.cursor,
          etag: source.etag,
          lastModified: source.last_modified,
          retryAfterSeconds: null,
          requestCount: 0,
          malformedCount: 0,
          failureReason: preflight.reason,
        });
        return { kind: 'success' };
      }

      // ATOMIC budget reservation BEFORE any network call (ADR-0038 §6).
      const planned = Math.max(1, connector.plannedRequestCount(config));
      const budget = await reserveIngestionBudget(options.executor, {
        sourceId,
        count: planned,
        nowMs,
      });
      if (budget.kind === 'source_missing') {
        return { kind: 'permanent', reasonCode: 'ingestion_source_missing' };
      }
      if (budget.kind === 'exhausted') {
        await commitTerminalState(options, source, holdUntilMs, {
          status: 'failed',
          items: [],
          cursor: source.cursor,
          etag: source.etag,
          lastModified: source.last_modified,
          retryAfterSeconds: null,
          requestCount: 0,
          malformedCount: 0,
          failureReason: 'budget_exhausted',
        });
        return { kind: 'success' };
      }

      // ONE bounded connector fetch sequence.
      let fetched: ConnectorFetchOutput;
      try {
        fetched = await connector.fetch({
          sourceId,
          config,
          state: { etag: source.etag, lastModified: source.last_modified, cursor: source.cursor },
          effects: {
            safeFetch: options.safeFetch,
            nowMs: options.nowMs,
            random: options.random,
            secrets: options.secrets,
          },
        });
      } catch (error) {
        options.logger?.warn('ingestion.poll.connector_threw', {
          errorCode: 'connector_unavailable',
        });
        void error; // never logged (may carry provider text)
        await commitTerminalState(options, source, holdUntilMs, {
          status: 'failed',
          items: [],
          cursor: source.cursor,
          etag: source.etag,
          lastModified: source.last_modified,
          retryAfterSeconds: null,
          requestCount: 0,
          malformedCount: 0,
          failureReason: 'connector_unavailable',
        });
        return { kind: 'success' };
      }

      // Reconcile OBSERVED extra requests (redirect hops, extra API calls).
      const extra = Math.max(0, fetched.requestCount - planned);
      if (extra > 0) {
        await reconcileIngestionBudget(options.executor, { sourceId, extraCount: extra, nowMs });
      }

      // Atomic guarded commit: items + fenced terminal state.
      const result = await commitTerminalState(options, source, holdUntilMs, fetched);

      options.logger?.debug('ingestion.poll.completed', {
        status: fetched.status,
        inserted: result.inserted,
        duplicateExternal: result.duplicateExternal,
        duplicateUrl: result.duplicateUrl,
        stateWriteWon: result.stateWriteWon,
        requests: fetched.requestCount,
      });
      return { kind: 'success' };
    },
  };
}

/** ±10 % full-range jitter (blueprint §9) with the injected random. */
function jittered(baseMs: number, random: () => number): number {
  const factor = 1 + (2 * random() - 1) * 0.1;
  return Math.max(1000, Math.round(baseMs * factor));
}

/** Adaptive backoff ladder: interval × 2^failures, capped (ADR-0038 §4). */
function adaptiveBackoffMs(intervalMs: number, failures: number): number {
  const exponent = Math.min(failures, 4);
  return Math.min(INGESTION_BACKOFF_CAP_MS, intervalMs * Math.pow(2, exponent));
}

/**
 * Terminal fetch result accepted by the state mapper (structurally the
 * connector output; aliased for readability at the commit boundary).
 */
type TerminalInput = ConnectorFetchOutput;

/** Failure classes that grow the ADAPTIVE ladder (blueprint §7). */
const LADDER_FAILURE_REASONS = new Set([
  'http_status_error',
  'http_timeout',
  'response_malformed',
  'unexpected_content_type',
  'response_too_large',
  'response_invalid_utf8',
  'http_redirect_limit',
  'pagination_bounded',
]);

/**
 * Map a connector result onto the terminal state and commit it with any
 * durable items (ADR-0038 §5). 304 writes ONLY scheduling/health metadata
 * (validators and cursor pass through unchanged). Returns the honest
 * commit classification from the atomic batch.
 */
async function commitTerminalState(
  options: SourcePollHandlerOptions,
  source: SourceWithState,
  holdUntilMs: number,
  fetched: TerminalInput,
): Promise<PollCommitResult> {
  const nowMs = options.nowMs();
  const intervalMs = source.interval_seconds * 1000;
  // The ladder grows ONLY for provider-class failures; configuration,
  // budget and circuit conditions own their own pacing (ADR-0038 §4).
  const failures =
    fetched.status === 'changed' || fetched.status === 'not_modified'
      ? 0
      : fetched.failureReason !== null && LADDER_FAILURE_REASONS.has(fetched.failureReason)
        ? source.consecutive_failures + 1
        : source.consecutive_failures;

  let nextPollAtMs: number;
  let circuitOpenUntilMs: number | null = null;
  if (fetched.retryAfterSeconds !== null) {
    // Retry-After is a TRUE lower bound (ADR-0038 §4): never earlier than
    // the provider's bound, even when the generic ladder is smaller.
    const retryAfterMs = fetched.retryAfterSeconds * 1000;
    nextPollAtMs = nowMs + Math.max(retryAfterMs, adaptiveBackoffMs(intervalMs, failures));
  } else if (fetched.failureReason === 'credentials_rejected') {
    nextPollAtMs = nowMs + intervalMs;
    circuitOpenUntilMs = nowMs + INGESTION_CIRCUIT_MS;
  } else if (fetched.failureReason === 'budget_exhausted') {
    nextPollAtMs = nowMs + INGESTION_BUDGET_RETRY_MS;
  } else if (fetched.status === 'failed') {
    nextPollAtMs = nowMs + jittered(adaptiveBackoffMs(intervalMs, failures), options.random);
  } else {
    nextPollAtMs = nowMs + jittered(intervalMs, options.random);
  }

  const lastError =
    fetched.status === 'changed' || fetched.status === 'not_modified'
      ? null
      : (fetched.failureReason ?? 'http_status_error');

  const requestsToday = await readIngestionBudget(options.executor, {
    sourceId: source.id,
    nowMs,
  });

  const state: PollTerminalState = {
    // 304: validators and cursor pass through UNCHANGED.
    cursor: fetched.cursor,
    etag: fetched.status === 'not_modified' ? source.etag : fetched.etag,
    lastModified:
      fetched.status === 'not_modified' ? source.last_modified : fetched.lastModified,
    nextPollAtMs,
    success: fetched.status === 'changed' || fetched.status === 'not_modified',
    lastChangedAtMs: fetched.status === 'changed' ? nowMs : null,
    lastError,
    consecutiveFailures: failures,
    circuitOpenUntilMs,
    requestsToday,
    budgetDate: tehranBudgetDay(nowMs),
  };

  const itemRows: IngestItemRow[] = fetched.items.map((item) => ({
    id: options.idGenerator.newId(),
    sourceId: source.id,
    externalId: item.externalId,
    canonicalUrl: item.canonicalUrl,
    title: item.title,
    excerpt: item.excerpt,
    author: item.author,
    publishedAtMs: item.publishedAtMs,
    fetchedAtMs: nowMs,
    contentHash: item.contentHash,
    rawJson: JSON.stringify(item.rawJson),
  }));

  return commitPollResults(options.executor, {
    sourceId: source.id,
    items: itemRows,
    state,
    holdUntilMs,
    nowMs,
  });
}
