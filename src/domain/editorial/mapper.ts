/**
 * Pure editorial mapping (Phase 5A — ADR-0042 §2): conservative evidence /
 * claim / draft shapes derived from stored source items and the validated
 * AI output. NO SQL, NO provider SDK, NO clock — every function is
 * deterministic and unit-testable offline.
 *
 * Conservatism contract (Posidon R1.11 §4–§7):
 * - The model output NEVER raises confidence and NEVER confirms a claim.
 * - Model-proposed claims live inside draft `document_json`/`facts_json`
 *   with status `unverified` — they are NOT rows in `claims` and carry no
 *   editorial trust. The full Fact Guard remains a later phase.
 * - The only durable `claims` row is the SOURCE REPORT: "source X reported
 *   this text" — `claim_type='source_report'`, `status='unverified'`,
 *   `confidence=0`, with `object_text` traceable to the SAME source item.
 * - Evidence links the report to its item with `stance='mentions'` and
 *   `confidence=0`: the existence of a link/text is NOT `supports` and
 *   NOT confirmation.
 * - The saved draft is `status='ready'`: "a draft is stored" — never
 *   validated / auto_approved / published.
 * - The Persian output of the model is a demo fixture of THIS offline
 *   path; no live-model Persian quality is claimed.
 */

import type { AiSemanticDraft } from '../ai/types';
import { EDITORIAL_DRAFT_VERSION } from './identity';

/** Fixed draft layout id for this phase's renderer contract. */
export const EDITORIAL_DRAFT_LAYOUT = 'news_v1' as const;

/** Actor recorded on drafts created by this pipeline. */
export const EDITORIAL_CREATED_BY = 'editorial.prepare_draft' as const;

/** Stable evidence identifier for the AI request: the source_item id itself. */
export interface EditorialEvidenceInput {
  readonly id: string;
  readonly text: string;
}

/** Bounded, traceable excerpt built from the stored item's own fields. */
export interface TraceableExcerpt {
  readonly text: string;
  readonly truncated: boolean;
}

/** Hard bound for the traceable excerpt (UTF-16 code units; D1 TEXT). */
export const EDITORIAL_EXCERPT_MAX_CHARS = 4000;

/** Maximum traceable snippet text handed to the AI service (see 16 KiB check). */
export const EDITORIAL_AI_SNIPPET_MAX_CHARS = 8000;

/**
 * Build the traceable excerpt from the item's OWN stored fields (title +
 * body_excerpt). `truncated` marks an excerpt cut at the bound — never
 * silently: the marker lands in draft warnings.
 */
export function buildTraceableExcerpt(item: {
  readonly title: string;
  readonly body_excerpt: string | null;
}): TraceableExcerpt {
  const body = item.body_excerpt?.trim() ?? '';
  const full = body.length > 0 ? `${item.title.trim()}\n\n${body}` : item.title.trim();
  if (full.length <= EDITORIAL_EXCERPT_MAX_CHARS) {
    return { text: full, truncated: false };
  }
  return {
    text: `${full.slice(0, EDITORIAL_EXCERPT_MAX_CHARS)}…`,
    truncated: true,
  };
}

/** The AI request evidence list: exactly one snippet — the item's own text. */
export function buildAiEvidenceInput(
  sourceItemId: string,
  excerpt: TraceableExcerpt,
): {
  readonly snippet: EditorialEvidenceInput;
  readonly rejected: 'oversized' | null;
} {
  if (excerpt.text.length > EDITORIAL_AI_SNIPPET_MAX_CHARS) {
    return { snippet: { id: sourceItemId, text: excerpt.text }, rejected: 'oversized' };
  }
  return { snippet: { id: sourceItemId, text: excerpt.text }, rejected: null };
}

/** The conservative `source_report` claim shape (pure data, no id/timestamps). */
export function buildSourceReportClaim(input: {
  readonly sourceName: string;
  readonly excerpt: TraceableExcerpt;
}): {
  readonly claimType: 'source_report';
  readonly subject: string;
  readonly predicate: 'reported';
  readonly objectText: string;
  readonly confidence: 0;
  readonly status: 'unverified';
} {
  return {
    claimType: 'source_report',
    subject: input.sourceName,
    predicate: 'reported',
    objectText: input.excerpt.text,
    confidence: 0,
    status: 'unverified',
  };
}

/** The conservative `mentions` evidence shape (pure data). */
export function buildMentionsEvidence(input: { readonly excerpt: TraceableExcerpt }): {
  readonly stance: 'mentions';
  readonly confidence: 0;
  readonly excerpt: string;
} {
  return {
    stance: 'mentions',
    confidence: 0,
    excerpt: input.excerpt.text,
  };
}

/** Stable, safe warning labels persisted in `drafts.warnings_json`. */
export const EDITORIAL_DRAFT_WARNINGS = [
  'model_output_unverified',
  'single_source_report',
  'fact_guard_pending',
] as const;

/**
 * Build the draft persistence shape from the validated AI output and the
 * traceable excerpt. Model claims are kept with `status:'unverified'` and
 * their evidence references — NEVER promoted into durable claims.
 */
export function buildDraftDocument(input: {
  readonly sourceItemId: string;
  readonly sourceName: string;
  readonly excerpt: TraceableExcerpt;
  readonly semanticDraft: AiSemanticDraft;
}): {
  readonly layout: typeof EDITORIAL_DRAFT_LAYOUT;
  readonly title: string;
  readonly document: {
    readonly schemaVersion: 1;
    readonly locale: 'fa';
    readonly headlineFa: string;
    readonly summaryFa: string;
    readonly sourceReport: {
      readonly sourceItemId: string;
      readonly sourceName: string;
      readonly stance: 'mentions';
      readonly excerptText: string;
      readonly truncated: boolean;
    };
    readonly modelClaims: readonly {
      readonly text: string;
      readonly evidenceIds: readonly string[];
      readonly status: 'unverified';
    }[];
  };
  readonly facts: readonly {
    readonly text: string;
    readonly evidenceIds: readonly string[];
    readonly status: 'unverified';
    readonly origin: 'model';
  }[];
  readonly warnings: readonly string[];
} {
  const modelClaims = input.semanticDraft.claims.map((claim) => ({
    text: claim.text,
    evidenceIds: claim.evidenceIds,
    status: 'unverified' as const,
  }));
  const warnings = [
    ...EDITORIAL_DRAFT_WARNINGS,
    ...(input.excerpt.truncated ? (['excerpt_truncated'] as const) : []),
  ];
  return {
    layout: EDITORIAL_DRAFT_LAYOUT,
    title: input.semanticDraft.headlineFa,
    document: {
      schemaVersion: 1,
      locale: 'fa',
      headlineFa: input.semanticDraft.headlineFa,
      summaryFa: input.semanticDraft.summaryFa,
      sourceReport: {
        sourceItemId: input.sourceItemId,
        sourceName: input.sourceName,
        stance: 'mentions',
        excerptText: input.excerpt.text,
        truncated: input.excerpt.truncated,
      },
      modelClaims,
    },
    facts: modelClaims.map((claim) => ({
      text: claim.text,
      evidenceIds: claim.evidenceIds,
      status: 'unverified' as const,
      origin: 'model' as const,
    })),
    warnings,
  };
}

/** Draft version this pipeline writes (re-exported for callers). */
export const DRAFT_VERSION = EDITORIAL_DRAFT_VERSION;
