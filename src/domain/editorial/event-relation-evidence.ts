/**
 * Bounded bidirectional evidence bundles for the event-relation pairs
 * (Phase 5E-1 — R1.17, ADR-0045). PURE + DETERMINISTIC (+ one async hash):
 * NO SQL, NO network, NO model call, NO clock.
 *
 * THE INPUT CONTRACT (attachment §4): each pair's input is ONLY the limited
 * public documents of THIS item and the candidate's durable draft basis —
 * side A/B with sourceItemId/contentHash, story/draft identities, and
 * SEPARATE STABLE evidence ids. The two sides' ids are NEVER mixed, even on
 * name collisions. Side texts come from REAL stored title/body text (side
 * A: the item's traceable excerpt; side B: the candidate draft's OWN
 * immutable sourceReport excerpt — never a mutable row alone). full vs
 * excerpt/truncated is recorded explicitly; no extra fetch/network ever
 * completes a text.
 *
 * THE BUNDLE IS BOUNDED: the two sides' texts total ≤16 KiB UTF-8 (the
 * same public input bound as drafting); the canonical input hash covers
 * BOTH bases (including the candidate draft's exact document bytes) plus
 * the prompt/policy version — so a pair's identity can never drift from
 * the bytes it was really built from.
 */

import { sha256Hex } from '../../shared/ids/idempotency-key';
import { EVENT_RELATION_BOUNDS } from '../ai/event-relation-policy';
import { EVENT_RELATION_POLICY_VERSION } from './event-relation-candidates';
import { EVENT_RELATION_PROMPT_VERSION } from '../ai/event-relation-policy';

/** Deterministic pair ids of ONE attempt: two evaluation slots. */
export const EVENT_RELATION_PAIR_IDS = ['erp-1', 'erp-2'] as const;
export type EventRelationPairId = (typeof EVENT_RELATION_PAIR_IDS)[number];

/** Identity + text basis of ONE side (pure data; no read rows carried). */
export interface EventRelationSideBasis {
  /** Stable public evidence id (side A: THIS item's id; side B: the
   * candidate's ORIGINAL reference item id from its durable basis). */
  readonly evidenceId: string;
  /** Real stored text (title/body composed) — bounded by the bundle cap. */
  readonly text: string;
  /** Whether the stored text basis is an EXCERPT (truncated) or FULL. */
  readonly truncated: boolean;
  readonly storyId: string;
  readonly sourceItemId: string;
  readonly contentHash: string;
  /** Side B only: the candidate's ready draft identity + exact document
   * bytes hash (side A leaves these undefined — its draft is created BY
   * this very commit). */
  readonly draftId?: string;
  readonly draftVersion?: number;
  readonly documentSha256?: string;
}

/** One bounded, hashed pair bundle handed to the relation task. */
export interface EventRelationPairBundle {
  readonly pairId: EventRelationPairId;
  readonly sideA: EventRelationSideBasis;
  readonly sideB: EventRelationSideBasis;
  /** sha256 over the policy+prompt versions and BOTH bases (ids, hashes,
   * draft identity, document bytes hash, text bytes) — the pair identity
   * the ledger records and the model output never influences. */
  readonly canonicalInputHash: string;
}

export type EventRelationBundleResult =
  | { readonly ok: true; readonly bundle: EventRelationPairBundle }
  | {
      readonly ok: false;
      readonly reason: 'self_pair_ids' | 'oversized_bundle' | 'bad_pair_id';
    };

/**
 * Build ONE pair bundle. TOTAL (ok or typed failure — never a throw):
 * - a pair whose two evidence ids collide is a SELF-PAIR and is rejected
 *   (ids are never mixed, even on name collisions);
 * - the UTF-8 size of the two sides' text is checked against the SAME
 *   16 KiB public bound drafting uses — an oversized pair is typed
 *   `oversized_bundle`, never silently truncated into the task.
 */
export async function buildEventRelationPairBundle(input: {
  readonly pairId: string;
  readonly sideA: EventRelationSideBasis;
  readonly sideB: EventRelationSideBasis;
}): Promise<EventRelationBundleResult> {
  const pairId = EVENT_RELATION_PAIR_IDS.find((id) => id === input.pairId);
  if (pairId === undefined) {
    return { ok: false, reason: 'bad_pair_id' };
  }
  if (
    input.sideA.evidenceId === input.sideB.evidenceId ||
    input.sideA.sourceItemId === input.sideB.sourceItemId
  ) {
    return { ok: false, reason: 'self_pair_ids' };
  }
  const encoder = new TextEncoder();
  const totalBytes =
    encoder.encode(input.sideA.text).length + encoder.encode(input.sideB.text).length;
  if (totalBytes > EVENT_RELATION_BOUNDS.maxBundleUtf8Bytes) {
    return { ok: false, reason: 'oversized_bundle' };
  }

  const canonical = [
    EVENT_RELATION_POLICY_VERSION,
    EVENT_RELATION_PROMPT_VERSION,
    pairId,
    // Side A basis identity.
    input.sideA.evidenceId,
    input.sideA.storyId,
    input.sideA.sourceItemId,
    input.sideA.contentHash,
    input.sideA.truncated ? 'excerpt' : 'full',
    await sha256Hex(input.sideA.text),
    // Side B basis identity — the DURABLE draft record, never a mutable
    // row alone: draft id + version + the EXACT document bytes hash plus
    // the bridged reference identity.
    input.sideB.evidenceId,
    input.sideB.storyId,
    input.sideB.sourceItemId,
    input.sideB.contentHash,
    input.sideB.draftId ?? '',
    String(input.sideB.draftVersion ?? ''),
    input.sideB.documentSha256 ?? '',
    input.sideB.truncated ? 'excerpt' : 'full',
    await sha256Hex(input.sideB.text),
  ].join('\u001f');

  return {
    ok: true,
    bundle: {
      pairId,
      sideA: input.sideA,
      sideB: input.sideB,
      canonicalInputHash: await sha256Hex(canonical),
    },
  };
}
