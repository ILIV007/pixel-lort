/**
 * Phase 8.4b — the CORRECTION CONTENT RENDER (crn1): the pure, deterministic
 * label-prepend pipeline that DERIVES the corrected per-message envelopes the
 * edit/correction engine (8.4) transports. The 8.4 design carried this slice
 * ("the engine transports caller-supplied per-message envelopes; the
 * label-prepend/render pipeline for correction variants is an editorial-domain
 * slice") — this module delivers it, and its output is the EXACT
 * `CorrectionEditMessage` shape `applyCorrection` consumes, so the caller
 * chain is: the stored draft document -> renderEditorialPostText (the SAME
 * render the scheduler sends) -> serializeRichTextEnvelope ->
 * renderCorrectionEditEnvelope / deriveCorrectionEdits -> the engine.
 *
 * The composition is EXACT and auditable:
 *
 *     <label>: <editorial statement>\n\n<original text>
 *
 *  - the label is a FIXED authored Persian constant per editable correction
 *    class (never user content, the EDITORIAL_POST_LABELS house pattern);
 *  - the original envelope is re-read defensively (readRichTextEnvelope) and
 *    its original text survives BYTE-FOR-BYTE as the suffix — the readers'
 *    already-seen content is never re-worded by the machine;
 *  - ONE fixed bold entity covers the label + ': ' only (never the editorial
 *    statement); every ORIGINAL entity survives with its offset shifted by
 *    exactly the UTF-16 prefix length (the unit Telegram offsets are
 *    expressed in) and every other field byte-identical;
 *  - the claimed kind must match the stored envelope's kind (kind_mismatch) —
 *    the transport's own re-validation is never surprised;
 *  - the statement is capped BEFORE any parse work (the house cap-before-parse
 *    ordering) and must be non-empty; the composed content must fit the kind
 *    cap — the failure is TYPED (text_too_large / caption_too_large), never a
 *    truncation-to-fit;
 *  - the minor_detail class is refused typed (class_not_editable): the ecl1
 *    planner never edits a minor detail (disposition none), so an edit payload
 *    for one can only be an abuse — the render fail-closes;
 *  - the same input always renders JSON-equal (the 7.2/8.1/8.2 house
 *    determinism pattern).
 *
 * Pure: no I/O, no clock, no SQL, no randomness; every failure typed; TOTAL
 * over its inputs (runtime-invalid values never throw).
 */

import { isCorrectionClass } from './edit-correction';
import {
  createRichTextEnvelope,
  readRichTextEnvelope,
  type RichTextEnvelope,
  type RichTextEntity,
  type RichTextFailureReason,
  type RichTextKind,
} from '../telegram/rich-text-envelope';

export const CORRECTION_RENDER_VERSION = 'crn1' as const;

/**
 * The named conservative application cap for the editorial correction
 * statement (UTF-16 code units). An application cap, clearly NOT a claim
 * about Telegram — the composed content must still fit the kind cap, which
 * is the final typed gate.
 */
export const CORRECTION_STATEMENT_MAX_UNITS = 1024;

/**
 * The bounded number of derived edits per correction pass — aligned with the
 * engine's own MAX_EDITS_PER_PASS (16): the derivation refuses MORE than the
 * engine would accept, typed, before any per-message work.
 */
export const CORRECTION_EDITS_MAX_MESSAGES = 16;

/** The chat-id cap (aligned with the correction audit identity cap of 256). */
const CHAT_ID_MAX_UNITS = 256;

/**
 * The FIXED authored Persian labels per EDITABLE correction class (stable
 * constants, never user content). The blueprint §15 class -> the reader-facing
 * lead label. `minor_detail` is deliberately absent: it never produces an edit.
 */
export const CORRECTION_LABELS = {
  meaningful_update: 'به‌روزرسانی',
  rumor_confirmed: 'تأیید',
  rumor_denied: 'تکذیب',
  correction: 'اصلاحیه',
} as const;

export type EditableCorrectionClass = keyof typeof CORRECTION_LABELS;

const EDITABLE_LABELS: ReadonlyMap<string, string> = new Map(Object.entries(CORRECTION_LABELS));

const RICH_TEXT_KINDS: ReadonlySet<string> = new Set(['text', 'caption']);

export type CorrectionRenderFailureReason =
  | 'invalid_input'
  | 'class_not_editable'
  | 'statement_empty'
  | 'statement_too_large'
  | 'kind_mismatch'
  | RichTextFailureReason;

export type CorrectionRenderOutcome =
  | {
      readonly ok: true;
      /** The corrected envelope (the label-prepended composition). */
      readonly envelope: RichTextEnvelope;
      /** The authored label applied (echoed for the caller's report). */
      readonly label: string;
    }
  | { readonly ok: false; readonly reason: CorrectionRenderFailureReason };

/**
 * Render ONE corrected envelope: the fixed label + the editorial statement as
 * the lead, the untouched original text as the suffix. Never mutates its
 * input; never throws; every failure typed.
 */
export function renderCorrectionEditEnvelope(input: {
  /** The serialized ORIGINAL envelope document (defensively re-read). */
  readonly originalEnvelopeJson: unknown;
  /** The claimed content kind — must match the stored envelope's kind. */
  readonly kind: unknown;
  /** The blueprint §15 correction class (a minor_detail is refused typed). */
  readonly correctionClass: unknown;
  /** The editorial correction statement (taken verbatim, never re-worded). */
  readonly statement: unknown;
}): CorrectionRenderOutcome {
  if (
    typeof input.correctionClass !== 'string' ||
    typeof input.kind !== 'string' ||
    typeof input.statement !== 'string' ||
    typeof input.originalEnvelopeJson !== 'string'
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!isCorrectionClass(input.correctionClass)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (input.correctionClass === 'minor_detail') {
    return { ok: false, reason: 'class_not_editable' };
  }
  if (!RICH_TEXT_KINDS.has(input.kind)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (input.statement.length === 0) {
    return { ok: false, reason: 'statement_empty' };
  }
  // The statement cap BEFORE any parse work (the house ordering).
  if (input.statement.length > CORRECTION_STATEMENT_MAX_UNITS) {
    return { ok: false, reason: 'statement_too_large' };
  }
  const original = readRichTextEnvelope(input.originalEnvelopeJson);
  if (!original.ok) {
    return { ok: false, reason: original.reason };
  }
  if (original.envelope.kind !== (input.kind as RichTextKind)) {
    return { ok: false, reason: 'kind_mismatch' };
  }
  const label = EDITABLE_LABELS.get(input.correctionClass);
  if (label === undefined) {
    // Unreachable by construction (the class gate above) — defense in depth.
    return { ok: false, reason: 'class_not_editable' };
  }

  // The exact composition: the lead (label + ': ' + statement), a blank
  // line, then the original text BYTE-FOR-BYTE.
  const lead = `${label}: ${input.statement}`;
  const separator = '\n\n';
  const text = `${lead}${separator}${original.envelope.text}`;
  const shiftUnits = lead.length + separator.length;
  const entities: readonly RichTextEntity[] = [
    { type: 'bold', offset: 0, length: label.length + 2 },
    ...original.envelope.entities.map((entity) => ({
      ...entity,
      offset: entity.offset + shiftUnits,
    })),
  ];
  const composed = createRichTextEnvelope({ kind: original.envelope.kind, text, entities });
  if (!composed.ok) {
    // Overflow (or any envelope rule violation) fails TYPED — no
    // truncation-to-fit is ever attempted.
    return { ok: false, reason: composed.reason };
  }
  return { ok: true, envelope: composed.envelope, label };
}

/** One source message the batch derivation renders (the ledger's view). */
export interface CorrectionEditSourceMessage {
  readonly chatId: unknown;
  readonly messageId: unknown;
  readonly ordinal: unknown;
  readonly kind: unknown;
  readonly originalEnvelopeJson: unknown;
}

/** One derived edit — structurally the engine's CorrectionEditMessage. */
export interface CorrectionEditDerived {
  readonly chatId: string;
  readonly messageId: number;
  /** Echoed for the caller's report; the engine matches by messageId. */
  readonly ordinal: number;
  readonly shape: 'text' | 'caption';
  readonly content: {
    readonly kind: string;
    readonly text: string;
    readonly entities: readonly unknown[];
  };
}

export type CorrectionEditsDerivationOutcome =
  | { readonly ok: true; readonly edits: readonly CorrectionEditDerived[] }
  | { readonly ok: false; readonly reason: 'too_many_messages' }
  | { readonly ok: false; readonly reason: CorrectionRenderFailureReason; readonly index: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyBoundedString(value: unknown, maxUnits: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxUnits;
}

/**
 * Derive the WHOLE per-message edit list for one correction pass: the same
 * render applied to every recorded message, the engine's `edits` input
 * directly. TOTAL: the first failing message reports its index; the batch
 * cap refuses wholesale before any per-message work. The input order is
 * preserved (the caller passes the ledger order — ordinal ascending).
 */
export function deriveCorrectionEdits(input: {
  readonly correctionClass: string;
  readonly statement: string;
  readonly messages: readonly CorrectionEditSourceMessage[];
}): CorrectionEditsDerivationOutcome {
  if (!Array.isArray(input.messages)) {
    // -1 = the batch input itself, never a message position.
    return { ok: false, reason: 'invalid_input', index: -1 };
  }
  if (input.messages.length > CORRECTION_EDITS_MAX_MESSAGES) {
    return { ok: false, reason: 'too_many_messages' };
  }
  const edits: CorrectionEditDerived[] = [];
  for (let index = 0; index < input.messages.length; index += 1) {
    const message = input.messages[index];
    if (!isPlainObject(message)) {
      return { ok: false, reason: 'invalid_input', index };
    }
    const chatId: unknown = message['chatId'];
    const messageId: unknown = message['messageId'];
    const ordinal: unknown = message['ordinal'];
    const kind: unknown = message['kind'];
    const originalEnvelopeJson: unknown = message['originalEnvelopeJson'];
    if (!isNonEmptyBoundedString(chatId, CHAT_ID_MAX_UNITS)) {
      return { ok: false, reason: 'invalid_input', index };
    }
    if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0) {
      return { ok: false, reason: 'invalid_input', index };
    }
    if (typeof ordinal !== 'number' || !Number.isInteger(ordinal) || ordinal < 0) {
      return { ok: false, reason: 'invalid_input', index };
    }
    if (typeof kind !== 'string' || !RICH_TEXT_KINDS.has(kind)) {
      return { ok: false, reason: 'invalid_input', index };
    }
    if (typeof originalEnvelopeJson !== 'string') {
      return { ok: false, reason: 'invalid_input', index };
    }
    const rendered = renderCorrectionEditEnvelope({
      originalEnvelopeJson,
      kind,
      correctionClass: input.correctionClass,
      statement: input.statement,
    });
    if (!rendered.ok) {
      // The class/statement gates are batch-level inputs, but they surface at
      // the FIRST message they fail for — the honest first-failure index.
      return { ok: false, reason: rendered.reason, index };
    }
    edits.push({
      chatId,
      messageId,
      ordinal,
      shape: kind as 'text' | 'caption',
      content: {
        kind: rendered.envelope.kind,
        text: rendered.envelope.text,
        entities: rendered.envelope.entities,
      },
    });
  }
  return { ok: true, edits };
}
