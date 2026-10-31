import { beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_ID,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedDraft,
  seedStory,
} from '../helpers/review-test-fixtures';
import { isSafeTelegramHtml } from '../../src/admin/telegram-html';
import { buildEventRelationDecisionReport } from '../../src/domain/editorial/event-relation-decision';

/**
 * R1.18 hostile-rendering tests: hostile markup, enormous strings, emoji
 * (incl. astral/surrogate pairs), RTL/bidi controls — the reply is ALWAYS
 * valid safe HTML within the 3500 UTF-16 unit budget, exactly ONE response,
 * explicit display truncation, and the safety notices are never silently
 * dropped in favor of long content.
 */

const HOSTILE_TEXTS = {
  markup: '<script>alert("x")</script> & <b onmouseover=alert(1)>bold</b> &amp; raw & entities',
  rtl: '‮ینا متن تستی با کنترل‌های بی‌دی است‬ \u202Bمخفی\u202C پایان',
  astral: '🎮🎮🎮 \u{1F600}\u{1F680}\u{1F525} بازی نمونه 🕹️🎲',
  enormous: 'ز'.repeat(20_000),
  entityFlood: '&'.repeat(2_000),
  quotes: `"'"'"<>"'"'`,
};

function hostileDocument(): string {
  return JSON.stringify({
    schemaVersion: 1,
    locale: 'fa',
    headlineFa: `${HOSTILE_TEXTS.markup} ${HOSTILE_TEXTS.astral}`,
    summaryFa: HOSTILE_TEXTS.enormous,
    sourceReport: {
      sourceItemId: `${HOSTILE_TEXTS.quotes}-item`,
      sourceName: `${HOSTILE_TEXTS.markup} — ${HOSTILE_TEXTS.rtl}`,
      stance: 'mentions',
      excerptText: `${HOSTILE_TEXTS.entityFlood} ${HOSTILE_TEXTS.enormous} ${HOSTILE_TEXTS.rtl}`,
      truncated: true,
    },
    modelClaims: [
      { text: HOSTILE_TEXTS.markup, evidenceIds: [HOSTILE_TEXTS.quotes] },
      { text: HOSTILE_TEXTS.enormous, evidenceIds: ['<img src=x onerror=alert(2)>'] },
      { text: HOSTILE_TEXTS.astral, evidenceIds: [] },
      { text: HOSTILE_TEXTS.rtl, evidenceIds: [] },
    ],
  });
}

async function seedHostileDraft(id: string, documentJson: string, title: string): Promise<void> {
  await seedStory(`story-${id}`, 'داستان خصمانه');
  await seedDraft({ id, storyId: `story-${id}`, title, documentJson });
}

beforeEach(async () => {
  await freshDb();
});

describe('hostile content stays bounded safe HTML', () => {
  it('detail of a fully hostile draft: ≤3500 units, valid HTML, one send, truncation + notices', async () => {
    await seedHostileDraft('draft-hostile', hostileDocument(), `${HOSTILE_TEXTS.markup} 🎮`);
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(
      privateMessage(7600, OWNER_ID, '/drafts draft-hostile'),
    );
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1); // exactly ONE response message
    const text = harness.sends[0]!.text;
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(isSafeTelegramHtml(text)).toBe(true);
    // No raw markup ever survives (only the escaped entity form can appear).
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('<img');
    expect(text).not.toContain('<b onmouseover');
    // Explicit display truncation happened.
    expect(text).toContain('display truncated');
    // Safety labels were NOT silently dropped in favor of long content.
    expect(text).toContain('NOT approved');
    expect(text).toContain('UNVERIFIED');
    // The emoji content survives as text (code points never split).
    expect(text).toContain('🎮');
  });

  it('hostile LIST row titles cannot break the page', async () => {
    for (let index = 0; index < 7; index += 1) {
      await seedHostileDraft(
        `draft-hl-${index}`,
        JSON.stringify({
          schemaVersion: 1,
          locale: 'fa',
          headlineFa: HOSTILE_TEXTS.enormous,
          summaryFa: HOSTILE_TEXTS.markup,
          sourceReport: {
            sourceItemId: 'i',
            sourceName: 's',
            stance: 'mentions',
            excerptText: 'e',
            truncated: false,
          },
          modelClaims: [],
        }),
        `${HOSTILE_TEXTS.markup} ${HOSTILE_TEXTS.enormous} ${index}`,
      );
    }
    const harness = buildReviewHarness();
    const outcome = await harness.ingress.processUpdate(privateMessage(7601, OWNER_ID, '/drafts'));
    expect(outcome).toBe('processed');
    expect(harness.sends).toHaveLength(1);
    const text = harness.sends[0]!.text;
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(isSafeTelegramHtml(text)).toBe(true);
    expect(text).toContain('draft-hl-0'); // 5 visible rows (insertion tie order)
    expect(text).toContain('draft-hl-4');
    expect(text).not.toContain('draft-hl-5'); // probe row absent
    expect(text).not.toContain('draft-hl-6');
    expect(text).toContain('More ready drafts may exist');
  });

  it('astral/surrogate content is never sliced mid-pair', async () => {
    await seedHostileDraft(
      'draft-astral',
      JSON.stringify({
        schemaVersion: 1,
        locale: 'fa',
        headlineFa: '🎮'.repeat(50),
        summaryFa: '\u{1F600}'.repeat(3000),
        sourceReport: {
          sourceItemId: 'i',
          sourceName: 's',
          stance: 'mentions',
          excerptText: '🎮'.repeat(1500),
          truncated: false,
        },
        modelClaims: [],
      }),
      'astral',
    );
    const harness = buildReviewHarness();
    await harness.ingress.processUpdate(privateMessage(7602, OWNER_ID, '/drafts draft-astral'));
    const text = harness.sends[0]!.text;
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(isSafeTelegramHtml(text)).toBe(true);
    // Walk the whole message: every code point must be well-formed.
    for (const codePoint of text) {
      expect(codePoint.length).toBeLessThanOrEqual(2);
    }
  });

  // R1.18.1 (S1): mandatory safety space is reserved BEFORE variable
  // content — long but bounded stored content can never crowd the relation
  // safety notices (or the honest conflict display) out of the reply.
  it('long stored content cannot crowd out the relation safety notices', async () => {
    const relationReport = buildEventRelationDecisionReport({
      disabled: false,
      snapshot: { sourceItemId: 'item-s1', contentHash: 'a'.repeat(64) },
      candidates: {
        entityLookup: { probed: ['entity-s1'], unprobedCount: 0, overflow: false },
        counts: { uniqueCandidatesObserved: 1, candidatesReported: 1 },
        candidatesTruncated: false,
        candidateEntries: [
          { storyId: 'story-s1-other', origins: ['fingerprint:url'], basisState: 'ok' },
        ],
      },
      pairAttempts: [
        {
          storyId: 'story-s1-other',
          pairId: 'erp-1',
          state: 'evaluated',
          sideA: { evidenceId: 'ev-a', sourceItemId: 'item-s1', contentHash: 'a'.repeat(64) },
          sideB: {
            storyId: 'story-s1-other',
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
    await seedHostileDraft(
      'draft-s1-long',
      JSON.stringify({
        schemaVersion: 1,
        locale: 'fa',
        headlineFa: 'ه'.repeat(600),
        summaryFa: 'خ'.repeat(900),
        sourceReport: {
          sourceItemId: 'item-s1',
          sourceName: 'م'.repeat(600),
          stance: 'mentions',
          excerptText: 'گ'.repeat(700),
          truncated: false,
        },
        modelClaims: [{ text: 'ا'.repeat(220), evidenceIds: ['ev-a'] }],
        eventRelation: relationReport,
      }),
      'S1 reservation',
    );
    const harness = buildReviewHarness();
    await harness.ingress.processUpdate(privateMessage(7603, OWNER_ID, '/drafts draft-s1-long'));
    const text = harness.sends[0]!.text;
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(isSafeTelegramHtml(text)).toBe(true);
    // The three mandatory relation safety notices survive long content.
    expect(text).toContain('*_proposed = model proposal only');
    expect(text).toContain('Technical states are technical');
    expect(text).toContain('Missing candidate / non-match is NOT');
    // The other mandatory notices survive too.
    expect(text).toContain('NOT approved');
    expect(text).toContain('UNVERIFIED');
    // Long content was bounded honestly — the explicit display-truncated
    // signal is present (stored report CONTENT such as conflicts may be
    // omitted by space, but never silently: the notice says so).
    expect(text).toContain('display truncated');
  });

  it('typed report read outcomes survive long content (state reservation)', async () => {
    await seedHostileDraft(
      'draft-s1-state',
      JSON.stringify({
        schemaVersion: 1,
        locale: 'fa',
        headlineFa: 'ت'.repeat(600),
        summaryFa: 'ج'.repeat(1500),
        sourceReport: {
          sourceItemId: 'item-s1-state',
          sourceName: 'س'.repeat(400),
          stance: 'mentions',
          excerptText: 'د'.repeat(700),
          truncated: false,
        },
        modelClaims: [],
        // No optional report keys at all: every typed read outcome is the
        // honest absent state and MUST stay visible in the bounded view.
      }),
      'state reservation',
    );
    const harness = buildReviewHarness();
    await harness.ingress.processUpdate(privateMessage(7604, OWNER_ID, '/drafts draft-s1-state'));
    const text = harness.sends[0]!.text;
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(isSafeTelegramHtml(text)).toBe(true);
    expect(text).toContain('not present in this stored document');
    expect(text).toContain('Event relation (≤2 pairs, proposals)');
  });
});
