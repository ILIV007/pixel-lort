/**
 * Budget-first Telegram-HTML renderer for the read-only draft review
 * surface (R1.18 — ADR-0046). PURE — no I/O, no clock, no D1.
 *
 * Budget discipline (R1.18 §3.D):
 * - The finished message is bounded to `REVIEW_MESSAGE_MAX_UNITS` UTF-16
 *   code units INCLUDING escaped HTML — conservatively below Telegram's
 *   4096 limit.
 * - Section/field budgets are decided BEFORE composition; a raw value can
 *   never push its section over budget: `boundedEscaped` walks the raw text
 *   CODE-POINT BY CODE-POINT and stops at the exact escaped-unit budget, so
 *   an entity is never sliced mid-way and a surrogate pair is never split.
 * - Composition is priority-ordered: safety labels/notices are composed
 *   first and never dropped in favor of long content; optional content
 *   sections are appended while they fit; anything dropped or field-trimmed
 *   raises ONE explicit `display_truncated` line at the end.
 * - Every emitted value is escaped text or a builder fragment — there is no
 *   raw-HTML passthrough; hostile `<>&"`, bidi controls, emoji and enormous
 *   foreign strings stay inert text.
 */
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  telegramCode,
  type TelegramSafeHtml,
} from '../../admin/telegram-html';
import type { AdminUiLanguage } from '../../admin/ui-language';
import { REVIEW_RENDER_LABELS, type ReviewRenderLabels } from './draft-review-labels';
import type { EvidenceGuardReport } from '../../domain/editorial/evidence-guard';
import type { CandidateDiscoveryReport } from '../../domain/editorial/candidate-discovery';
import type { CandidateAssessmentReport } from '../../domain/editorial/candidate-assessment';
import type { FactGuardReport } from '../../domain/editorial/fact-guard';
import type { EntityMentionsReport } from '../../domain/editorial/entity-mentions';
import type { EventRelationDecisionReport } from '../../domain/editorial/event-relation-decision';

/** Finished-message budget in UTF-16 code units, escaped HTML included. */
export const REVIEW_MESSAGE_MAX_UNITS = 3500;

/** Reserve for the trailing display-truncated notice (always kept). */
const TRUNCATION_NOTICE_RESERVE = REVIEW_RENDER_LABELS.en.displayTruncated.length + 24;

export interface BoundedEscaped {
  readonly text: string;
  readonly truncated: boolean;
}

const ESCAPE_MAP: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

function escapeCodePoint(codePoint: string): string {
  return ESCAPE_MAP[codePoint] ?? codePoint;
}

/**
 * Escape at most `maxEscapedUnits` UTF-16 code units of `raw`, walking
 * CODE POINTS (never slicing a surrogate pair) and whole entities (never
 * slicing an entity). The result is always valid escaped text — the same
 * entity set `escapeTelegramHtml` produces.
 */
export function boundedEscaped(raw: string, maxEscapedUnits: number): BoundedEscaped {
  if (maxEscapedUnits <= 0) {
    return { text: '', truncated: raw.length > 0 };
  }
  let out = '';
  for (const codePoint of raw) {
    const escaped = escapeCodePoint(codePoint);
    if (out.length + escaped.length > maxEscapedUnits) {
      return { text: out, truncated: true };
    }
    out += escaped;
  }
  return { text: out, truncated: false };
}

/** Format a stored epoch-ms timestamp deterministically (UTC ISO-8601). */
export function formatUtcEpochMs(ms: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    return '—';
  }
  return new Date(ms).toISOString();
}

/**
 * Priority-ordered message composer. Fixed lines (labels, safety notices)
 * are added first and never dropped; content lines are added while they
 * fit. `finish()` always returns a message within budget and, when anything
 * was trimmed or dropped, ends with the explicit display-truncated notice.
 *
 * R1.18.1 (S1): mandatory lines (safety notices, typed report states) can
 * be RESERVED before variable content is composed. Reserved units are
 * subtracted from every content budget and released only when the line is
 * actually added — long stored content can never crowd them out; less
 * content is always preferred over weaker warnings.
 */
class BudgetedMessage {
  private readonly parts: TelegramSafeHtml[] = [];
  private used = 0;
  private truncated = false;
  private readonly max: number;
  /** Reserved-but-not-yet-added mandatory line units (R1.18.1 — S1). */
  private reservedUnits = 0;
  private readonly reservations = new Map<string, number>();

  constructor(
    max: number,
    private readonly labels: ReviewRenderLabels,
  ) {
    this.max = max;
  }

  private remaining(): number {
    return this.max - this.used - this.reservedUnits - TRUNCATION_NOTICE_RESERVE;
  }

  /**
   * Reserve the exact escaped size of a mandatory line under `key` BEFORE
   * variable content is composed. Idempotent per key.
   */
  reserveLine(key: string, units: number): void {
    if (this.reservations.has(key)) {
      return;
    }
    this.reservations.set(key, units);
    this.reservedUnits += units;
  }

  private releaseLine(key: string): void {
    const units = this.reservations.get(key);
    if (units !== undefined) {
      this.reservedUnits -= units;
      this.reservations.delete(key);
    }
  }

  /** Add a reserved FIXED line (the exact label text — always kept). */
  addReservedFixed(key: string, label: string): void {
    this.releaseLine(key);
    this.addFixed((remaining) => boundedEscaped(label, remaining).text as TelegramSafeHtml);
  }

  /** Add a reserved labeled-value line (short bounded state value). */
  addReservedLabeledValue(key: string, label: string, value: string): void {
    this.releaseLine(key);
    this.addLabeledValue(label, value);
  }

  /**
   * Honest-omission signal (R1.18.1 — C1): whenever a displayed section's
   * values or entries are dropped by caps or space, the message must say
   * so instead of silently implying completeness.
   */
  flagTruncated(): void {
    this.truncated = true;
  }

  /**
   * A FIXED line (label/notice) — always kept. If even this cannot fit
   * (degenerate budget), it is dropped and the truncation flag rises; the
   * header lines are small enough that this never happens in practice.
   */
  addFixed(build: (remaining: number) => TelegramSafeHtml): void {
    const remaining = Math.max(0, this.remaining());
    const line = build(remaining);
    if (line.length <= remaining && line.length > 0) {
      this.parts.push(line);
      this.used += line.length + 1; // composing joins with '\n'
    } else {
      this.truncated = true;
    }
  }

  /**
   * A CONTENT line with a raw untrusted value: the label is fixed, the
   * value is bounded to whatever budget remains (minus the reserve). When
   * the value does not fit at all, the line is dropped and truncation rises.
   */
  addLabeledValue(
    label: string,
    rawValue: string,
    options: { readonly valueSeparator?: string; readonly valueBudget?: number } = {},
  ): void {
    const separator = options.valueSeparator ?? ' ';
    const labelHtml = escapeTelegramHtml(label);
    const fixedCost = labelHtml.length + separator.length + 1;
    const valueBudget = Math.min(
      options.valueBudget ?? Number.POSITIVE_INFINITY,
      this.remaining() - fixedCost,
    );
    if (valueBudget <= 0) {
      this.truncated = true;
      return;
    }
    const bounded = boundedEscaped(rawValue, valueBudget);
    if (bounded.truncated) {
      this.truncated = true;
    }
    if (bounded.text.length === 0) {
      return;
    }
    const line = (labelHtml + separator + bounded.text) as TelegramSafeHtml;
    this.parts.push(line);
    this.used += line.length + 1;
  }

  /** A free-form already-safe fragment bounded to the remaining budget. */
  addFragment(build: (remaining: number) => TelegramSafeHtml | null): void {
    const remaining = this.remaining();
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const fragment = build(remaining);
    if (fragment === null || fragment.length > remaining) {
      if (fragment !== null) {
        this.truncated = true;
      }
      return;
    }
    this.parts.push(fragment);
    this.used += fragment.length + 1;
  }

  finish(): TelegramSafeHtml {
    if (this.truncated) {
      const notice = escapeTelegramHtml(this.labels.displayTruncated);
      if (this.used + notice.length + 1 <= this.max) {
        this.parts.push(notice);
      }
    }
    return composeTelegramHtml(this.parts);
  }
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

export interface DraftListRowView {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
}

export type DraftListViewModel =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'rows';
      readonly rows: readonly DraftListRowView[];
      readonly moreAvailable: boolean;
    };

/** Per-row escaped-title budget (list rows stay one line each). */
const LIST_ROW_TITLE_BUDGET = 90;

export function renderDraftsList(view: DraftListViewModel, ui: AdminUiLanguage): TelegramSafeHtml {
  const labels = REVIEW_RENDER_LABELS[ui];
  const message = new BudgetedMessage(REVIEW_MESSAGE_MAX_UNITS, labels);
  message.addFixed(() => telegramBold(labels.listTitle));
  if (view.kind === 'empty') {
    message.addFixed(
      (remaining) => boundedEscaped(labels.listEmpty, remaining).text as TelegramSafeHtml,
    );
    return message.finish();
  }
  view.rows.forEach((row, index) => {
    message.addFragment((remaining) => {
      const prefix = escapeTelegramHtml(`${index + 1}. `);
      const idHtml = telegramCode(row.id);
      const titleBounded = boundedEscaped(
        row.title,
        Math.min(LIST_ROW_TITLE_BUDGET, remaining - prefix.length - idHtml.length - 24),
      );
      const line =
        prefix +
        idHtml +
        escapeTelegramHtml(' — ') +
        (titleBounded.text.length > 0
          ? titleBounded.text
          : escapeTelegramHtml(labels.valueUnavailable)) +
        escapeTelegramHtml(` · ${formatUtcEpochMs(row.createdAt)}`);
      if (line.length > remaining) {
        return null;
      }
      return line as TelegramSafeHtml;
    });
  });
  if (view.moreAvailable) {
    message.addFixed(
      (remaining) => boundedEscaped(labels.listMore, remaining).text as TelegramSafeHtml,
    );
  }
  message.addFixed(
    (remaining) => boundedEscaped(labels.listHint, remaining).text as TelegramSafeHtml,
  );
  return message.finish();
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

export interface DraftRowMetaView {
  readonly id: string;
  readonly storyId: string;
  readonly status: string;
  readonly version: number;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly documentBytes: number;
}

/** Bounded per-field escaped budgets (decided BEFORE composition). */
const FIELD_BUDGETS = {
  headline: 600,
  summary: 900,
  excerpt: 700,
  claimText: 220,
  claimEvidenceId: 80,
  idValue: 200,
  reason: 140,
  conflict: 140,
  reference: 100,
} as const;

const CLAIM_SAMPLES_SHOWN = 3;
const RELATION_REASONS_MAX = 2;
const RELATION_REFERENCES_MAX = 4;

/** A stored report's typed read state (the strict readers' own outcomes). */
export type ReviewReportState<T> =
  | { readonly kind: 'ok'; readonly report: T }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unsupported_version' }
  | { readonly kind: 'malformed' };

export interface DraftClaimSampleView {
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

export interface DraftDocumentView {
  readonly headlineFa: string;
  readonly summaryFa: string;
  readonly sourceName: string;
  readonly sourceExcerpt: string;
  readonly sourceExcerptStoredTruncated: boolean;
  readonly sourceItemId: string;
  readonly snapshotContentHash: string | null;
  readonly claimSamples: readonly DraftClaimSampleView[];
  readonly claimSamplesDropped: boolean;
  readonly guard: ReviewReportState<EvidenceGuardReport> | null;
  readonly discovery: ReviewReportState<CandidateDiscoveryReport> | null;
  readonly assessment: ReviewReportState<CandidateAssessmentReport> | null;
  readonly mentions: ReviewReportState<EntityMentionsReport> | null;
  readonly relation: ReviewReportState<EventRelationDecisionReport> | null;
  /** Phase 6.4: the stored fact-guard report's typed read state (the
   * strict reader's own outcomes; null never occurs from the projection
   * but the renderer stays defensive). */
  readonly factGuard: ReviewReportState<FactGuardReport> | null;
}

export type DraftDetailViewModel =
  | { readonly kind: 'not_found'; readonly requestedId: string }
  | {
      readonly kind: 'row_only';
      readonly row: DraftRowMetaView;
      readonly documentState: 'too_large' | 'unsupported_version' | 'malformed';
    }
  | { readonly kind: 'full'; readonly row: DraftRowMetaView; readonly document: DraftDocumentView };

function reportStateLine(
  state: 'absent' | 'unsupported_version' | 'malformed',
  labels: ReviewRenderLabels,
): string {
  switch (state) {
    case 'absent':
      return labels.reportAbsent;
    case 'unsupported_version':
      return labels.reportUnsupported;
    case 'malformed':
      return labels.reportMalformed;
  }
}

/** Render one typed report state intro (ok reports get their own summary). */
function addReportState<T>(
  message: BudgetedMessage,
  label: string,
  state: ReviewReportState<T> | null,
  labels: ReviewRenderLabels,
  reservationKey: string,
): void {
  if (state === null) {
    return;
  }
  if (state.kind === 'ok') {
    return; // rendered by the section-specific summary
  }
  // R1.18.1 (S1): report read outcomes never disappear in favor of long
  // article text — the typed state line is added under its reservation.
  message.addReservedLabeledValue(reservationKey, label, reportStateLine(state.kind, labels));
}

/**
 * Escaped unit cost of one fixed line (label text) plus the '\n' join.
 */
function fixedLineUnits(label: string): number {
  return escapeTelegramHtml(label).length + 1;
}

/**
 * Escaped unit cost of one labeled-value line ('label value' + join) —
 * exactly the cost `addLabeledValue` accounts for the same input.
 */
function labeledLineUnits(label: string, value: string): number {
  return escapeTelegramHtml(label).length + 1 + escapeTelegramHtml(value).length + 1;
}

/** Per-pair stored-conflict entries shown (the strict reader bounds ≤4). */
const RELATION_CONFLICTS_MAX = 3;

export function renderDraftDetail(
  view: DraftDetailViewModel,
  ui: AdminUiLanguage,
): TelegramSafeHtml {
  const labels = REVIEW_RENDER_LABELS[ui];
  const message = new BudgetedMessage(REVIEW_MESSAGE_MAX_UNITS, labels);

  if (view.kind === 'not_found') {
    message.addFixed(() => telegramBold(labels.notFoundTitle));
    message.addFixed(
      (remaining) => boundedEscaped(labels.notFoundBody, remaining).text as TelegramSafeHtml,
    );
    message.addLabeledValue(labels.labelDraft, view.requestedId);
    return message.finish();
  }

  const { row } = view;
  message.addFixed(() => telegramBold(labels.detailTitle));
  message.addFragment((remaining) => {
    const idHtml = telegramCode(row.id);
    const meta = escapeTelegramHtml(
      ` · ${labels.labelVersion} ${row.version} · ${labels.labelStatus} ${row.status} · ${formatUtcEpochMs(row.createdAt)}`,
    );
    const line = (escapeTelegramHtml(`${labels.labelDraft} `) + idHtml + meta) as TelegramSafeHtml;
    return line.length <= remaining ? line : null;
  });
  if (row.status === 'ready') {
    message.addFixed(
      (remaining) => boundedEscaped(labels.readyNotice, remaining).text as TelegramSafeHtml,
    );
  }
  message.addLabeledValue(labels.labelStory, row.storyId);

  if (view.kind === 'row_only') {
    const body =
      view.documentState === 'too_large'
        ? `${labels.documentTooLarge} ${labels.readBudgetNote} ${row.documentBytes}`
        : view.documentState === 'unsupported_version'
          ? labels.unsupportedVersion
          : labels.malformedDocument;
    message.addFixed((remaining) => boundedEscaped(body, remaining).text as TelegramSafeHtml);
    return message.finish();
  }

  const doc = view.document;

  // R1.18.1 (S1): reserve ALL mandatory safety/report-state lines BEFORE
  // any variable content is composed. Conditions mirror the add sites
  // below exactly, so every reserved line is later released exactly once.
  message.reserveLine('claimsHeader', fixedLineUnits(labels.labelClaims));
  message.reserveLine('claimsNote', fixedLineUnits(labels.claimsUnverifiedNote));
  message.reserveLine('candidatesNote', fixedLineUnits(labels.candidatesNote));
  if (doc.guard?.kind === 'ok') {
    message.reserveLine('guardNote', fixedLineUnits(labels.guardUnassessedNote));
  }
  if (doc.relation?.kind === 'ok') {
    message.reserveLine('relProposalNote', fixedLineUnits(labels.relationProposalNote));
    message.reserveLine('relTechnicalNote', fixedLineUnits(labels.relationTechnicalNote));
    message.reserveLine('relNoCandidateNote', fixedLineUnits(labels.relationNoCandidateNote));
  }
  if (doc.factGuard?.kind === 'ok') {
    message.reserveLine('factGuardNote', fixedLineUnits(labels.factGuardObsNote));
  }
  if (doc.guard !== null && doc.guard.kind !== 'ok') {
    message.reserveLine(
      'guardState',
      labeledLineUnits(labels.labelGuard, reportStateLine(doc.guard.kind, labels)),
    );
  }
  if (doc.discovery !== null && doc.discovery.kind !== 'ok') {
    message.reserveLine(
      'discoveryState',
      labeledLineUnits(labels.labelCandidates, reportStateLine(doc.discovery.kind, labels)),
    );
  }
  if (doc.assessment !== null && doc.assessment.kind !== 'ok') {
    message.reserveLine(
      'assessmentState',
      labeledLineUnits(labels.labelCandidates, reportStateLine(doc.assessment.kind, labels)),
    );
  }
  if (doc.mentions !== null && doc.mentions.kind !== 'ok') {
    message.reserveLine(
      'mentionsState',
      labeledLineUnits(labels.labelMentions, reportStateLine(doc.mentions.kind, labels)),
    );
  }
  if (doc.relation !== null && doc.relation.kind !== 'ok') {
    message.reserveLine(
      'relationState',
      labeledLineUnits(labels.labelRelation, reportStateLine(doc.relation.kind, labels)),
    );
  }
  if (doc.factGuard !== null && doc.factGuard.kind !== 'ok') {
    message.reserveLine(
      'factGuardState',
      labeledLineUnits(labels.labelFactGuard, reportStateLine(doc.factGuard.kind, labels)),
    );
  }

  message.addLabeledValue(labels.labelHeadline, doc.headlineFa, {
    valueSeparator: ': ',
    valueBudget: FIELD_BUDGETS.headline,
  });
  message.addLabeledValue(labels.labelSummary, doc.summaryFa, {
    valueSeparator: ': ',
    valueBudget: FIELD_BUDGETS.summary,
  });
  message.addLabeledValue(labels.labelSource, doc.sourceName, {
    valueBudget: FIELD_BUDGETS.headline,
  });
  message.addLabeledValue(labels.labelExcerpt, doc.sourceExcerpt, {
    valueBudget: FIELD_BUDGETS.excerpt,
  });
  if (doc.sourceExcerptStoredTruncated) {
    message.addFixed(
      (remaining) =>
        boundedEscaped(labels.excerptStoredTruncated, remaining).text as TelegramSafeHtml,
    );
  }
  message.addLabeledValue(labels.labelSourceItem, doc.sourceItemId, {
    valueBudget: FIELD_BUDGETS.idValue,
  });
  message.addLabeledValue(
    labels.labelSnapshot,
    doc.snapshotContentHash ?? labels.labelSnapshotUnavailable,
    { valueBudget: FIELD_BUDGETS.idValue },
  );

  // Model claims — bounded samples, explicitly UNVERIFIED. The section
  // header carries the mandatory UNVERIFIED distinction (R1.18.1 — S1):
  // it is added under its reservation, never crowded out by content.
  message.addReservedFixed('claimsHeader', labels.labelClaims);
  if (doc.claimSamples.length === 0) {
    message.addFixed(
      (remaining) => boundedEscaped(labels.valueUnavailable, remaining).text as TelegramSafeHtml,
    );
  } else {
    if (doc.claimSamplesDropped) {
      // R1.18.1 (C1): entries omitted by caps are an honest truncation, not
      // a silent completeness claim.
      message.flagTruncated();
    }
    doc.claimSamples.slice(0, CLAIM_SAMPLES_SHOWN).forEach((claim, index) => {
      message.addFragment((remaining) => {
        const label = escapeTelegramHtml(`${labels.labelClaimSample} ${index + 1}: `);
        const bounded = boundedEscaped(
          claim.text,
          Math.min(FIELD_BUDGETS.claimText, remaining - label.length - 24),
        );
        if (bounded.text.length === 0) {
          return null;
        }
        const evidence =
          claim.evidenceIds.length > 0
            ? escapeTelegramHtml(` (${labels.labelEvidenceIds}: `) +
              claim.evidenceIds.map((id) => telegramCode(id)).join(escapeTelegramHtml(', ')) +
              escapeTelegramHtml(')')
            : '';
        const line = (label + bounded.text + evidence) as TelegramSafeHtml;
        return line.length <= remaining ? line : null;
      });
    });
  }
  message.addReservedFixed('claimsNote', labels.claimsUnverifiedNote);

  // Evidence guard — direct-text/unresolved summary + unassessed warning.
  addReportState(message, labels.labelGuard, doc.guard, labels, 'guardState');
  if (doc.guard?.kind === 'ok') {
    const guard = doc.guard.report;
    message.addLabeledValue(
      labels.labelGuard,
      `${labels.labelStatus}: ${guard.evaluationStatus} · ${guard.counts.total} (${guard.counts.directTextObserved} direct / ${guard.counts.unresolvedRequiresFurtherVerification} unresolved)`,
    );
    // Per-claim honest outcomes (the stored report's own statuses).
    const statuses = guard.claims
      .slice(0, 4)
      .map((claim) => claim.status)
      .join(', ');
    if (statuses.length > 0) {
      message.addLabeledValue(labels.labelGuard, statuses);
    }
    message.addReservedFixed('guardNote', labels.guardUnassessedNote);
  }

  // Fact guard (Phase 6.4) — the stored LEXICAL observations only. The
  // section states the observation counts under the SAME reservation
  // discipline (the mandatory note survives budget pressure); the typed
  // non-ok states render through the shared honest-state line.
  addReportState(message, labels.labelFactGuard, doc.factGuard, labels, 'factGuardState');
  if (doc.factGuard?.kind === 'ok') {
    const factGuard = doc.factGuard.report;
    message.addLabeledValue(
      labels.labelFactGuard,
      `${labels.labelStatus}: ${factGuard.evaluationStatus} · ${factGuard.counts.total} (${factGuard.counts.claimsRequiringReview} ${labels.factGuardRequiringReview} / ${factGuard.counts.unwitnessedClaims} ${labels.factGuardUnwitnessed})`,
    );
    const findings =
      factGuard.counts.numberFindings +
      factGuard.counts.quotationFindings +
      factGuard.counts.rumorFindings +
      factGuard.counts.negationFindings;
    message.addLabeledValue(labels.labelFactGuard, `findings: ${findings}`);
    message.addReservedFixed('factGuardNote', labels.factGuardObsNote);
  }

  // Candidates (discovery + assessment) — historical observations only.
  addReportState(message, labels.labelCandidates, doc.discovery, labels, 'discoveryState');
  addReportState(message, labels.labelCandidates, doc.assessment, labels, 'assessmentState');
  if (doc.discovery?.kind === 'ok') {
    const discovery = doc.discovery.report;
    message.addLabeledValue(
      labels.labelCandidates,
      `discovery: ${discovery.observation} · ${discovery.counts.candidatesReported}`,
    );
  }
  if (doc.assessment?.kind === 'ok') {
    const assessment = doc.assessment.report;
    message.addLabeledValue(
      labels.labelCandidates,
      `assessment: ${assessment.observation} · ${assessment.counts.assessed}`,
    );
  }
  message.addReservedFixed('candidatesNote', labels.candidatesNote);

  // Entity mentions — historical observation only.
  addReportState(message, labels.labelMentions, doc.mentions, labels, 'mentionsState');
  if (doc.mentions?.kind === 'ok') {
    const mentions = doc.mentions.report;
    message.addLabeledValue(
      labels.labelMentions,
      `${mentions.observation} · ${mentions.counts.uniqueAliasesMatched} (+${mentions.counts.ambiguousAliasesObserved} ambiguous)`,
    );
  }

  // Event relation — proposals vs technical states.
  addReportState(message, labels.labelRelation, doc.relation, labels, 'relationState');
  if (doc.relation?.kind === 'ok') {
    const relation = doc.relation.report;
    message.addLabeledValue(labels.labelRelation, `observation: ${relation.observation}`);
    const pairEntries = relation.pairs;
    const pairs = pairEntries.slice(0, 2);
    if (pairEntries.length > pairs.length) {
      // Pair cap (≤2) hit: honest omission, never silent completeness.
      message.flagTruncated();
    }
    pairs.forEach((pair, index) => {
      message.addFragment((remaining) => {
        const head = escapeTelegramHtml(
          `${labels.labelRelation} #${index + 1}: ${pair.pairId} · ${pair.state}`,
        );
        const parts: string[] = [head];
        if (pair.verdict !== undefined) {
          parts.push(escapeTelegramHtml(`verdict: ${pair.verdict}`));
        }
        if (pair.sideA !== undefined) {
          parts.push(escapeTelegramHtml(`A: `) + telegramCode(pair.sideA.evidenceId));
        }
        if (
          pair.sideB !== undefined &&
          typeof pair.sideB.storyId === 'string' &&
          pair.sideB.storyId.length > 0
        ) {
          parts.push(escapeTelegramHtml('B: ') + telegramCode(pair.sideB.storyId));
        }
        const reasonEntries = pair.reasons ?? [];
        const reasonLines = reasonEntries.slice(0, RELATION_REASONS_MAX);
        if (reasonEntries.length > reasonLines.length) {
          message.flagTruncated();
        }
        for (const reason of reasonLines) {
          const bounded = boundedEscaped(reason, FIELD_BUDGETS.reason);
          if (bounded.truncated) {
            message.flagTruncated();
          }
          parts.push(escapeTelegramHtml('· ') + bounded.text);
        }
        // R1.18.1 (C1): the pair's STORED conflicts — bounded escaped text,
        // DISTINCT from reasons, verbatim (never translated, replaced or
        // inferred; no new assessment runs). Honest omission/truncation.
        const conflictEntries = pair.conflicts ?? [];
        const conflictLines = conflictEntries.slice(0, RELATION_CONFLICTS_MAX);
        if (conflictEntries.length > conflictLines.length) {
          message.flagTruncated();
        }
        for (const conflict of conflictLines) {
          const bounded = boundedEscaped(conflict, FIELD_BUDGETS.conflict);
          if (bounded.truncated) {
            message.flagTruncated();
          }
          if (bounded.text.length > 0) {
            parts.push(escapeTelegramHtml('conflict: ') + bounded.text);
          }
        }
        const referenceEntries = pair.references ?? [];
        const referenceLines = referenceEntries.slice(0, RELATION_REFERENCES_MAX);
        if (referenceEntries.length > referenceLines.length) {
          message.flagTruncated();
        }
        if (referenceLines.length > 0) {
          parts.push(
            escapeTelegramHtml(`${labels.labelEvidenceIds}: `) +
              referenceLines
                .map((reference) => telegramCode(`${reference.side}:${reference.evidenceId}`))
                .join(escapeTelegramHtml(', ')),
          );
        }
        // The pair's REAL adjudication run ids (honest provenance; ≤2 shown).
        const runEntries = pair.aiRunIds ?? [];
        const runLines = runEntries.slice(0, 2);
        if (runEntries.length > runLines.length) {
          message.flagTruncated();
        }
        if (runLines.length > 0) {
          parts.push(
            escapeTelegramHtml('runs: ') +
              runLines.map((runId) => telegramCode(runId)).join(escapeTelegramHtml(', ')),
          );
        }
        const joined = parts.join(escapeTelegramHtml(' · ')) as TelegramSafeHtml;
        if (joined.length > remaining) {
          // The pair tail does not fit: head-only plus an HONEST truncation
          // signal — never a silent completeness implication (R1.18.1 — C1).
          message.flagTruncated();
          const headOnly = head.length <= remaining ? (head as TelegramSafeHtml) : null;
          return headOnly;
        }
        return joined;
      });
    });
    message.addReservedFixed('relProposalNote', labels.relationProposalNote);
    message.addReservedFixed('relTechnicalNote', labels.relationTechnicalNote);
    message.addReservedFixed('relNoCandidateNote', labels.relationNoCandidateNote);
  }

  return message.finish();
}
