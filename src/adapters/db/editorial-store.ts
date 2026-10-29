/**
 * Editorial durable-state store (Phase 5A — ADR-0042 §4): ALL editorial SQL
 * in ONE typed D1 adapter (ADR-0022). Domain/application code contains no
 * SQL and no Cloudflare types; every value is bound, never interpolated.
 *
 * WRITE-FENCING CONTRACT (Posidon R1.11 — stable execution): every
 * mutation of the editorial commit runs as ONE atomic `executor.batch()`
 * and EVERY statement carries the same ownership predicate — the job row
 * must STILL be claimed by EXACTLY this generation:
 *
 *   EXISTS (SELECT 1 FROM jobs
 *            WHERE id = ?1 AND status = 'claimed' AND attempts = ?2)
 *
 * SNAPSHOT PREDICATE (R1.11.1 — Posidon correctness review): EVERY
 * statement ALSO carries the identity of the source snapshot the handler
 * read — (source item id, source id, content_hash) — evaluated INSIDE the
 * same atomic batch:
 *
 *   EXISTS (SELECT 1 FROM source_items
 *            WHERE id = ? AND source_id = ? AND content_hash = ?)
 *
 * If the stored item changes between the handler's identity-checked read
 * and the commit (the R1.11.1 demonstrated race), EVERY effect of the
 * batch — story, claim, evidence, ai_run, draft AND the processed flip —
 * matches ZERO rows: a draft of an OLD snapshot can never be committed
 * while the item is marked processed as a NEW one. A JS re-read never
 * substitutes for this SQL condition; a post-batch read only CLASSIFIES
 * which predicate failed for the typed outcome (the write protection
 * itself is entirely in SQL).
 *
 * IDEMPOTENCY CONTRACT: story/claim/evidence/draft rows use DETERMINISTIC
 * ids derived from (sourceItemId, snapshotHash) (ADR-0042 §2), so the
 * INSERT..SELECT guards (`NOT EXISTS` same id) make the whole commit
 * re-runnable without creating duplicates: replay after a successful
 * commit finds the stable result BEFORE the AI service is called and
 * never re-invokes the provider.
 *
 * AT-LEAST-ONCE HONESTY (R1.11): a crash after the provider answered but
 * before this batch commits loses the ai_runs row WITH the draft — the
 * retry is a NEW generation that legitimately calls the provider again
 * and writes its own ai_runs row. Each attempt was charged through the
 * durable AI budget authority (ai-budget-store) BEFORE the call. Exactly-
 * once external behavior is NOT claimed.
 */

import type { DbExecutor } from './db-executor';
import type {
  FingerprintLookupPlan,
  StoryFingerprintKind,
} from '../../domain/editorial/story-fingerprints';

/** Editorial-owned read shape of a source_items row (traceable fields only). */
export interface EditorialSourceItemRow {
  readonly id: string;
  readonly source_id: string;
  readonly title: string;
  readonly body_excerpt: string | null;
  /** R1.13: read in the SAME projection (no extra read) — the verbatim
   * stored URL identity behind the `url` fingerprint signal. */
  readonly canonical_url: string | null;
  readonly content_hash: string;
  readonly processing_status: string;
}

/** Editorial-owned read shape of a sources row (attribution only). */
export interface EditorialSourceRow {
  readonly id: string;
  readonly name: string;
  readonly trust_tier: number;
}

export async function findEditorialSourceItem(
  executor: DbExecutor,
  sourceItemId: string,
): Promise<EditorialSourceItemRow | null> {
  return executor.first<EditorialSourceItemRow>({
    sql: `SELECT id, source_id, title, body_excerpt, canonical_url, content_hash,
                 processing_status
            FROM source_items WHERE id = ?`,
    params: [sourceItemId],
  });
}

export async function findEditorialSource(
  executor: DbExecutor,
  sourceId: string,
): Promise<EditorialSourceRow | null> {
  return executor.first<EditorialSourceRow>({
    sql: `SELECT id, name, trust_tier FROM sources WHERE id = ?`,
    params: [sourceId],
  });
}

export interface EditorialStoryRow {
  readonly id: string;
  readonly story_key: string;
  readonly status: string;
}

export async function findStoryByKey(
  executor: DbExecutor,
  storyKey: string,
): Promise<EditorialStoryRow | null> {
  return executor.first<EditorialStoryRow>({
    sql: `SELECT id, story_key, status FROM stories WHERE story_key = ?`,
    params: [storyKey],
  });
}

export interface EditorialDraftRow {
  readonly id: string;
  readonly story_id: string;
  readonly status: string;
  readonly version: number;
}

export async function findDraftForStory(
  executor: DbExecutor,
  storyId: string,
  version: number,
): Promise<EditorialDraftRow | null> {
  return executor.first<EditorialDraftRow>({
    sql: `SELECT id, story_id, status, version FROM drafts WHERE story_id = ? AND version = ?`,
    params: [storyId, version],
  });
}

/**
 * The STABLE-RESULT lookup: the (story, ready draft) pair that proves the
 * pipeline's durable effect already exists for this snapshot — the pre-AI
 * idempotency check (retry after a successful commit must NOT call the
 * provider again, ADR-0042 §5).
 */
export async function findStableEditorialResult(
  executor: DbExecutor,
  storyKey: string,
  draftVersion: number,
): Promise<{ readonly story: EditorialStoryRow; readonly draft: EditorialDraftRow } | null> {
  const story = await findStoryByKey(executor, storyKey);
  if (story === null) {
    return null;
  }
  const draft = await findDraftForStory(executor, story.id, draftVersion);
  if (draft === null || draft.status !== 'ready') {
    return null;
  }
  return { story, draft };
}

/**
 * One candidate lookup's outcome: the DISTINCT story owners of ONE
 * fingerprint digest within the exact namespace prefix, plus the honest
 * overflow flag (a full probe page means "at least N seen — maybe more",
 * never "all"). A DB error PROPAGATES to the caller — a failed lookup is
 * NEVER reported as a successful empty one (R1.13 honesty boundary).
 */
export interface StoryCandidateLookupOutcome {
  readonly kind: StoryFingerprintKind;
  readonly storyIds: readonly string[];
  readonly overflow: boolean;
}

/**
 * The LIMITED candidate lookup (R1.13): at most one parameterized range
 * query per present signal, each reading AT MOST the probe limit (9) rows
 * from the (kind, value) primary-key index of `story_fingerprints` — the
 * exact `sc1:<digest>:` namespace prefix, story-scope excluded for the
 * current story, no wildcards, no full scan, no unbounded reads.
 */
export async function findStoryCandidatesByFingerprints(
  executor: DbExecutor,
  plans: readonly FingerprintLookupPlan[],
  excludeStoryId: string,
  probeLimit: number,
): Promise<readonly StoryCandidateLookupOutcome[]> {
  const outcomes: StoryCandidateLookupOutcome[] = [];
  for (const plan of plans) {
    const rows = await executor.query<{ story_id: string }>({
      sql: `SELECT story_id FROM story_fingerprints
             WHERE kind = ? AND value >= ? AND value < ? AND story_id <> ?
             LIMIT ?`,
      params: [plan.kind, plan.lowerBound, plan.upperBound, excludeStoryId, probeLimit],
    });
    outcomes.push({
      kind: plan.kind,
      storyIds: [...new Set(rows.rows.map((row) => row.story_id))],
      overflow: rows.rows.length >= probeLimit,
    });
  }
  return outcomes;
}

/** One statement's insertion target inside the fenced commit batch. */
export interface EditorialCommitInput {
  /** Ownership fence: the durable job id. */
  readonly jobId: string;
  /** Ownership fence: the claimed generation (jobs.attempts). */
  readonly generation: number;
  /** Ownership fence: the "now" the lease freshness is judged against. */
  readonly fenceNowMs: number;
  /**
   * Snapshot identity the handler READ and verified (R1.11.1): applied as
   * an SQL predicate on EVERY statement of the batch so a source item that
   * changed between the read and the commit produces ZERO editorial
   * effects and ZERO processed flips.
   */
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly sourceId: string;
    readonly contentHash: string;
  };
  readonly story: {
    readonly id: string;
    readonly storyKey: string;
    readonly workingHeadline: string | null;
    readonly createdAt: number;
  };
  readonly claim: {
    readonly id: string;
    readonly storyId: string;
    readonly claimType: string;
    readonly subject: string;
    readonly predicate: string;
    readonly objectText: string;
    readonly confidence: number;
    readonly status: string;
    readonly createdAt: number;
  };
  readonly evidence: {
    readonly id: string;
    readonly claimId: string;
    readonly sourceItemId: string;
    readonly stance: string;
    readonly confidence: number;
    readonly excerpt: string;
    readonly createdAt: number;
  };
  readonly aiRun: {
    readonly id: string;
    readonly task: string;
    readonly provider: string;
    readonly model: string;
    readonly promptVersion: string;
    readonly inputHash: string;
    readonly status: string;
    readonly latencyMs: number | null;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
    readonly createdAt: number;
    readonly completedAt: number | null;
  };
  readonly draft: {
    readonly id: string;
    readonly storyId: string;
    readonly status: string;
    readonly language: string;
    readonly layout: string;
    readonly title: string;
    readonly documentJson: string;
    readonly factsJson: string;
    readonly warningsJson: string;
    readonly aiRunId: string;
    readonly version: number;
    readonly createdBy: string;
    readonly createdAt: number;
  };
  /**
   * R1.13: the NEW story's durable fingerprints (≤3, one per present
   * signal) — inserted by the SAME atomic batch, each statement carrying
   * the SAME fence AND snapshot predicates, so a lost fence or a changed
   * snapshot writes NO draft AND NO fingerprint, and a stale generation
   * can never leave an orphan row behind. Values are story-scoped
   * (`sc1:<digest>:<storyId>`), so an insert can never replace another
   * owner; the NOT EXISTS guard covers only the story's OWN row (idempotent
   * replay). INSERT OR REPLACE / silent collision overrides are forbidden.
   */
  readonly fingerprints: readonly {
    readonly kind: StoryFingerprintKind;
    readonly value: string;
  }[];
}

/** Per-statement outcome of the fenced atomic commit. */
export interface EditorialCommitResult {
  /** The draft row was inserted by THIS generation (ownership proven). */
  readonly draftInserted: boolean;
  /** The story row was inserted by THIS batch (false = reused existing). */
  readonly storyInserted: boolean;
  /** The source_item processing_status moved to 'processed' by this batch. */
  readonly sourceItemProcessed: boolean;
  /** R1.13: fingerprint rows inserted by THIS batch (0..3; 0 on any
   * predicate failure — never orphaned, never half-written). */
  readonly fingerprintsInserted: number;
  /** Zero fenced effects: the caller lost ownership (stale generation). */
  readonly fenceLost: boolean;
  /**
   * Zero effects because the SOURCE SNAPSHOT changed between the
   * handler's read and this batch (R1.11.1) — the job fence still holds.
   * DISTINCT from `fenceLost` on purpose: the caller maps it to a
   * terminal, snapshot-specific outcome, never to a blind retry.
   */
  readonly snapshotChanged: boolean;
}

const FENCE_PREDICATE = `EXISTS (SELECT 1 FROM jobs
                        WHERE id = ? AND status = 'claimed' AND attempts = ?
                          AND lease_until IS NOT NULL AND lease_until > ?)`;

const SNAPSHOT_PREDICATE = `EXISTS (SELECT 1 FROM source_items
                              WHERE id = ? AND source_id = ? AND content_hash = ?)`;

/**
 * Fenced standalone ai_runs insert for NON-success paths (deferred /
 * refusal): records the REAL provider/model/prompt/status of an attempt
 * that actually happened, without faking a success and without touching
 * any editorial row. A never-attempted run (zero provider involvement)
 * is never written by any caller — a provider that did not run is never
 * fabricated.
 */
export async function recordEditorialAiRun(
  executor: DbExecutor,
  input: {
    readonly jobId: string;
    readonly generation: number;
    readonly fenceNowMs: number;
    readonly aiRun: EditorialCommitInput['aiRun'];
  },
): Promise<boolean> {
  const run = input.aiRun;
  const fenceParams = [input.jobId, input.generation, input.fenceNowMs];
  const meta = await executor.run({
    sql: `INSERT INTO ai_runs (id, task, provider, model, prompt_version, input_hash, status,
                                latency_ms, input_tokens, output_tokens, error_code,
                                error_message, created_at, completed_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM ai_runs WHERE id = ?)
             AND ${FENCE_PREDICATE}`,
    params: [
      run.id,
      run.task,
      run.provider,
      run.model,
      run.promptVersion,
      run.inputHash,
      run.status,
      run.latencyMs,
      run.inputTokens,
      run.outputTokens,
      run.errorCode,
      run.errorMessage,
      run.createdAt,
      run.completedAt,
      run.id,
      ...fenceParams,
    ],
  });
  return meta.changes > 0;
}

/**
 * THE atomic editorial commit (ADR-0042 §4): story + source_report claim +
 * mentions evidence + ai_runs row + ready draft + source_item→processed,
 * all in ONE atomic D1 batch, every statement fenced on job ownership AND
 * on the read source snapshot (R1.11.1). A failure anywhere rolls the
 * WHOLE batch back (no partial editorial state, no fake success, no fake
 * processed). When the draft lands with zero effects, ONE classification
 * read decides WHICH predicate failed (fence vs snapshot) — the guards
 * themselves never leave SQL.
 */
export async function commitEditorialResult(
  executor: DbExecutor,
  input: EditorialCommitInput,
): Promise<EditorialCommitResult> {
  const fenceParams = [input.jobId, input.generation, input.fenceNowMs];
  const snapshotParams = [
    input.snapshot.sourceItemId,
    input.snapshot.sourceId,
    input.snapshot.contentHash,
  ];

  const metas = await executor.batch([
    {
      sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type,
                                  priority, confidence, working_headline,
                                  first_seen_at, last_evidence_at, version, created_at, updated_at)
            SELECT ?, ?, 'discovered', 'unknown', 'industry', 50, 0, ?, ?, ?, 1, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM stories WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}`,
      params: [
        input.story.id,
        input.story.storyKey,
        input.story.workingHeadline,
        input.story.createdAt,
        input.story.createdAt,
        input.story.createdAt,
        input.story.createdAt,
        input.story.id,
        ...fenceParams,
        ...snapshotParams,
      ],
    },
    {
      sql: `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text,
                                 confidence, status, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM claims WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}`,
      params: [
        input.claim.id,
        input.claim.storyId,
        input.claim.claimType,
        input.claim.subject,
        input.claim.predicate,
        input.claim.objectText,
        input.claim.confidence,
        input.claim.status,
        input.claim.createdAt,
        input.claim.createdAt,
        input.claim.id,
        ...fenceParams,
        ...snapshotParams,
      ],
    },
    {
      sql: `INSERT INTO evidence (id, claim_id, source_item_id, stance, confidence, excerpt, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM evidence WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}`,
      params: [
        input.evidence.id,
        input.evidence.claimId,
        input.evidence.sourceItemId,
        input.evidence.stance,
        input.evidence.confidence,
        input.evidence.excerpt,
        input.evidence.createdAt,
        input.evidence.id,
        ...fenceParams,
        ...snapshotParams,
      ],
    },
    {
      sql: `INSERT INTO ai_runs (id, task, provider, model, prompt_version, input_hash, status,
                                  latency_ms, input_tokens, output_tokens, error_code,
                                  error_message, created_at, completed_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM ai_runs WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}`,
      params: [
        input.aiRun.id,
        input.aiRun.task,
        input.aiRun.provider,
        input.aiRun.model,
        input.aiRun.promptVersion,
        input.aiRun.inputHash,
        input.aiRun.status,
        input.aiRun.latencyMs,
        input.aiRun.inputTokens,
        input.aiRun.outputTokens,
        input.aiRun.errorCode,
        input.aiRun.errorMessage,
        input.aiRun.createdAt,
        input.aiRun.completedAt,
        input.aiRun.id,
        ...fenceParams,
        ...snapshotParams,
      ],
    },
    {
      sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
                                 facts_json, warnings_json, ai_run_id, version, created_by,
                                 created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM drafts WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}`,
      params: [
        input.draft.id,
        input.draft.storyId,
        input.draft.status,
        input.draft.language,
        input.draft.layout,
        input.draft.title,
        input.draft.documentJson,
        input.draft.factsJson,
        input.draft.warningsJson,
        input.draft.aiRunId,
        input.draft.version,
        input.draft.createdBy,
        input.draft.createdAt,
        input.draft.createdAt,
        input.draft.id,
        ...fenceParams,
        ...snapshotParams,
      ],
    },
    {
      // The processed flip is guarded DIRECTLY on the same row: the exact
      // snapshot identity (source_id + content_hash) must still hold.
      sql: `UPDATE source_items
              SET processing_status = 'processed'
            WHERE id = ?
              AND source_id = ?
              AND content_hash = ?
              AND processing_status IN ('new', 'queued')
              AND ${FENCE_PREDICATE}`,
      params: [input.snapshot.sourceItemId, ...snapshotParams.slice(1), ...fenceParams],
    },
    // R1.13: the NEW story's fingerprints — same batch, same fences, same
    // snapshot predicate. A fingerprint row can never outlive the draft it
    // belongs to: any predicate failure no-ops the WHOLE batch.
    ...input.fingerprints.map((fingerprint) => ({
      sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
            SELECT ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM story_fingerprints
                                WHERE kind = ? AND value = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}`,
      params: [
        input.draft.storyId,
        fingerprint.kind,
        fingerprint.value,
        input.draft.createdAt,
        fingerprint.kind,
        fingerprint.value,
        ...fenceParams,
        ...snapshotParams,
      ],
    })),
  ]);

  const storyInserted = (metas[0]?.changes ?? 0) > 0;
  const draftInserted = (metas[4]?.changes ?? 0) > 0;
  const sourceItemProcessed = (metas[5]?.changes ?? 0) > 0;
  const fingerprintsInserted = metas
    .slice(6)
    .reduce((total, meta) => total + (meta?.changes ?? 0), 0);
  if (draftInserted) {
    return {
      draftInserted,
      storyInserted,
      sourceItemProcessed,
      fingerprintsInserted,
      fenceLost: false,
      snapshotChanged: false,
    };
  }

  // Zero draft effects: ONE classification read decides which predicate
  // failed (write protection already happened entirely inside SQL — this
  // read only picks the typed outcome for the zero-effect batch).
  const classification = await executor.first<{ fence_holds: number; snapshot_holds: number }>({
    sql: `SELECT EXISTS (SELECT 1 FROM jobs
                          WHERE id = ? AND status = 'claimed' AND attempts = ?
                            AND lease_until IS NOT NULL AND lease_until > ?) AS fence_holds,
                 EXISTS (SELECT 1 FROM source_items
                          WHERE id = ? AND source_id = ? AND content_hash = ?) AS snapshot_holds`,
    params: [...fenceParams, ...snapshotParams],
  });
  const fenceHolds = (classification?.fence_holds ?? 0) === 1;
  const snapshotHolds = (classification?.snapshot_holds ?? 0) === 1;
  if (fenceHolds && !snapshotHolds) {
    // The job fence held but the source snapshot is gone: the R1.11.1
    // commit-time change — zero editorial effects, distinct typed outcome.
    return {
      draftInserted,
      storyInserted,
      sourceItemProcessed,
      fingerprintsInserted: 0,
      fenceLost: false,
      snapshotChanged: true,
    };
  }
  // Stale generation (fence lost), or the impossible both-hold case (a
  // pre-existing non-ready draft with this deterministic id — no such
  // path exists; conservatively reported as a lost fence, bounded by the
  // engine's own attempt budget).
  return {
    draftInserted,
    storyInserted,
    sourceItemProcessed,
    fingerprintsInserted: 0,
    fenceLost: true,
    snapshotChanged: false,
  };
}
