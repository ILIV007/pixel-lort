import { describe, expect, it } from 'vitest';
import {
  EditorialPrepareDraftPayloadSchema,
  parseJobPayload,
} from '../../src/domain/jobs/payloads';
import { JOB_ERROR_CODES, JOB_TYPES, isJobErrorCode } from '../../src/domain/jobs/job-types';
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
  buildFullEvidenceText,
  buildMentionsEvidence,
  buildSourceReportClaim,
  buildTraceableExcerpt,
  EDITORIAL_AI_SNIPPET_MAX_CHARS,
} from '../../src/domain/editorial/mapper';
import {
  buildEvidenceGuardReport,
  type EvidenceGuardReport,
} from '../../src/domain/editorial/evidence-guard';
import {
  buildCandidateDiscoveryReport,
  type CandidateDiscoveryReport,
} from '../../src/domain/editorial/candidate-discovery';
import {
  buildCandidateAssessmentReport,
  type CandidateAssessmentReport,
} from '../../src/domain/editorial/candidate-assessment';
import {
  emptyEntityMentionsReport,
  type EntityMentionsReport,
} from '../../src/domain/editorial/entity-mentions';
import {
  disabledEventRelationReport,
  type EventRelationDecisionReport,
} from '../../src/domain/editorial/event-relation-decision';
import {
  classifyAiOutcome,
  observeAiRun,
} from '../../src/application/editorial/prepare-draft-handler';
import type { AiOutcome } from '../../src/domain/ai/types';

const ITEM_ID = 'item-0001';
const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

/** A deterministic guard report for the composition tests (R1.12, 5B). */
const GUARD_REPORT: EvidenceGuardReport = buildEvidenceGuardReport({
  snapshot: { sourceItemId: ITEM_ID, contentHash: HASH },
  evidence: {
    evidenceId: ITEM_ID,
    excerptText: 'متن شاهد آزمایشی',
    excerptTruncated: false,
  },
  draftClaims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
  draftHeadlineFa: 'تیتر مدل',
  draftSummaryFa: 'خلاصه مدل',
  draftSourceItemId: ITEM_ID,
});

/** A deterministic empty discovery report for the composition tests (R1.13). */
const NO_CANDIDATES_REPORT: CandidateDiscoveryReport = buildCandidateDiscoveryReport({
  snapshot: { sourceItemId: ITEM_ID, contentHash: HASH },
  storyId: 'edst_test_story',
  lookups: [],
  matches: [],
});

/** Its deterministic assessment (R1.14) — zero entries, nothing concluded. */
const NO_CANDIDATES_ASSESSMENT: CandidateAssessmentReport = buildCandidateAssessmentReport({
  discovery: NO_CANDIDATES_REPORT,
});

/** Its deterministic "nothing observed" mentions report (R1.16). */
const NO_MENTIONS_REPORT: EntityMentionsReport = emptyEntityMentionsReport({
  sourceItemId: ITEM_ID,
  contentHash: HASH,
});

/** R1.17: its honest "disabled" relation ledger (the required additive
 * field every new draft carries; the flag is OFF in this suite). */
const DISABLED_EVENT_RELATION_REPORT: EventRelationDecisionReport = disabledEventRelationReport({
  sourceItemId: ITEM_ID,
  contentHash: HASH,
});

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
      evidenceGuard: GUARD_REPORT,
      candidateDiscovery: NO_CANDIDATES_REPORT,
      candidateAssessment: NO_CANDIDATES_ASSESSMENT,
      entityMentions: NO_MENTIONS_REPORT,
      eventRelation: DISABLED_EVENT_RELATION_REPORT,
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

  it('embeds the versioned Evidence Guard report additively (R1.12, 5B)', () => {
    const document = buildDraftDocument({
      sourceItemId: ITEM_ID,
      sourceName: 'منبع رسمی',
      excerpt,
      semanticDraft: {
        headlineFa: 'تیتر مدل',
        summaryFa: 'خلاصه مدل',
        claims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
      },
      evidenceGuard: GUARD_REPORT,
      candidateDiscovery: NO_CANDIDATES_REPORT,
      candidateAssessment: NO_CANDIDATES_ASSESSMENT,
      entityMentions: NO_MENTIONS_REPORT,
      eventRelation: DISABLED_EVENT_RELATION_REPORT,
    });
    // The report rides INSIDE document_json, byte-for-byte the one built
    // for THIS draft; schemaVersion stays 1 (additive contract extension).
    expect(document.document.evidenceGuard).toBe(GUARD_REPORT);
    expect(document.document.schemaVersion).toBe(1);
    expect(document.document.evidenceGuard.guardVersion).toBe(1);
    expect(document.document.evidenceGuard.snapshot).toEqual({
      sourceItemId: ITEM_ID,
      contentHash: HASH,
    });
    // Report/claim index correspondence with the stored document.
    expect(document.document.modelClaims).toHaveLength(
      document.document.evidenceGuard.claims.length,
    );
  });

  it('embeds the versioned candidate-assessment report additively (R1.14, 5C-2)', () => {
    const document = buildDraftDocument({
      sourceItemId: ITEM_ID,
      sourceName: 'منبع رسمی',
      excerpt,
      semanticDraft: {
        headlineFa: 'تیتر مدل',
        summaryFa: 'خلاصه مدل',
        claims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
      },
      evidenceGuard: GUARD_REPORT,
      candidateDiscovery: NO_CANDIDATES_REPORT,
      candidateAssessment: NO_CANDIDATES_ASSESSMENT,
      entityMentions: NO_MENTIONS_REPORT,
      eventRelation: DISABLED_EVENT_RELATION_REPORT,
    });
    expect(document.document.candidateAssessment).toBe(NO_CANDIDATES_ASSESSMENT);
    expect(document.document.schemaVersion).toBe(1);
    expect(document.document.candidateAssessment.assessmentVersion).toBe(1);
    expect(document.document.candidateAssessment.observation).toBe('no_candidates_observed');
    expect(document.document.candidateAssessment.entries).toEqual([]);
    expect(document.document.candidateAssessment.unrelatednessConcluded).toBe(false);
    expect(document.document.candidateAssessment.limitations).toContain('not_same_event_proof');
    expect(document.document.candidateAssessment.unassessed).toEqual([
      'same_event',
      'truth',
      'source_independence',
    ]);
  });

  it('embeds the versioned entity-mentions report additively (R1.16, 5D)', () => {
    const document = buildDraftDocument({
      sourceItemId: ITEM_ID,
      sourceName: 'منبع رسمی',
      excerpt,
      semanticDraft: {
        headlineFa: 'تیتر مدل',
        summaryFa: 'خلاصه مدل',
        claims: [{ text: 'ادعای مدل', evidenceIds: [ITEM_ID] }],
      },
      evidenceGuard: GUARD_REPORT,
      candidateDiscovery: NO_CANDIDATES_REPORT,
      candidateAssessment: NO_CANDIDATES_ASSESSMENT,
      entityMentions: NO_MENTIONS_REPORT,
      eventRelation: DISABLED_EVENT_RELATION_REPORT,
    });
    // Additive contract: schemaVersion stays 1; the report rides inside
    // document_json byte-for-byte with its policy identity and honest
    // scope labels — an explicit mention is NEVER a verification and the
    // text NEVER adds anything to the catalog.
    expect(document.document.schemaVersion).toBe(1);
    expect(document.document.entityMentions).toBe(NO_MENTIONS_REPORT);
    expect(document.document.entityMentions.mentionsVersion).toBe(1);
    expect(document.document.entityMentions.policyVersion).toBe('em1');
    expect(document.document.entityMentions.observation).toBe('no_phrases_observed');
    expect(document.document.entityMentions.coverage.textAddsToCatalog).toBe(false);
    expect(document.document.entityMentions.limitations).toContain('controlled_aliases_only');
    expect(document.document.entityMentions.limitations).toContain('reuse_drafts_not_enriched');
  });

  it('flags oversized AI snippets via the byte-level handler check path', () => {
    const oversized = buildAiEvidenceInput(ITEM_ID, {
      text: 'z'.repeat(EDITORIAL_AI_SNIPPET_MAX_CHARS + 1),
      truncated: true,
    });
    expect(oversized.rejected).toBe('oversized');
  });

  it('composes the FULL evidence input from the SAME title+body source as the excerpt', () => {
    // R1.11.1: the byte cap is measured on buildFullEvidenceText BEFORE any
    // truncation; it must be the exact uncut composition of the excerpt —
    // the excerpt is a PREFIX (plus the ellipsis) of the full text:
    // truncation never changes the composition, only the length.
    const samples = [
      { title: 'تیتر', body_excerpt: 'بدنهٔ خبر' },
      { title: 'تیتر', body_excerpt: null },
      { title: '  حاشیه‌ها بریده می‌شوند  ', body_excerpt: '  بدنه  ' },
      { title: '', body_excerpt: '' },
      { title: 'x'.repeat(5000), body_excerpt: 'y'.repeat(5000) },
    ];
    for (const sample of samples) {
      const full = buildFullEvidenceText(sample);
      const excerpt = buildTraceableExcerpt(sample);
      if (excerpt.truncated) {
        expect(full.startsWith(excerpt.text.slice(0, -1))).toBe(true);
      } else {
        expect(excerpt.text).toBe(full);
      }
    }
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
      // R1.11.1 (Posidon correctness review): distinct terminal outcomes.
      'editorial_snapshot_changed',
      'editorial_no_traced_claim',
    ]) {
      expect(isJobErrorCode(code)).toBe(true);
    }
  });

  it('keeps the two R1.11.1 outcomes distinct from the fence-loss and pre-read codes', () => {
    expect(new Set(JOB_ERROR_CODES).size).toBe(JOB_ERROR_CODES.length); // no duplicates
    expect(JOB_ERROR_CODES.indexOf('editorial_snapshot_changed')).toBeGreaterThan(
      JOB_ERROR_CODES.indexOf('editorial_snapshot_mismatch'),
    );
  });
});
