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

import type { DbExecutor, DbQueryMeta } from './db-executor';
import type {
  FingerprintLookupPlan,
  StoryFingerprintKind,
} from '../../domain/editorial/story-fingerprints';
import { isAppError } from '../../shared/errors/app-error';

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
 * The DURABLE source_report attachment of one source item (R1.15): the
 * (claim, story) pair that proves the item's provenance relation to a
 * story result already exists — the replay fast-path of the exact-content
 * reuse. ONE indexed read (evidence by source_item_id → claims by PK);
 * the atomic commit guarantees a claim and its evidence (and the item's
 * processed flip) always landed TOGETHER, so claim existence is the
 * relation's existence proof.
 */
export interface EditorialSourceAttachmentRow {
  readonly claim_id: string;
  readonly story_id: string;
}

export async function findEditorialSourceAttachment(
  executor: DbExecutor,
  sourceItemId: string,
): Promise<EditorialSourceAttachmentRow | null> {
  return executor.first<EditorialSourceAttachmentRow>({
    sql: `SELECT c.id AS claim_id, c.story_id
            FROM evidence e
            JOIN claims c ON c.id = e.claim_id
           WHERE e.source_item_id = ? AND c.claim_type = 'source_report'
           ORDER BY c.created_at ASC, c.id ASC
           LIMIT 1`,
    params: [sourceItemId],
  });
}

/**
 * The REFERENCE items of one candidate story (R1.15): the source items
 * attached to the story through its `source_report` claims' evidence —
 * the ONLY honest basis for the byte-exact content verification that must
 * precede any reuse decision (a fingerprint is a locator, never the
 * decision). Bounded, deterministic (ascending item id); all joins are
 * index/PK driven (claims by story, evidence by claim's UNIQUE index,
 * source_items by PK).
 */
export async function findStoryReferenceItems(
  executor: DbExecutor,
  storyId: string,
  limit: number,
): Promise<readonly EditorialSourceItemRow[]> {
  const { rows } = await executor.query<EditorialSourceItemRow>({
    sql: `SELECT si.id, si.source_id, si.title, si.body_excerpt, si.canonical_url,
                 si.content_hash, si.processing_status
            FROM claims c
            JOIN evidence e ON e.claim_id = c.id
            JOIN source_items si ON si.id = e.source_item_id
           WHERE c.story_id = ? AND c.claim_type = 'source_report'
           ORDER BY si.id ASC
           LIMIT ?`,
    params: [storyId, limit],
  });
  return rows;
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
 *
 * R1.13.1 (bounded selection fix): `ORDER BY value ASC` before LIMIT. For
 * a fixed kind and digest the value is `sc1:<digest>:<storyId>`, so this
 * order IS the PK order of the probed range — SQLite satisfies it straight
 * from the index scan (no temporary sort, EXPLAIN-verified), and the probe
 * page becomes the SAME first-9 rows regardless of scan direction or
 * physical insertion order. Without it, a full probe page could return a
 * DIFFERENT set of owners for the SAME stored data (demonstrated on real
 * workerd D1 with PRAGMA reverse_unordered_selects), changing the final
 * candidates with zero writes. Row order without ORDER BY is never a
 * SQLite guarantee; relying on the builder's post-LIMIT sort cannot make
 * the PRE-LIMIT selection deterministic.
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
             ORDER BY value ASC
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
  /**
   * R1.15 (Phase 5C-3): the exact-content GROUP anchor — the group-unique
   * `sc1:<digest>` value (NO story suffix) derived from THIS item's OWN
   * full composed text. The `(kind,value)` PRIMARY KEY makes the anchor
   * unique across ALL stories: when another commit already owns this
   * exact content, the anchor's PRIMARY KEY COLLIDES and the WHOLE atomic
   * batch is rolled back (D1 batch = transaction) — the SQL-level
   * uniqueness of one stable result per exact content. The REAL path
   * ALWAYS provides the anchor; the own-row NOT EXISTS guard keeps the
   * commit re-runnable for the SAME story only.
   */
  readonly exactContentAnchor: {
    readonly kind: StoryFingerprintKind;
    readonly value: string;
  };
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
  /**
   * R1.15: the exact-content anchor PRIMARY KEY collided — ANOTHER story
   * already owns this exact full content, so the WHOLE batch (including
   * the anchor) rolled back with ZERO effects. DISTINCT from fence/snapshot
   * failures on purpose: the caller records its REAL provider run (it
   * happened and stays charged) and retries into the verified reuse path —
   * never an overwrite, never a second stable result.
   */
  readonly contentTaken: boolean;
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
 * The R1.15 exact-content anchor statement — appended LAST in the fenced
 * commit batch. Deliberately NO cross-story NOT EXISTS: when another story
 * already owns the `sc1:<digest>` anchor, the PRIMARY KEY collision is the
 * SIGNAL that aborts the whole atomic batch (typed `contentTaken`). The
 * own-row guard keeps the statement re-runnable for the SAME story only.
 * Fence and snapshot predicates still gate the insert, so a stale
 * generation or a changed snapshot can NEVER plant an anchor.
 */
function exactContentAnchorStatement(
  input: EditorialCommitInput,
  fenceParams: readonly unknown[],
  snapshotParams: readonly unknown[],
): { readonly sql: string; readonly params: readonly unknown[] } {
  const anchor = input.exactContentAnchor;
  return {
    sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
          SELECT ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM story_fingerprints
                              WHERE kind = ? AND value = ? AND story_id = ?)
             AND ${FENCE_PREDICATE}
             AND ${SNAPSHOT_PREDICATE}`,
    params: [
      input.story.id,
      anchor.kind,
      anchor.value,
      input.draft.createdAt,
      anchor.kind,
      anchor.value,
      input.story.id,
      ...fenceParams,
      ...snapshotParams,
    ],
  };
}

/**
 * Classification of a caught batch error into the R1.15 typed
 * `contentTaken` outcome: the ONLY constraint the unguarded anchor can
 * violate is its own `(kind, value)` PRIMARY KEY (every other statement
 * carries a NOT EXISTS/deterministic-id guard), so a constraint violation
 * whose raw driver message names `story_fingerprints` IS the anchor
 * collision. The raw message is inspected for CLASSIFICATION ONLY and is
 * never surfaced, logged, or serialized (d1-errors.ts contract).
 */
function isExactContentAnchorConflict(error: unknown): boolean {
  if (!isAppError(error) || error.code !== 'db_constraint_violation') {
    return false;
  }
  const cause = error.cause;
  return cause instanceof Error && cause.message.includes('story_fingerprints');
}

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

  let metas: readonly DbQueryMeta[];
  try {
    metas = await buildAndRunCommitBatch(executor, input, fenceParams, snapshotParams);
  } catch (error) {
    if (isExactContentAnchorConflict(error)) {
      // The exact-content anchor collided: ANOTHER story owns this exact
      // full content. The D1 batch is a transaction — the WHOLE batch
      // (story, claim, evidence, ai_run, draft, processed flip, story-
      // scoped fingerprints AND the anchor) rolled back with ZERO effects.
      // Typed, distinct outcome: never conflated with a lost fence or a
      // changed snapshot; the caller owns the honest retry into reuse.
      return {
        draftInserted: false,
        storyInserted: false,
        sourceItemProcessed: false,
        fingerprintsInserted: 0,
        contentTaken: true,
        fenceLost: false,
        snapshotChanged: false,
      };
    }
    throw error;
  }

  return classifyCommitMetas(metas, input, fenceParams, snapshotParams, executor);
}

/**
 * The atomic statement list: the six base statements + the ≤3 story-scoped
 * fingerprints (R1.13) + the exact-content anchor (R1.15, LAST). Any
 * statement failure rolls back the whole transaction; the anchor's PRIMARY
 * KEY collision is the R1.15 group-uniqueness signal.
 */
async function buildAndRunCommitBatch(
  executor: DbExecutor,
  input: EditorialCommitInput,
  fenceParams: readonly unknown[],
  snapshotParams: readonly unknown[],
): Promise<readonly DbQueryMeta[]> {
  return executor.batch([
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
    // R1.15: the exact-content group anchor — LAST, deliberately unguarded
    // across stories: a live cross-story owner trips the PRIMARY KEY and
    // aborts the whole transaction (typed contentTaken for the caller).
    exactContentAnchorStatement(input, fenceParams, snapshotParams),
  ]);
}

/**
 * Per-statement classification of a successful batch (or the one
 * classification read for a zero-effect batch — write protection itself
 * always happened entirely inside SQL).
 */
async function classifyCommitMetas(
  metas: readonly DbQueryMeta[],
  input: EditorialCommitInput,
  fenceParams: readonly unknown[],
  snapshotParams: readonly unknown[],
  executor: DbExecutor,
): Promise<EditorialCommitResult> {
  const storyInserted = (metas[0]?.changes ?? 0) > 0;
  const draftInserted = (metas[4]?.changes ?? 0) > 0;
  const sourceItemProcessed = (metas[5]?.changes ?? 0) > 0;
  // Indices 6..6+n are the story-scoped fingerprints; the LAST meta is the
  // exact-content anchor (not part of `fingerprintsInserted`).
  const fingerprintsInserted = metas
    .slice(6, 6 + input.fingerprints.length)
    .reduce((total, meta) => total + (meta?.changes ?? 0), 0);
  if (draftInserted) {
    return {
      draftInserted,
      storyInserted,
      sourceItemProcessed,
      fingerprintsInserted,
      contentTaken: false,
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
      contentTaken: false,
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
    contentTaken: false,
    fenceLost: true,
    snapshotChanged: false,
  };
}

/** The reuse-target validity predicate (R1.15): the story the reuse
 * attaches to must STILL exist and STILL own a usable ready draft at the
 * pipeline's draft version — evaluated INSIDE the atomic batch (a target
 * that died between the lookup and the commit produces ZERO effects with
 * a distinct typed outcome, never a partial attachment). */
const REUSE_TARGET_PREDICATE = `EXISTS (SELECT 1 FROM stories rs
                                  WHERE rs.id = ?
                                    AND EXISTS (SELECT 1 FROM drafts rd
                                                 WHERE rd.story_id = rs.id
                                                   AND rd.status = 'ready'
                                                   AND rd.version = ?))`;

/** Input of the R1.15 fenced REUSE commit. */
export interface EditorialReuseCommitInput {
  /** Ownership fence: the durable job id. */
  readonly jobId: string;
  /** Ownership fence: the claimed generation (jobs.attempts). */
  readonly generation: number;
  /** Ownership fence: the "now" the lease freshness is judged against. */
  readonly fenceNowMs: number;
  /** Snapshot identity of the REUSING item (read and verified by the
   * handler) — evaluated inside the batch on EVERY statement. */
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly sourceId: string;
    readonly contentHash: string;
  };
  /** The verified reuse target: the story whose usable ready draft will
   * serve this item's exact content. */
  readonly target: {
    readonly storyId: string;
    readonly draftVersion: number;
  };
  /** The reusing item's OWN source_report claim (its own provenance —
   * deterministic per (story, item); the old draft's claims are never
   * reattributed). */
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
  /** The reusing item's OWN mentions evidence. */
  readonly evidence: {
    readonly id: string;
    readonly claimId: string;
    readonly sourceItemId: string;
    readonly stance: string;
    readonly confidence: number;
    readonly excerpt: string;
    readonly createdAt: number;
  };
}

/** Typed outcome of the R1.15 fenced reuse commit. */
export interface EditorialReuseCommitResult {
  /** The claim AND evidence rows landed by THIS batch (the durable
   * provenance relation exists). */
  readonly attached: boolean;
  /** The reusing item's processing_status moved to 'processed' by this
   * batch (reported honestly; the relation never precedes it). */
  readonly sourceItemProcessed: boolean;
  /** The deterministic claim already existed — the relation was already
   * durably established (defensive replay branch; SQL-proven). */
  readonly alreadyAttached: boolean;
  /** Zero effects: the caller lost ownership (stale generation). */
  readonly fenceLost: boolean;
  /** Zero effects: the reusing item's snapshot changed mid-flight. */
  readonly snapshotChanged: boolean;
  /** Zero effects: the target story/usable draft no longer holds — the
   * caller retries; the next generation's lookup re-decides honestly. */
  readonly targetInvalid: boolean;
}

/**
 * THE R1.15 fenced REUSE commit: the reusing item's own source_report
 * claim + mentions evidence + its processed flip — ONE atomic batch, EVERY
 * statement carrying the job fence, the reusing item's snapshot predicate,
 * AND the reuse-target validity predicate (the target's usable ready draft
 * must still exist INSIDE the batch). NO draft, NO story, NO ai_runs row,
 * NO fingerprint is written here: the reused result belongs to the target
 * story and is never rewritten; a reuse makes NO provider call, so NO
 * ai_runs row is fabricated. A failure anywhere rolls the WHOLE batch back
 * (no orphan relation, no fake processed).
 */
export async function commitEditorialReuse(
  executor: DbExecutor,
  input: EditorialReuseCommitInput,
): Promise<EditorialReuseCommitResult> {
  const fenceParams = [input.jobId, input.generation, input.fenceNowMs];
  const snapshotParams = [
    input.snapshot.sourceItemId,
    input.snapshot.sourceId,
    input.snapshot.contentHash,
  ];
  const targetParams = [input.target.storyId, input.target.draftVersion];

  const metas = await executor.batch([
    {
      sql: `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text,
                                 confidence, status, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM claims WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}
               AND ${REUSE_TARGET_PREDICATE}`,
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
        ...targetParams,
      ],
    },
    {
      sql: `INSERT INTO evidence (id, claim_id, source_item_id, stance, confidence, excerpt, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM evidence WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}
               AND ${REUSE_TARGET_PREDICATE}`,
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
        ...targetParams,
      ],
    },
    {
      // The processed flip is guarded DIRECTLY on the reusing item's row
      // AND on the target's continued validity — the relation and the
      // processed status land (or not) TOGETHER.
      sql: `UPDATE source_items
              SET processing_status = 'processed'
            WHERE id = ?
              AND source_id = ?
              AND content_hash = ?
              AND processing_status IN ('new', 'queued')
              AND ${FENCE_PREDICATE}
              AND ${REUSE_TARGET_PREDICATE}`,
      params: [
        input.snapshot.sourceItemId,
        ...snapshotParams.slice(1),
        ...fenceParams,
        ...targetParams,
      ],
    },
  ]);

  const claimInserted = (metas[0]?.changes ?? 0) > 0;
  const evidenceInserted = (metas[1]?.changes ?? 0) > 0;
  const sourceItemProcessed = (metas[2]?.changes ?? 0) > 0;
  if (claimInserted && evidenceInserted) {
    return {
      attached: true,
      sourceItemProcessed,
      alreadyAttached: false,
      fenceLost: false,
      snapshotChanged: false,
      targetInvalid: false,
    };
  }

  // Zero (or partial) effects: ONE classification read decides WHICH
  // predicate produced the no-op — the guards themselves never left SQL.
  const classification = await executor.first<{
    fence_holds: number;
    snapshot_holds: number;
    target_holds: number;
    claim_exists: number;
  }>({
    sql: `SELECT EXISTS (SELECT 1 FROM jobs
                          WHERE id = ? AND status = 'claimed' AND attempts = ?
                            AND lease_until IS NOT NULL AND lease_until > ?) AS fence_holds,
                 EXISTS (SELECT 1 FROM source_items
                          WHERE id = ? AND source_id = ? AND content_hash = ?) AS snapshot_holds,
                 ${REUSE_TARGET_PREDICATE} AS target_holds,
                 EXISTS (SELECT 1 FROM claims WHERE id = ?) AS claim_exists`,
    params: [...fenceParams, ...snapshotParams, ...targetParams, input.claim.id],
  });
  const fenceHolds = (classification?.fence_holds ?? 0) === 1;
  const snapshotHolds = (classification?.snapshot_holds ?? 0) === 1;
  const targetHolds = (classification?.target_holds ?? 0) === 1;
  const claimExists = (classification?.claim_exists ?? 0) === 1;
  if (claimExists) {
    // The durable relation already exists (defensive replay branch; the
    // handler's pre-commit attachment check makes this unreachable in the
    // real flow). Honest success: the work IS durably done.
    return {
      attached: false,
      sourceItemProcessed,
      alreadyAttached: true,
      fenceLost: false,
      snapshotChanged: false,
      targetInvalid: false,
    };
  }
  if (!fenceHolds) {
    return {
      attached: false,
      sourceItemProcessed: false,
      alreadyAttached: false,
      fenceLost: true,
      snapshotChanged: false,
      targetInvalid: false,
    };
  }
  if (!snapshotHolds) {
    return {
      attached: false,
      sourceItemProcessed: false,
      alreadyAttached: false,
      fenceLost: false,
      snapshotChanged: true,
      targetInvalid: false,
    };
  }
  if (!targetHolds) {
    return {
      attached: false,
      sourceItemProcessed: false,
      alreadyAttached: false,
      fenceLost: false,
      snapshotChanged: false,
      targetInvalid: true,
    };
  }
  // Unreachable conservative default (a pre-existing evidence row without
  // its claim, etc.) — reported as a lost fence, bounded by the engine's
  // own attempt budget; no partial state can exist either way.
  return {
    attached: false,
    sourceItemProcessed: false,
    alreadyAttached: false,
    fenceLost: true,
    snapshotChanged: false,
    targetInvalid: false,
  };
}
