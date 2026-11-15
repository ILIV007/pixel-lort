/**
 * Phase V4-carry — the ALBUM SEND PLAN (ADR-0060): the pure, deterministic
 * derivation from a durable album content document + destination to the
 * media-group wire plan the publication scheduler's send path consumes.
 *
 * THE WIRING CONTRACT (the 7.4 honest carry, now built):
 *  - the wire items ride the document's file_ids IN ORDINAL ORDER — the
 *    upload already happened (the document is the upload path's ONLY legal
 *    artifact), so a send-time album travels file_id-only;
 *  - the attachments array is ALWAYS empty here: MediaGroupAttachmentV1
 *    (the A5 fresh-bytes contract) belongs to the UPLOAD path, which
 *    already consumes it; a send-time album NEVER re-fetches bytes — the
 *    empty array is PINNED, not incidental;
 *  - the caption rides ordinal 0 ONLY (the no-separation layer, extended
 *    from the plan through the document to the wire);
 *  - the send identity ('album-send:v1', the A4 scaffold) is re-derived
 *    from the SAME inputs the upload path used (destination + the item
 *    identities + the caption text) by the ONE shared function — the
 *    upload service imports THIS module, so the two sides can never drift;
 *  - the derivation is TOTAL: every malformed / out-of-bound / non-album
 *    input fails TYPED. A text draft, a broken document or an oversized
 *    string can never be guessed into a send plan.
 *
 * THE DISCRIMINATOR: `discriminateAlbumDocument` is the scheduler's cheap
 * route check — parse failure / oversize / non-album route BACK to the
 * text path (prior-phase behavior byte-identical); only a parseable object
 * declaring `media: 'album'` enters the album path.
 *
 * BOUNDARY: pure — no I/O, no clock, no SQL, no Telegram/R2 types.
 */

import {
  ALBUM_CONTENT_LIMITS,
  readAlbumContentDocumentV1,
  type AlbumContentReasonV1,
} from './album-content';
import type { AlbumItemKindV1 } from './album-content';
import type { MediaGroupAttachmentV1 } from './media-ports';

export const ALBUM_SEND_PLAN_VERSION = 'alsp1' as const;
export const ALBUM_SEND_IDENTITY_VERSION = 'album-send:v1' as const;

/** The destination bound (the same application cap the upload path pins). */
const MAX_DESTINATION_UNITS = 256;

export interface AlbumSendPlanItemV1 {
  readonly ordinal: number;
  readonly type: AlbumItemKindV1;
  /** The Telegram file_id reference the wire item rides (file_id-only). */
  readonly media: string;
  /** The item's canonical source URL — the ledger-binding anchor. */
  readonly canonicalUrl: string;
}

export interface AlbumSendPlanV1 {
  readonly schemaVersion: 1;
  readonly planVersion: 'alsp1';
  readonly destination: string;
  readonly items: readonly AlbumSendPlanItemV1[];
  /** Present IFF the document carries a caption — rides ordinal 0 ONLY. */
  readonly caption?: { readonly text: string; readonly entities: readonly unknown[] };
  /**
   * ALWAYS empty at publication-send time (pinned): the fresh-bytes
   * attachment contract is the UPLOAD path's; a send-time album never
   * carries bytes.
   */
  readonly attachments: readonly MediaGroupAttachmentV1[];
  readonly sendIdentityKey: string;
}

export type AlbumSendPlanFailureReason =
  | 'invalid_input'
  | 'document_too_large'
  | 'document_parse_failed'
  | 'not_album_document'
  | 'identity_derivation_failed'
  | AlbumContentReasonV1;

export type AlbumSendPlanOutcome =
  | { readonly ok: true; readonly plan: AlbumSendPlanV1 }
  | { readonly ok: false; readonly reason: AlbumSendPlanFailureReason };

export type AlbumSendIdentityOutcome =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: 'invalid_input' };

export type AlbumDocumentDiscrimination = 'album' | 'not_album' | 'parse_failed' | 'too_large';

function isValidDestination(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DESTINATION_UNITS) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x1f || unit === 0x7f) return false;
  }
  return true;
}

/**
 * THE ONE versioned send-identity derivation (the A4 scaffold, now the
 * shared source of truth): sha256 over the tagged, delimited serialization
 * of (version tag, destination, every item's kind:url identity, the caption
 * text). The upload service imports THIS function — the derived key is
 * byte-identical on both sides by construction.
 */
export async function deriveAlbumSendIdentityKey(input: {
  readonly destination: string;
  readonly items: readonly { readonly kind: string; readonly canonicalUrl: string }[];
  readonly captionText?: string | null;
}): Promise<AlbumSendIdentityOutcome> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (!isValidDestination(input.destination) || !Array.isArray(input.items)) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (
    input.items.length < ALBUM_CONTENT_LIMITS.minItems ||
    input.items.length > ALBUM_CONTENT_LIMITS.maxItems
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  for (const item of input.items) {
    if (typeof item !== 'object' || item === null) return { ok: false, reason: 'invalid_input' };
    if (item.kind !== 'photo' && item.kind !== 'video') {
      return { ok: false, reason: 'invalid_input' };
    }
    if (
      typeof item.canonicalUrl !== 'string' ||
      item.canonicalUrl.length === 0 ||
      item.canonicalUrl.length > ALBUM_CONTENT_LIMITS.maxUrlUnits
    ) {
      return { ok: false, reason: 'invalid_input' };
    }
  }
  if (
    input.captionText !== undefined &&
    input.captionText !== null &&
    typeof input.captionText !== 'string'
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  const parts = [
    ALBUM_SEND_IDENTITY_VERSION,
    input.destination,
    ...input.items.map((item) => `${item.kind}:${item.canonicalUrl}`),
    input.captionText ?? '',
  ];
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(parts.join('\u001f')) as unknown as ArrayBuffer,
  );
  const hex: string[] = [];
  for (const byte of new Uint8Array(digest)) {
    hex.push(byte.toString(16).padStart(2, '0'));
  }
  return { ok: true, key: hex.join('') };
}

/**
 * The TOTAL discriminator: only a parseable object declaring
 * `media: 'album'` is the scheduler's album route; everything else (parse
 * failure, oversize, a text document, any other shape) routes back to the
 * text path UNCHANGED.
 */
export function discriminateAlbumDocument(documentJson: string): AlbumDocumentDiscrimination {
  if (typeof documentJson !== 'string' || documentJson.length === 0) return 'not_album';
  if (new TextEncoder().encode(documentJson).byteLength > ALBUM_CONTENT_LIMITS.maxSerializedBytes) {
    return 'too_large';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson);
  } catch {
    return 'parse_failed';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'not_album';
  return (parsed as { media?: unknown }).media === 'album' ? 'album' : 'not_album';
}

/**
 * The ONLY legal send-plan derivation: the durable album document is
 * re-validated by ITS OWN strict reader, then projected into the wire plan
 * with the re-derived send identity. Failures are typed and ordered — the
 * input gates run BEFORE any parse (the byte cap), the reader before the
 * identity (a document that cannot be vouched for never derives a key).
 */
export async function deriveAlbumSendPlan(input: {
  readonly documentJson: string;
  readonly destination: string;
}): Promise<AlbumSendPlanOutcome> {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    !isValidDestination(input.destination)
  ) {
    return { ok: false, reason: 'invalid_input' };
  }
  if (typeof input.documentJson !== 'string' || input.documentJson.length === 0) {
    return { ok: false, reason: 'invalid_input' };
  }
  // The byte cap runs BEFORE the parse: a legal album document never
  // exceeds the serialized bound, so an over-cap string is refused without
  // handing the parser an unbounded input.
  if (
    new TextEncoder().encode(input.documentJson).byteLength >
    ALBUM_CONTENT_LIMITS.maxSerializedBytes
  ) {
    return { ok: false, reason: 'document_too_large' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.documentJson);
  } catch {
    return { ok: false, reason: 'document_parse_failed' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not_album_document' };
  }
  if ((parsed as { media?: unknown }).media !== 'album') {
    return { ok: false, reason: 'not_album_document' };
  }
  const read = await readAlbumContentDocumentV1(parsed);
  if (!read.ok) return { ok: false, reason: read.reason };

  const document = read.document;
  const identity = await deriveAlbumSendIdentityKey({
    destination: input.destination,
    items: document.items.map((item) => ({ kind: item.kind, canonicalUrl: item.canonicalUrl })),
    captionText: document.caption?.text ?? null,
  });
  if (!identity.ok) return { ok: false, reason: 'identity_derivation_failed' };

  const plan: AlbumSendPlanV1 = {
    schemaVersion: 1,
    planVersion: ALBUM_SEND_PLAN_VERSION,
    destination: input.destination,
    items: document.items.map((item, ordinal) => ({
      ordinal,
      type: item.kind,
      media: item.fileId,
      canonicalUrl: item.canonicalUrl,
    })),
    ...(document.caption !== undefined
      ? { caption: { text: document.caption.text, entities: document.caption.entities } }
      : {}),
    attachments: [],
    sendIdentityKey: identity.key,
  };
  return { ok: true, plan };
}

// ---------------------------------------------------------------------------
// THE DELIVERY-EVIDENCE COMPLETENESS PROOF (the independent review d65d811,
// P1-2 fix): ONE recorded witness proves AT LEAST ONE message was delivered
// — never that the WHOLE album was. The healable proof is the COMPLETE set.
// ---------------------------------------------------------------------------

/** The ledger's per-ordinal delivery view the evaluator consumes. */
export interface AlbumDeliveryMessageViewV1 {
  readonly ordinal: number;
  readonly chatId: string;
}

/** The ledger's per-ordinal USAGE binding view (ordinal -> media asset). */
export interface AlbumDeliveryUsageViewV1 {
  readonly ordinal: number;
  readonly mediaAssetId: string;
}

export type AlbumDeliveryEvidenceVerdict =
  | { readonly kind: 'complete' }
  | {
      readonly kind: 'incomplete';
      /**
       * `foreign_destination` — a record points at a different destination;
       * `missing_ordinals` — the recorded ordinal set does not cover the
       * plan exactly; `unbound_usages` — every ordinal is proven but the
       * media_usages binding is not complete yet (the heal reconciles it);
       * `usage_binding_mismatch` — a bound usage CONTRADICTS the plan's
       * expected asset for its ordinal (the a279e13 review: a swapped
       * binding satisfied the counts and healed with wrong provenance —
       * the exact per-ordinal match is now part of the proof; a mismatch
       * parks uncertain, keeps the evidence intact, never rewrites it).
       */
      readonly reason:
        'foreign_destination' | 'missing_ordinals' | 'unbound_usages' | 'usage_binding_mismatch';
      /** The missing plan ordinals (empty for the non-ordinal reasons). */
      readonly missingOrdinals: readonly number[];
    };

const MAX_EXPECTED_ORDINALS = 10; // the Bot API media-group bound (2..10)

/**
 * The TOTAL, deterministic completeness-and-correctness verdict over ONE
 * album publication's delivery evidence:
 *  1. every recorded message must point at the CONFIGURED destination (a
 *     record to another chat is not this publication's proof);
 *  2. the recorded ordinal set must be EXACTLY {0..n-1} over the plan's
 *     item count — the count AND the set, not merely a non-empty ledger;
 *  3. the bound media_usages must cover the same set (the honest durable
 *     reconciliation the review demands) AND — when the binding views are
 *     supplied (the a279e13 review) — every bound usage must reference
 *     EXACTLY the plan-resolved asset for its ordinal: a SWAPPED or
 *     foreign binding is `usage_binding_mismatch`, never a proof.
 * An out-of-range expectation (0 or beyond the media-group bound) proves
 * nothing: incomplete with every ordinal missing. An unusable binding
 * view (a non-array, a malformed row, a duplicated or out-of-range
 * expected binding) proves nothing the same way. The binding views are
 * OPTIONAL for the pre-a279 callers: absent, the verdict is the exact
 * count-only contract (never a silent behavior change). Pure: no I/O.
 */
export function evaluateAlbumDeliveryEvidence(input: {
  readonly expectedOrdinals: number;
  readonly destination: string;
  readonly messages: readonly AlbumDeliveryMessageViewV1[];
  readonly boundUsageOrdinals: readonly number[];
  /** The bound usages WITH their asset ids (the correctness view). */
  readonly boundUsages?: readonly AlbumDeliveryUsageViewV1[];
  /** The plan-resolved expected bindings (ordinal -> asset id). */
  readonly expectedBindings?: readonly AlbumDeliveryUsageViewV1[];
}): AlbumDeliveryEvidenceVerdict {
  const inputValid =
    typeof input === 'object' &&
    input !== null &&
    Number.isInteger(input.expectedOrdinals) &&
    input.expectedOrdinals >= 1 &&
    input.expectedOrdinals <= MAX_EXPECTED_ORDINALS &&
    typeof input.destination === 'string' &&
    input.destination.length > 0 &&
    Array.isArray(input.messages) &&
    Array.isArray(input.boundUsageOrdinals) &&
    (input.boundUsages === undefined || Array.isArray(input.boundUsages)) &&
    (input.expectedBindings === undefined || Array.isArray(input.expectedBindings));
  if (!inputValid) {
    // An unusable expectation can never be verified: prove nothing (the
    // caller treats the evidence as incomplete — never as a proof).
    return { kind: 'incomplete', reason: 'missing_ordinals', missingOrdinals: [] };
  }
  const expected = input.expectedOrdinals;
  const allOrdinals = Array.from({ length: expected }, (_unused, ordinal) => ordinal);

  const foreign = input.messages.some(
    (message) =>
      message === null ||
      typeof message !== 'object' ||
      typeof message.chatId !== 'string' ||
      message.chatId !== input.destination,
  );
  if (foreign) {
    return { kind: 'incomplete', reason: 'foreign_destination', missingOrdinals: [] };
  }

  const recorded = new Set<number>();
  for (const message of input.messages) {
    if (
      message === null ||
      typeof message !== 'object' ||
      !Number.isInteger(message.ordinal) ||
      (message.ordinal as number) < 0 ||
      (message.ordinal as number) >= expected
    ) {
      continue;
    }
    recorded.add(message.ordinal);
  }
  const missingOrdinals = allOrdinals.filter((ordinal) => !recorded.has(ordinal));
  if (missingOrdinals.length > 0) {
    return { kind: 'incomplete', reason: 'missing_ordinals', missingOrdinals };
  }

  const bound = new Set<number>();
  for (const ordinal of input.boundUsageOrdinals) {
    if (Number.isInteger(ordinal) && (ordinal as number) >= 0 && (ordinal as number) < expected) {
      bound.add(ordinal);
    }
  }

  // THE BINDING-CORRECTNESS PROOF (the a279e13 review): when the binding
  // views are supplied, the bound (ordinal -> asset) mapping must EQUAL
  // the plan-resolved expectation — exact pairs, no extras, no swaps.
  // Checked BEFORE the unbound reconciliation: a wrong binding must never
  // be silently rewritten by the reconcile path (the evidence stays for
  // the human dispositions). An unusable view proves nothing.
  if (input.boundUsages !== undefined && input.expectedBindings !== undefined) {
    const expectedMap = new Map<number, string>();
    let expectationUsable = true;
    for (const entry of input.expectedBindings) {
      if (
        entry === null ||
        typeof entry !== 'object' ||
        !Number.isInteger(entry.ordinal) ||
        (entry.ordinal as number) < 0 ||
        (entry.ordinal as number) >= expected ||
        typeof entry.mediaAssetId !== 'string' ||
        entry.mediaAssetId.length === 0 ||
        expectedMap.has(entry.ordinal)
      ) {
        expectationUsable = false;
        break;
      }
      expectedMap.set(entry.ordinal, entry.mediaAssetId);
    }
    if (!expectationUsable || expectedMap.size !== expected) {
      return { kind: 'incomplete', reason: 'missing_ordinals', missingOrdinals: [] };
    }
    const boundMap = new Map<number, string>();
    for (const usage of input.boundUsages) {
      if (
        usage === null ||
        typeof usage !== 'object' ||
        !Number.isInteger(usage.ordinal) ||
        (usage.ordinal as number) < 0 ||
        (usage.ordinal as number) >= expected ||
        typeof usage.mediaAssetId !== 'string' ||
        usage.mediaAssetId.length === 0
      ) {
        return { kind: 'incomplete', reason: 'usage_binding_mismatch', missingOrdinals: [] };
      }
      if (boundMap.has(usage.ordinal)) {
        return { kind: 'incomplete', reason: 'usage_binding_mismatch', missingOrdinals: [] };
      }
      boundMap.set(usage.ordinal, usage.mediaAssetId);
    }
    for (const [ordinal, expectedAsset] of expectedMap) {
      const boundAsset = boundMap.get(ordinal);
      if (boundAsset === undefined) {
        continue; // not bound yet — the unbound reconciliation decides below
      }
      if (boundAsset !== expectedAsset) {
        return { kind: 'incomplete', reason: 'usage_binding_mismatch', missingOrdinals: [] };
      }
    }
    for (const ordinal of boundMap.keys()) {
      if (!expectedMap.has(ordinal)) {
        return { kind: 'incomplete', reason: 'usage_binding_mismatch', missingOrdinals: [] };
      }
    }
  }

  const unbound = allOrdinals.filter((ordinal) => !bound.has(ordinal));
  if (unbound.length > 0) {
    return { kind: 'incomplete', reason: 'unbound_usages', missingOrdinals: [] };
  }
  return { kind: 'complete' };
}
