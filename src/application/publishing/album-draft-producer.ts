/**
 * The ALBUM DRAFT PRODUCER (the ADR-0060 honest carry, closed): the
 * editorial flow that turns a story's media candidates into a DURABLE
 * album draft the publication scheduler's album branch consumes (the
 * discriminator routes `media:'album'` documents there — the wiring
 * delivered at 1.31.0).
 *
 * THE SAFE CONTRACT (the owner priority: media safety and rights before
 * every send path — the CONTINUATION_PLAN_POSIDON.md slice 2):
 *  - LEDGER-BOUND ONLY: every plan item must resolve to an UPLOADED
 *    media_assets row whose durable state still supports the send (the
 *    SAME `resolveAssetReuse` predicate the scheduler's send path and the
 *    evidence path enforce — uploaded + PUBLICATION_MEDIA_RIGHTS_V1 +
 *    the kind match). There is NO fetch, NO staging, NO transport and NO
 *    license invented here: the machine mints no clearance (OD-010) — an
 *    `unknown` durable echo refuses the item exactly like the send gate.
 *  - ALL-OR-NOTHING: one unresolved item refuses the WHOLE album typed
 *    with the per-item reasons and ZERO durable writes — a partial album
 *    can never exist and a doomed publication is never created quietly.
 *  - THE ONLY LEGAL CONSTRUCTION PATH: the plan comes from the pure 7.2
 *    planner (`planAlbumMedia`) and the document from
 *    `createAlbumContentDocument` — a hand-built item list has no entry
 *    point, and the fingerprint is derived from the exact stored bytes.
 *  - THE MACHINE MINTS NO APPROVAL: the draft ships `ready`; the album
 *    enqueue (`enqueueAlbumDraft`) refuses every non-sendable status —
 *    an explicit approval transition (owner/policy) is the ONLY route a
 *    publication row is created. The enqueue is the existing
 *    `enqueuePublication` idempotent store path (the pidek1 key), gated
 *    first by the album discriminator: a text draft can never ride the
 *    album enqueuer.
 *
 * BOUNDARY: application composition — the D1 reads/writes and the pure
 * domain modules are the only pieces; no transport, no clock side effects
 * beyond the injected clock, no flags (the SEND side stays gated
 * separately; LIVE surfaces BLOCKED_LIVE, Posidon only).
 */

import type { DbExecutor } from '../../adapters/db/db-executor';
import type { Clock } from '../../shared/time/clock';
import type { Logger } from '../../observability/logger';
import { createMediaAssetStore } from '../../adapters/db/media-asset-store';
import {
  findMaxDraftVersion,
  insertAlbumDraft,
  ALBUM_DRAFT_ID_MAX_UNITS,
  ALBUM_DRAFT_TITLE_MAX_UNITS,
  ALBUM_DRAFT_ACTOR_MAX_UNITS,
} from '../../adapters/db/album-draft-store';
import {
  enqueuePublication,
  type EnqueueOutcome,
} from '../../adapters/db/publication-outbox-store';
import {
  planAlbumMedia,
  type AlbumPlanningInputV1,
  type MediaSelectModeV1,
} from '../../domain/media/album-plan';
import { createAlbumContentDocument, ALBUM_CONTENT_LIMITS } from '../../domain/media/album-content';
import { resolveAssetReuse, isPublishableRightsStatus } from '../../domain/media/media-usage';
import {
  readRichTextEnvelopeValue,
  type RichTextEnvelope,
} from '../../domain/telegram/rich-text-envelope';
import { isAppError } from '../../shared/errors/app-error';

/** The bounded story-reference shape (the stories-table PK reality). */
const STORY_ID_MAX_UNITS = 128;

export type AlbumProduceReason =
  | 'invalid_input'
  | 'story_not_found'
  | 'plan_derivation_failed'
  | 'plan_not_album'
  | 'ledger_binding_unresolved'
  | 'document_construction_failed'
  | 'draft_write_failed';

/** The per-item ledger resolution detail (the honest refusal evidence). */
export interface AlbumBindingItemDetail {
  readonly ordinal: number;
  readonly canonicalUrl: string;
  readonly reason: 'resolved' | 'no_uploaded_asset' | 'rights_not_publishable' | 'kind_mismatch';
  readonly mediaAssetId?: string;
  readonly rightsStatus?: string;
}

export type AlbumDraftProduceOutcome =
  | {
      readonly ok: true;
      readonly draftId: string;
      readonly version: number;
      readonly fingerprint: string;
      /** The exact per-ordinal ledger binding the send path will re-resolve. */
      readonly items: readonly {
        readonly ordinal: number;
        readonly mediaAssetId: string;
        readonly rightsStatus: string;
      }[];
      /** The planner's typed exclusions (visible, never silent). */
      readonly excluded: readonly { readonly canonicalUrl: string; readonly reason: string }[];
    }
  | {
      readonly ok: false;
      readonly reason: AlbumProduceReason;
      readonly detail?: {
        readonly planMode?: MediaSelectModeV1;
        readonly planReason?: string;
        readonly items?: readonly AlbumBindingItemDetail[];
        readonly documentReason?: string;
        readonly writeKind?: 'duplicate_draft_id' | 'version_conflict';
      };
    };

function isBoundedUnits(value: unknown, maxUnits: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxUnits;
}

function validateCaptionEnvelope(caption: unknown): caption is RichTextEnvelope {
  if (caption === undefined) return true;
  const read = readRichTextEnvelopeValue(caption);
  return read.ok && read.envelope.kind === 'caption';
}

export async function produceAlbumDraft(
  deps: {
    readonly executor: DbExecutor;
    readonly clock: Clock;
    readonly logger: Logger;
  },
  input: {
    readonly storyId: string;
    /** The 7.2 planning input — re-validated by the planner (defense in depth). */
    readonly candidates: readonly unknown[];
    readonly title: string;
    readonly createdBy: string;
    /** The caller-minted draft identity (a repeat id conflicts typed, never overwrites). */
    readonly draftId?: string;
    readonly caption?: RichTextEnvelope;
    readonly officialVideoLink?: string | null;
    readonly videoAsPrimaryNews?: boolean;
    readonly storyDemandsConceptBeforeGameplay?: boolean;
  },
): Promise<AlbumDraftProduceOutcome> {
  // 1. The input shape gates (fail-closed, before ANY read).
  if (
    typeof input !== 'object' ||
    input === null ||
    !isBoundedUnits(input.storyId, STORY_ID_MAX_UNITS) ||
    !isBoundedUnits(input.title, ALBUM_DRAFT_TITLE_MAX_UNITS) ||
    !isBoundedUnits(input.createdBy, ALBUM_DRAFT_ACTOR_MAX_UNITS) ||
    (input.draftId !== undefined && !isBoundedUnits(input.draftId, ALBUM_DRAFT_ID_MAX_UNITS)) ||
    !Array.isArray(input.candidates)
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!validateCaptionEnvelope(input.caption)) {
    return { ok: false, reason: 'invalid_input' };
  }

  // 2. The story must exist (the honest early refusal — the FK would fail
  // later anyway, but the report should say WHY, not the mechanics).
  const story = await deps.executor.first<{ readonly id: string }>({
    sql: `SELECT id FROM stories WHERE id = ?`,
    params: [input.storyId],
  });
  if (!story) {
    return { ok: false, reason: 'story_not_found' };
  }

  // 3. The plan derivation — the ONLY legal plan path (the pure 7.2 planner).
  const planning: AlbumPlanningInputV1 = {
    candidates: input.candidates as AlbumPlanningInputV1['candidates'],
    ...(input.officialVideoLink !== undefined
      ? { officialVideoLink: input.officialVideoLink }
      : {}),
    ...(input.videoAsPrimaryNews !== undefined
      ? { videoAsPrimaryNews: input.videoAsPrimaryNews }
      : {}),
    ...(input.storyDemandsConceptBeforeGameplay !== undefined
      ? { storyDemandsConceptBeforeGameplay: input.storyDemandsConceptBeforeGameplay }
      : {}),
  };
  const plan = planAlbumMedia(planning);
  if (!plan.ok) {
    return {
      ok: false,
      reason: 'plan_derivation_failed',
      detail: { planReason: plan.reason },
    };
  }
  if (plan.plan.mode !== 'album') {
    // The producer is the ALBUM producer: 'none'/'single'/'official_video_link'
    // route to their own paths — never guessed into an album.
    return {
      ok: false,
      reason: 'plan_not_album',
      detail: { planMode: plan.plan.mode },
    };
  }

  // 4. The ledger resolution — the SAME predicate the send path enforces.
  //    One bounded read for ALL urls; every item must resolve to an
  //    UPLOADED + rights-cleared + kind-matching row (all-or-nothing).
  const assetStore = createMediaAssetStore(deps.executor);
  const urls = plan.plan.items.map((item) => item.candidate.canonicalUrl);
  const assets = await assetStore.findAssetsByUrls(urls);
  const resolutions = resolveAssetReuse(
    plan.plan.items.map((item) => ({
      canonicalUrl: item.candidate.canonicalUrl,
      kind: item.candidate.kind,
    })),
    assets,
  );
  const detail: AlbumBindingItemDetail[] = [];
  const fileIds: string[] = [];
  const bindings: { ordinal: number; mediaAssetId: string; rightsStatus: string }[] = [];
  for (let index = 0; index < plan.plan.items.length; index += 1) {
    const resolution = resolutions[index]!;
    const canonicalUrl = plan.plan.items[index]!.candidate.canonicalUrl;
    if (resolution.outcome !== 'reuse') {
      // WHY did it fail? The honest per-item reason from the SAME rows the
      // predicate read — a rights refusal is distinguishable from a missing
      // upload, never a generic shrug.
      const item = plan.plan.items[index]!;
      const rowsForUrl = assets.filter((row) => row.canonicalUrl === canonicalUrl);
      const uploadedRow = rowsForUrl.find((row) => row.status === 'uploaded');
      let reason: AlbumBindingItemDetail['reason'] = 'no_uploaded_asset';
      if (uploadedRow !== undefined) {
        if (uploadedRow.type !== item.candidate.kind) {
          reason = 'kind_mismatch';
        } else if (!isPublishableRightsStatus(uploadedRow.rightsStatus)) {
          reason = 'rights_not_publishable';
        }
      }
      detail.push({ ordinal: index, canonicalUrl, reason });
      continue;
    }
    // The matched row for the honest binding report.
    const row = assets.find((candidate) => candidate.telegramFileId === resolution.fileId);
    if (row === undefined) {
      detail.push({ ordinal: index, canonicalUrl, reason: 'no_uploaded_asset' });
      continue;
    }
    detail.push({
      ordinal: index,
      canonicalUrl,
      reason: 'resolved',
      mediaAssetId: row.id,
      rightsStatus: row.rightsStatus,
    });
    fileIds.push(resolution.fileId);
    bindings.push({ ordinal: index, mediaAssetId: row.id, rightsStatus: row.rightsStatus });
  }
  if (bindings.length !== plan.plan.items.length) {
    deps.logger.warn('album_producer.ledger_binding_unresolved', {
      storyId: input.storyId,
      unresolved: plan.plan.items.length - bindings.length,
    });
    return {
      ok: false,
      reason: 'ledger_binding_unresolved',
      detail: { items: detail },
    };
  }

  // 5. The document — the ONLY legal construction path (plan + fileIds + caption).
  const document = await createAlbumContentDocument(plan.plan, fileIds, input.caption);
  if (!document.ok) {
    return {
      ok: false,
      reason: 'document_construction_failed',
      detail: { documentReason: document.reason },
    };
  }

  // 6. The draft write — versioned honestly (max+1; the UNIQUE fence is the
  //    authority over a racing producer), status 'ready' (no approval minted).
  const maxVersion = await findMaxDraftVersion(deps.executor, input.storyId);
  const version = (maxVersion ?? 0) + 1;
  const draftId =
    input.draftId ?? `album-draft-${input.storyId}-${version}-${document.fingerprint.slice(0, 16)}`;
  const written = await insertAlbumDraft(deps.executor, {
    id: draftId,
    storyId: input.storyId,
    title: input.title,
    documentJson: document.serialized,
    createdBy: input.createdBy,
    version,
    nowMs: deps.clock.now(),
  });
  if (written.kind !== 'created') {
    return {
      ok: false,
      reason: 'draft_write_failed',
      detail: { writeKind: written.kind },
    };
  }

  deps.logger.info('album_producer.draft_produced', {
    storyId: input.storyId,
    draftId,
    version,
    items: bindings.length,
  });
  return {
    ok: true,
    draftId,
    version,
    fingerprint: document.fingerprint,
    items: bindings,
    excluded: plan.plan.excluded.map((exclusion) => ({
      canonicalUrl: exclusion.canonicalUrl,
      reason: exclusion.reason,
    })),
  };
}

// ---------------------------------------------------------------------------
// the album enqueue (the explicit post-approval step)
// ---------------------------------------------------------------------------

export type AlbumEnqueueRejectedReason =
  | 'not_album_document'
  | 'draft_not_found'
  | 'draft_not_sendable'
  | 'mode_status_mismatch'
  | 'invalid_draft_id'
  | 'invalid_destination'
  | 'invalid_score';

export type AlbumEnqueueOutcome =
  | { readonly kind: 'created'; readonly publicationId: string; readonly idempotencyKey: string }
  | { readonly kind: 'duplicate'; readonly publicationId: string }
  | { readonly kind: 'rejected'; readonly reason: AlbumEnqueueRejectedReason };

/**
 * Enqueue ONE album draft for publication — the EXPLICIT step AFTER the
 * owner/policy approval transition (the producer always ships 'ready'; the
 * machine mints no approval). The draft must BE an album document (the
 * ADR-0060 discriminator gates the route — a text draft is a typed refusal,
 * never a guessed ride through the album path); the durable write itself is
 * the existing idempotent `enqueuePublication` (the pidek1 key over
 * draft+destination — a duplicate returns the EXISTING row).
 */
export async function enqueueAlbumDraft(
  deps: {
    readonly executor: DbExecutor;
    readonly clock: Clock;
    readonly logger: Logger;
  },
  input: {
    readonly draftId: string;
    readonly destination: string;
    readonly approvalMode: 'auto' | 'safe_auto' | 'approval';
    readonly publicationId: string;
    readonly priorityScore?: number;
  },
): Promise<AlbumEnqueueOutcome> {
  // 1. The route gate: the draft must exist AND be an album document.
  //    (A not-found draft is the store's honest refusal — one read.)
  let documentJson: string | null = null;
  try {
    const row = await deps.executor.first<{ readonly document_json: string }>({
      sql: `SELECT document_json FROM drafts WHERE id = ?`,
      params: [input.draftId],
    });
    documentJson = row?.document_json ?? null;
  } catch (error) {
    if (isAppError(error) && error.code === 'db_constraint_violation') {
      return { kind: 'rejected', reason: 'invalid_draft_id' };
    }
    throw error;
  }
  if (documentJson === null) {
    return { kind: 'rejected', reason: 'draft_not_found' };
  }
  const parsed = safeParse(documentJson);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    (parsed as { media?: unknown }).media !== 'album'
  ) {
    return { kind: 'rejected', reason: 'not_album_document' };
  }
  // The document must still be BOUNDED before the store's own re-validation
  // (the byte cap BEFORE the parse is the send-plan discipline; here the
  // parse already happened on the shape gate, so the bound is checked now).
  if (new TextEncoder().encode(documentJson).byteLength > ALBUM_CONTENT_LIMITS.maxSerializedBytes) {
    return { kind: 'rejected', reason: 'not_album_document' };
  }

  // 2. The idempotent durable write (the store owns the status/mode matrix).
  const outcome: EnqueueOutcome = await enqueuePublication(deps.executor, {
    publicationId: input.publicationId,
    draftId: input.draftId,
    destination: input.destination,
    priorityScore: input.priorityScore ?? 62,
    approvalMode: input.approvalMode,
    nowMs: deps.clock.now(),
  });
  if (outcome.kind === 'created') {
    deps.logger.info('album_producer.enqueued', {
      draftId: input.draftId,
      publicationId: outcome.publicationId,
    });
    return {
      kind: 'created',
      publicationId: outcome.publicationId,
      idempotencyKey: outcome.idempotencyKey,
    };
  }
  if (outcome.kind === 'duplicate') {
    return { kind: 'duplicate', publicationId: outcome.publicationId };
  }
  return { kind: 'rejected', reason: outcome.reason };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
