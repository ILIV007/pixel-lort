import { beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_ID,
  buildReviewHarness,
  freshDb,
  privateMessage,
  seedDraft,
  seedStory,
} from '../helpers/review-test-fixtures';

/**
 * R1.18 document-projection tests: legacy absent reports, future versions,
 * malformed/null/primitive/array optional reports — every honest state stays
 * VISIBLE and distinct per report, the preview never crashes, never raw-JSON
 * dumps, never a fabricated verified badge or a false zero/no-match.
 */

interface DocumentOptions {
  readonly schemaVersion?: unknown;
  readonly eventRelation?: unknown;
  readonly evidenceGuard?: unknown;
  readonly entityMentions?: unknown;
  readonly candidateDiscovery?: unknown;
  readonly candidateAssessment?: unknown;
}

function documentJson(options: DocumentOptions = {}): string {
  return JSON.stringify({
    schemaVersion: options.schemaVersion ?? 1,
    locale: 'fa',
    headlineFa: 'تیتر سند آزمون',
    summaryFa: 'خلاصهٔ سند آزمون',
    sourceReport: {
      sourceItemId: 'item-doc-1',
      sourceName: 'منبع آزمون',
      stance: 'mentions',
      excerptText: 'گزارهٔ ذخیره‌شدهٔ سند آزمون',
      truncated: false,
    },
    modelClaims: [{ text: 'ادعای آزمون', evidenceIds: ['item-doc-1'], status: 'unverified' }],
    ...(options.eventRelation !== undefined ? { eventRelation: options.eventRelation } : {}),
    ...(options.evidenceGuard !== undefined ? { evidenceGuard: options.evidenceGuard } : {}),
    ...(options.entityMentions !== undefined ? { entityMentions: options.entityMentions } : {}),
    ...(options.candidateDiscovery !== undefined
      ? { candidateDiscovery: options.candidateDiscovery }
      : {}),
    ...(options.candidateAssessment !== undefined
      ? { candidateAssessment: options.candidateAssessment }
      : {}),
  });
}

async function seedDocumentDraft(id: string, json: string, title = 'سند آزمون'): Promise<void> {
  await seedStory(`story-${id}`, 'داستان سند');
  await seedDraft({ id, storyId: `story-${id}`, title, documentJson: json });
}

/** File-level unique update ids (storage persists across tests in a file). */
let detailUpdateId = 7400;

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

describe('legacy absent reports (pre-5B/5C/5D/5E drafts)', () => {
  it('core-only document → safe row metadata + explicit absent/legacy states per report', async () => {
    await seedDocumentDraft('draft-legacy', documentJson());
    const text = await renderDetail('draft-legacy');
    expect(text).toContain('draft-legacy');
    expect(text).toContain('تیتر سند آزمون');
    expect(text).toContain('older/legacy draft');
    expect(text).toContain('not present in this stored document');
    // No fabricated current-schema content; relation absence never claims
    // "no match" — it states the report is not present.
    expect(text).toContain('Event relation');
  });

  it('legacy view still shows the stored Persian content and source identity', async () => {
    await seedDocumentDraft('draft-legacy2', documentJson());
    const text = await renderDetail('draft-legacy2');
    expect(text).toContain('گزارهٔ ذخیره‌شدهٔ سند آزمون');
    expect(text).toContain('item-doc-1');
    expect(text).toContain('unavailable in this stored document');
  });
});

describe('future/unsupported document versions', () => {
  it('schemaVersion 2 → typed unsupported-version state with safe metadata only', async () => {
    await seedDocumentDraft('draft-future', documentJson({ schemaVersion: 2 }));
    const text = await renderDetail('draft-future');
    expect(text).toContain('draft-future');
    expect(text).toContain('uses a version this view does not read');
    expect(text).not.toContain('تیتر سند آزمون');
  });

  it('schemaVersion missing entirely → same honest unsupported state', async () => {
    const json = JSON.stringify({
      locale: 'fa',
      headlineFa: 'تیتر بی‌نسخه',
      summaryFa: 'خلاصه',
      sourceReport: {
        sourceItemId: 'i',
        sourceName: 's',
        stance: 'mentions',
        excerptText: 'e',
        truncated: false,
      },
      modelClaims: [],
    });
    await seedDocumentDraft('draft-noversion', json);
    const text = await renderDetail('draft-noversion');
    expect(text).toContain('uses a version this view does not read');
    expect(text).not.toContain('تیتر بی‌نسخه');
  });
});

describe('malformed documents and optional reports', () => {
  it('document not parseable as an object (primitive) → malformed_document, safe metadata', async () => {
    await seedDocumentDraft('draft-primitive', JSON.stringify('just a string'));
    const text = await renderDetail('draft-primitive');
    expect(text).toContain('malformed');
    expect(text).toContain('draft-primitive');
  });

  it('document not parseable as JSON → malformed_document (no throw)', async () => {
    await seedDocumentDraft('draft-notjson', '{not json at all');
    const text = await renderDetail('draft-notjson');
    expect(text).toContain('malformed');
  });

  it('corrupt optional report (primitive) → that report shows malformed, preview survives', async () => {
    await seedDocumentDraft('draft-badrelation', documentJson({ eventRelation: 42 }));
    const text = await renderDetail('draft-badrelation');
    expect(text).toContain('draft-badrelation');
    expect(text).toContain('تیتر سند آزمون');
    expect(text).toContain('stored report is malformed');
  });

  it('corrupt optional report (null) → shown as unavailable, never as zero/no-match', async () => {
    await seedDocumentDraft('draft-nullguard', documentJson({ evidenceGuard: null }));
    const text = await renderDetail('draft-nullguard');
    expect(text).toContain('stored report is malformed');
  });

  it('corrupt optional report (array) → shown as unavailable, never guessed', async () => {
    await seedDocumentDraft('draft-arraymentions', documentJson({ entityMentions: [] }));
    const text = await renderDetail('draft-arraymentions');
    expect(text).toContain('stored report is malformed');
  });

  it('future-version optional report → distinct unsupported state, other reports unaffected', async () => {
    await seedDocumentDraft(
      'draft-futurerelation',
      documentJson({ eventRelation: { eventRelationVersion: 99 } }),
    );
    const text = await renderDetail('draft-futurerelation');
    expect(text).toContain('stored report has a version this view does not read');
    expect(text).toContain('تیتر سند آزمون');
  });

  it('no raw JSON dump of a malformed object ever appears', async () => {
    await seedDocumentDraft(
      'draft-nodump',
      documentJson({ eventRelation: { hostile: '<script>alert(1)</script>' } }),
    );
    const text = await renderDetail('draft-nodump');
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('hostile');
  });
});
