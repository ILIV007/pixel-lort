/**
 * `sources.fetch_poll` handler (Phase 4 — ADR-0038 §4/§5; per-hop budget
 * authority reshaped by Round 1.8 R10; source-poll ownership added by
 * Round 1.9 R09).
 *
 * Executes ONE bounded poll attempt for one source:
 *   load source+state → defense-in-depth pre-flight → connector fetch
 *   (safe HTTP through the MANDATORY source-bound budgeted transport) →
 *   normalize (inside the connector) → ATOMIC guarded commit (items +
 *   fenced state).
 *
 * R09 OWNERSHIP (Round 1.9 — schema-4 capability, feature-detected ONCE
 * per execution from the APPLIED schema version; R19-01 correction: the
 * capability resolves into EXACTLY ONE of three typed states — a readable
 * exact v4 runs the ownership fences, a readable exact v3 the accepted
 * legacy paths, and ANY unavailable/invalid/unsupported state FAILS
 * CLOSED): after the engine's atomic claim and BEFORE any preflight/budget
 * network activity, an unresolved capability returns a stable retryable
 * outcome with ZERO budget/network/item/source-state effects — it is
 * never downgraded to the legacy path and never completed silently (CE2/
 * CE3/CE4). On a schema-4 database the handler ACQUIRES the durable poll
 * ownership (A1): the CURRENT-TIME hold and the owner become visible
 * atomically, fenced on job identity/type/aggregate, claimed status and
 * the EXACT generation.
 * A non-owner (superseded window, foreign owner, stale generation, or a
 * cancelled job) skips BEFORE the network: zero fetches, zero budget
 * rows, zero state writes — it cannot release a newer owner and completes
 * honestly. The terminal commit is OWNERSHIP-FENCED: every item insert
 * AND the state write carry the same predicate P (durable hold + owner +
 * job identity/claimed/generation) inside ONE atomic batch — an old
 * generation or a lost owner writes zero items and zero state; on success
 * ownership is released together with the fresh schedule. Mixed-source
 * batches are rejected BEFORE any statement runs (B1). Under the APPLIED
 * schema 3 the accepted legacy paths below stay byte-identical (the R09
 * defect remains honestly visible there — ownership is a schema-4
 * capability by design).
 *
 * R10 budget authority: there is NO planned reservation and NO post-fetch
 * reconciliation. The handler builds the ingestion transport PER EXECUTION
 * via `createIngestionSafeFetch`, binding an authorizer that atomically
 * consumes EXACTLY ONE source/day unit (Tehran bucket resolved at EACH
 * authorization) before EVERY raw fetch attempt — hop 0, every redirect
 * hop, every later connector request. A denial (`budget_denied`) defers
 * the WHOLE window: no items, prior cursor/validators preserved EXACTLY
 * (R10.1/B2 — the commit pins the loaded source row's cursor, etag and
 * last-modified), the strongest provider Retry-After bound observed in the
 * denied sequence is carried through (R10.1/B3), and scheduling satisfies
 * BOTH the budget-defer minimum AND every observed provider lower bound.
 * A mid-sequence missing source surfaces the
 * same permanent `ingestion_source_missing` job outcome the old job-start
 * path used. A D1 failure at authorization fails closed BEFORE network and
 * takes the distinct infrastructure job-retry path (no terminal state
 * write; durable charges stand; durable cursor unchanged; the typed
 * `SafeFetchAuthorityError` carries the poll's OBSERVED raw-attempt total
 * (R10.1/B4), exposed on the stable warning — separate from charges).
 *
 * Retry ownership (ADR-0038 §4): provider-side conditions (timeout, 5xx,
 * 429, malformed, auth) are owned by the SOURCE schedule — the handler
 * writes backoff/Retry-After/circuit into source_state and returns
 * SUCCESS ("one poll attempt durably recorded"). Only infrastructure
 * uncertainty stays on the Phase 3 job-retry path.
 *
 * The fenced terminal write uses the deterministic hold window from the
 * payload (`scheduledForMs + hold`) under the LEGACY schema-3 path: a
 * stale worker's state write changes 0 rows (visible in meta) and never
 * overwrites a newer poll, while its item inserts still land (dedup
 * absorbs duplicates). Under OWNERSHIP (schema 4) the fence is the
 * OBSERVED durable hold + the durable owner — never payload-derived.
 */
import type { JobHandler, HandlerOutcome, JobExecutionContext } from '../../domain/jobs/handler';
import { SourcesPollPayloadSchema, type SourcesPollPayload } from '../../domain/jobs/payloads';
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  commitPollResults,
  commitOwnedPollResults,
  acquirePollOwnership,
  type IngestItemRow,
  type PollCommitResult,
  type PollTerminalState,
} from '../../adapters/db/source-ingest-store';
import { resolveSchemaCapability } from '../../adapters/db/schema-health';
import {
  authorizeIngestionUnit,
  readIngestionBudget,
} from '../../adapters/db/ingestion-budget-store';
import type { ConnectorRegistry } from '../../connectors/registry';
import type { ConnectorFetchOutput } from '../../connectors/contract';
import { createIngestionSafeFetch, SafeFetchAuthorityError } from '../../shared/http/safe-http';
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
  /**
   * R10: the RAW transport (`typeof fetch`) over which the handler builds
   * the MANDATORY per-hop budget-authorizing ingestion transport for every
   * execution. Production wiring passes the platform fetch (engine-env); a
   * pre-built SafeFetchExecutor is deliberately NOT accepted here — the
   * ingestion path can never be wired around the budget authority.
   */
  readonly fetchFn: typeof fetch;
  readonly idGenerator: IdGenerator;
  readonly secrets: (name: string) => string | undefined;
  readonly nowMs: () => number;
  readonly random: () => number;
  readonly logger?: Logger;
}

/**
 * R10 infrastructure marker thrown by the transport authorizer when the
 * budget-store read/write itself fails (D1 outage). It NEVER escapes the
 * ingestion transport boundary: safe-http wraps ANY authorizer throw into
 * the typed `SafeFetchAuthorityError` (carrying the observed attempt count,
 * no raw payloads), which the handler catches below. Classification is
 * infrastructure end to end — never quota exhaustion.
 */
class IngestionBudgetAuthorityError extends Error {
  constructor() {
    super('ingestion budget authority unavailable');
    this.name = 'IngestionBudgetAuthorityError';
  }
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
      // R10: `nowMs` is resolved at EACH authorization (options.nowMs()
      // inside the transport authorizer) and again at the terminal commit —
      // never once at job start.

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
        return {
          kind: 'permanent',
          reasonCode: 'ingestion_connector_unavailable',
        };
      }
      const connector = options.connectors.get(source.connector);
      if (connector === undefined) {
        return {
          kind: 'permanent',
          reasonCode: 'ingestion_connector_unavailable',
        };
      }

      // R09/R19-01 OWNERSHIP: resolve the capability ONCE per execution
      // (ONE bounded, indexed metadata read) into exactly one of three
      // typed states. An UNRESOLVED capability (missing/corrupt/unsafe
      // metadata, unsupported version, or a failed metadata read) stops
      // the handler HERE — before ownership, preflight, budget, network,
      // items and source-state effects — with a stable typed RECOVERABLE
      // failure. The engine's own claim/lease bookkeeping for THIS
      // delivery (attempts/lease rows on the jobs table) has already
      // happened by construction and the retry outcome adds the engine's
      // fenced retry_wait bookkeeping — that is engine retry accounting,
      // deliberately distinct from ingestion effects, of which there are
      // ZERO (CE2/CE3/CE4). The work is neither silently completed nor
      // poisoned as an unknown type: the SAME window re-executes once the
      // capability resolves (bounded by the job's max attempts; a persistent
      // outage then dead-letters observably instead of fabricating a
      // success).
      const capability = await resolveSchemaCapability(options.executor);
      if (capability.kind === 'unresolved') {
        options.logger?.warn('ingestion.poll.capability_unresolved', {
          reason: capability.reason,
        });
        return { kind: 'retry', reasonCode: 'ingestion_capability_unresolved' };
      }
      const ownershipEnabled = capability.kind === 'known_v4_ownership';
      let ownedHoldUntilMs: number | null = null;
      if (ownershipEnabled) {
        const acquisition = await acquirePollOwnership(options.executor, {
          sourceId,
          jobId: context.jobId,
          scheduledForMs,
          generation: context.generation,
          nowMs: options.nowMs(),
        });
        if (acquisition.kind === 'not_owned') {
          // Superseded window or foreign owner: skip BEFORE the network —
          // zero fetches, zero budget rows, zero state writes (an old
          // generation or lost owner writes zero items, zero state, and
          // cannot release a newer owner). Completes honestly.
          options.logger?.debug('ingestion.poll.ownership_refused', {
            reason: acquisition.reason,
          });
          return { kind: 'success' };
        }
        ownedHoldUntilMs = acquisition.holdUntilMs;
      }
      // The commit fence hold: the OBSERVED durable anchor under ownership
      // (never payload-derived); the legacy payload-derived window under
      // the applied schema 3.
      const fenceHoldUntilMs = ownedHoldUntilMs ?? holdUntilMs;
      const commitOwner = ownershipEnabled
        ? ({ jobId: context.jobId, generation: context.generation } as const)
        : null;

      // Pre-flight re-check (payload carries IDs only; config comes from D1).
      let config: Record<string, unknown> = {};
      try {
        const parsedConfig: unknown = JSON.parse(source.config_json);
        if (
          parsedConfig !== null &&
          typeof parsedConfig === 'object' &&
          !Array.isArray(parsedConfig)
        ) {
          config = parsedConfig as Record<string, unknown>;
        }
      } catch {
        config = {};
      }
      const preflight = connector.preflight(config, options.secrets);
      if (!preflight.ok) {
        await commitTerminalState(
          options,
          source,
          fenceHoldUntilMs,
          {
            status: 'failed',
            items: [],
            cursor: source.cursor,
            etag: source.etag,
            lastModified: source.last_modified,
            retryAfterSeconds: null,
            requestCount: 0,
            malformedCount: 0,
            failureReason: preflight.reason,
          },
          commitOwner,
        );
        return { kind: 'success' };
      }

      // R10: build the source-bound budgeted ingestion transport for THIS
      // execution. The authorizer resolves `nowMs` at EACH authorization
      // (Tehran bucket per hop), consumes EXACTLY ONE unit atomically, and
      // maps a D1 storage failure onto the typed infrastructure error (the
      // transport fails closed with zero raw requests; the error reaches
      // the typed catch below — it is never quota exhaustion).
      const ingestionFetch = createIngestionSafeFetch({
        fetchFn: options.fetchFn,
        authorizeUnit: async () => {
          try {
            const grant = await authorizeIngestionUnit(options.executor, {
              sourceId,
              nowMs: options.nowMs(),
            });
            if (grant.kind === 'authorized') {
              return { kind: 'granted' };
            }
            return grant.kind === 'denied' ? { kind: 'budget_denied' } : { kind: 'source_missing' };
          } catch {
            // Storage failure inside the authority: infrastructure, not
            // quota. The transport has issued no raw request for this hop.
            throw new IngestionBudgetAuthorityError();
          }
        },
      });

      // ONE bounded connector fetch sequence through the budgeted transport.
      let fetched: ConnectorFetchOutput;
      try {
        fetched = await connector.fetch({
          sourceId,
          config,
          state: {
            etag: source.etag,
            lastModified: source.last_modified,
            cursor: source.cursor,
          },
          effects: {
            safeFetch: ingestionFetch,
            nowMs: options.nowMs,
            random: options.random,
            secrets: options.secrets,
          },
        });
      } catch (error) {
        if (error instanceof SafeFetchAuthorityError) {
          // Distinct stable infrastructure path (R10; R10.1/B4): NO
          // terminal state write (durable cursor unchanged), job-retry
          // ownership, and the poll's safe OBSERVED raw-attempt total
          // (prior completed sequences + the failing one, aggregated once
          // by the connectors) is exposed on the stable warning — a
          // SEPARATE metric from durable charged units, never derived from
          // them. No error text/URL/headers/body is ever logged.
          options.logger?.warn('ingestion.poll.budget_authority_unavailable', {
            errorCode: 'job_handler_retryable_error',
            observedRequests: error.requestCount,
          });
          return { kind: 'retry', reasonCode: 'job_handler_retryable_error' };
        }
        options.logger?.warn('ingestion.poll.connector_threw', {
          errorCode: 'connector_unavailable',
        });
        void error; // never logged (may carry provider text)
        await commitTerminalState(
          options,
          source,
          fenceHoldUntilMs,
          {
            status: 'failed',
            items: [],
            cursor: source.cursor,
            etag: source.etag,
            lastModified: source.last_modified,
            retryAfterSeconds: null,
            requestCount: 0,
            malformedCount: 0,
            failureReason: 'connector_unavailable',
          },
          commitOwner,
        );
        return { kind: 'success' };
      }

      // R10: a mid-sequence missing source (the row vanished between the
      // existence check and a later authorization) surfaces the SAME
      // permanent outcome the old job-start path used — no terminal state
      // write against a possibly-vanished source.
      if (fetched.budgetDenied === true && fetched.budgetDenialKind === 'source_missing') {
        return { kind: 'permanent', reasonCode: 'ingestion_source_missing' };
      }

      // Atomic guarded commit: items + fenced terminal state. Budget-
      // denied exits arrive here with the connector's typed output (no
      // items, prior cursor/validators, failureReason 'budget_exhausted')
      // and take the existing INGESTION_BUDGET_RETRY_MS pacing branch.
      // Under ownership the batch is the OWNERSHIP-FENCED commit (every
      // item insert AND the state write carry predicate P; on success
      // ownership is released atomically).
      const result = await commitTerminalState(
        options,
        source,
        fenceHoldUntilMs,
        fetched,
        commitOwner,
      );

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
 *
 * R09: with `owner` present (schema-4 ownership capability ON) the commit
 * is the OWNERSHIP-FENCED batch — every statement carries predicate P
 * (durable hold + owner + job identity/claimed/exact generation), the
 * hold fence is the OBSERVED durable anchor (never payload-derived), and
 * a mixed-source batch is rejected before any statement runs (B1).
 * Without `owner` (applied schema 3) the accepted legacy fenced commit
 * runs byte-identically.
 */
async function commitTerminalState(
  options: SourcePollHandlerOptions,
  source: SourceWithState,
  holdUntilMs: number,
  fetched: TerminalInput,
  owner: { readonly jobId: string; readonly generation: number } | null,
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
  if (fetched.budgetDenied === true) {
    // R10.1 (B3): a denied window must never be scheduled EARLIER than
    // either its budget-defer minimum OR the strongest provider Retry-After
    // lower bound already observed in the denied sequence (R05 invariant at
    // the new boundary; ZERO is a valid bound and is never treated as
    // unknown). The ladder does not apply (a denial is not a provider
    // failure); ordinary (non-denied) outcomes keep the exact prior policy.
    const providerBoundMs =
      fetched.retryAfterSeconds !== null ? fetched.retryAfterSeconds * 1000 : 0;
    nextPollAtMs = nowMs + Math.max(INGESTION_BUDGET_RETRY_MS, providerBoundMs);
  } else if (fetched.retryAfterSeconds !== null) {
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
    // R10.1 (B2): a budget-denied window pins the LOADED source row's
    // cursor/etag/last-modified EXACTLY — a denial by authority must never
    // null or partially advance the persisted state (coherent across the
    // contract helper and this real commit path).
    cursor: fetched.budgetDenied === true ? source.cursor : fetched.cursor,
    etag:
      fetched.budgetDenied === true || fetched.status === 'not_modified'
        ? source.etag
        : fetched.etag,
    lastModified:
      fetched.budgetDenied === true || fetched.status === 'not_modified'
        ? source.last_modified
        : fetched.lastModified,
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

  if (owner === null) {
    return commitPollResults(options.executor, {
      sourceId: source.id,
      items: itemRows,
      state,
      holdUntilMs,
      nowMs,
    });
  }
  return commitOwnedPollResults(options.executor, {
    sourceId: source.id,
    jobId: owner.jobId,
    generation: owner.generation,
    observedHoldUntilMs: holdUntilMs,
    items: itemRows,
    state,
    nowMs,
  });
}
