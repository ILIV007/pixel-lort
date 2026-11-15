import { beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_ID,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedDraft,
  seedStory,
} from '../helpers/review-test-fixtures';
import { extractBotCommand } from '../../src/adapters/telegram/update-parser';
import { buildEventRelationDecisionReport } from '../../src/domain/editorial/event-relation-decision';
import { readEventRelationDecision } from '../../src/domain/editorial/event-relation-decision';
import { isSafeTelegramHtml } from '../../src/admin/telegram-html';

const report = () =>
  buildEventRelationDecisionReport({
    disabled: false,
    snapshot: { sourceItemId: 'item-proof', contentHash: 'a'.repeat(64) },
    candidates: {
      entityLookup: { probed: ['entity-proof'], unprobedCount: 0, overflow: false },
      counts: { uniqueCandidatesObserved: 1, candidatesReported: 1 },
      candidatesTruncated: false,
      candidateEntries: [
        { storyId: 'story-other', origins: ['fingerprint:url'], basisState: 'ok' },
      ],
    },
    pairAttempts: [
      {
        storyId: 'story-other',
        pairId: 'erp-1',
        state: 'evaluated',
        sideA: { evidenceId: 'ev-a', sourceItemId: 'item-proof', contentHash: 'a'.repeat(64) },
        sideB: {
          storyId: 'story-other',
          evidenceId: 'ev-b',
          sourceItemId: 'item-other',
          contentHash: 'b'.repeat(64),
          draftId: 'draft-other',
          draftVersion: 1,
        },
        canonicalInputHash: 'c'.repeat(64),
        verdict: 'different_event_proposed',
        reasons: ['Related title, but a different launch date.'],
        conflicts: ['CONFLICT_DIFFERENT_LAUNCH_DATE'],
        references: [
          { side: 'A', evidenceId: 'ev-a' },
          { side: 'B', evidenceId: 'ev-b' },
        ],
        aiRunIds: [`edai_${'1'.repeat(32)}`],
      },
    ],
  });
async function render(long: boolean, updateId: number) {
  const doc = {
    schemaVersion: 1,
    locale: 'fa',
    headlineFa: long ? 'ه'.repeat(600) : 'تیتر',
    summaryFa: long ? 'خ'.repeat(900) : 'خلاصه',
    sourceReport: {
      sourceItemId: 'item-proof',
      sourceName: long ? 'م'.repeat(600) : 'منبع',
      stance: 'mentions',
      excerptText: long ? 'گ'.repeat(700) : 'متن',
      truncated: false,
    },
    modelClaims: [{ text: long ? 'ا'.repeat(220) : 'ادعا', evidenceIds: ['ev-a'] }],
    eventRelation: report(),
  };
  expect(readEventRelationDecision(JSON.stringify(doc)).kind).toBe('event_relation_v1');
  await seedStory('story-proof', 'خبر');
  await seedDraft({
    id: 'draft-proof',
    storyId: 'story-proof',
    title: 'خبر',
    documentJson: JSON.stringify(doc),
  });
  const h = buildReviewHarness();
  expect(
    await h.ingress.processUpdate(privateMessage(updateId, OWNER_ID, '/drafts draft-proof')),
  ).toBe('processed');
  expect(h.sends).toHaveLength(1);
  return h.sends[0]!.text;
}
beforeEach(freshDb);
describe('Posidon R118 ORIGINAL acceptance counterexamples', () => {
  it('S1: safety notices survive bounded but lengthy stored content', async () => {
    const text = await render(true, 98101);
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(isSafeTelegramHtml(text)).toBe(true);
    console.log(
      'POSIDON_R118_S1',
      JSON.stringify({
        units: text.length,
        proposalNotice: text.includes('*_proposed = model proposal only'),
        technicalNotice: text.includes('Technical states are technical'),
        noCandidateNotice: text.includes('Missing candidate / non-match is NOT'),
      }),
    );
    expect(text).toContain('*_proposed = model proposal only');
    expect(text).toContain('Technical states are technical');
    expect(text).toContain('Missing candidate / non-match is NOT');
  });
  it('V1: newline-bearing whole argument is rejected before editorial SQL', async () => {
    const text = '/drafts draft-proof\nextra';
    const parsedCommand = extractBotCommand(text);
    expect(parsedCommand?.command).toBe('drafts');
    const h = buildReviewHarness();
    expect(
      await h.ingress.processUpdate(
        privateMessage(98102, OWNER_ID, text, { command: parsedCommand!.command }),
      ),
    ).toBe('processed');
    console.log(
      'POSIDON_R118_V1',
      JSON.stringify({ editorialSelects: h.executor.stats().draftsSql, reply: h.sends[0]?.text }),
    );
    expect(h.executor.stats().draftsSql).toBe(0);
  });
  it('C1: stored conflicts are visible, not silently omitted with ample budget', async () => {
    const text = await render(false, 98103);
    expect(text).toContain('different_event_proposed');
    console.log(
      'POSIDON_R118_C1',
      JSON.stringify({
        units: text.length,
        verdict: text.includes('different_event_proposed'),
        storedConflictShown: text.includes('CONFLICT_DIFFERENT_LAUNCH_DATE'),
        displayTruncated: text.includes('display truncated'),
      }),
    );
    expect(text).toContain('CONFLICT_DIFFERENT_LAUNCH_DATE');
  });
});
