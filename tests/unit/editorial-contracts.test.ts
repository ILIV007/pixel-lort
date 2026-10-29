import { describe, expect, it } from 'vitest';
import {
  EditorialPrepareDraftPayloadSchema,
  parseJobPayload,
} from '../../src/domain/jobs/payloads';
import { JOB_TYPES, isJobErrorCode } from '../../src/domain/jobs/job-types';
import {
  isPausedByPolicy,
  policyExcludedTypes,
  type JobsPolicyGates,
} from '../../src/domain/jobs/policy';
import { parseEditorialConfig } from '../../src/shared/config/phase5';
import {
  aiRunIdForAttempt,
  draftIdForStory,
  editorialAiInputHash,
  editorialPrepareDraftIdempotencyKey,
  mentionsEvidenceId,
  sourceReportClaimId,
  storyIdForSnapshot,
  storyKeyForSnapshot,
} from '../../src/domain/editorial/identity';
import {
  buildAiEvidenceInput,
  buildDraftDocument,
  buildMentionsEvidence,
  buildSourceReportClaim,
  buildTraceableExcerpt,
  EDITORIAL_AI_SNIPPET_MAX_CHARS,
} from '../../src/domain/editorial/mapper';
import {
  classifyAiOutcome,
  observeAiRun,
} from '../../src/application/editorial/prepare-draft-handler';
import type { AiOutcome } from '../../src/domain/ai/types';

const ITEM_ID = 'item-0001';
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

describe('editorial payload contract (ADR-0042 §2)', () => {
  it('registers editorial.prepare_draft as a known job type', () => {
    expect(JOB_TYPES).toContain('editorial.prepare_draft');
    const parsed = parseJobPayload(
      'editorial.prepare_draft',
      JSON.stringify({ sourceItemId: ITEM_ID, snapshotHash: HASH }),
    );
    expect(parsed).toEqual({
      ok: true,
      payload: { sourceItemId: ITEM_ID, snapshotHash: HASH },
    });
  });

  it('is strict: unknown fields, news text, or secrets are rejected', () => {
    const result = EditorialPrepareDraftPayloadSchema.safeParse({
      sourceItemId: ITEM_ID,
      snapshotHash: HASH,
      newsText: 'leaked body text',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed snapshot hashes and empty ids', () => {
    expect(
      EditorialPrepareDraftPayloadSchema.safeParse({
        sourceItemId: ITEM_ID,
        snapshotHash: 'NOT-A-HASH',
      }).success,
    ).toBe(false);
    expect(
      EditorialPrepareDraftPayloadSchema.safeParse({
        sourceItemId: '',
        snapshotHash: HASH,
      }).success,
    ).toBe(false);
  });

  it('stays payload-bounded for the durable envelope', () => {
    const raw = JSON.stringify({ sourceItemId: ITEM_ID, snapshotHash: HASH });
    expect(raw.length).toBeLessThan(256);
  });
});

describe('editorial enablement policy (ADR-0042 §3)', () => {
  const gatesOff: JobsPolicyGates = { ingestionGateOn: true, editorialGateOn: false };
  const gatesOn: JobsPolicyGates = { ingestionGateOn: true, editorialGateOn: true };

  it('pauses editorial.prepare_draft only while its own gate is off', () => {
    expect(isPausedByPolicy('editorial.prepare_draft', gatesOff)).toBe(true);
    expect(isPausedByPolicy('editorial.prepare_draft', gatesOn)).toBe(false);
  });

  it('keeps the ingestion gate independent of the editorial gate', () => {
    expect(isPausedByPolicy('sources.fetch_poll', gatesOff)).toBe(false);
    expect(isPausedByPolicy('sources.fetch_poll', { ingestionGateOn: false })).toBe(true);
  });

  it('treats an ABSENT editorial gate snapshot as ON (offline harness compat)', () => {
    expect(isPausedByPolicy('editorial.prepare_draft', { ingestionGateOn: true })).toBe(false);
    expect(policyExcludedTypes({ ingestionGateOn: true })).toEqual([]);
  });

  it('excludes only the paused type from scans', () => {
    expect(policyExcludedTypes(gatesOff)).toEqual(['editorial.prepare_draft']);
    expect(policyExcludedTypes({ ingestionGateOn: false, editorialGateOn: false })).toEqual([
      'sources.fetch_poll',
      'editorial.prepare_draft',
    ]);
  });
});

describe('EDITORIAL_ENABLED configuration (fail-closed)', () => {
  it('defaults to false when absent', () => {
    const { config, result } = parseEditorialConfig({});
    expect(config.EDITORIAL_ENABLED).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('parses explicit true/false', () => {
    expect(parseEditorialConfig({ EDITORIAL_ENABLED: 'true' }).config.EDITORIAL_ENABLED).toBe(true);
    expect(parseEditorialConfig({ EDITORIAL_ENABLED: 'false' }).config.EDITORIAL_ENABLED).toBe(
      false,
    );
  });

  it('fails closed on present-but-invalid values (never silently ignored)', () => {
    const { result } = parseEditorialConfig({ EDITORIAL_ENABLED: 'yes' });
    expect(result.ok).toBe(false);
  });
});

describe('deterministic editorial identity (ADR-0042 §2)', () => {
  it('derives stable, versioned, bounded idempotency keys', async () => {
    const key1 = await editorialPrepareDraftIdempotencyKey(ITEM_ID, HASH);
    const key2 = await editorialPrepareDraftIdempotencyKey(ITEM_ID, HASH);
    expect(key1).toBe(key2);
    expect(key1.startsWith('editorial.prepare_draft:')).toBe(true);
    expect(key1.length).toBeLessThanOrEqual(256);
    const differentSnapshot = await editorialPrepareDraftIdempotencyKey(ITEM_ID, HASH2);
    expect(differentSnapshot).not.toBe(key1);
  });

  it('never merges different snapshots, even with identical titles', async () => {
    const keyA = await storyKeyForSnapshot('item-a', HASH);
    const keyB = await storyKeyForSnapshot('item-b', HASH);
    expect(keyA).not.toBe(keyB);
    const keyOtherSnapshot = await storyKeyForSnapshot('item-a', HASH2);
    expect(keyOtherSnapshot).not.toBe(keyA);
  });

  it('derives one claim/evidence/draft per snapshot story, deterministically', async () => {
    const storyId = await storyIdForSnapshot(ITEM_ID, HASH);
    const storyIdAgain = await storyIdForSnapshot(ITEM_ID, HASH);
    expect(storyId).toBe(storyIdAgain);
    const claimId = await sourceReportClaimId(storyId, ITEM_ID);
    const evidenceId = await mentionsEvidenceId(claimId, ITEM_ID);
    const draftId = await draftIdForStory(storyId);
    expect(claimId).toMatch(/^edcl_[0-9a-f]{32}$/);
    expect(evidenceId).toMatch(/^edev_[0-9a-f]{32}$/);
    expect(draftId).toMatch(/^eddr_[0-9a-f]{32}$/);
    // A new generation is a NEW, honestly-distinct ai_runs row.
    const run1 = await aiRunIdForAttempt('job-1', 1);
    const run2 = await aiRunIdForAttempt('job-1', 2);
    expect(run1).not.toBe(run2);
    expect(run1).toMatch(/^edai_[0-9a-f]{32}$/);
  });

  it('hashes the AI input deterministically without storing news text', async () => {
    const h1 = await editorialAiInputHash([{ id: ITEM_ID, text: 'some news text' }]);
    const h2 = await editorialAiInputHash([{ id: ITEM_ID, text: 'some news text' }]);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    const different = await editorialAiInputHash([{ id: ITEM_ID, text: 'other text' }]);
    expect(different).not.toBe(h1);
  });
});

describe('conservative mapping (ADR-0042 §2)', () => {
  const item = { title: 'تیتر خبر', body_excerpt: 'خلاصه متن خبر' };
  const excerpt = buildTraceableExcerpt(item);

  it('builds the traceable excerpt from the item own fields', () => {
    expect(excerpt.text).toContain('تیتر خبر');
    expect(excerpt.text).toContain('خلاصه متن خبر');
    expect(excerpt.truncated).toBe(false);
  });

  it('marks truncation instead of silently cutting', () => {
    const long = buildTraceableExcerpt({
      title: 'x'.repeat(5000),
      body_excerpt: 'y'.repeat(5000),
    });
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(EDITORIAL_AI_SNIPPET_MAX_CHARS);
  });

  it('keeps the source_report claim unverified with zero confidence', () => {
    const claim = buildSourceReportClaim({ sourceName: 'منبع رسمی', excerpt });
    expect(claim).toEqual({
      claimType: 'source_report',
      subject: 'منبع رسمی',
      predicate: 'reported',
      objectText: excerpt.text,
      confidence: 0,
      status: 'unverified',
    });
  });

  it('uses stance mentions with zero confidence for evidence', () => {
    expect(buildMentionsEvidence({ excerpt })).toEqual({
      stance: 'mentions',
      confidence: 0,
      excerpt: excerpt.text,
    });
  });

  it('keeps model claims unverified inside the draft document', () => {
    const document = buildDraftDocument({
      sourceItemId: ITEM_ID,
      sourceName: 'منبع رسمی',
      excerpt,
      semanticDraft: {
        headlineFa: 'تیتر مدل',
        summaryFa: 'خلاصه مدل',
        claims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
      },
    });
    expect(document.title).toBe('تیتر مدل');
    expect(document.document.schemaVersion).toBe(1);
    expect(document.document.locale).toBe('fa');
    expect(document.document.sourceReport).toMatchObject({
      sourceItemId: ITEM_ID,
      sourceName: 'منبع رسمی',
      stance: 'mentions',
      truncated: false,
    });
    expect(document.document.modelClaims).toEqual([
      { text: 'ادعای مدل', evidenceIds: [ITEM_ID], status: 'unverified' },
    ]);
    expect(document.facts).toEqual([
      { text: 'ادعای مدل', evidenceIds: [ITEM_ID], status: 'unverified', origin: 'model' },
    ]);
    expect(document.warnings).toContain('model_output_unverified');
    expect(document.warnings).toContain('single_source_report');
    expect(document.warnings).toContain('fact_guard_pending');
  });

  it('flags oversized AI snippets via the byte-level handler check path', () => {
    const oversized = buildAiEvidenceInput(ITEM_ID, {
      text: 'z'.repeat(EDITORIAL_AI_SNIPPET_MAX_CHARS + 1),
      truncated: true,
    });
    expect(oversized.rejected).toBe('oversized');
  });
});

describe('AI outcome mapping (ADR-0042 §5)', () => {
  const draftOutcome: AiOutcome = {
    kind: 'draft',
    draft: {
      headlineFa: 'h',
      summaryFa: 's',
      claims: [{ text: 'c', evidenceIds: [ITEM_ID] }],
    },
    usage: [],
    attempts: [],
  };

  it('commits drafts', () => {
    expect(classifyAiOutcome(draftOutcome)).toEqual({ kind: 'commit' });
  });

  it('maps refusal to a TERMINAL permanent outcome (no safety fallback)', () => {
    expect(
      classifyAiOutcome({
        kind: 'refusal',
        provider: 'workers-ai',
        modelId: '@cf/meta/llama-3.1-8b-instruct-fp8',
        reason: 'provider_safety_refusal',
        attempts: [],
      }),
    ).toEqual({ kind: 'permanent', reasonCode: 'editorial_ai_refused' });
  });

  it('maps pre-AI input rejection to a terminal typed outcome (no storm)', () => {
    expect(classifyAiOutcome({ kind: 'deferred', reason: 'input_invalid', attempts: [] })).toEqual({
      kind: 'permanent',
      reasonCode: 'editorial_input_invalid',
    });
  });

  it('maps typed deferrals onto the recoverable retry path', () => {
    for (const reason of [
      'ai_disabled',
      'binding_missing',
      'budget_denied',
      'budget_store_error',
      'deadline_exceeded',
      'provider_unavailable',
      'provider_auth_failed',
      'eligibility_unverified',
      'no_free_path',
      'config_invalid',
      'key_missing',
    ] as const) {
      expect(classifyAiOutcome({ kind: 'deferred', reason, attempts: [] })).toEqual({
        kind: 'retry',
      });
    }
  });

  it('records the real run for a successful draft (usage only when reported)', () => {
    const observed = observeAiRun(
      {
        ...draftOutcome,
        usage: [
          {
            provider: 'workers-ai',
            modelId: '@cf/meta/llama-3.1-8b-instruct-fp8',
            promptVersion: 'pixel-news-draft-v1',
            inputTokens: 100,
            outputTokens: 30,
          },
        ],
        attempts: [
          {
            provider: 'workers-ai',
            modelId: '@cf/meta/llama-3.1-8b-instruct-fp8',
            promptVersion: 'pixel-news-draft-v1',
            outcome: 'succeeded',
            durationMs: 25,
          },
        ],
      },
      1_000,
      1_100,
    );
    expect(observed).toMatchObject({
      provider: 'workers-ai',
      model: '@cf/meta/llama-3.1-8b-instruct-fp8',
      status: 'succeeded',
      inputTokens: 100,
      outputTokens: 30,
      errorCode: null,
    });
  });

  it('records a REAL failed run for deferrals with attempts, with the reason code', () => {
    const observed = observeAiRun(
      {
        kind: 'deferred',
        reason: 'provider_unavailable',
        attempts: [
          {
            provider: 'workers-ai',
            modelId: '@cf/meta/llama-3.1-8b-instruct-fp8',
            promptVersion: 'pixel-news-draft-v1',
            outcome: 'invalid_output',
            durationMs: 12,
          },
        ],
      },
      1_000,
      1_100,
    );
    expect(observed).toMatchObject({
      provider: 'workers-ai',
      status: 'failed',
      errorCode: 'provider_unavailable',
      inputTokens: null,
      outputTokens: null,
    });
  });

  it('NEVER fabricates a run when the provider never executed (zero attempts)', () => {
    expect(
      observeAiRun({ kind: 'deferred', reason: 'ai_disabled', attempts: [] }, 0, 0),
    ).toBeNull();
    expect(
      observeAiRun({ kind: 'deferred', reason: 'input_invalid', attempts: [] }, 0, 0),
    ).toBeNull();
  });

  it('records real refusal provider/model with the stable safety code', () => {
    const observed = observeAiRun(
      {
        kind: 'refusal',
        provider: 'workers-ai',
        modelId: '@cf/qwen/qwen3-30b-a3b-fp8',
        reason: 'provider_safety_refusal',
        attempts: [
          {
            provider: 'workers-ai',
            modelId: '@cf/qwen/qwen3-30b-a3b-fp8',
            promptVersion: 'pixel-news-draft-v1',
            outcome: 'refused',
            durationMs: 9,
          },
        ],
      },
      1_000,
      1_100,
    );
    expect(observed).toMatchObject({
      provider: 'workers-ai',
      model: '@cf/qwen/qwen3-30b-a3b-fp8',
      status: 'failed',
      errorCode: 'provider_safety_refusal',
    });
  });
});

describe('editorial error codes are stable and safe', () => {
  it('exposes the authored editorial codes', () => {
    for (const code of [
      'editorial_source_item_missing',
      'editorial_source_missing',
      'editorial_snapshot_mismatch',
      'editorial_input_invalid',
      'editorial_ai_refused',
    ]) {
      expect(isJobErrorCode(code)).toBe(true);
    }
  });
});
