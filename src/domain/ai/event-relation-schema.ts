/**
 * STRICT output schema for the `event_relation` task (Phase 5E-1 — R1.17).
 *
 * Every provider answer is parsed against THIS contract before it can
 * become an evaluated pair: one verdict from the enum, short bounded
 * reasons, references valid from the REQUESTED sides only (a fabricated
 * reference is never accepted), and explicit citation semantics for an
 * output that only reports evidence shortage. Foreign ids, a wrong
 * pairId, self-pair answers, extra command fields (merge/trust/publish/
 * HTML) and incomplete/oversized JSON are ALL rejections — never a
 * semantic decision. Zod `.strict()` rejects any unknown field, so model
 * "command" fields cannot ride along.
 */

import { z } from 'zod';
import type { EventRelationModelOutput, EventRelationVerdict } from './event-relation-types';
import { EVENT_RELATION_BOUNDS, EVENT_RELATION_OUTPUT_LIMITS } from './event-relation-policy';

/** Stable evidence-id shape (same family as the draft task's). */
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

const boundedString = (maxChars: number) => z.string().min(1).max(maxChars);

const eventRelationOutputSchema = z
  .object({
    pairId: z.string().min(1).max(64),
    verdict: z.enum(['same_event_proposed', 'different_event_proposed', 'insufficient_evidence']),
    reasons: z
      .array(boundedString(EVENT_RELATION_OUTPUT_LIMITS.maxReasonChars))
      .min(1)
      .max(EVENT_RELATION_OUTPUT_LIMITS.maxReasons),
    references: z
      .array(
        z
          .object({
            side: z.enum(['A', 'B']),
            evidenceId: z.string().regex(EVIDENCE_ID_PATTERN),
          })
          .strict(),
      )
      .max(EVENT_RELATION_OUTPUT_LIMITS.maxReferences),
    conflicts: z
      .array(boundedString(EVENT_RELATION_OUTPUT_LIMITS.maxConflictChars))
      .max(EVENT_RELATION_OUTPUT_LIMITS.maxConflicts),
  })
  .strict();

/** Structured rejection reasons — typed, never collapsed into a verdict. */
export type EventRelationParseFailureReason =
  | 'oversized_output'
  | 'malformed_json'
  | 'schema_invalid'
  | 'pair_id_mismatch'
  | 'foreign_reference'
  | 'missing_both_side_citations'
  | 'self_pair_reference';

export type EventRelationParseResult =
  | { readonly ok: true; readonly output: EventRelationModelOutput }
  | { readonly ok: false; readonly reason: EventRelationParseFailureReason };

const VERDICTS_REQUIRING_BOTH_SIDES: ReadonlySet<EventRelationVerdict> = new Set([
  'same_event_proposed',
  'different_event_proposed',
]);

/**
 * Parse ONE provider answer for ONE requested pair. The context carries the
 * exact requested pairId and the two sides' evidence ids — the ONLY ids a
 * reference may name. The citation contract for `insufficient_evidence` is
 * EXPLICIT (attachment §4): references are optional there, but every
 * reference still names a real requested side id; the two `*_proposed`
 * verdicts MUST cite both sides.
 */
export function parseEventRelationDecisionJson(
  rawText: string,
  context: {
    readonly expectedPairId: string;
    readonly sideAEvidenceId: string;
    readonly sideBEvidenceId: string;
  },
): EventRelationParseResult {
  if (rawText.length === 0 || rawText.length > EVENT_RELATION_BOUNDS.maxOutputRawChars) {
    return { ok: false, reason: 'oversized_output' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return { ok: false, reason: 'malformed_json' };
  }
  const validated = eventRelationOutputSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, reason: 'schema_invalid' };
  }
  const candidate = validated.data;

  // The answer must answer THIS pair — a swapped/foreign pair id is a
  // rejection, never a relabel.
  if (candidate.pairId !== context.expectedPairId) {
    return { ok: false, reason: 'pair_id_mismatch' };
  }

  // Reference legality: the ONLY valid references are the requested side
  // ids, each at most once, with the side label matching the id's side.
  const seen = new Set<string>();
  for (const reference of candidate.references) {
    const expectedId = reference.side === 'A' ? context.sideAEvidenceId : context.sideBEvidenceId;
    if (reference.evidenceId !== expectedId) {
      return { ok: false, reason: 'foreign_reference' };
    }
    const key = `${reference.side}\u001f${reference.evidenceId}`;
    if (seen.has(key)) {
      return { ok: false, reason: 'foreign_reference' };
    }
    seen.add(key);
  }
  // Side-crossing/self-pair defense: a side label pointing at the OTHER
  // side's id never happens by construction (checked above), and a pair
  // whose two requested ids are identical is rejected outright.
  if (context.sideAEvidenceId === context.sideBEvidenceId) {
    return { ok: false, reason: 'self_pair_reference' };
  }

  // Citation contract: the two `*_proposed` verdicts MUST cite BOTH sides;
  // `insufficient_evidence` may cite nothing (explicit, tested contract —
  // never a fabricated reference).
  if (VERDICTS_REQUIRING_BOTH_SIDES.has(candidate.verdict)) {
    const hasA = candidate.references.some((reference) => reference.side === 'A');
    const hasB = candidate.references.some((reference) => reference.side === 'B');
    if (!hasA || !hasB) {
      return { ok: false, reason: 'missing_both_side_citations' };
    }
  }

  return {
    ok: true,
    output: {
      pairId: candidate.pairId,
      verdict: candidate.verdict,
      reasons: candidate.reasons,
      references: candidate.references,
      conflicts: candidate.conflicts,
    },
  };
}
