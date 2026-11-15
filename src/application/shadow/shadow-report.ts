/**
 * Phase 11.1 — the SHADOW-MODE report generator (the offline
 * instrumentation the 7–14 day shadow run consumes; ADR-0042 §6 shape).
 *
 * A PURE read layer over the blueprint-approved tables (schema 6 — ZERO
 * DDL): every metric is a bounded, read-only aggregate the shadow
 * runbook samples ONCE per tick; nothing here writes, sends, or enables
 * anything. The metrics mirror the shadow gates the roadmap Phase 11
 * names: freshness, duplicate pressure, quality-signal counts, budget
 * consumption, and the publication honesty counts (the parked-uncertain
 * family is EXPLICIT — a shadow report that hid the ambiguous window
 * would be a lie).
 *
 * HONEST BOUNDARY: the actual 7–14 day shadow run is a LIVE surface
 * (Posidon only) — this module is the offline instrumentation the run
 * READS; a report over an empty local D1 is honestly zero-valued, never
 * simulated. Every metric carries its window so a caller cannot confuse
 * a stale report with the current one.
 */

import type { DbExecutor } from '../../adapters/db/db-executor';

export const SHADOW_REPORT_VERSION = 'shd1' as const;

export interface ShadowReport {
  readonly version: typeof SHADOW_REPORT_VERSION;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
  readonly generatedAtMs: number;
  /** The publication honesty counts over the window + the ALL-TIME parked state. */
  readonly publications: {
    readonly publishedInWindow: number;
    readonly failedParkedAllTime: number;
    readonly supersededAllTime: number;
    readonly deadLetterAllTime: number;
    readonly recordedMessagesAllTime: number;
  };
  /** The story/claim/evidence pipeline pressure. */
  readonly pipeline: {
    readonly storiesAllTime: number;
    readonly draftsAllTime: number;
    readonly claimsAllTime: number;
    readonly evidenceAllTime: number;
  };
  /** The duplicate pressure over the window (the source-level dedup verdicts). */
  readonly ingestion: {
    readonly itemsProcessedInWindow: number;
    readonly itemsDuplicateInWindow: number;
    readonly itemsFailedInWindow: number;
  };
  /** The AI run consumption (the LOCAL PROXY metric — never a billing counter). */
  readonly ai: {
    readonly runsInWindow: number;
  };
}

function intOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

async function countWhere(
  executor: DbExecutor,
  sql: string,
  params: readonly (number | string)[],
): Promise<number> {
  const row = await executor.first<{ readonly total: number }>({
    sql,
    params,
  });
  return intOrZero(row?.total);
}

export async function generateShadowReport(
  executor: DbExecutor,
  input: { readonly windowStartMs: number; readonly windowEndMs: number },
): Promise<ShadowReport> {
  const { windowStartMs, windowEndMs } = input;
  const publications = {
    publishedInWindow: await countWhere(
      executor,
      `SELECT COUNT(*) AS total FROM publications
        WHERE status = 'published' AND published_at IS NOT NULL
          AND published_at >= ? AND published_at <= ?`,
      [windowStartMs, windowEndMs],
    ),
    failedParkedAllTime: await countWhere(
      executor,
      `SELECT COUNT(*) AS total FROM publications WHERE status = 'failed'`,
      [],
    ),
    supersededAllTime: await countWhere(
      executor,
      `SELECT COUNT(*) AS total FROM publications WHERE status = 'superseded'`,
      [],
    ),
    deadLetterAllTime: await countWhere(
      executor,
      `SELECT COUNT(*) AS total FROM publications WHERE status = 'dead_letter'`,
      [],
    ),
    recordedMessagesAllTime: await countWhere(
      executor,
      `SELECT COUNT(*) AS total FROM publication_messages`,
      [],
    ),
  };
  const pipeline = {
    storiesAllTime: await countWhere(executor, `SELECT COUNT(*) AS total FROM stories`, []),
    draftsAllTime: await countWhere(executor, `SELECT COUNT(*) AS total FROM drafts`, []),
    claimsAllTime: await countWhere(executor, `SELECT COUNT(*) AS total FROM claims`, []),
    evidenceAllTime: await countWhere(executor, `SELECT COUNT(*) AS total FROM evidence`, []),
  };
  const ingestion = {
    itemsProcessedInWindow: await countWhere(
      executor,
      `SELECT COUNT(*) AS total FROM source_items
        WHERE processing_status = 'processed' AND fetched_at >= ? AND fetched_at <= ?`,
      [windowStartMs, windowEndMs],
    ),
    itemsDuplicateInWindow: await countWhere(
      executor,
      `SELECT COUNT(*) AS total FROM source_items
        WHERE processing_status = 'duplicate' AND fetched_at >= ? AND fetched_at <= ?`,
      [windowStartMs, windowEndMs],
    ),
    itemsFailedInWindow: await countWhere(
      executor,
      `SELECT COUNT(*) AS total FROM source_items
        WHERE processing_status = 'failed' AND fetched_at >= ? AND fetched_at <= ?`,
      [windowStartMs, windowEndMs],
    ),
  };
  const ai = {
    runsInWindow: await countWhere(
      executor,
      `SELECT COUNT(*) AS total FROM ai_runs
        WHERE created_at >= ? AND created_at <= ?`,
      [windowStartMs, windowEndMs],
    ),
  };
  return {
    version: SHADOW_REPORT_VERSION,
    windowStartMs,
    windowEndMs,
    generatedAtMs: windowEndMs,
    publications,
    pipeline,
    ingestion,
    ai,
  };
}

/**
 * The shadow-gate evaluation (the roadmap's STOP criteria, typed): a
 * gate evaluates over the report; every gate name/verdict is data the
 * runbook reads — never a free-text judgement.
 */
export type ShadowGateVerdict = 'pass' | 'insufficient_data' | 'stop';

export interface ShadowGate {
  readonly name: string;
  readonly verdict: ShadowGateVerdict;
  readonly detail: string;
}

export function evaluateShadowGates(report: ShadowReport): readonly ShadowGate[] {
  const gates: ShadowGate[] = [];
  // The duplicate-pressure gate: over the window, the duplicate share of
  // the processed items must stay under the pinned 50% ceiling (a higher
  // share means the source set is wasting the budget).
  const processed = report.ingestion.itemsProcessedInWindow;
  const duplicates = report.ingestion.itemsDuplicateInWindow;
  if (processed === 0) {
    gates.push({
      name: 'duplicate_pressure',
      verdict: 'insufficient_data',
      detail: 'no processed source items in the window',
    });
  } else if (duplicates / processed > 0.5) {
    gates.push({
      name: 'duplicate_pressure',
      verdict: 'stop',
      detail: `duplicate share ${(duplicates / processed).toFixed(3)} over the 0.5 ceiling`,
    });
  } else {
    gates.push({
      name: 'duplicate_pressure',
      verdict: 'pass',
      detail: `duplicate share ${(duplicates / processed).toFixed(3)} within the ceiling`,
    });
  }
  // The parked-uncertainty gate: the ALL-TIME failed-parked family must
  // be zero for the AUTO decision — a parked outcome is never auto-resent
  // (ADR-0058), so any parked row needs a human disposition BEFORE the
  // rollout plan may widen.
  gates.push({
    name: 'parked_uncertainty',
    verdict: report.publications.failedParkedAllTime === 0 ? 'pass' : 'stop',
    detail: `failed-parked publications: ${report.publications.failedParkedAllTime}`,
  });
  // The publication-throughput gate: the shadow run must have actually
  // published (an empty window means the pipeline never went live —
  // insufficient data for the AUTO decision, never a pass).
  gates.push({
    name: 'publication_throughput',
    verdict: report.publications.publishedInWindow > 0 ? 'pass' : 'insufficient_data',
    detail: `published in window: ${report.publications.publishedInWindow}`,
  });
  return gates;
}
