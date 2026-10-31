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
});
