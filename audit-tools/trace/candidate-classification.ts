/**
 * R1.10.3 CANDIDATE DESIGN — grouped, source-bound classification probes
 * (DESIGN-LAB code — NOT accepted product source, NOT implemented in the
 * product, NOT authorized for product use yet).
 *
 * This module is the R112-04-CORRECTED candidate for the classification
 * reads that the accepted per-item loop performs after the atomic commit
 * batch (`src/adapters/db/source-ingest-store.ts` lines ≈249–287 legacy /
 * ≈934–967 owned — identical shape). It preserves EVERY accepted property
 * the manager froze:
 *
 *  1. SOURCE IDENTITY (R112-04): every probe keeps the exact per-item
 *     (id, source_id) / (source_id, external_id) / (source_id,
 *     canonical_url) pairs. The grouped form binds the source predicate
 *     `source_id = ?` ONCE per chunk and chunks the identity values — a
 *     row belonging to a foreign source is NEVER returned by a probe, so
 *     the classification outcome for the CE2 shape equals the accepted
 *     probe (empty).
 *  2. BIND BUDGET: every statement carries ≤ 100 bound parameters
 *     INCLUDING the shared source bind (documented D1 limit "Maximum
 *     bound parameters per query: 100"). Chunk size is therefore ≤ 99
 *     identity values per statement.
 *  3. CLASSIFICATION ORDER AND QUIRKS: the assembly below is a pure
 *     in-memory join that reproduces the accepted loop's per-item outcome
 *     IN ATTEMPT ORDER, including the conservative quirk (own-miss +
 *     external-miss + non-null url matched nothing → counted as
 *     duplicateExternal) and the accepted unreachable branch (own-miss +
 *     external-miss + null url → counted nowhere = 'unclassified').
 *  4. NULL KEYS: the accepted probes bind NULL and therefore never match
 *     (`external_id = NULL` is never true). The grouped form EXCLUDES
 *     null keys from the IN lists — the same miss, stated explicitly.
 *
 * The probe statements are plain SELECTs on the accepted schema (3 AND 4):
 * NO new index, table, or metadata object is required.
 */

/** Documented D1 limit: "Maximum bound parameters per query | 100". */
export const MAX_BOUND_PARAMS = 100;

/** Identity values bound per chunk = MAX_BOUND_PARAMS - 1 shared source bind. */
export const CHUNK_SIZE = MAX_BOUND_PARAMS - 1;

export type ClassificationOutcome =
  | 'inserted'
  | 'duplicateExternal'
  | 'duplicateUrl'
  | 'unclassified';

export interface CandidateItem {
  readonly id: string;
  readonly sourceId: string;
  readonly externalId: string | null;
  readonly canonicalUrl: string | null;
}

export interface ClassifiedItem {
  readonly item: CandidateItem;
  readonly outcome: ClassificationOutcome;
}

/** Minimal read surface the candidate needs (the instrumented D1 binding). */
export type ExecutorLike = {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
    };
  };
};

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Group items per source (legacy batches may mix sources; the owned path
 * rejects mixed batches BEFORE any statement — grouping is a no-op there
 * but is performed anyway so ONE implementation serves both paths without
 * weakening either).
 */
function groupBySource(items: readonly CandidateItem[]): Map<string, CandidateItem[]> {
  const groups = new Map<string, CandidateItem[]>();
  for (const item of items) {
    const list = groups.get(item.sourceId);
    if (list === undefined) groups.set(item.sourceId, [item]);
    else list.push(item);
  }
  return groups;
}

/**
 * Candidate grouped classification — replaces the accepted per-item probe
 * loop with bounded grouped reads. Issued AFTER the atomic commit batch,
 * exactly like the accepted loop (same place, same fence semantics — the
 * batch itself is untouched).
 */
export async function classifyGrouped(
  executor: ExecutorLike,
  items: readonly CandidateItem[],
): Promise<ClassifiedItem[]> {
  // R112-04 (hardened): hit sets are PER SOURCE. A global value-keyed set
  // would leak a foreign source's probe hit onto a same-valued item of
  // another source — exactly the identity confusion R112-04 forbids.
  const ownHits = new Map<string, Set<string>>();
  const externalHits = new Map<string, Set<string>>();
  const urlHits = new Map<string, Set<string>>();

  for (const [sourceId, group] of groupBySource(items)) {
    const ownSet = new Set<string>();
    const externalSet = new Set<string>();
    const urlSet = new Set<string>();
    ownHits.set(sourceId, ownSet);
    externalHits.set(sourceId, externalSet);
    urlHits.set(sourceId, urlSet);

    // Probe A — own fresh id. Source predicate PRESERVED (R112-04).
    for (const ids of chunk(distinct(group.map((i) => i.id)), CHUNK_SIZE)) {
      const placeholders = ids.map(() => '?').join(', ');
      const res = await executor
        .prepare(
          `SELECT id FROM source_items WHERE source_id = ? AND id IN (${placeholders})`,
        )
        .bind(sourceId, ...ids)
        .all<{ id: string }>();
      for (const row of res.results) ownSet.add(row.id);
    }
    // Probe B — duplicate external (non-null keys only; null never matches).
    const bValues = distinct(
      group.filter((i) => i.externalId !== null).map((i) => i.externalId as string),
    );
    for (const values of chunk(bValues, CHUNK_SIZE)) {
      const placeholders = values.map(() => '?').join(', ');
      const res = await executor
        .prepare(
          `SELECT external_id FROM source_items WHERE source_id = ? AND external_id IN (${placeholders})`,
        )
        .bind(sourceId, ...values)
        .all<{ external_id: string | null }>();
      for (const row of res.results) if (row.external_id !== null) externalSet.add(row.external_id);
    }
    // Probe C — duplicate canonical url (non-null keys only).
    const cValues = distinct(
      group.filter((i) => i.canonicalUrl !== null).map((i) => i.canonicalUrl as string),
    );
    for (const values of chunk(cValues, CHUNK_SIZE)) {
      const placeholders = values.map(() => '?').join(', ');
      const res = await executor
        .prepare(
          `SELECT canonical_url FROM source_items WHERE source_id = ? AND canonical_url IN (${placeholders})`,
        )
        .bind(sourceId, ...values)
        .all<{ canonical_url: string | null }>();
      for (const row of res.results)
        if (row.canonical_url !== null) urlSet.add(row.canonical_url);
    }
  }

  // Assembly — accepted control flow IN ATTEMPT ORDER (quirks preserved):
  //   own-hit → inserted
  //   external-hit → duplicateExternal
  //   url-hit → duplicateUrl
  //   miss with non-null url → duplicateExternal (accepted conservative quirk)
  //   miss with null url → counted NOWHERE ('unclassified'; accepted branch)
  return items.map((item) => {
    const own = ownHits.get(item.sourceId) ?? new Set<string>();
    const external = externalHits.get(item.sourceId) ?? new Set<string>();
    const url = urlHits.get(item.sourceId) ?? new Set<string>();
    if (own.has(item.id)) return { item, outcome: 'inserted' as const };
    if (item.externalId !== null && external.has(item.externalId)) {
      return { item, outcome: 'duplicateExternal' as const };
    }
    if (item.canonicalUrl !== null && url.has(item.canonicalUrl)) {
      return { item, outcome: 'duplicateUrl' as const };
    }
    if (item.canonicalUrl !== null) return { item, outcome: 'duplicateExternal' as const };
    return { item, outcome: 'unclassified' as const };
  });
}

/**
 * The ACCEPTED per-item classification loop (provenance: verbatim control
 * flow of `src/adapters/db/source-ingest-store.ts` — legacy lines
 * ≈249–287; owned lines ≈934–967 are the identical shape). Used by the
 * parity tests as the reference implementation; NOT a candidate.
 */
export async function classifyAcceptedPerItem(
  executor: {
    prepare(sql: string): {
      bind(...values: unknown[]): {
        first<T>(): Promise<T | null>;
      };
    };
  },
  items: readonly CandidateItem[],
): Promise<ClassifiedItem[]> {
  const out: ClassifiedItem[] = [];
  for (const item of items) {
    const own = await executor
      .prepare('SELECT id FROM source_items WHERE id = ? AND source_id = ?')
      .bind(item.id, item.sourceId)
      .first<{ id: string }>();
    if (own !== null) {
      out.push({ item, outcome: 'inserted' });
      continue;
    }
    const byExternal = await executor
      .prepare('SELECT id FROM source_items WHERE source_id = ? AND external_id = ?')
      .bind(item.sourceId, item.externalId)
      .first<{ id: string }>();
    if (byExternal !== null) {
      out.push({ item, outcome: 'duplicateExternal' });
      continue;
    }
    const byUrl =
      item.canonicalUrl === null
        ? null
        : await executor
            .prepare('SELECT id FROM source_items WHERE source_id = ? AND canonical_url = ?')
            .bind(item.sourceId, item.canonicalUrl)
            .first<{ id: string }>();
    if (byUrl !== null) {
      out.push({ item, outcome: 'duplicateUrl' });
    } else if (item.canonicalUrl !== null) {
      out.push({ item, outcome: 'duplicateExternal' });
    } else {
      // Accepted branch: own-miss + external-miss + null url counts NOWHERE.
      out.push({ item, outcome: 'unclassified' });
    }
  }
  return out;
}
