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
import type { EntityMentionLookupRow } from '../../domain/editorial/entity-mentions';
import {
  ENTITY_MENTION_MAX_RESULT_ROWS,
  STORY_ENTITY_MENTION_CONFIDENCE,
  STORY_ENTITY_RELATION_MENTIONED,
} from '../../domain/editorial/entity-mentions';
import { isAppError } from '../../shared/errors/app-error';
import { awaitWithDeadline, type DeadlineTimeoutScheduler } from '../../shared/time/deadline-wait';

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
  /** R1.15.1: the draft's OWN immutable document record — the reuse
   * verification basis (`sourceReport` + `evidenceGuard.snapshot`) lives
   * here. Drafts are write-once (no update path exists), so the basis read
   * here is the snapshot content the draft was REALLY built from. */
  readonly document_json: string;
}

export async function findDraftForStory(
  executor: DbExecutor,
  storyId: string,
  version: number,
): Promise<EditorialDraftRow | null> {
  return executor.first<EditorialDraftRow>({
    sql: `SELECT id, story_id, status, version, document_json
            FROM drafts WHERE story_id = ? AND version = ?`,
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
 * The DIRECT exact-content anchor resolution (R1.15.1 — Posidon P3): ONE
 * parameterized PRIMARY-KEY point read on `story_fingerprints(kind,value)`
 * for the group-unique anchor value `sc1:<digest>` — INDEPENDENT of the ≤9-row
 * discovery probe page (no LIMIT growth, no unbounded scan, no wildcard).
 * Returns the owner story id, or `null` when NO story owns this exact
 * content yet. The anchor alone is a LOCATOR: the owner must still pass the
 * full reuse verification (usable ready draft + immutable basis) before any
 * reuse, and a BLOCKING anchor with an unusable owner never drives the paid
 * provider→conflict→retry cycle (the handler decides before any provider
 * work).
 */
export async function findStoryIdByExactContentAnchor(
  executor: DbExecutor,
  anchor: {
    readonly kind: StoryFingerprintKind;
    readonly value: string;
  },
): Promise<string | null> {
  const row = await executor.first<{ story_id: string }>({
    sql: `SELECT story_id FROM story_fingerprints WHERE kind = ? AND value = ?`,
    params: [anchor.kind, anchor.value],
  });
  return row?.story_id ?? null;
}

/**
 * The REFERENCE items of one candidate story (R1.15): the source items
 * attached to the story through its `source_report` claims' evidence —
 * the honest reference surface of a story's provenance. R1.15.1: the reuse
 * DECISION no longer compares these mutable rows (the draft's immutable
 * document basis is the decision, through the ONE original reference row);
 * this bounded read remains the store contract for inspecting a story's
 * attached references. Bounded, deterministic (ascending item id); all
 * joins are index/PK driven (claims by story, evidence by claim's UNIQUE
 * index, source_items by PK).
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

/**
 * The R1.16 CONTROLLED-ALIAS lookup (Phase 5D): ONE parameterized, indexed
 * IN-list query against `entity_aliases(normalized_alias)` — the ONLY
 * lookup this round performs (no full-table scan, no per-word unbounded
 * queries, no SQL interpolation; the IN-list size is the caller's bounded
 * phrase cap, ≤ the D1 per-query bound-parameter limit). The page is
 * `ORDER BY`-ed BEFORE the LIMIT so the probed page is the SAME first rows
 * regardless of scan direction or physical order (R1.13.1 lesson), and
 * the +1 row probe detects overflow HONESTLY. A DB error PROPAGATES to
 * the caller — a failed lookup is NEVER reported as a successful empty
 * one. Empty phrase list → ZERO SQL (the bounded no-op).
 */
export async function findEntityMentionMatches(
  executor: DbExecutor,
  phrases: readonly string[],
): Promise<{ readonly rows: readonly EntityMentionLookupRow[]; readonly overflow: boolean }> {
  if (phrases.length === 0) {
    return { rows: [], overflow: false };
  }
  const placeholders = phrases.map(() => '?').join(', ');
  const { rows } = await executor.query<EntityMentionLookupRow>({
    sql: `SELECT entity_id, normalized_alias FROM entity_aliases
           WHERE normalized_alias IN (${placeholders})
          ORDER BY normalized_alias ASC, entity_id ASC
           LIMIT ${ENTITY_MENTION_MAX_RESULT_ROWS}`,
    params: [...phrases],
  });
  return { rows, overflow: rows.length >= ENTITY_MENTION_MAX_RESULT_ROWS };
}

/**
 * The R1.17 SHARED-ENTITY candidate lookup (Phase 5E-1): ONE parameterized,
 * indexed query PER probed entity against
 * `idx_story_entities_entity(entity_id, story_id)` — no full scan, no
 * wildcard, no SQL interpolation, no unbounded N+1 (the caller bounds the
 * probe count at 3). Each page is `ORDER BY story_id ASC` BEFORE the LIMIT
 * so the probed page is the SAME first rows regardless of scan direction
 * or physical order (the R1.13.1 lesson), and a full page is the honest
 * overflow probe. A DB error PROPAGATES to the caller — a failed lookup is
 * NEVER reported as a successful empty one. An empty entity list → ZERO
 * SQL (the bounded no-op). R1.17.1 (D1): a NEW probe never STARTS after
 * the caller's absolute step deadline (the shortfall is detectable by the
 * outcome count — never hidden).
 */
export interface StoryEntityCandidateOutcome {
  readonly entityId: string;
  readonly storyIds: readonly string[];
  readonly overflow: boolean;
}

export async function findStoryCandidatesByEntities(
  executor: DbExecutor,
  entityIds: readonly string[],
  excludeStoryId: string,
  probeLimit: number,
  options?: {
    /** R1.17.1 (D1): the step's ABSOLUTE deadline — a NEW probe never
     * STARTS after expiry (already-completed probes stay; the caller
     * detects the shortfall by the outcome count). A pending D1 query is
     * NOT cancellable — expiry frees the CALLER only, never a claimed
     * real cancellation.
     * R1.17.2 (D2): the pending probe itself is BOUNDED by the same
     * absolute deadline through the accepted race primitive — a probe
     * that never settles can no longer suspend the step past expiry; the
     * late settlement is observed and absorbed (never a fabricated
     * outcome, never a resurrected probe). */
    readonly deadlineAtMs?: number;
    readonly nowMs?: () => number;
    readonly deadlineScheduler?: DeadlineTimeoutScheduler;
  },
): Promise<readonly StoryEntityCandidateOutcome[]> {
  const outcomes: StoryEntityCandidateOutcome[] = [];
  const nowMsFn = options?.nowMs ?? Date.now;
  for (const entityId of entityIds) {
    if (options?.deadlineAtMs !== undefined && nowMsFn() >= options.deadlineAtMs) {
      break; // the step's time budget is spent — no new probe starts
    }
    const probeStatement = {
      sql: `SELECT story_id FROM story_entities
             WHERE entity_id = ? AND story_id <> ?
             ORDER BY story_id ASC
             LIMIT ?`,
      params: [entityId, excludeStoryId, probeLimit],
    } as const;
    let rows: readonly { story_id: string }[];
    if (options?.deadlineAtMs === undefined) {
      rows = (await executor.query<{ story_id: string }>(probeStatement)).rows;
    } else {
      // R1.17.2 (D2): the bounded race — expiry frees the caller; the
      // still-pending probe's late settlement is absorbed by the
      // primitive (handlers stay attached for its whole lifetime).
      const probeWait = await awaitWithDeadline(
        executor.query<{ story_id: string }>(probeStatement),
        options.deadlineAtMs,
        nowMsFn(),
        { scheduleTimeout: options.deadlineScheduler },
      );
      if (probeWait.kind === 'timed_out') {
        break; // the honest shortfall — the caller detects it by the count
      }
      rows = probeWait.value.rows;
    }
    outcomes.push({
      entityId,
      storyIds: [...new Set(rows.map((row) => row.story_id))],
      overflow: rows.length >= probeLimit,
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
  /**
   * R1.16 (Phase 5D): the DETERMINISTIC unique controlled-alias mentions
   * resolved for THIS draft (policy `em1` — ambiguous aliases are NEVER
   * here). Each pair becomes ONE `story_entities` statement in the SAME
   * atomic batch, and the WHOLE RESULT is SQL-conditioned on the validity
   * of EVERY relied mapping (R1.16.1, C1): a mapping deleted, remapped,
   * or given a second owner between the lookup and the commit zeroes EVERY
   * statement (typed `catalogChanged` — zero effects, zero orphans, no
   * draft/report claiming links that did not persist), never an invalid
   * link and never a partial editorial state. The PK (story_id, entity_id,
   * relation) dedups multi-alias mentions of one entity; confidence is the
   * fixed conservative 0; INSERT OR REPLACE and link deletion are forbidden.
   */
  readonly entityMentions: readonly {
    readonly normalizedAlias: string;
    readonly entityId: string;
  }[];
  /**
   * R1.17 (Phase 5E-1): the REAL event-relation adjudication ai_runs rows
   * (task 'event_relation', ≤3 per step) — inserted by the SAME fenced
   * atomic batch as the draft so decision runs settle atomically with the
   * ledger that references them. Ids are deterministic per
   * (job, generation, pair, attempt) and never collide with the news_draft
   * run; `drafts.ai_run_id` stays the news_draft run. An empty list (the
   * disabled/no-candidate/flag-off paths) writes NOTHING — a provider that
   * never ran is never fabricated.
   */
  readonly eventRelationAiRuns?: readonly EditorialCommitInput['aiRun'][];
  /**
   * R1.17 (Phase 5E-1): the mutable candidate bases the event-relation
   * decision REALLY evaluated (≤2, one per evaluated pair's side B).
   * EVERY statement of the batch additionally carries the basis gate: each
   * candidate story must STILL own its ready draft at the pinned version
   * with the EXACT document bytes the pair was bundled from, AND the
   * bridged reference row must STILL carry the content hash that was read
   * — ALL evaluated INSIDE the atomic batch (a JS re-read is never a
   * substitute). One invalidated basis (mutation/deletion/version change
   * inside the lookup→commit window) zeroes EVERY statement — zero stale
   * decision, zero partial editorial effects — classified typed
   * `eventRelationBasisChanged`. An empty list is the trivial always-true
   * gate (`1 = 1`): every non-relation path stays unchanged.
   */
  readonly eventRelationBases?: readonly {
    readonly draftId: string;
    readonly storyId: string;
    readonly draftVersion: number;
    readonly documentJson: string;
    readonly referenceItemId: string;
    readonly referenceContentHash: string;
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
  /** R1.16: durable `story_entities` mention links inserted by THIS batch
   * (on a committed result this EQUALS the distinct entity count of the
   * resolved pairs — R1.16.1's whole-result catalog gate guarantees every
   * relied mapping was valid inside the batch, so the report counts and
   * the durable rows can never diverge). */
  readonly entityMentionsInserted: number;
  /**
   * R1.17: event-relation adjudication ai_runs rows inserted by THIS batch
   * (0..3; 0 on any predicate failure — never orphaned, never half-written;
   * a pair never attempted contributes zero fabricated runs).
   */
  readonly eventRelationRunsInserted: number;
  /**
   * R1.17: the WHOLE editorial result was withheld because at least ONE
   * candidate basis the relation decision evaluated was mutated, deleted,
   * or version-changed inside the lookup→commit window — the SQL basis
   * gate zeroed EVERY statement (zero stale decision, zero partial
   * editorial effects). DISTINCT from `catalogChanged`/`fenceLost`/
   * `snapshotChanged`/`contentTaken` on purpose: the caller records its
   * REAL provider runs honestly (charged, never refunded) and hands the
   * bounded engine retry — the next generation re-decides against the
   * CURRENT bases.
   */
  readonly eventRelationBasisChanged: boolean;
  /**
   * R1.16.1 (C1): the WHOLE editorial result was withheld — at least one
   * alias mapping the report relied on was deleted, remapped, or given a
   * second owner inside the lookup→commit window, so the SQL catalog gate
   * zeroed EVERY statement of the batch (zero effects, zero orphans, no
   * draft/report claiming links that did not persist). DISTINCT from
   * `fenceLost`/`snapshotChanged`/`contentTaken` on purpose: the caller
   * re-resolves against the CURRENT catalog (one fresh SQL lookup, NO new
   * provider call) and only then retries — never a blind re-run, never a
   * fabricated outcome.
   */
  readonly catalogChanged: boolean;
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
 * Fence, snapshot and catalog-gate (R1.16.1) predicates still gate the
 * insert, so a stale generation, a changed snapshot or an invalidated
 * relied alias mapping can NEVER plant an anchor.
 */
function exactContentAnchorStatement(
  input: EditorialCommitInput,
  fenceParams: readonly unknown[],
  snapshotParams: readonly unknown[],
  gate: { readonly sql: string; readonly params: readonly unknown[] },
): { readonly sql: string; readonly params: readonly unknown[] } {
  const anchor = input.exactContentAnchor;
  return {
    sql: `INSERT INTO story_fingerprints (story_id, kind, value, created_at)
          SELECT ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM story_fingerprints
                              WHERE kind = ? AND value = ? AND story_id = ?)
             AND ${FENCE_PREDICATE}
             AND ${SNAPSHOT_PREDICATE}
             AND ${gate.sql}`,
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
      ...gate.params,
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
        entityMentionsInserted: 0,
        eventRelationRunsInserted: 0,
        eventRelationBasisChanged: false,
        catalogChanged: false,
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
 * The R1.16 alias-mapping validity predicate (per-mention statement): the
 * normalized alias the decision was made from must STILL map to EXACTLY
 * ONE entity AND that entity must still be THIS one — evaluated INSIDE the
 * atomic batch on the mention's own statement (a JS re-read is never a
 * substitute). R1.16.1 (C1): this per-pair predicate is now
 * DEFENSE-IN-DEPTH — the WHOLE result is additionally conditioned on the
 * same validity for EVERY relied mapping (the catalog gate below), so a
 * mapping invalidated inside the lookup→commit window can no longer leave
 * a committed draft whose report claims a link that did not persist.
 */
const ALIAS_UNIQOWN_PREDICATE = `1 = (SELECT COUNT(DISTINCT ea.entity_id)
                                      FROM entity_aliases ea
                                       WHERE ea.normalized_alias = ?)
   AND EXISTS (SELECT 1 FROM entity_aliases ea
                WHERE ea.normalized_alias = ? AND ea.entity_id = ?)`;

/**
 * R1.16.1 (C1): the WHOLE-RESULT catalog-mapping gate — appended to EVERY
 * statement of the commit batch. The editorial result may persist ONLY if
 * EVERY (alias, entity) pair the report claims as durable STILL holds at
 * commit time: the alias still maps to EXACTLY ONE entity AND that entity
 * is the claimed one. One invalidated mapping (deleted, remapped, or given
 * a second owner inside the lookup→commit window) zeroes EVERY statement —
 * ZERO effects, zero orphans, and no draft/report that claims links which
 * did not persist — classified typed `catalogChanged`.
 *
 * The claimed pairs travel as ONE bound JSON parameter read through
 * `json_each` (injection-safe, ≤ ENTITY_MENTION_MAX_PHRASES pairs, TWO
 * bound parameters per statement) — never per-pair SQL text interpolation
 * and never a per-pair parameter blowup against the D1 per-query bound
 * limit of 100. An EMPTY claimed list is the trivial always-true gate
 * (`1 = 1`): the no-mention path stays byte-identical to R1.16.
 */
function catalogMappingGate(input: EditorialCommitInput): {
  readonly sql: string;
  readonly params: readonly unknown[];
} {
  if (input.entityMentions.length === 0) {
    return { sql: '1 = 1', params: [] };
  }
  return {
    sql: `(SELECT COUNT(*) FROM json_each(?) claimed
            WHERE EXISTS (SELECT 1 FROM entity_aliases ea
                           WHERE ea.normalized_alias = json_extract(claimed.value, '$[0]')
                             AND ea.entity_id = json_extract(claimed.value, '$[1]'))
              AND 1 = (SELECT COUNT(DISTINCT ea2.entity_id) FROM entity_aliases ea2
                        WHERE ea2.normalized_alias = json_extract(claimed.value, '$[0]')))
         = ?`,
    params: [
      JSON.stringify(input.entityMentions.map((pair) => [pair.normalizedAlias, pair.entityId])),
      input.entityMentions.length,
    ],
  };
}

/**
 * R1.17 (Phase 5E-1): the candidate-BASIS validity gate — the R1.17 twin of
 * the catalog gate, appended to EVERY statement of the commit batch. For
 * EVERY candidate basis the event-relation decision really evaluated (≤2,
 * one per pair's side B): the candidate story must STILL own its ready
 * draft at the pinned version with the EXACT document bytes the pair was
 * bundled from (`rd.document_json = ?`), AND the bridged reference row
 * must STILL carry the content hash that was really read (`ri.id = ? AND
 * ri.content_hash = ?`) — ALL evaluated INSIDE the atomic batch (a JS
 * re-read is never a substitute). One invalidated basis (candidate
 * mutation/deletion/version change inside the lookup→commit window) zeroes
 * EVERY statement — zero stale decision, zero partial editorial effects —
 * classified typed `eventRelationBasisChanged`.
 *
 * Six bound parameters per basis (≤2 bases → ≤12 per statement) — injection
 * -safe, never interpolated, well under the D1 per-query bound limit of
 * 100. An EMPTY basis list is the trivial always-true gate (`1 = 1`): every
 * non-relation path stays byte-identical to R1.16.1.
 */
function eventRelationBasisGate(input: EditorialCommitInput): {
  readonly sql: string;
  readonly params: readonly unknown[];
} {
  const bases = input.eventRelationBases ?? [];
  if (bases.length === 0) {
    return { sql: '1 = 1', params: [] };
  }
  const perBasis = (basis: (typeof bases)[number]): { sql: string; params: unknown[] } => ({
    sql: `EXISTS (SELECT 1 FROM drafts rd
                    WHERE rd.id = ? AND rd.story_id = ?
                      AND rd.status = 'ready' AND rd.version = ?
                      AND rd.document_json = ?
                      AND EXISTS (SELECT 1 FROM claims rc
                                   JOIN evidence re ON re.claim_id = rc.id
                                   JOIN source_items ri ON ri.id = re.source_item_id
                                   WHERE rc.story_id = rd.story_id
                                     AND rc.claim_type = 'source_report'
                                     AND re.source_item_id = ?
                                     AND ri.content_hash = ?))`,
    params: [
      basis.draftId,
      basis.storyId,
      basis.draftVersion,
      basis.documentJson,
      basis.referenceItemId,
      basis.referenceContentHash,
    ],
  });
  const parts = bases.map((basis) => perBasis(basis));
  return {
    sql: parts.map((part) => part.sql).join(' AND '),
    params: parts.flatMap((part) => part.params),
  };
}

/**
 * The WHOLE-result gate every commit statement carries: the R1.16.1
 * catalog-mapping gate AND the R1.17 candidate-basis gate (each trivially
 * `1 = 1` when its list is empty — the legacy paths keep their exact
 * behavior with zero extra bound parameters).
 */
function combinedResultGate(input: EditorialCommitInput): {
  readonly sql: string;
  readonly params: readonly unknown[];
} {
  const catalog = catalogMappingGate(input);
  const basis = eventRelationBasisGate(input);
  return {
    sql: `${catalog.sql} AND ${basis.sql}`,
    params: [...catalog.params, ...basis.params],
  };
}

/** One fenced standalone event-relation ai_runs insert (R1.17): the REAL
 * adjudication attempt row, fenced on job ownership + the snapshot + the
 * whole-result gate — used INSIDE the commit batch for the commit path. */
function eventRelationRunStatement(
  input: EditorialCommitInput,
  run: EditorialCommitInput['aiRun'],
  fenceParams: readonly unknown[],
  snapshotParams: readonly unknown[],
  gate: { readonly sql: string; readonly params: readonly unknown[] },
): { readonly sql: string; readonly params: readonly unknown[] } {
  return {
    sql: `INSERT INTO ai_runs (id, task, provider, model, prompt_version, input_hash, status,
                                 latency_ms, input_tokens, output_tokens, error_code,
                                 error_message, created_at, completed_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM ai_runs WHERE id = ?)
             AND ${FENCE_PREDICATE}
             AND ${SNAPSHOT_PREDICATE}
             AND ${gate.sql}`,
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
      ...snapshotParams,
      ...gate.params,
    ],
  };
}

/** One fenced `story_entities` mention-link statement (R1.16; R1.16.1 —
 * carries the whole-result catalog gate as defense-in-depth). */
function entityMentionStatement(
  input: EditorialCommitInput,
  mention: { readonly normalizedAlias: string; readonly entityId: string },
  fenceParams: readonly unknown[],
  snapshotParams: readonly unknown[],
  gate: { readonly sql: string; readonly params: readonly unknown[] },
): { readonly sql: string; readonly params: readonly unknown[] } {
  return {
    sql: `INSERT INTO story_entities (story_id, entity_id, relation, confidence)
          SELECT ?, ?, '${STORY_ENTITY_RELATION_MENTIONED}', ${STORY_ENTITY_MENTION_CONFIDENCE}
           WHERE NOT EXISTS (SELECT 1 FROM story_entities
                              WHERE story_id = ? AND entity_id = ?
                                AND relation = '${STORY_ENTITY_RELATION_MENTIONED}')
             AND ${ALIAS_UNIQOWN_PREDICATE}
             AND ${FENCE_PREDICATE}
             AND ${SNAPSHOT_PREDICATE}
             AND ${gate.sql}`,
    params: [
      input.story.id,
      mention.entityId,
      input.story.id,
      mention.entityId,
      mention.normalizedAlias,
      mention.normalizedAlias,
      mention.entityId,
      ...fenceParams,
      ...snapshotParams,
      ...gate.params,
    ],
  };
}

/**
 * The atomic statement list: the six base statements + the ≤3 story-scoped
 * fingerprints (R1.13) + the ≤resolved controlled-alias mention links
 * (R1.16) + the ≤3 event-relation adjudication ai_runs rows (R1.17) + the
 * exact-content anchor (R1.15, LAST). Every statement also carries the
 * R1.16.1 whole-result catalog gate AND the R1.17 candidate-basis gate:
 * the batch persists only if every relied (alias, entity) mapping AND
 * every evaluated candidate basis is still valid inside the transaction.
 * Any statement failure rolls back the whole transaction; the anchor's
 * PRIMARY KEY collision is the R1.15 group-uniqueness signal.
 */
async function buildAndRunCommitBatch(
  executor: DbExecutor,
  input: EditorialCommitInput,
  fenceParams: readonly unknown[],
  snapshotParams: readonly unknown[],
): Promise<readonly DbQueryMeta[]> {
  // R1.16.1 (C1) + R1.17: ONE combined whole-result gate shared by EVERY
  // statement — the catalog-mapping gate and the candidate-basis gate
  // (each trivial `1 = 1` with zero extra params when its list is empty:
  // byte-identical legacy behavior).
  const gate = combinedResultGate(input);
  return executor.batch([
    {
      sql: `INSERT INTO stories (id, story_key, status, trust_status, content_type,
                                  priority, confidence, working_headline,
                                  first_seen_at, last_evidence_at, version, created_at, updated_at)
            SELECT ?, ?, 'discovered', 'unknown', 'industry', 50, 0, ?, ?, ?, 1, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM stories WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}
               AND ${gate.sql}`,
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
        ...gate.params,
      ],
    },
    {
      sql: `INSERT INTO claims (id, story_id, claim_type, subject, predicate, object_text,
                                 confidence, status, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM claims WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}
               AND ${gate.sql}`,
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
        ...gate.params,
      ],
    },
    {
      sql: `INSERT INTO evidence (id, claim_id, source_item_id, stance, confidence, excerpt, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM evidence WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}
               AND ${gate.sql}`,
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
        ...gate.params,
      ],
    },
    {
      sql: `INSERT INTO ai_runs (id, task, provider, model, prompt_version, input_hash, status,
                                  latency_ms, input_tokens, output_tokens, error_code,
                                  error_message, created_at, completed_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM ai_runs WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}
               AND ${gate.sql}`,
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
        ...gate.params,
      ],
    },
    {
      sql: `INSERT INTO drafts (id, story_id, status, language, layout, title, document_json,
                                 facts_json, warnings_json, ai_run_id, version, created_by,
                                 created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE NOT EXISTS (SELECT 1 FROM drafts WHERE id = ?)
               AND ${FENCE_PREDICATE}
               AND ${SNAPSHOT_PREDICATE}
               AND ${gate.sql}`,
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
        ...gate.params,
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
              AND ${FENCE_PREDICATE}
              AND ${gate.sql}`,
      params: [
        input.snapshot.sourceItemId,
        ...snapshotParams.slice(1),
        ...fenceParams,
        ...gate.params,
      ],
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
               AND ${SNAPSHOT_PREDICATE}
               AND ${gate.sql}`,
      params: [
        input.draft.storyId,
        fingerprint.kind,
        fingerprint.value,
        input.draft.createdAt,
        fingerprint.kind,
        fingerprint.value,
        ...fenceParams,
        ...snapshotParams,
        ...gate.params,
      ],
    })),
    // R1.16: the controlled-alias mention links — same batch, same fences,
    // same snapshot predicate, PLUS the per-pair alias-mapping validity
    // predicate (R1.16.1 defense-in-depth: the whole result is ALSO gated
    // on the same validity for every relied mapping). A mention link can
    // never outlive the draft it belongs to: any predicate failure no-ops
    // the WHOLE batch.
    ...input.entityMentions.map((mention) =>
      entityMentionStatement(input, mention, fenceParams, snapshotParams, gate),
    ),
    // R1.17: the event-relation adjudication ai_runs rows — same batch,
    // same fences, same snapshot predicate, same whole-result gate. The
    // decision runs settle atomically WITH the ledger that references
    // them; a predicate failure leaves NO orphan run behind.
    ...(input.eventRelationAiRuns ?? []).map((run) =>
      eventRelationRunStatement(input, run, fenceParams, snapshotParams, gate),
    ),
    // R1.15: the exact-content group anchor — LAST, deliberately unguarded
    // across stories: a live cross-story owner trips the PRIMARY KEY and
    // aborts the whole transaction (typed contentTaken for the caller).
    exactContentAnchorStatement(input, fenceParams, snapshotParams, gate),
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
  const relationRuns = input.eventRelationAiRuns ?? [];
  // Indices 6..6+n are the story-scoped fingerprints; then the R1.16
  // mention links; then the R1.17 relation ai_runs rows; the LAST meta is
  // the exact-content anchor (not part of any inserted count).
  const fingerprintsInserted = metas
    .slice(6, 6 + input.fingerprints.length)
    .reduce((total, meta) => total + (meta?.changes ?? 0), 0);
  const mentionsStart = 6 + input.fingerprints.length;
  const entityMentionsInserted = metas
    .slice(mentionsStart, mentionsStart + input.entityMentions.length)
    .reduce((total, meta) => total + (meta?.changes ?? 0), 0);
  const relationRunsStart = mentionsStart + input.entityMentions.length;
  const eventRelationRunsInserted = metas
    .slice(relationRunsStart, relationRunsStart + relationRuns.length)
    .reduce((total, meta) => total + (meta?.changes ?? 0), 0);
  if (draftInserted) {
    return {
      draftInserted,
      storyInserted,
      sourceItemProcessed,
      fingerprintsInserted,
      entityMentionsInserted,
      eventRelationRunsInserted,
      eventRelationBasisChanged: false,
      catalogChanged: false,
      contentTaken: false,
      fenceLost: false,
      snapshotChanged: false,
    };
  }

  // Zero draft effects: ONE classification read decides which predicate
  // failed (write protection already happened entirely inside SQL — this
  // read only picks the typed outcome for the zero-effect batch).
  // R1.16.1 (C1): the SAME read evaluates the catalog-mapping gate
  // (mappings_hold); R1.17 adds the candidate-basis gate (bases_hold) so
  // an invalidated evaluated basis gets its OWN typed outcome instead of
  // hiding inside the fence/snapshot/catalog classes.
  const basisGate = eventRelationBasisGate(input);
  const catalogGate = catalogMappingGate(input);
  const classification = await executor.first<{
    fence_holds: number;
    snapshot_holds: number;
    mappings_hold: number;
    bases_hold: number;
  }>({
    sql: `SELECT EXISTS (SELECT 1 FROM jobs
                          WHERE id = ? AND status = 'claimed' AND attempts = ?
                            AND lease_until IS NOT NULL AND lease_until > ?) AS fence_holds,
                 EXISTS (SELECT 1 FROM source_items
                          WHERE id = ? AND source_id = ? AND content_hash = ?) AS snapshot_holds,
                 ${input.entityMentions.length === 0 ? '1' : `(${catalogGate.sql})`} AS mappings_hold,
                 ${(input.eventRelationBases ?? []).length === 0 ? '1' : `(${basisGate.sql})`} AS bases_hold`,
    params: [...fenceParams, ...snapshotParams, ...catalogGate.params, ...basisGate.params],
  });
  const fenceHolds = (classification?.fence_holds ?? 0) === 1;
  const snapshotHolds = (classification?.snapshot_holds ?? 0) === 1;
  const mappingsHold = (classification?.mappings_hold ?? 0) === 1;
  const basesHold = (classification?.bases_hold ?? 0) === 1;
  if (fenceHolds && snapshotHolds && !mappingsHold) {
    // The fence and the snapshot are intact but at least ONE relied alias
    // mapping was deleted, remapped, or given a second owner inside the
    // lookup→commit window: the catalog gate zeroed EVERY statement —
    // zero effects, zero orphans, no draft/report claiming links that did
    // not persist. DISTINCT typed outcome (R1.16.1, C1): the caller
    // re-resolves against the CURRENT catalog (one fresh SQL lookup, NO
    // new provider call) and only then retries.
    return {
      draftInserted,
      storyInserted,
      sourceItemProcessed,
      fingerprintsInserted: 0,
      entityMentionsInserted: 0,
      eventRelationRunsInserted: 0,
      eventRelationBasisChanged: false,
      catalogChanged: true,
      contentTaken: false,
      fenceLost: false,
      snapshotChanged: false,
    };
  }
  if (fenceHolds && snapshotHolds && mappingsHold && !basesHold) {
    // The fence, snapshot, and catalog mappings are intact but at least
    // ONE candidate basis the relation decision evaluated was mutated,
    // deleted, or version-changed inside the lookup→commit window: the
    // basis gate zeroed EVERY statement — zero stale decision, zero
    // partial editorial effects. DISTINCT typed outcome (R1.17): the
    // caller records its REAL provider runs honestly (charged, never
    // refunded) and hands the bounded engine retry — the next generation
    // re-decides against the CURRENT bases.
    return {
      draftInserted,
      storyInserted,
      sourceItemProcessed,
      fingerprintsInserted: 0,
      entityMentionsInserted: 0,
      eventRelationRunsInserted: 0,
      eventRelationBasisChanged: true,
      catalogChanged: false,
      contentTaken: false,
      fenceLost: false,
      snapshotChanged: false,
    };
  }
  if (fenceHolds && !snapshotHolds) {
    // The job fence held but the source snapshot is gone: the R1.11.1
    // commit-time change — zero editorial effects, distinct typed outcome.
    return {
      draftInserted,
      storyInserted,
      sourceItemProcessed,
      fingerprintsInserted: 0,
      entityMentionsInserted: 0,
      eventRelationRunsInserted: 0,
      eventRelationBasisChanged: false,
      catalogChanged: false,
      contentTaken: false,
      fenceLost: false,
      snapshotChanged: true,
    };
  }
  // Stale generation (fence lost), or the impossible all-hold case (a
  // pre-existing non-ready draft with this deterministic id — no such
  // path exists; conservatively reported as a lost fence, bounded by the
  // engine's own attempt budget).
  return {
    draftInserted,
    storyInserted,
    sourceItemProcessed,
    fingerprintsInserted: 0,
    entityMentionsInserted: 0,
    eventRelationRunsInserted: 0,
    eventRelationBasisChanged: false,
    catalogChanged: false,
    contentTaken: false,
    fenceLost: true,
    snapshotChanged: false,
  };
}

/** The reuse-target validity predicate (R1.15; R1.15.1 — Posidon P2): the
 * story the reuse attaches to must STILL exist and STILL own a usable ready
 * draft at the pipeline's draft version WHOSE EXACT DOCUMENT BYTES are the
 * basis the equality was verified against (`rd.document_json = ?`) AND
 * whose ORIGINAL reference row — located through the story's own
 * source_report provenance — still carries the content_hash identity that
 * was really compared (`ri.id = ? AND ri.content_hash = ?`). ALL evaluated
 * INSIDE the atomic batch on EVERY reuse artifact: a reference mutated
 * between the verification and the commit (or a draft document that changed
 * at all) makes the WHOLE batch write NOTHING with the distinct typed
 * `targetInvalid` outcome — the compared basis is carried into SQL, never
 * re-read in JavaScript. */
const REUSE_TARGET_PREDICATE = `EXISTS (SELECT 1 FROM stories rs
                                  WHERE rs.id = ?
                                    AND EXISTS (SELECT 1 FROM drafts rd
                                                 WHERE rd.story_id = rs.id
                                                   AND rd.status = 'ready'
                                                   AND rd.version = ?
                                                   AND rd.document_json = ?
                                                   AND EXISTS (SELECT 1 FROM claims rc
                                                                JOIN evidence re
                                                                  ON re.claim_id = rc.id
                                                                JOIN source_items ri
                                                                  ON ri.id = re.source_item_id
                                                               WHERE rc.story_id = rs.id
                                                                 AND rc.claim_type = 'source_report'
                                                                 AND ri.id = ?
                                                                 AND ri.content_hash = ?)))`;

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
   * serve this item's exact content. R1.15.1: the comparison basis is
   * carried INTO the SQL predicate — the EXACT document bytes the equality
   * was verified against, and the ORIGINAL reference row identity (item id
   * + content_hash AS READ at verification time). A mutation of either
   * between the verification and this batch produces ZERO effects. */
  readonly target: {
    readonly storyId: string;
    readonly draftVersion: number;
    /** The verified draft's document_json — the immutable basis bytes. */
    readonly documentJson: string;
    /** The story's ORIGINAL reference item id (the snapshot the draft was
     * built from, per the draft's own document record). */
    readonly referenceItemId: string;
    /** The reference row's content_hash AS READ at verification. */
    readonly referenceContentHash: string;
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
  const targetParams = [
    input.target.storyId,
    input.target.draftVersion,
    input.target.documentJson,
    input.target.referenceItemId,
    input.target.referenceContentHash,
  ];

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
