/**
 * Zod v4 migration contract (the Phase 10 tracked carry — the
 * GHSA-mrhx-c7xc-m3w5 memory-exhaustion advisory, fixed in zod 4.6.6+).
 *
 * Written FIRST, on the pre-migration tree (zod 3.25.76):
 * - THE MIGRATION MARKERS are RED on the pre-migration tree and GREEN only
 *   when the installed dependency is the fixed v4 (house pin >= 4.6.7):
 *   the bundled-version gate and the v4 canonical issue-message shape.
 * - THE PRESERVATION PINS lock the parse contracts of every migrated
 *   surface — the queue envelope (ADR-0036 §5/ADR-0037), the durable job
 *   payload schemas (ADR-0036 §7), the AI provider-output schemas
 *   (ADR-0041) and the source-registry schema (ADR-0038 §2) incl. the
 *   superRefine custom issues and the config record — so a major-version
 *   migration can never silently change a typed refusal, a strict-object
 *   boundary or an accepted shape.
 *
 * The 1-arg `z.record` removal and the `z.ZodIssueCode` removal are pinned
 * at COMPILE time by `npm run typecheck` (the source now uses the 2-arg
 * record form and the string-literal "custom" code); this suite pins the
 * RUNTIME behavior that must survive the migration unchanged.
 */
import { expect, describe, it } from 'vitest';
import zodPackageJson from 'zod/package.json';
import { z } from 'zod';
import { parseAiSemanticDraftJson } from '../../src/domain/ai/schema';
import { parseQueueEnvelope, QueueEnvelopeSchema } from '../../src/domain/jobs/envelope';
import { PAYLOAD_SCHEMAS, SourcesPollPayloadSchema } from '../../src/domain/jobs/payloads';
import { RegistrySchema } from '../../src/domain/source/source-registry';

const ZOD_VERSION = zodPackageJson.version as string;

function versionAtLeast(version: string, min: readonly number[]): boolean {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < min.length; i += 1) {
    const p = parts[i] ?? 0;
    const m = min[i] ?? 0;
    if (p > m) return true;
    if (p < m) return false;
  }
  return true;
}

function validGlobalPolicies(): Record<string, unknown> {
  return {
    timezone: 'Asia/Tehran',
    defaultPublishingMode: 'auto',
    rssConditionalGet: true,
    respectRetryAfter: true,
    maxRedirects: 2,
    httpTimeoutMs: 10000,
    maxFeedBytes: 2097152,
    maxArticleBytes: 1048576,
    allowHttp: false,
    storeRawDays: 90,
    neverAutoPublishSignalOnly: true,
    noPiracyDownloadLinks: true,
    youtubeDownloadForbidden: true,
  };
}

const validSource = {
  id: 'test_feed',
  name: 'Test Feed',
  connector: 'rss',
  lane: 'official',
  endpoint: 'https://example.com/feed.xml',
  trustTier: 90,
  intervalSeconds: 300,
  dailyRequestBudget: 100,
  approvalPolicy: 'threshold',
  autoPublishThreshold: 82,
  content: ['official_news'],
};

function validRegistryWith(source: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: 1,
    brand: { channelName: 'a', channelUsername: 'b', botPersona: 'c', footerHtml: 'd' },
    globalPolicies: validGlobalPolicies(),
    sources: [source],
  };
}

describe('zod v4 migration: THE MIGRATION MARKERS (RED pre-migration)', () => {
  it('the installed zod dependency is the GHSA-mrhx-c7xc-m3w5 fix (major 4, >= 4.6.7)', () => {
    const major = Number.parseInt(ZOD_VERSION.split('.')[0] ?? '0', 10);
    expect(major).toBe(4);
    expect(versionAtLeast(ZOD_VERSION, [4, 6, 7])).toBe(true);
  });

  it('a failed string parse reports the v4 canonical issue message shape', () => {
    const parsed = z.string().safeParse(undefined);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues[0];
    expect(issue).toBeDefined();
    expect(issue?.code).toBe('invalid_type');
    // v4 canonical phrasing (v3 said only "Required" — the observable marker).
    expect(issue?.message.startsWith('Invalid input: expected string')).toBe(true);
  });

  it('the v4 2-arg record form accepts string-keyed unknown values', () => {
    const recordSchema = z.record(z.string(), z.unknown());
    const parsed = recordSchema.safeParse({ anything: { nested: [1, 'x', true] }, n: 5 });
    expect(parsed.success).toBe(true);
  });
});

describe('zod v4 migration: the queue-envelope contract is preserved', () => {
  const validEnvelope = {
    version: 1,
    jobId: 'job-1',
    type: 'jobs.maintenance_heartbeat',
    attempt: 1,
    traceId: 'trace-1',
  };

  it('accepts a valid canonical envelope object', () => {
    const parsed = parseQueueEnvelope(validEnvelope);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.jobId).toBe('job-1');
    expect(parsed.envelope.attempt).toBe(1);
  });

  it('accepts the defensive JSON-encoded string form (ADR-0037)', () => {
    const parsed = parseQueueEnvelope(JSON.stringify(validEnvelope));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.type).toBe('jobs.maintenance_heartbeat');
  });

  it('refuses a smuggled extra field (the strict boundary)', () => {
    const parsed = parseQueueEnvelope({ ...validEnvelope, payload: { smuggled: true } });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('malformed_envelope');
  });

  it('refuses a non-integer attempt and an oversized jobId', () => {
    expect(parseQueueEnvelope({ ...validEnvelope, attempt: 1.5 }).ok).toBe(false);
    expect(parseQueueEnvelope({ ...validEnvelope, jobId: 'x'.repeat(65) }).ok).toBe(false);
  });

  it('yields the distinct unsupported_version outcome for version 2', () => {
    const parsed = parseQueueEnvelope({ ...validEnvelope, version: 2 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('unsupported_version');
  });

  it('safeParse failure issues carry code + path (the .issues contract)', () => {
    const parsed = QueueEnvelopeSchema.safeParse({ version: 1 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.length).toBeGreaterThan(0);
    expect(parsed.error.issues[0]?.code).toBeDefined();
    expect(Array.isArray(parsed.error.issues[0]?.path)).toBe(true);
  });
});

describe('zod v4 migration: the durable job payload contract is preserved', () => {
  it('PAYLOAD_SCHEMAS resolves the registered poll payload schema', () => {
    expect(PAYLOAD_SCHEMAS.get('sources.fetch_poll')).toBe(SourcesPollPayloadSchema);
  });

  it('accepts a valid poll payload and strips nothing (strict)', () => {
    const parsed = SourcesPollPayloadSchema.safeParse({
      sourceId: 'test_feed',
      scheduledForMs: 1000,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ sourceId: 'test_feed', scheduledForMs: 1000 });
  });

  it('refuses a malformed source id, a float timestamp and an extra key', () => {
    expect(SourcesPollPayloadSchema.safeParse({ sourceId: 'X', scheduledForMs: 1 }).success).toBe(
      false,
    );
    expect(
      SourcesPollPayloadSchema.safeParse({ sourceId: 'test_feed', scheduledForMs: 1.5 }).success,
    ).toBe(false);
    expect(
      SourcesPollPayloadSchema.safeParse({
        sourceId: 'test_feed',
        scheduledForMs: 1,
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe('zod v4 migration: the AI provider-output contract is preserved', () => {
  const validDraft = JSON.stringify({
    headlineFa: 'تیتر',
    summaryFa: 'خلاصه',
    claims: [{ text: 'ادعا', evidenceIds: ['e1'] }],
  });

  it('parses a valid provider draft', () => {
    const parsed = parseAiSemanticDraftJson(validDraft);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft.claims.length).toBe(1);
  });

  it('classifies empty, malformed and schema-mismatched output (stable codes)', () => {
    expect(parseAiSemanticDraftJson('   ').ok).toBe(false);
    expect(parseAiSemanticDraftJson('not json {').ok).toBe(false);
    const mismatch = parseAiSemanticDraftJson('{"headlineFa":"h","summaryFa":"s","claims":[]}');
    expect(mismatch.ok).toBe(true); // zero claims is a SHAPE match; emptiness is a service rule
    const wrongShape = parseAiSemanticDraftJson(
      JSON.stringify({ headlineFa: 'h', summaryFa: 's', claims: [{ text: 't' }] }),
    );
    expect(wrongShape.ok).toBe(false);
    if (wrongShape.ok) return;
    expect(wrongShape.code).toBe('schema_mismatch');
    const oversized = parseAiSemanticDraftJson(
      JSON.stringify({ headlineFa: 'x'.repeat(201), summaryFa: 's', claims: [] }),
    );
    expect(oversized.ok).toBe(false);
    if (oversized.ok) return;
    expect(oversized.code).toBe('schema_mismatch');
  });
});

describe('zod v4 migration: the source-registry contract is preserved', () => {
  it('accepts a valid minimal registry', () => {
    const parsed = RegistrySchema.safeParse(validRegistryWith({ ...validSource }));
    expect(parsed.success).toBe(true);
  });

  it('a schema-connector config must satisfy its strict schema; a non-object config is refused', () => {
    const accepted = RegistrySchema.safeParse(
      validRegistryWith({
        ...validSource,
        connector: 'github-releases',
        config: { repositories: ['ILIV007/pixel-lort'], includePrereleases: false },
      }),
    );
    expect(accepted.success).toBe(true);
    const nonObject = RegistrySchema.safeParse(
      validRegistryWith({ ...validSource, connector: 'github-releases', config: 5 }),
    );
    expect(nonObject.success).toBe(false);
  });

  it('refuses an invented top-level source field (the strict catalog boundary)', () => {
    const parsed = RegistrySchema.safeParse(
      validRegistryWith({ ...validSource, inventedField: true }),
    );
    expect(parsed.success).toBe(false);
  });

  it('refuses an invalid connector config with a custom issue at the config path', () => {
    const parsed = RegistrySchema.safeParse(
      validRegistryWith({
        ...validSource,
        connector: 'steam-news',
        config: { appsPerBatch: 10, maxItemsPerApp: 99 },
      }),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const configIssue = parsed.error.issues.find(
      (issue) => issue.path.join('.') === 'sources.0.config',
    );
    expect(configIssue).toBeDefined();
    expect(configIssue?.code).toBe('custom');
  });

  it('refuses a signal_only source carrying an auto threshold (custom issue)', () => {
    const parsed = RegistrySchema.safeParse(
      validRegistryWith({
        ...validSource,
        approvalPolicy: 'signal_only',
        autoPublishThreshold: 80,
      }),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const thresholdIssue = parsed.error.issues.find(
      (issue) => issue.path.join('.') === 'sources.0.autoPublishThreshold',
    );
    expect(thresholdIssue).toBeDefined();
    expect(thresholdIssue?.code).toBe('custom');
  });
});
