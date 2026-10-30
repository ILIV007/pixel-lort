/**
 * Controlled entity aliases → durable story mentions (Phase 5D — R1.16).
 * PURE, DETERMINISTIC, VERSIONED policy `em1` for resolving explicit
 * alias mentions in one snapshot's OWN full composed text against the
 * EXISTING controlled catalog (`entities` + `entity_aliases`, schema 3,
 * no migration). NO SQL, NO network, NO model call, NO clock — the same
 * offline purity as the mapper, the Evidence Guard and the candidate
 * discovery (ADR-0042 §2).
 *
 * WHAT THIS IS (and nothing more):
 * - ONE limited normalization (`normalizeEntityMentionText`): NFC +
 *   Unicode whitespace collapse + trim — the SAME function the Evidence
 *   Guard and the title fingerprint use. Deliberately NO case folding,
 *   NO Persian/Latin digit or ی/ک conversion: an alias matches EXACTLY
 *   the form(s) registered for it — registration is an explicit mapping,
 *   never a model guess, and every extra equivalence needs its own
 *   documented collision test (none is invented here).
 * - BOUNDED candidate phrases from the text itself: token runs are
 *   maximal spans of Unicode letters/numbers/marks (ZWNJ U+200C is
 *   word-INTERNAL — a conscious, tested نیم‌فاصله decision); phrases are
 *   byte-exact substrings between token boundaries, generated width-major
 *   (all 1-token phrases first), so `Half-Life` matches while `Doom`
 *   inside `Doomlike` or `Doom2` can NEVER be a candidate phrase (the
 *   boundary characters would be token chars).
 * - Deterministic resolution of ONE indexed lookup's rows: a
 *   `normalized_alias` mapping to EXACTLY ONE entity resolves that
 *   entity; a shared alias (≥2 distinct owners) is AMBIGUOUS — ZERO auto
 *   links, no invented confidence threshold, no first-row-wins, and the
 *   result NEVER depends on SQL row order (everything is sorted and
 *   grouped by value).
 *
 * WHAT THIS NEVER DOES:
 * - No fuzzy matching, no translation, no semantic merge, no event
 *   detection, no truth verification. A match means `mentioned` ONLY —
 *   relation `mentioned` with confidence 0, never a trust/status raise,
 *   never a claim verification.
 * - The news text NEVER adds an alias/canonical name to the catalog
 *   (`textAddsToCatalog: false`); an empty catalog or a zero-row lookup
 *   is `no_match_observed` — "no mention OBSERVED", never a proof of
 *   absence, and an empty catalog is the SAME honest outcome.
 * - No full-coverage claim: the caps below bound the scan window and the
 *   lookup page; truncation/overflow are recorded, never hidden, and a
 *   result-overflow embeds NOTHING as unique (zero links, zero ambiguous
 *   rows carried).
 *
 * HONEST BOUNDARY vs exact-content reuse (R1.15.2, preserved): mention
 * resolution runs ONLY on the NEW draft path, strictly AFTER the early
 * reuse decisions — replayed/reused snapshots never run lookups, and
 * historical/reused drafts are NEVER enriched or backfilled
 * (`reuse_drafts_not_enriched`).
 */

import { normalizeForDirectTextMatch } from './evidence-guard';

/** Report schema version — bump ONLY with a documented contract change. */
export const ENTITY_MENTIONS_VERSION = 1 as const;

/** The versioned mention policy label recorded in every report. */
export const ENTITY_MENTION_POLICY_VERSION = 'em1' as const;

/** Alias tokens above this count can never match (documented cap). */
export const ENTITY_MENTION_MAX_ALIAS_TOKENS = 4;

/** Tokens scanned before the phrase window stops (bounded CPU). */
export const ENTITY_MENTION_MAX_SCAN_TOKENS = 256;

/** Distinct candidate phrases per lookup — also the IN-list size bound
 * (90 ≤ the D1 per-query bound-parameter limit of 100). */
export const ENTITY_MENTION_MAX_PHRASES = 90;

/** Lookup result page: the cap plus ONE probe row to DETECT overflow. */
export const ENTITY_MENTION_MAX_RESULT_ROWS = 91;

/** The ONLY relation this round writes into `story_entities`. */
export const STORY_ENTITY_RELATION_MENTIONED = 'mentioned' as const;

/** The conservative mention confidence (never raised, per the boundary). */
export const STORY_ENTITY_MENTION_CONFIDENCE = 0 as const;

/** The ONE limited normalization (NFC + whitespace collapse + trim). */
export function normalizeEntityMentionText(text: string): string {
  return normalizeForDirectTextMatch(text);
}

/** Token characters: Unicode letters, numbers, marks, and ZWNJ. */
const TOKEN_CHAR = /[\p{L}\p{N}\p{M}\u200c]/u;

/** One token span inside the normalized text, as char offsets [start, end). */
interface TokenSpan {
  readonly start: number;
  readonly end: number;
}

/** The token spans of the normalized text (bounded by the scan cap). */
function tokenizeBounded(normalizedText: string): {
  readonly tokens: readonly TokenSpan[];
  readonly tokensTruncated: boolean;
} {
  const tokens: TokenSpan[] = [];
  let index = 0;
  while (index < normalizedText.length) {
    if (!TOKEN_CHAR.test(normalizedText[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < normalizedText.length && TOKEN_CHAR.test(normalizedText[index]!)) {
      index += 1;
    }
    tokens.push({ start, end: index });
  }
  if (tokens.length <= ENTITY_MENTION_MAX_SCAN_TOKENS) {
    return { tokens, tokensTruncated: false };
  }
  return {
    tokens: tokens.slice(0, ENTITY_MENTION_MAX_SCAN_TOKENS),
    tokensTruncated: true,
  };
}

/** The bounded phrase scan of one full evidence text (pure input). */
export interface EntityMentionPhraseScan {
  /** Normalized, deduplicated candidate phrases in deterministic
   * width-major/position order, ≤ `ENTITY_MENTION_MAX_PHRASES`. */
  readonly phrases: readonly string[];
  /** The normalized text the phrases came from (bookkeeping only). */
  readonly normalizedText: string;
  readonly scannedTokens: number;
  readonly tokensTruncated: boolean;
  readonly phrasesTruncated: boolean;
}

/**
 * Build the bounded candidate phrases for one item's full composed text:
 * normalize under the ONE policy rule, tokenize with the boundary rule,
 * then emit byte-exact substrings of 1..4 consecutive tokens, width-major
 * (every 1-token phrase first, then 2-token windows, …) — the order that
 * maximizes single-alias coverage inside the cap. Distinct-by-construction
 * windows deduplicate by value; the cap keeps the IN-list bounded, and
 * hitting it is recorded (`phrasesTruncated`), never hidden.
 */
export function buildEntityMentionPhrases(fullEvidenceText: string): EntityMentionPhraseScan {
  const normalizedText = normalizeEntityMentionText(fullEvidenceText);
  if (normalizedText.length === 0) {
    return {
      phrases: [],
      normalizedText,
      scannedTokens: 0,
      tokensTruncated: false,
      phrasesTruncated: false,
    };
  }
  const { tokens, tokensTruncated } = tokenizeBounded(normalizedText);
  const phrases: string[] = [];
  const seen = new Set<string>();
  let phrasesTruncated = false;
  for (let width = 1; width <= ENTITY_MENTION_MAX_ALIAS_TOKENS; width += 1) {
    for (let start = 0; start + width <= tokens.length; start += 1) {
      const from = tokens[start]!.start;
      const to = tokens[start + width - 1]!.end;
      const phrase = normalizedText.slice(from, to);
      if (seen.has(phrase)) {
        continue;
      }
      if (phrases.length >= ENTITY_MENTION_MAX_PHRASES) {
        phrasesTruncated = true;
        return {
          phrases,
          normalizedText,
          scannedTokens: tokens.length,
          tokensTruncated,
          phrasesTruncated,
        };
      }
      seen.add(phrase);
      phrases.push(phrase);
    }
  }
  return {
    phrases,
    normalizedText,
    scannedTokens: tokens.length,
    tokensTruncated,
    phrasesTruncated,
  };
}

/** One raw lookup row (the store returns exactly these two columns). */
export interface EntityMentionLookupRow {
  readonly normalized_alias: string;
  readonly entity_id: string;
}

/** The observations a report can honestly record (mutually exhaustive). */
export type EntityMentionsObservation =
  | 'no_phrases_observed'
  | 'no_match_observed'
  | 'mentions_observed'
  | 'ambiguous_only_observed'
  | 'lookup_overflow';

/** Fixed limitation labels (the honest scope statement of every report). */
export const ENTITY_MENTIONS_LIMITATIONS = [
  'controlled_aliases_only',
  'mention_not_verification',
  'confidence_zero',
  'no_fuzzy_no_translation',
  'bounded_scan_window',
  'lookup_moment_visibility',
  'reuse_drafts_not_enriched',
] as const;

/** The versioned, deterministic report stored with the draft. */
export interface EntityMentionsReport {
  readonly mentionsVersion: typeof ENTITY_MENTIONS_VERSION;
  readonly policyVersion: typeof ENTITY_MENTION_POLICY_VERSION;
  readonly observation: EntityMentionsObservation;
  /** The source snapshot identity the scanned text belongs to. */
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  /** The text basis: the item's OWN full composed title+body text. */
  readonly textBasis: 'full_evidence_text';
  readonly scan: {
    readonly phrasesConsidered: number;
    readonly scannedTokens: number;
    readonly tokensTruncated: boolean;
    readonly phrasesTruncated: boolean;
    readonly resultOverflow: boolean;
  };
  /** Unique resolved mentions — deterministic ascending
   * (normalizedAlias, entityId); one row per (alias, entity) pair. */
  readonly matched: readonly {
    readonly normalizedAlias: string;
    readonly entityId: string;
  }[];
  /** Ambiguous aliases (≥2 distinct owners) — ZERO links, ownerCount
   * recorded; ascending normalizedAlias, never in `matched`. */
  readonly ambiguous: readonly {
    readonly normalizedAlias: string;
    readonly ownerCount: number;
  }[];
  readonly counts: {
    readonly uniqueAliasesMatched: number;
    readonly ambiguousAliasesObserved: number;
    readonly entitiesLinked: number;
  };
  readonly caps: {
    readonly maxPhrases: typeof ENTITY_MENTION_MAX_PHRASES;
    readonly maxAliasTokens: typeof ENTITY_MENTION_MAX_ALIAS_TOKENS;
    readonly maxScanTokens: typeof ENTITY_MENTION_MAX_SCAN_TOKENS;
    readonly maxResultRows: typeof ENTITY_MENTION_MAX_RESULT_ROWS;
  };
  readonly coverage: {
    readonly catalogScope: 'entity_aliases_table_only';
    readonly textAddsToCatalog: false;
    readonly historicalBackfill: false;
  };
  readonly limitations: readonly string[];
}

/** The resolution outcome: the report + the DETERMINISTIC unique pairs
 * the fenced commit may attempt to link (the SQL predicate re-checks
 * every mapping INSIDE the batch — this list is never trusted alone). */
export interface EntityMentionResolution {
  readonly report: EntityMentionsReport;
  readonly resolved: readonly {
    readonly normalizedAlias: string;
    readonly entityId: string;
  }[];
}

export interface EntityMentionsBuildInput {
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  /** The bounded phrase scan of THIS snapshot's text. */
  readonly scan: EntityMentionPhraseScan;
  /** The raw lookup rows (ANY order — the resolution never depends on it). */
  readonly matches: readonly EntityMentionLookupRow[];
  /** True iff the lookup returned its FULL result page (≥ cap rows). */
  readonly resultOverflow: boolean;
}

function byAliasThenEntity(
  a: { readonly normalizedAlias: string; readonly entityId: string },
  b: { readonly normalizedAlias: string; readonly entityId: string },
): number {
  if (a.normalizedAlias !== b.normalizedAlias) {
    return a.normalizedAlias < b.normalizedAlias ? -1 : 1;
  }
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}

/**
 * Resolve the raw lookup rows under the `em1` policy. TOTAL and
 * DETERMINISTIC: same input → byte-identical report (fixed field order,
 * explicit sorts, no timestamps, no randomness). Result overflow embeds
 * NOTHING (zero links, zero ambiguous rows) — an overfull page is never
 * interpreted as a unique mapping.
 */
export function buildEntityMentionsReport(
  input: EntityMentionsBuildInput,
): EntityMentionResolution {
  const { snapshot, scan, matches, resultOverflow } = input;

  if (resultOverflow) {
    const report: EntityMentionsReport = {
      mentionsVersion: ENTITY_MENTIONS_VERSION,
      policyVersion: ENTITY_MENTION_POLICY_VERSION,
      observation: 'lookup_overflow',
      snapshot: { ...snapshot },
      textBasis: 'full_evidence_text',
      scan: {
        phrasesConsidered: scan.phrases.length,
        scannedTokens: scan.scannedTokens,
        tokensTruncated: scan.tokensTruncated,
        phrasesTruncated: scan.phrasesTruncated,
        resultOverflow: true,
      },
      matched: [],
      ambiguous: [],
      counts: { uniqueAliasesMatched: 0, ambiguousAliasesObserved: 0, entitiesLinked: 0 },
      caps: {
        maxPhrases: ENTITY_MENTION_MAX_PHRASES,
        maxAliasTokens: ENTITY_MENTION_MAX_ALIAS_TOKENS,
        maxScanTokens: ENTITY_MENTION_MAX_SCAN_TOKENS,
        maxResultRows: ENTITY_MENTION_MAX_RESULT_ROWS,
      },
      coverage: {
        catalogScope: 'entity_aliases_table_only',
        textAddsToCatalog: false,
        historicalBackfill: false,
      },
      limitations: ENTITY_MENTIONS_LIMITATIONS,
    };
    return { report, resolved: [] };
  }

  // ---- Group rows by normalized alias; count DISTINCT owners per alias.
  //      Row order never matters: grouping is by value.
  const ownersByAlias = new Map<string, Set<string>>();
  for (const match of matches) {
    let owners = ownersByAlias.get(match.normalized_alias);
    if (owners === undefined) {
      owners = new Set<string>();
      ownersByAlias.set(match.normalized_alias, owners);
    }
    owners.add(match.entity_id);
  }
  const matched: { normalizedAlias: string; entityId: string }[] = [];
  const ambiguous: { normalizedAlias: string; ownerCount: number }[] = [];
  for (const [alias, owners] of ownersByAlias) {
    if (owners.size === 1) {
      matched.push({ normalizedAlias: alias, entityId: [...owners][0]! });
    } else {
      ambiguous.push({ normalizedAlias: alias, ownerCount: owners.size });
    }
  }
  matched.sort(byAliasThenEntity);
  ambiguous.sort((a, b) => (a.normalizedAlias < b.normalizedAlias ? -1 : 1));

  const observation: EntityMentionsObservation =
    scan.phrases.length === 0
      ? 'no_phrases_observed'
      : matches.length === 0
        ? 'no_match_observed'
        : matched.length > 0
          ? 'mentions_observed'
          : 'ambiguous_only_observed';

  const report: EntityMentionsReport = {
    mentionsVersion: ENTITY_MENTIONS_VERSION,
    policyVersion: ENTITY_MENTION_POLICY_VERSION,
    observation,
    snapshot: { ...snapshot },
    textBasis: 'full_evidence_text',
    scan: {
      phrasesConsidered: scan.phrases.length,
      scannedTokens: scan.scannedTokens,
      tokensTruncated: scan.tokensTruncated,
      phrasesTruncated: scan.phrasesTruncated,
      resultOverflow: false,
    },
    matched,
    ambiguous,
    counts: {
      uniqueAliasesMatched: new Set(matched.map((entry) => entry.normalizedAlias)).size,
      ambiguousAliasesObserved: ambiguous.length,
      entitiesLinked: new Set(matched.map((entry) => entry.entityId)).size,
    },
    caps: {
      maxPhrases: ENTITY_MENTION_MAX_PHRASES,
      maxAliasTokens: ENTITY_MENTION_MAX_ALIAS_TOKENS,
      maxScanTokens: ENTITY_MENTION_MAX_SCAN_TOKENS,
      maxResultRows: ENTITY_MENTION_MAX_RESULT_ROWS,
    },
    coverage: {
      catalogScope: 'entity_aliases_table_only',
      textAddsToCatalog: false,
      historicalBackfill: false,
    },
    limitations: ENTITY_MENTIONS_LIMITATIONS,
  };
  return { report, resolved: matched };
}

/**
 * The honest "nothing observed" report for a snapshot — used by test/seed
 * shapers that must carry the PRODUCTION document shape for snapshots
 * that predate this round (never by the real path, which always scans).
 */
export function emptyEntityMentionsReport(snapshot: {
  readonly sourceItemId: string;
  readonly contentHash: string;
}): EntityMentionsReport {
  return buildEntityMentionsReport({
    snapshot,
    scan: buildEntityMentionPhrases(''),
    matches: [],
    resultOverflow: false,
  }).report;
}

// ---------------------------------------------------------------------------
// Versioned reader — payloads that merely claim the version are malformed.
// ---------------------------------------------------------------------------

export type EntityMentionsRead =
  | { readonly kind: 'entity_mentions_v1'; readonly report: EntityMentionsReport }
  /** A pre-5D draft (no mentions payload). Honest absence — never a pass. */
  | { readonly kind: 'absent' }
  /** A mentions-shaped payload with a different (e.g. future) version. */
  | { readonly kind: 'unsupported_version'; readonly mentionsVersion: unknown }
  /** Not a mentions payload at all — including one that violates v1. */
  | { readonly kind: 'malformed' };

const OBSERVATIONS: ReadonlySet<string> = new Set([
  'no_phrases_observed',
  'no_match_observed',
  'mentions_observed',
  'ambiguous_only_observed',
  'lookup_overflow',
]);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Read the mentions payload from a PARSED `drafts.document_json` value.
 * Consumers must treat `absent`/`unsupported_version`/`malformed` as "no
 * current mention result" — none of them validates anything. The check
 * validates the REAL v1 builder invariants (count/order/identity), so a
 * payload that merely CLAIMS the version never passes as current.
 */
export function readEntityMentionsReport(document: unknown): EntityMentionsRead {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { kind: 'malformed' };
  }
  const mentions = (document as Record<string, unknown>)['entityMentions'];
  if (mentions === undefined) {
    return { kind: 'absent' };
  }
  if (typeof mentions !== 'object' || mentions === null || Array.isArray(mentions)) {
    return { kind: 'malformed' };
  }
  const m = mentions as Record<string, unknown>;
  if (m['mentionsVersion'] !== ENTITY_MENTIONS_VERSION) {
    return { kind: 'unsupported_version', mentionsVersion: m['mentionsVersion'] };
  }
  if (
    m['policyVersion'] !== ENTITY_MENTION_POLICY_VERSION ||
    m['textBasis'] !== 'full_evidence_text' ||
    typeof m['observation'] !== 'string' ||
    !OBSERVATIONS.has(m['observation'])
  ) {
    return { kind: 'malformed' };
  }

  const snapshot = m['snapshot'];
  const scan = m['scan'];
  const counts = m['counts'];
  const caps = m['caps'];
  const coverage = m['coverage'];
  const limitations = m['limitations'];
  const matched = m['matched'];
  const ambiguous = m['ambiguous'];
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    typeof (snapshot as Record<string, unknown>)['sourceItemId'] !== 'string' ||
    ((snapshot as Record<string, unknown>)['sourceItemId'] as string).length === 0 ||
    typeof (snapshot as Record<string, unknown>)['contentHash'] !== 'string' ||
    ((snapshot as Record<string, unknown>)['contentHash'] as string).length === 0 ||
    typeof scan !== 'object' ||
    scan === null ||
    Array.isArray(scan) ||
    typeof counts !== 'object' ||
    counts === null ||
    Array.isArray(counts) ||
    typeof caps !== 'object' ||
    caps === null ||
    Array.isArray(caps) ||
    typeof coverage !== 'object' ||
    coverage === null ||
    Array.isArray(coverage) ||
    !Array.isArray(limitations) ||
    !Array.isArray(matched) ||
    !Array.isArray(ambiguous)
  ) {
    return { kind: 'malformed' };
  }

  // ---- Caps and coverage: the fixed, honest scope statement.
  if (
    (caps as Record<string, unknown>)['maxPhrases'] !== ENTITY_MENTION_MAX_PHRASES ||
    (caps as Record<string, unknown>)['maxAliasTokens'] !== ENTITY_MENTION_MAX_ALIAS_TOKENS ||
    (caps as Record<string, unknown>)['maxScanTokens'] !== ENTITY_MENTION_MAX_SCAN_TOKENS ||
    (caps as Record<string, unknown>)['maxResultRows'] !== ENTITY_MENTION_MAX_RESULT_ROWS ||
    (coverage as Record<string, unknown>)['catalogScope'] !== 'entity_aliases_table_only' ||
    (coverage as Record<string, unknown>)['textAddsToCatalog'] !== false ||
    (coverage as Record<string, unknown>)['historicalBackfill'] !== false
  ) {
    return { kind: 'malformed' };
  }

  // ---- Limitations: exactly the fixed v1 label set, each once.
  const fixed = ENTITY_MENTIONS_LIMITATIONS as readonly string[];
  if (
    limitations.length !== fixed.length ||
    new Set(limitations).size !== limitations.length ||
    !limitations.every((label) => typeof label === 'string' && fixed.includes(label))
  ) {
    return { kind: 'malformed' };
  }

  // ---- Scan block: non-negative integers inside the caps; the truncation
  //      and overflow flags must COHERE with the values they describe.
  const scanRecord = scan as Record<string, unknown>;
  const phrasesConsidered = scanRecord['phrasesConsidered'];
  const scannedTokens = scanRecord['scannedTokens'];
  const tokensTruncated = scanRecord['tokensTruncated'];
  const phrasesTruncated = scanRecord['phrasesTruncated'];
  const resultOverflow = scanRecord['resultOverflow'];
  if (
    !isNonNegativeInteger(phrasesConsidered) ||
    !isNonNegativeInteger(scannedTokens) ||
    typeof tokensTruncated !== 'boolean' ||
    typeof phrasesTruncated !== 'boolean' ||
    typeof resultOverflow !== 'boolean' ||
    phrasesConsidered > ENTITY_MENTION_MAX_PHRASES ||
    scannedTokens > ENTITY_MENTION_MAX_SCAN_TOKENS ||
    (phrasesTruncated && phrasesConsidered !== ENTITY_MENTION_MAX_PHRASES)
  ) {
    return { kind: 'malformed' };
  }

  // ---- Matched: deterministic strict ascent, no duplicate pairs, every
  //      alias distinct, bounded by the phrase cap.
  const matchedPairs: { normalizedAlias: string; entityId: string }[] = [];
  let previous: { alias: string; entity: string } | null = null;
  for (const entry of matched as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { kind: 'malformed' };
    }
    const alias = (entry as Record<string, unknown>)['normalizedAlias'];
    const entityId = (entry as Record<string, unknown>)['entityId'];
    if (
      typeof alias !== 'string' ||
      alias.length === 0 ||
      typeof entityId !== 'string' ||
      entityId.length === 0
    ) {
      return { kind: 'malformed' };
    }
    if (
      previous !== null &&
      !(previous.alias < alias || (previous.alias === alias && previous.entity < entityId))
    ) {
      return { kind: 'malformed' };
    }
    previous = { alias, entity: entityId };
    matchedPairs.push({ normalizedAlias: alias, entityId });
  }
  if (matchedPairs.length > phrasesConsidered) {
    return { kind: 'malformed' };
  }

  // ---- Ambiguous: ownerCount ≥ 2, strict ascent, disjoint from matched.
  const ambiguousAliases: { normalizedAlias: string; ownerCount: number }[] = [];
  let previousAlias: string | null = null;
  for (const entry of ambiguous as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { kind: 'malformed' };
    }
    const alias = (entry as Record<string, unknown>)['normalizedAlias'];
    const ownerCount = (entry as Record<string, unknown>)['ownerCount'];
    if (
      typeof alias !== 'string' ||
      alias.length === 0 ||
      !isNonNegativeInteger(ownerCount) ||
      ownerCount < 2
    ) {
      return { kind: 'malformed' };
    }
    if (previousAlias !== null && !(previousAlias < alias)) {
      return { kind: 'malformed' };
    }
    previousAlias = alias;
    ambiguousAliases.push({ normalizedAlias: alias, ownerCount });
  }

  // ---- Counts must EXACTLY describe the payload they accompany.
  const countsRecord = counts as Record<string, unknown>;
  const uniqueAliasesMatched = countsRecord['uniqueAliasesMatched'];
  const ambiguousAliasesObserved = countsRecord['ambiguousAliasesObserved'];
  const entitiesLinked = countsRecord['entitiesLinked'];
  if (
    !isNonNegativeInteger(uniqueAliasesMatched) ||
    !isNonNegativeInteger(ambiguousAliasesObserved) ||
    !isNonNegativeInteger(entitiesLinked) ||
    uniqueAliasesMatched !== new Set(matchedPairs.map((entry) => entry.normalizedAlias)).size ||
    ambiguousAliasesObserved !== ambiguousAliases.length ||
    entitiesLinked !== new Set(matchedPairs.map((entry) => entry.entityId)).size
  ) {
    return { kind: 'malformed' };
  }

  // ---- The observation must match the lists and flags it describes.
  const observation = m['observation'] as string;
  const mentionsExist = matchedPairs.length > 0;
  const ambiguityExists = ambiguousAliases.length > 0;
  const observationCoheres =
    (observation === 'no_phrases_observed' &&
      phrasesConsidered === 0 &&
      !mentionsExist &&
      !ambiguityExists &&
      !resultOverflow) ||
    (observation === 'no_match_observed' &&
      phrasesConsidered > 0 &&
      !mentionsExist &&
      !ambiguityExists &&
      !resultOverflow) ||
    (observation === 'mentions_observed' && mentionsExist && !resultOverflow) ||
    (observation === 'ambiguous_only_observed' &&
      !mentionsExist &&
      ambiguityExists &&
      !resultOverflow) ||
    (observation === 'lookup_overflow' && resultOverflow && !mentionsExist && !ambiguityExists);
  if (!observationCoheres) {
    return { kind: 'malformed' };
  }

  return {
    kind: 'entity_mentions_v1',
    report: mentions as unknown as EntityMentionsReport,
  };
}
