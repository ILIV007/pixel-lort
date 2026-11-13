import { beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_ID,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedDraft,
  seedStory,
} from '../helpers/review-test-fixtures';
import {
  buildEventRelationDecisionReport,
  disabledEventRelationReport,
  type EventRelationPairAttempt,
} from '../../src/domain/editorial/event-relation-decision';
import { isSafeTelegramHtml } from '../../src/admin/telegram-html';

/**
 * R1.18 relation-rendering tests: the SAME draft surface shows the stored
 * event-relation ledger honestly — same/different/insufficient proposals and
 * ALL technical states remain distinguishable; a missing candidate is never
 * "unrelated"; ready is never "approved". Fixtures are built with the REAL
 * pure builder and validated by the REAL strict reader inside the render
 * path.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const RUN_1 = `edai_${'1'.repeat(32)}`;
const RUN_2 = `edai_${'2'.repeat(32)}`;

function evaluatedPair(
  index: number,
  verdict: 'same_event_proposed' | 'different_event_proposed' | 'insufficient_evidence',
  overrides: Partial<EventRelationPairAttempt> = {},
): EventRelationPairAttempt {
  return {
    storyId: `story-rel-${index}`,
    pairId: index === 1 ? 'erp-1' : 'erp-2',
    state: 'evaluated',
    sideA: { evidenceId: `ev-a-${index}`, sourceItemId: 'item-rel-1', contentHash: HASH_A },
    sideB: {
      storyId: `story-rel-${index}`,
      evidenceId: `ev-b-${index}`,
      sourceItemId: `item-rel-${index}`,
      contentHash: HASH_B,
      draftId: `draft-rel-${index}`,
      draftVersion: 1,
    },
    canonicalInputHash: `c${index}`.padEnd(64, '0'),
    verdict,
    reasons: ['زمان و مکان مشترک گزارش شده است'],
    conflicts: verdict === 'different_event_proposed' ? ['تعارض در منابع'] : [],
    references: [
      { side: 'A', evidenceId: `ev-a-${index}` },
      { side: 'B', evidenceId: `ev-b-${index}` },
    ],
    aiRunIds: [RUN_1],
    ...overrides,
  };
}

function relationDocument(report: unknown): string {
  return JSON.stringify({
    schemaVersion: 1,
    locale: 'fa',
    headlineFa: 'تیتر ارتباط رویداد',
    summaryFa: 'خلاصهٔ ارتباط رویداد',
    sourceReport: {
      sourceItemId: 'item-rel-1',
      sourceName: 'منبع ارتباط',
      stance: 'mentions',
      excerptText: 'گزارهٔ ارتباط',
      truncated: false,
    },
    modelClaims: [],
    eventRelation: report,
  });
}

async function seedRelationDraft(id: string, report: unknown): Promise<void> {
  await seedStory(`story-${id}`, 'داستان ارتباط');
  await seedDraft({
    id,
    storyId: `story-${id}`,
    title: 'ارتباط رویداد',
    documentJson: relationDocument(report),
  });
}

/** File-level unique update ids (storage persists across tests in a file). */
let detailUpdateId = 7500;

async function renderDetail(id: string): Promise<string> {
  const harness = buildReviewHarness();
  const outcome = await harness.ingress.processUpdate(
    privateMessage(detailUpdateId++, OWNER_ID, `/drafts ${id}`),
  );
  expect(outcome).toBe('processed');
  expect(harness.sends).toHaveLength(1);
  return harness.sends[0]!.text;
}

beforeEach(async () => {
  await freshDb();
});

describe('relation proposals stay proposals', () => {
  it('same/different verdicts render distinctly with their run evidence', async () => {
    const report = buildEventRelationDecisionReport({
      disabled: false,
      snapshot: { sourceItemId: 'item-rel-1', contentHash: HASH_A },
      candidates: {
        entityLookup: { probed: ['entity-rel-1'], unprobedCount: 0, overflow: false },
        counts: { uniqueCandidatesObserved: 2, candidatesReported: 2 },
        candidatesTruncated: false,
        candidateEntries: [
          { storyId: 'story-rel-1', origins: ['fingerprint:url'], basisState: 'ok' },
          { storyId: 'story-rel-2', origins: ['entity:ent-rel-1'], basisState: 'ok' },
        ],
      },
      pairAttempts: [
        evaluatedPair(1, 'same_event_proposed'),
        evaluatedPair(2, 'different_event_proposed', { aiRunIds: [RUN_2] }),
      ],
    });
    await seedRelationDraft('draft-rel-verdicts', report);
    const text = await renderDetail('draft-rel-verdicts');
    expect(text).toContain('same_event_proposed');
    expect(text).toContain('different_event_proposed');
    expect(text).toContain(RUN_1.slice(0, 20));
    expect(text).toContain('*_proposed = model proposal only');
    expect(text).toContain('NOT approved');
  });

  it('insufficient_evidence stays a visible distinct proposal (never dropped)', async () => {
    const report = buildEventRelationDecisionReport({
      disabled: false,
      snapshot: { sourceItemId: 'item-rel-1', contentHash: HASH_A },
      candidates: {
        entityLookup: { probed: ['entity-rel-1'], unprobedCount: 0, overflow: false },
        counts: { uniqueCandidatesObserved: 1, candidatesReported: 1 },
        candidatesTruncated: false,
        candidateEntries: [
          { storyId: 'story-rel-3', origins: ['fingerprint:url'], basisState: 'ok' },
        ],
      },
      pairAttempts: [evaluatedPair(3, 'insufficient_evidence', { aiRunIds: [] })],
    });
    await seedRelationDraft('draft-rel-insufficient', report);
    const text = await renderDetail('draft-rel-insufficient');
    expect(text).toContain('insufficient_evidence');
    expect(text).toContain('verdict: insufficient_evidence');
  });

  it('technical states stay technical — never semantic insufficient_evidence', async () => {
    const report = buildEventRelationDecisionReport({
      disabled: false,
      snapshot: { sourceItemId: 'item-rel-1', contentHash: HASH_A },
      candidates: {
        entityLookup: { probed: ['entity-rel-1'], unprobedCount: 0, overflow: false },
        counts: { uniqueCandidatesObserved: 2, candidatesReported: 2 },
        candidatesTruncated: false,
        candidateEntries: [
          { storyId: 'story-tx-1', origins: ['fingerprint:url'], basisState: 'ok' },
          { storyId: 'story-tx-2', origins: ['fingerprint:url'], basisState: 'ok' },
        ],
      },
      pairAttempts: [
        {
          storyId: 'story-tx-1',
          pairId: 'erp-1',
          state: 'basis_unavailable',
          sideA: { evidenceId: 'ev-a-tx-1', sourceItemId: 'item-rel-1', contentHash: HASH_A },
          sideB: { storyId: 'story-tx-1', basisUnavailableReason: 'reference_row_unavailable' },
          aiRunIds: [],
        },
        {
          storyId: 'story-tx-2',
          pairId: 'erp-2',
          state: 'skipped_deadline',
          sideA: { evidenceId: 'ev-a-tx-2', sourceItemId: 'item-rel-1', contentHash: HASH_A },
          deferredReason: 'step_deadline_expired',
          aiRunIds: [],
        },
      ],
    });
    await seedRelationDraft('draft-rel-technical', report);
    const text = await renderDetail('draft-rel-technical');
    expect(text).toContain('basis_unavailable');
    expect(text).toContain('skipped_deadline');
    expect(text).toContain('Technical states are technical');
    expect(text).not.toContain('same_event_proposed');
  });

  it('honest disabled observation + missing-candidate note (never "unrelated")', async () => {
    await seedRelationDraft(
      'draft-rel-disabled',
      disabledEventRelationReport({ sourceItemId: 'item-rel-1', contentHash: HASH_A }),
    );
    const text = await renderDetail('draft-rel-disabled');
    expect(text).toContain('disabled');
    expect(text).toContain('is NOT "unrelated"');
  });
});

describe('stored conflicts render honestly (R1.18.1 — C1)', () => {
  it('conflicts render verbatim, DISTINCT from reasons, with ample space', async () => {
    const report = buildEventRelationDecisionReport({
      disabled: false,
      snapshot: { sourceItemId: 'item-rel-1', contentHash: HASH_A },
      candidates: {
        entityLookup: { probed: ['entity-rel-1'], unprobedCount: 0, overflow: false },
        counts: { uniqueCandidatesObserved: 1, candidatesReported: 1 },
        candidatesTruncated: false,
        candidateEntries: [
          { storyId: 'story-rel-1', origins: ['fingerprint:url'], basisState: 'ok' },
        ],
      },
      pairAttempts: [
        evaluatedPair(1, 'different_event_proposed', {
          reasons: ['Related title, but a different launch date.'],
          conflicts: ['CONFLICT_DIFFERENT_LAUNCH_DATE', 'CONFLICT_DIFFERENT_SOURCES'],
        }),
      ],
    });
    await seedRelationDraft('draft-rel-conflicts', report);
    const text = await renderDetail('draft-rel-conflicts');
    expect(text).toContain('verdict: different_event_proposed');
    // The stored conflict codes — verbatim, bounded, escaped.
    expect(text).toContain('conflict: CONFLICT_DIFFERENT_LAUNCH_DATE');
    expect(text).toContain('conflict: CONFLICT_DIFFERENT_SOURCES');
    // Distinct section: reasons keep their own '· ' prefix form.
    expect(text).toContain('· Related title, but a different launch date.');
    // Honest: with ample space nothing is omitted → no truncation notice.
    expect(text).not.toContain('display truncated');
  });

  it('empty stored conflict list fabricates nothing', async () => {
    const report = buildEventRelationDecisionReport({
      disabled: false,
      snapshot: { sourceItemId: 'item-rel-1', contentHash: HASH_A },
      candidates: {
        entityLookup: { probed: ['entity-rel-1'], unprobedCount: 0, overflow: false },
        counts: { uniqueCandidatesObserved: 1, candidatesReported: 1 },
        candidatesTruncated: false,
        candidateEntries: [
          { storyId: 'story-rel-4', origins: ['fingerprint:url'], basisState: 'ok' },
        ],
      },
      pairAttempts: [evaluatedPair(4, 'different_event_proposed', { conflicts: [] })],
    });
    await seedRelationDraft('draft-rel-noconflicts', report);
    const text = await renderDetail('draft-rel-noconflicts');
    expect(text).toContain('different_event_proposed');
    expect(text).not.toContain('conflict: ');
  });

  it('multiple long hostile conflicts stay bounded with honest truncation', async () => {
    const hostileEntry = `${'<script>'.repeat(15)}${'&'.repeat(78)}`;
    const conflicts = [0, 1, 2, 3].map((i) => `${hostileEntry}-${i}`);
    const report = buildEventRelationDecisionReport({
      disabled: false,
      snapshot: { sourceItemId: 'item-rel-1', contentHash: HASH_A },
      candidates: {
        entityLookup: { probed: ['entity-rel-1'], unprobedCount: 0, overflow: false },
        counts: { uniqueCandidatesObserved: 1, candidatesReported: 1 },
        candidatesTruncated: false,
        candidateEntries: [
          { storyId: 'story-rel-5', origins: ['fingerprint:url'], basisState: 'ok' },
        ],
      },
      pairAttempts: [evaluatedPair(5, 'different_event_proposed', { conflicts })],
    });
    await seedRelationDraft('draft-rel-hostile-conflicts', report);
    const text = await renderDetail('draft-rel-hostile-conflicts');
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(isSafeTelegramHtml(text)).toBe(true);
    // No raw hostile markup ever survives (the renderer's own <b>/<code>
    // builders are the only raw tags allowed).
    expect(text).not.toContain('<script>');
    // Bounded fitting entries are shown escaped...
    expect(text).toContain('conflict: ');
    // ...and the honest omission/truncation signal is present (4th entry by
    // the display cap and/or per-entry budget).
    expect(text).toContain('display truncated');
  });
});
