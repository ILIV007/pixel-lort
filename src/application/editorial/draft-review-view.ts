/**
 * The read-only editorial review APPLICATION service (R1.18 — ADR-0046).
 *
 * Wires, for the `/drafts` surface ONLY:
 *   store (the two bounded SELECTs) -> defensive document projection (the
 *   EXISTING strict typed readers) -> budget-first renderer.
 *
 * Non-effects (hard boundaries):
 * - ZERO editorial writes of any kind; ZERO provider calls; ZERO ai_runs,
 *   budget or publication rows. A read is side-effect-free editorially.
 * - The five stored reports are read through the EXISTING strict typed
 *   readers — `readEventRelationDecision` takes the document JSON STRING,
 *   the other four take the parsed document — their honest typed states
 *   (absent / unsupported_version / malformed) stay VISIBLE and distinct
 *   per report; a corrupt optional report never crashes the preview and
 *   never displays as a zero/no-match observation.
 * - The view shows the SAVED document: nothing is recomputed from mutable
 *   source rows, no side-B evidence text is reconstructed, no fresh basis
 *   check is claimed, and no backfill happens.
 * - A transient DB failure THROWS (mapped AppError, retryable in the
 *   ingress failure classification) — it can never surface as not_found or
 *   as an empty success.
 */
import type { DbExecutor } from '../../adapters/db/db-executor';
import {
  createEditorialReviewStore,
  type EditorialReviewDraftDetailRow,
} from '../../adapters/db/editorial-review-store';
import type { TelegramSafeHtml } from '../../admin/telegram-html';
import type { AdminUiLanguage } from '../../admin/ui-language';
import type { EvidenceGuardReport } from '../../domain/editorial/evidence-guard';
import { readEvidenceGuardReport } from '../../domain/editorial/evidence-guard';
import type { CandidateDiscoveryReport } from '../../domain/editorial/candidate-discovery';
import { readCandidateDiscoveryReport } from '../../domain/editorial/candidate-discovery';
import type { CandidateAssessmentReport } from '../../domain/editorial/candidate-assessment';
import { readCandidateAssessmentReport } from '../../domain/editorial/candidate-assessment';
import type { EntityMentionsReport } from '../../domain/editorial/entity-mentions';
import { readEntityMentionsReport } from '../../domain/editorial/entity-mentions';
import type { EventRelationDecisionReport } from '../../domain/editorial/event-relation-decision';
import { readEventRelationDecision } from '../../domain/editorial/event-relation-decision';
import {
  renderDraftDetail,
  renderDraftsList,
  type DraftClaimSampleView,
  type DraftDocumentView,
  type DraftListRowView,
  type DraftListViewModel,
  type DraftRowMetaView,
  type ReviewReportState,
} from './draft-review-render';

export interface EditorialReviewService {
  /** The bounded ready-drafts first page as one safe Telegram message. */
  draftsList(uiLanguage: AdminUiLanguage): Promise<TelegramSafeHtml>;
  /** One stored draft's detail view by its exact validated id. */
  draftsDetail(draftId: string, uiLanguage: AdminUiLanguage): Promise<TelegramSafeHtml>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Map a strict reader result to the renderer's report state. */
function toReportState<T>(read: unknown): ReviewReportState<T> {
  const kind = (read as { readonly kind?: unknown }).kind;
  if (kind === 'absent' || kind === 'unsupported_version' || kind === 'malformed') {
    return { kind };
  }
  const report = (read as { readonly report?: T }).report;
  // The ok variants carry `report`; anything else is honestly malformed —
  // never guessed into a fabricated ok state.
  return report === undefined ? { kind: 'malformed' } : { kind: 'ok', report };
}

/** Defensively read bounded model-claim samples from the stored document. */
function readClaimSamples(document: Record<string, unknown>): {
  readonly samples: readonly DraftClaimSampleView[];
  readonly dropped: boolean;
} {
  const raw = document['modelClaims'];
  if (!Array.isArray(raw)) {
    return { samples: [], dropped: false };
  }
  const samples: DraftClaimSampleView[] = [];
  for (const entry of raw) {
    if (samples.length >= 3) {
      return { samples, dropped: true };
    }
    if (!isPlainObject(entry)) {
      continue;
    }
    const text = entry['text'];
    if (typeof text !== 'string' || text.length === 0) {
      continue;
    }
    const rawIds = entry['evidenceIds'];
    const evidenceIds = Array.isArray(rawIds)
      ? rawIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 3)
      : [];
    samples.push({ text, evidenceIds });
  }
  return { samples, dropped: false };
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Defensive core projection. The stored document is NOT trusted: core field
 * types are checked before display, and each optional report is read by its
 * own strict reader so its honest state stays visible and distinct.
 */
function projectDocument(
  row: EditorialReviewDraftDetailRow,
  documentJson: string,
):
  | { readonly kind: 'full'; readonly document: DraftDocumentView }
  | { readonly kind: 'core_malformed' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson) as unknown;
  } catch {
    return { kind: 'core_malformed' };
  }
  if (!isPlainObject(parsed)) {
    return { kind: 'core_malformed' };
  }
  if (parsed['schemaVersion'] !== 1) {
    // Handled by the caller as the typed unsupported-version state.
    return { kind: 'core_malformed' };
  }
  const headlineFa = parsed['headlineFa'];
  const summaryFa = parsed['summaryFa'];
  const sourceReport = parsed['sourceReport'];
  if (!isString(headlineFa) || !isString(summaryFa) || !isPlainObject(sourceReport)) {
    return { kind: 'core_malformed' };
  }
  const sourceName = sourceReport['sourceName'];
  const excerptText = sourceReport['excerptText'];
  const sourceItemId = sourceReport['sourceItemId'];
  const truncated = sourceReport['truncated'];

  const guardRead = readEvidenceGuardReport(parsed);
  const discoveryRead = readCandidateDiscoveryReport(parsed);
  const assessmentRead = readCandidateAssessmentReport(parsed);
  const mentionsRead = readEntityMentionsReport(parsed);
  // NOTE the deliberate API difference: the relation reader takes the
  // document JSON STRING (its own strict contract — never re-implemented).
  const relationRead = readEventRelationDecision(documentJson);

  const guard = toReportState<EvidenceGuardReport>(guardRead);
  const snapshotContentHash =
    guard.kind === 'ok'
      ? guard.report.snapshot.contentHash
      : discoveryRead.kind === 'candidate_discovery_v1'
        ? discoveryRead.report.snapshot.contentHash
        : null;

  const claims = readClaimSamples(parsed);

  const document: DraftDocumentView = {
    headlineFa,
    summaryFa,
    sourceName: isString(sourceName) ? sourceName : '',
    sourceExcerpt: isString(excerptText) ? excerptText : '',
    sourceExcerptStoredTruncated: truncated === true,
    sourceItemId: isString(sourceItemId) ? sourceItemId : '',
    snapshotContentHash,
    claimSamples: claims.samples,
    claimSamplesDropped: claims.dropped,
    guard,
    discovery: toReportState<CandidateDiscoveryReport>(discoveryRead),
    assessment: toReportState<CandidateAssessmentReport>(assessmentRead),
    mentions: toReportState<EntityMentionsReport>(mentionsRead),
    relation: toReportState<EventRelationDecisionReport>(relationRead),
  };
  return { kind: 'full', document };
}

function toRowMeta(row: EditorialReviewDraftDetailRow): DraftRowMetaView {
  return {
    id: row.id,
    storyId: row.storyId,
    status: row.status,
    version: row.version,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    documentBytes: row.documentBytes,
  };
}

export function createEditorialReviewService(deps: {
  readonly executor: DbExecutor;
}): EditorialReviewService {
  const store = createEditorialReviewStore(deps.executor);

  async function draftsList(uiLanguage: AdminUiLanguage): Promise<TelegramSafeHtml> {
    const page = await store.listReadyFirstPage();
    let view: DraftListViewModel;
    if (page.rows.length === 0) {
      view = { kind: 'empty' };
    } else {
      const rows: DraftListRowView[] = page.rows.map((row) => ({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt,
      }));
      view = { kind: 'rows', rows, moreAvailable: page.moreAvailable };
    }
    return renderDraftsList(view, uiLanguage);
  }

  async function draftsDetail(
    draftId: string,
    uiLanguage: AdminUiLanguage,
  ): Promise<TelegramSafeHtml> {
    const row = await store.findDraftDetail(draftId);
    if (row === null) {
      return renderDraftDetail({ kind: 'not_found', requestedId: draftId }, uiLanguage);
    }
    const meta = toRowMeta(row);
    if (row.documentJson === null) {
      // The SQL byte guard kept the oversized document from transferring.
      return renderDraftDetail(
        { kind: 'row_only', row: meta, documentState: 'too_large' },
        uiLanguage,
      );
    }
    // Unsupported document version check BEFORE the core projection: the
    // projection itself treats a non-1 schemaVersion as malformed — but the
    // honest state here is unsupported_version (distinct typed outcome).
    let unsupportedVersion = false;
    try {
      const parsed: unknown = JSON.parse(row.documentJson);
      if (isPlainObject(parsed) && parsed['schemaVersion'] !== 1) {
        unsupportedVersion = true;
      }
    } catch {
      // fall through to the projection's malformed handling
    }
    if (unsupportedVersion) {
      return renderDraftDetail(
        { kind: 'row_only', row: meta, documentState: 'unsupported_version' },
        uiLanguage,
      );
    }
    const projection = projectDocument(row, row.documentJson);
    if (projection.kind === 'core_malformed') {
      return renderDraftDetail(
        { kind: 'row_only', row: meta, documentState: 'malformed' },
        uiLanguage,
      );
    }
    return renderDraftDetail(
      { kind: 'full', row: meta, document: projection.document },
      uiLanguage,
    );
  }

  return { draftsList, draftsDetail };
}
