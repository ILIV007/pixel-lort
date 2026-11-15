import { describe, expect, it } from 'vitest';
import { evaluateAlbumDeliveryEvidence } from '../../src/domain/media/album-send-plan';

/**
 * publication-90 — THE BINDING-CORRECTNESS PROOF (the independent review
 * a279e13, finding 1): the album evidence evaluator previously proved
 * completeness by COUNTING — every ordinal recorded to the destination and
 * every ordinal bound in media_usages. A SWAPPED binding (ordinal 0 bound
 * to asset 2, ordinal 1 bound to asset 1) satisfied the counts and the
 * scheduler healed the album `published` with the wrong provenance. The
 * review demands the EXACT per-ordinal match of each bound asset against
 * the plan-resolved expectation — fail-closed, evidence preserved, never
 * auto-resent. These unit tests pin the PURE verdict contract; the REAL
 * D1 engine behavior is pinned by publication-91.
 */

const DESTINATION = '@pixel_lores';

const MESSAGES = [
  { ordinal: 0, chatId: DESTINATION },
  { ordinal: 1, chatId: DESTINATION },
];

const SWAPPED_USAGES = [
  { ordinal: 0, mediaAssetId: 'a2' },
  { ordinal: 1, mediaAssetId: 'a1' },
];

const EXPECTED_BINDINGS = [
  { ordinal: 0, mediaAssetId: 'a1' },
  { ordinal: 1, mediaAssetId: 'a2' },
];

const MATCHING_USAGES = [
  { ordinal: 0, mediaAssetId: 'a1' },
  { ordinal: 1, mediaAssetId: 'a2' },
];

describe('publication-90: the album evidence verdict verifies the per-ordinal asset binding', () => {
  it('a SWAPPED binding is a mismatch — never a complete proof', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: 2,
      destination: DESTINATION,
      messages: MESSAGES,
      boundUsageOrdinals: SWAPPED_USAGES.map((usage) => usage.ordinal),
      boundUsages: SWAPPED_USAGES,
      expectedBindings: EXPECTED_BINDINGS,
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'usage_binding_mismatch',
      missingOrdinals: [],
    });
  });

  it('matching bindings complete the proof (the honest heal shape)', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: 2,
      destination: DESTINATION,
      messages: MESSAGES,
      boundUsageOrdinals: MATCHING_USAGES.map((usage) => usage.ordinal),
      boundUsages: MATCHING_USAGES,
      expectedBindings: EXPECTED_BINDINGS,
    });
    expect(verdict).toEqual({ kind: 'complete' });
  });

  it('a partially bound album with the bound ordinal CORRECT stays unbound_usages (the reconcile family)', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: 2,
      destination: DESTINATION,
      messages: MESSAGES,
      boundUsageOrdinals: [0],
      boundUsages: [{ ordinal: 0, mediaAssetId: 'a1' }],
      expectedBindings: EXPECTED_BINDINGS,
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'unbound_usages',
      missingOrdinals: [],
    });
  });

  it('a partially bound album with the bound ordinal WRONG is a mismatch — the reconcile must never rewrite it silently', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: 2,
      destination: DESTINATION,
      messages: MESSAGES,
      boundUsageOrdinals: [0],
      boundUsages: [{ ordinal: 0, mediaAssetId: 'a2' }],
      expectedBindings: EXPECTED_BINDINGS,
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'usage_binding_mismatch',
      missingOrdinals: [],
    });
  });

  it('an EXTRA usage beyond the plan (an ordinal the plan never declared) is a mismatch', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: 2,
      destination: DESTINATION,
      messages: MESSAGES,
      boundUsageOrdinals: [0, 1, 2],
      boundUsages: [
        { ordinal: 0, mediaAssetId: 'a1' },
        { ordinal: 1, mediaAssetId: 'a2' },
        { ordinal: 2, mediaAssetId: 'a3' },
      ],
      expectedBindings: EXPECTED_BINDINGS,
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'usage_binding_mismatch',
      missingOrdinals: [],
    });
  });

  it('a malformed bound usage row proves nothing (fail-closed, never guessed)', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: 2,
      destination: DESTINATION,
      messages: MESSAGES,
      boundUsageOrdinals: [0, 1],
      boundUsages: [
        { ordinal: 0, mediaAssetId: 'a1' },
        { ordinal: 1, mediaAssetId: '' },
      ],
      expectedBindings: EXPECTED_BINDINGS,
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'usage_binding_mismatch',
      missingOrdinals: [],
    });
  });

  it('an out-of-range expected binding makes the expectation unusable — prove nothing', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: 2,
      destination: DESTINATION,
      messages: MESSAGES,
      boundUsageOrdinals: [0, 1],
      boundUsages: MATCHING_USAGES,
      expectedBindings: [
        { ordinal: 0, mediaAssetId: 'a1' },
        { ordinal: 5, mediaAssetId: 'a2' },
      ],
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'missing_ordinals',
      missingOrdinals: [],
    });
  });

  it('a duplicated expected binding makes the expectation unusable — prove nothing', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: 2,
      destination: DESTINATION,
      messages: MESSAGES,
      boundUsageOrdinals: [0, 1],
      boundUsages: MATCHING_USAGES,
      expectedBindings: [
        { ordinal: 0, mediaAssetId: 'a1' },
        { ordinal: 0, mediaAssetId: 'a2' },
      ],
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'missing_ordinals',
      missingOrdinals: [],
    });
  });

  it('the legacy count-only contract is unchanged when the binding views are absent (backward compatibility)', () => {
    // The pre-a279 callers (count-only) keep their exact verdicts: the
    // extension is additive, never a silent contract change.
    expect(
      evaluateAlbumDeliveryEvidence({
        expectedOrdinals: 2,
        destination: DESTINATION,
        messages: MESSAGES,
        boundUsageOrdinals: [0, 1],
      }),
    ).toEqual({ kind: 'complete' });
    expect(
      evaluateAlbumDeliveryEvidence({
        expectedOrdinals: 2,
        destination: DESTINATION,
        messages: MESSAGES,
        boundUsageOrdinals: [0],
      }),
    ).toEqual({ kind: 'incomplete', reason: 'unbound_usages', missingOrdinals: [] });
  });

  it('the delivery completeness gates still outrank the binding check (missing ordinal first)', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: 2,
      destination: DESTINATION,
      messages: [MESSAGES[0]!],
      boundUsageOrdinals: [0],
      boundUsages: [{ ordinal: 0, mediaAssetId: 'a2' }],
      expectedBindings: EXPECTED_BINDINGS,
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'missing_ordinals',
      missingOrdinals: [1],
    });
  });

  it('a foreign-destination record still outranks everything (not our proof at all)', () => {
    const verdict = evaluateAlbumDeliveryEvidence({
      expectedOrdinals: 2,
      destination: DESTINATION,
      messages: [
        { ordinal: 0, chatId: '@someone_else' },
        { ordinal: 1, chatId: DESTINATION },
      ],
      boundUsageOrdinals: [0, 1],
      boundUsages: SWAPPED_USAGES,
      expectedBindings: EXPECTED_BINDINGS,
    });
    expect(verdict).toEqual({
      kind: 'incomplete',
      reason: 'foreign_destination',
      missingOrdinals: [],
    });
  });
});
