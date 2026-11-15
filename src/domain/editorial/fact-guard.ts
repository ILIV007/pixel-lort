/**
 * Fact Guard v1 (Phase 6.3 — V4 local round): the BOUNDED, PURE,
 * DETERMINISTIC lexical evaluator over model claims (roadmap ۶.۳: ادعای
 * بی‌شاهد / شایعه / تضاد / نقل‌قول / اعداد). NO SQL, NO network, NO SDK,
 * NO model call, NO clock — the same offline purity as the Evidence Guard
 * (5B) and the candidate reports (5C/5.2/5.3), so every result is
 * reproducible from its inputs alone.
 *
 * WHAT IT DOES (and nothing more) — four bounded LENSES over each claim,
 * every one of them a LEXICAL OBSERVATION against the SAME traceable
 * excerpt that produced the draft:
 * - witness: the claim's evidence basis (no references at all /
 *   references that are not the verified snapshot's evidence id);
 * - numbers: number tokens (Persian ۰-۹, Arabic-Indic ٠-٩, Latin 0-9,
 *   digits NEVER folded into each other) observed verbatim in the excerpt;
 * - quotation: quoted spans («…», "…", “…”, ‘…’) whose inner text is (or
 *   is not) observed verbatim in the excerpt; unclosed/empty/over-cap
 *   spans are typed honest notes, never invented content;
 * - rumor: the FIXED versioned hedging-marker list (شایعه، به نقل از،
 *   ادعا می‌شود، …) observed on EITHER side — the claim hedging beyond
 *   its source, or the source's rumor language NOT reflected in the claim
 *   (the promotion-to-fact risk), or the benign reflected case;
 * - negation: a small FIXED versioned negation vocabulary (token-bounded,
 *   substrings never match) with polarity ASYMMETRY flagged in either
 *   direction — never a contradiction CONCLUSION.
 *
 * WHAT IT NEVER DOES (the 5→6 gate honesty boundary, binding):
 * - A finding is NEVER a truth verdict: `lexical_presence_not_truth` is a
 *   permanent limitation label of every report. The report NEVER upgrades,
 *   downgrades or rewrites a claim's `unverified` status — that status is
 *   structural (5A) and stays untouched.
 * - Absence of a number/quote in the excerpt is NOT proof of absence in
 *   the source or of falsehood (excerpt scope + bounded lists are explicit
 *   limitations); presence is NOT truth.
 * - The marker lists are deliberately NON-EXHAUSTIVE and versioned —
 *   `marker_lists_are_not_exhaustive` is a permanent label. No semantic
 *   analysis, no NER, no paraphrase detection, no translation, no scoring,
 *   no thresholds, no confidence.
 * - headline/summary are OUTSIDE the evaluator's scope and recorded as
 *   explicitly `unassessed` — never silently "checked".
 * - The claim/excerpt texts are INERT DATA: injection-like text is
 *   observed lexically, never interpreted, never executed, never obeyed.
 *
 * THE ONE LIMITED NORMALIZATION is inherited from the Evidence Guard
 * (`normalizeForDirectTextMatch`: NFC + whitespace collapse + trim). It
 * deliberately does NOT fold case, digits, Arabic/Persian letter variants
 * or negations.
 *
 * The result is a VERSIONED report (`factGuardVersion: 1`) that rides
 * INSIDE `drafts.document_json` of the SAME fenced atomic commit (additive
 * `factGuard` field — no new SQL, no migration), produced ONLY under the
 * independent fail-closed EDITORIAL_FACT_GUARD_ENABLED gate. ABSENT (the
 * key never written) is the honest historical/flag-off shape; pre-6.3
 * drafts read `absent` via `readFactGuardReport` — no automatic backfill.
 */

import { EDITORIAL_EXCERPT_MAX_CHARS } from './mapper';
import { normalizeForDirectTextMatch } from './evidence-guard';

/** Report schema version — bump ONLY with a documented contract change. */
export const FACT_GUARD_VERSION = 1 as const;

/** The bounded lenses a finding can come from (fixed, versioned set). */
export type FactGuardLens = 'witness' | 'numbers' | 'quotation' | 'rumor' | 'negation';

export const FACT_GUARD_LENSES: readonly FactGuardLens[] = [
  'witness',
  'numbers',
  'quotation',
  'rumor',
  'negation',
] as const;

/** Stable finding codes — additive-only across versions; never remapped. */
export type FactGuardFindingCode =
  | 'no_evidence_basis'
  | 'evidence_basis_not_the_snapshot'
  | 'identity_inconsistent'
  | 'number_not_observed_in_evidence'
  | 'number_tokens_capped'
  | 'quotation_not_observed_in_evidence'
  | 'quotation_span_unclosed'
  | 'quotation_span_empty'
  | 'quotation_span_over_cap'
  | 'rumor_marker_not_observed_in_evidence'
  | 'source_rumor_language_absent_from_claim'
  | 'rumor_language_reflected'
  | 'negation_in_claim_not_observed_in_evidence'
  | 'negation_in_evidence_not_reflected_in_claim';

/** The lens each v1 code belongs to (the reader enforces this mapping). */
export const FACT_GUARD_CODE_LENSES: Readonly<Record<FactGuardFindingCode, FactGuardLens>> = {
  no_evidence_basis: 'witness',
  evidence_basis_not_the_snapshot: 'witness',
  identity_inconsistent: 'witness',
  number_not_observed_in_evidence: 'numbers',
  number_tokens_capped: 'numbers',
  quotation_not_observed_in_evidence: 'quotation',
  quotation_span_unclosed: 'quotation',
  quotation_span_empty: 'quotation',
  quotation_span_over_cap: 'quotation',
  rumor_marker_not_observed_in_evidence: 'rumor',
  source_rumor_language_absent_from_claim: 'rumor',
  rumor_language_reflected: 'rumor',
  negation_in_claim_not_observed_in_evidence: 'negation',
  negation_in_evidence_not_reflected_in_claim: 'negation',
};

/**
 * Codes that may carry a bounded, sorted, unique token list (the reader
 * enforces this — every other code must carry NO tokens).
 */
const CODES_WITH_TOKENS: ReadonlySet<FactGuardFindingCode> = new Set([
  'number_not_observed_in_evidence',
  'quotation_not_observed_in_evidence',
  'rumor_marker_not_observed_in_evidence',
  'source_rumor_language_absent_from_claim',
  'negation_in_claim_not_observed_in_evidence',
  'negation_in_evidence_not_reflected_in_claim',
] as const);

/**
 * Benign observations — never set `reviewRequired` (they record that the
 * lens RAN and observed a coherent/absent state, or a bounded skip note).
 */
const BENIGN_CODES: ReadonlySet<FactGuardFindingCode> = new Set([
  'rumor_language_reflected',
  'number_tokens_capped',
] as const);

/** One bounded finding: lens + stable code + optional bounded token list. */
export interface FactGuardFinding {
  readonly lens: FactGuardLens;
  readonly code: FactGuardFindingCode;
  /** Sorted, deduplicated, bounded — deterministic JSON by construction.
   *  Present ONLY for the codes listed in CODES_WITH_TOKENS. */
  readonly tokens?: readonly string[];
}

/** One evaluated claim: an index into the SAME draft document it rides with. */
export interface FactGuardClaimResult {
  /** Index into `document_json.modelClaims` (and `facts_json`). */
  readonly claimIndex: number;
  readonly findings: readonly FactGuardFinding[];
  /** Derived, never stored as a free choice: ANY non-benign finding ⇒ true. */
  readonly reviewRequired: boolean;
}

/** Report-level evaluation status (identity gate before any text work). */
export type FactGuardEvaluationStatus = 'evaluated' | 'invalid_snapshot_identity';

/** Fixed limitation labels (order is part of the deterministic output). */
export const FACT_GUARD_LIMITATIONS = [
  'lexical_presence_not_truth',
  'bounded_marker_lists',
  'marker_lists_are_not_exhaustive',
  'excerpt_scope_only',
  'no_semantic_analysis',
  'headline_summary_unassessed',
] as const;

/**
 * The FIXED versioned rumor/hedging marker list (Phase 6.3, bounded and
 * deliberately NON-exhaustive). Markers are matched as normalized
 * substrings of the ONE normalization; both Persian spellings (space and
 * ZWNJ) of the transfer phrase are listed explicitly. Bump this list ONLY
 * with a documented contract change (the version is the report's).
 */
export const FACT_GUARD_RUMOR_MARKERS: readonly string[] = [
  'شایعه',
  'شایعات',
  'شایعاتی',
  'به نقل از',
  'به‌نقل از',
  'ادعا می‌شود',
  'ادعا شده',
  'گزارش شده است',
  'احتمالاً',
  'شاید',
  'ظاهراً',
  'به گفته',
  'طبق اعلام',
  'حدس زده می‌شود',
];

/**
 * The FIXED versioned negation vocabulary (bounded, deliberately small).
 * Token-Bounded matching (never substrings): a word token EQUALS one of
 * the exact forms, or STARTS WITH the Persian verbal negation prefix
 * `نمی` (always ZWNJ-attached to its verb, which the tokenizer keeps
 * word-internal). Digits/names like «نه» (9) ambiguity is a documented
 * limitation of the lens, not a truth claim.
 */
export const FACT_GUARD_NEGATION_EXACT_TOKENS: readonly string[] = [
  'نه',
  'نیست',
  'نبود',
  'نخواهد',
  'هرگز',
  'بدون',
  'غیر',
];
export const FACT_GUARD_NEGATION_PREFIX_TOKENS: readonly string[] = ['نمی'];

/** Bounds (part of the deterministic contract — the reader enforces them). */
export const FACT_GUARD_MAX_NUMBER_TOKENS = 16 as const;
export const FACT_GUARD_MAX_TOKENS_PER_FINDING = 8 as const;
export const FACT_GUARD_MAX_QUOTED_SPANS = 8 as const;
export const FACT_GUARD_QUOTED_SPAN_MAX_CHARS = 120 as const;

/** The token characters (same discipline as entity-mentions: ZWNJ is
 *  word-INTERNAL; code-point walking, never UTF-16 half-surrogates). */
const TOKEN_CHAR = /[\p{L}\p{N}\p{M}\u200c]/u;

/** Number token: digit runs with optional decimal/thousand separators. */
const NUMBER_TOKEN = /[\d۰-۹٠-٩]+(?:[.,٬٫][\d۰-۹٠-٩]+)*/gu;

/** The quoted-span shapes (bounded set; unmatched = typed note, not crash). */
const QUOTED_SPANS: readonly { readonly open: string; readonly close: string }[] = [
  { open: '«', close: '»' },
  { open: '"', close: '"' },
  { open: '“', close: '”' },
  { open: '‘', close: '’' },
];

/** Word tokens of the NORMALIZED text (bounded by the hard scan cap). */
function wordTokens(normalizedText: string): readonly string[] {
  const MAX_SCAN_TOKENS = 512; // hard bound, far above any real claim
  const tokens: string[] = [];
  let index = 0;
  const length = normalizedText.length;
  while (index < length && tokens.length < MAX_SCAN_TOKENS) {
    const code = normalizedText.codePointAt(index)!;
    if (!TOKEN_CHAR.test(String.fromCodePoint(code))) {
      index += code > 0xffff ? 2 : 1;
      continue;
    }
    const start = index;
    while (index < length) {
      const next = normalizedText.codePointAt(index)!;
      if (!TOKEN_CHAR.test(String.fromCodePoint(next))) {
        break;
      }
      index += next > 0xffff ? 2 : 1;
    }
    tokens.push(normalizedText.slice(start, index));
  }
  return tokens;
}

function negationTokensFound(normalizedText: string): readonly string[] {
  const found = new Set<string>();
  for (const token of wordTokens(normalizedText)) {
    const exact = FACT_GUARD_NEGATION_EXACT_TOKENS.find((candidate) => token === candidate);
    if (exact !== undefined) {
      found.add(exact);
      continue;
    }
    const prefix = FACT_GUARD_NEGATION_PREFIX_TOKENS.find((candidate) =>
      token.startsWith(candidate),
    );
    if (prefix !== undefined) {
      found.add(token.length <= 24 ? token : prefix);
    }
  }
  return sortUnique([...found]);
}

function sortUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function markersIn(normalizedText: string, markers: readonly string[]): readonly string[] {
  const found = markers.filter((marker) => normalizedText.includes(marker));
  return sortUnique(found);
}

/** Bounded quoted-span extraction over the NORMALIZED claim text. */
function quotedSpans(normalizedClaim: string): {
  readonly spans: readonly string[];
  readonly unclosed: boolean;
  readonly empty: boolean;
  readonly overCap: boolean;
} {
  const spans: string[] = [];
  let unclosed = false;
  let empty = false;
  let overCap = false;
  for (const shape of QUOTED_SPANS) {
    let searchFrom = 0;
    while (searchFrom <= normalizedClaim.length - shape.open.length) {
      const openAt = normalizedClaim.indexOf(shape.open, searchFrom);
      if (openAt === -1) {
        break;
      }
      const closeAt = normalizedClaim.indexOf(shape.close, openAt + shape.open.length);
      if (closeAt === -1) {
        unclosed = true;
        break;
      }
      const inner = normalizedClaim.slice(openAt + shape.open.length, closeAt);
      if (inner.trim().length === 0) {
        empty = true;
      } else if (inner.length > FACT_GUARD_QUOTED_SPAN_MAX_CHARS) {
        overCap = true;
      } else {
        spans.push(inner);
      }
      searchFrom = closeAt + shape.close.length;
    }
  }
  return { spans, unclosed, empty, overCap };
}

/** Per-claim input (the caller passes the draft's claims in stored order). */
export interface FactGuardClaimInput {
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

/** The expected evidence/snapshot/draft identities and claims to evaluate. */
export interface FactGuardInput {
  /** The verified source snapshot identity (the caller verified it before
   *  this evaluator ever runs — re-checked inside the report). */
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  /** The SAME traceable excerpt that produced the draft. */
  readonly evidence: {
    readonly evidenceId: string;
    readonly excerptText: string;
    readonly excerptTruncated: boolean;
  };
  /** Model claims exactly as they will be stored (`modelClaims` order). */
  readonly draftClaims: readonly FactGuardClaimInput[];
  /** Draft headline/summary — passed for scope honesty, NEVER evaluated. */
  readonly draftHeadlineFa: string;
  readonly draftSummaryFa: string;
  /** The item id recorded INSIDE the draft document (identity cross-check). */
  readonly draftSourceItemId: string;
}

/** The versioned, deterministic report stored with the draft. */
export interface FactGuardReport {
  readonly factGuardVersion: typeof FACT_GUARD_VERSION;
  readonly evaluationStatus: FactGuardEvaluationStatus;
  readonly snapshot: {
    readonly sourceItemId: string;
    readonly contentHash: string;
  };
  readonly evidence: {
    readonly evidenceId: string;
    readonly excerptTruncated: boolean;
    readonly excerptMaxChars: number;
  };
  /** Fixed, code-defined limitation labels (never success claims). */
  readonly limitations: readonly string[];
  /** Fields the evaluator explicitly did NOT assess. */
  readonly unassessedFields: readonly ['headlineFa', 'summaryFa'];
  readonly claims: readonly FactGuardClaimResult[];
  readonly counts: {
    readonly total: number;
    readonly claimsRequiringReview: number;
    readonly unwitnessedClaims: number;
    readonly numberFindings: number;
    readonly quotationFindings: number;
    readonly rumorFindings: number;
    readonly negationFindings: number;
  };
}

/**
 * Build the versioned fact-guard report. TOTAL and DETERMINISTIC: the same
 * input always yields a byte-identical report (fixed field order, bounded
 * sorted token lists, no timestamps, no randomness).
 */
export function buildFactGuardReport(input: FactGuardInput): FactGuardReport {
  // ---- Identity gate (before ANY textual evaluation) — the SAME
  //      discipline as the Evidence Guard: the evidence id, the verified
  //      snapshot and the draft's own recorded item identity must all name
  //      the SAME snapshot. A mismatch means nothing is observed and every
  //      claim carries exactly the typed identity finding.
  const identityValid =
    input.evidence.evidenceId === input.snapshot.sourceItemId &&
    input.draftSourceItemId === input.snapshot.sourceItemId;

  const normalizedExcerpt = normalizeForDirectTextMatch(input.evidence.excerptText);

  const claims = input.draftClaims.map((claim, claimIndex): FactGuardClaimResult => {
    if (!identityValid) {
      return {
        claimIndex,
        findings: [{ lens: 'witness', code: 'identity_inconsistent' }],
        reviewRequired: true,
      };
    }
    const findings: FactGuardFinding[] = [];

    // ---- Witness lens (ادعای بی‌شاهد / foreign basis).
    if (claim.evidenceIds.length === 0) {
      findings.push({ lens: 'witness', code: 'no_evidence_basis' });
    } else if (!claim.evidenceIds.includes(input.evidence.evidenceId)) {
      findings.push({ lens: 'witness', code: 'evidence_basis_not_the_snapshot' });
    }

    const normalizedClaim = normalizeForDirectTextMatch(claim.text);

    // ---- Numbers lens (digits NEVER folded; Persian ≠ Latin ≠ Arabic-Indic).
    const claimNumbers = [...normalizedClaim.matchAll(NUMBER_TOKEN)].map((m) => m[0]);
    const capped = claimNumbers.length > FACT_GUARD_MAX_NUMBER_TOKENS;
    const scanned = claimNumbers.slice(0, FACT_GUARD_MAX_NUMBER_TOKENS);
    const missingNumbers = sortUnique(scanned.filter((n) => !normalizedExcerpt.includes(n)));
    if (missingNumbers.length > 0) {
      findings.push({
        lens: 'numbers',
        code: 'number_not_observed_in_evidence',
        tokens: missingNumbers.slice(0, FACT_GUARD_MAX_TOKENS_PER_FINDING),
      });
    }
    if (capped) {
      findings.push({ lens: 'numbers', code: 'number_tokens_capped' });
    }

    // ---- Quotation lens (observed spans only; typed notes otherwise).
    const spans = quotedSpans(normalizedClaim);
    if (spans.unclosed) {
      findings.push({ lens: 'quotation', code: 'quotation_span_unclosed' });
    }
    if (spans.empty) {
      findings.push({ lens: 'quotation', code: 'quotation_span_empty' });
    }
    if (spans.overCap) {
      findings.push({ lens: 'quotation', code: 'quotation_span_over_cap' });
    }
    const missingQuotes = sortUnique(spans.spans.filter((s) => !normalizedExcerpt.includes(s)));
    if (missingQuotes.length > 0) {
      findings.push({
        lens: 'quotation',
        code: 'quotation_not_observed_in_evidence',
        tokens: missingQuotes.slice(0, FACT_GUARD_MAX_TOKENS_PER_FINDING),
      });
    }

    // ---- Rumor lens (hedging language observed on either side).
    const claimMarkers = markersIn(normalizedClaim, FACT_GUARD_RUMOR_MARKERS);
    const excerptMarkers = markersIn(normalizedExcerpt, FACT_GUARD_RUMOR_MARKERS);
    if (claimMarkers.length > 0 && excerptMarkers.length > 0) {
      findings.push({ lens: 'rumor', code: 'rumor_language_reflected' });
    } else if (claimMarkers.length > 0 && excerptMarkers.length === 0) {
      findings.push({
        lens: 'rumor',
        code: 'rumor_marker_not_observed_in_evidence',
        tokens: claimMarkers.slice(0, FACT_GUARD_MAX_TOKENS_PER_FINDING),
      });
    } else if (claimMarkers.length === 0 && excerptMarkers.length > 0) {
      findings.push({
        lens: 'rumor',
        code: 'source_rumor_language_absent_from_claim',
        tokens: excerptMarkers.slice(0, FACT_GUARD_MAX_TOKENS_PER_FINDING),
      });
    }

    // ---- Negation lens (polarity asymmetry observed, never concluded).
    const claimNegation = negationTokensFound(normalizedClaim);
    const excerptNegation = negationTokensFound(normalizedExcerpt);
    if (claimNegation.length > 0 && excerptNegation.length === 0) {
      findings.push({
        lens: 'negation',
        code: 'negation_in_claim_not_observed_in_evidence',
        tokens: claimNegation.slice(0, FACT_GUARD_MAX_TOKENS_PER_FINDING),
      });
    } else if (claimNegation.length === 0 && excerptNegation.length > 0) {
      findings.push({
        lens: 'negation',
        code: 'negation_in_evidence_not_reflected_in_claim',
        tokens: excerptNegation.slice(0, FACT_GUARD_MAX_TOKENS_PER_FINDING),
      });
    }

    const reviewRequired = findings.some((f) => !BENIGN_CODES.has(f.code));
    return { claimIndex, findings, reviewRequired };
  });

  const countLens = (lens: FactGuardLens): number =>
    claims.filter((c) => c.findings.some((f) => f.lens === lens)).length;

  const counts = {
    total: claims.length,
    claimsRequiringReview: claims.filter((c) => c.reviewRequired).length,
    unwitnessedClaims: countLens('witness'),
    numberFindings: countLens('numbers'),
    quotationFindings: countLens('quotation'),
    rumorFindings: countLens('rumor'),
    negationFindings: countLens('negation'),
  };

  return {
    factGuardVersion: FACT_GUARD_VERSION,
    evaluationStatus: identityValid ? 'evaluated' : 'invalid_snapshot_identity',
    snapshot: {
      sourceItemId: input.snapshot.sourceItemId,
      contentHash: input.snapshot.contentHash,
    },
    evidence: {
      evidenceId: input.evidence.evidenceId,
      excerptTruncated: input.evidence.excerptTruncated,
      excerptMaxChars: EDITORIAL_EXCERPT_MAX_CHARS,
    },
    limitations: FACT_GUARD_LIMITATIONS,
    unassessedFields: ['headlineFa', 'summaryFa'],
    claims,
    counts,
  };
}

// ---------------------------------------------------------------------------
// Versioned reader — old/unversioned payloads are never "current results";
// a payload that merely CLAIMS version 1 while violating the v1 contract
// below is malformed. Absence stays honest (no backfill).
// ---------------------------------------------------------------------------

export type FactGuardReportRead =
  | { readonly kind: 'fact_guard_v1'; readonly report: FactGuardReport }
  /** A pre-6.3 draft (no factGuard payload). Honest absence — never a pass. */
  | { readonly kind: 'absent' }
  /** A factGuard-shaped payload with a different (e.g. future) version. */
  | { readonly kind: 'unsupported_version'; readonly factGuardVersion: unknown }
  /** Not a factGuard payload at all — including one that violates v1. */
  | { readonly kind: 'malformed' };

const FACT_GUARD_CODE_SET: ReadonlySet<string> = new Set(Object.keys(FACT_GUARD_CODE_LENSES));

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** Exact string-array equality (order included) — for the fixed tuples. */
function isExactStringArray(value: readonly string[], expected: readonly string[]): boolean {
  return value.length === expected.length && expected.every((item, index) => value[index] === item);
}

/** A valid bounded token list: strings, ≤ cap, sorted unique, non-empty. */
function isBoundedTokenList(value: unknown): value is readonly string[] {
  if (!isStringArray(value)) {
    return false;
  }
  if (value.length === 0 || value.length > FACT_GUARD_MAX_TOKENS_PER_FINDING) {
    return false;
  }
  if (value.some((token) => token.length === 0 || token.length > 120)) {
    return false;
  }
  const sorted = [...new Set(value)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted.every((token, index) => token === value[index]);
}

function findingIsValid(finding: unknown): boolean {
  if (typeof finding !== 'object' || finding === null) {
    return false;
  }
  const f = finding as Record<string, unknown>;
  const lens = f['lens'];
  const code = f['code'];
  if (typeof lens !== 'string' || !FACT_GUARD_LENSES.includes(lens as FactGuardLens)) {
    return false;
  }
  if (typeof code !== 'string' || !FACT_GUARD_CODE_SET.has(code)) {
    return false;
  }
  // The code→lens mapping is part of the contract (no cross-lens forgeries).
  if (FACT_GUARD_CODE_LENSES[code as FactGuardFindingCode] !== lens) {
    return false;
  }
  const tokens = f['tokens'];
  if (tokens === undefined) {
    return !CODES_WITH_TOKENS.has(code as FactGuardFindingCode);
  }
  if (!CODES_WITH_TOKENS.has(code as FactGuardFindingCode)) {
    // Tokens on a code that must not carry them are a stored lie.
    return false;
  }
  return isBoundedTokenList(tokens);
}

function claimResultIsValid(claim: unknown, position: number): boolean {
  if (typeof claim !== 'object' || claim === null) {
    return false;
  }
  const c = claim as Record<string, unknown>;
  if (c['claimIndex'] !== position) {
    return false;
  }
  if (!Array.isArray(c['findings']) || !c['findings'].every(findingIsValid)) {
    return false;
  }
  if (typeof c['reviewRequired'] !== 'boolean') {
    return false;
  }
  const findings = c['findings'] as readonly FactGuardFinding[];
  const derived = findings.some((f) => !BENIGN_CODES.has(f.code));
  if (c['reviewRequired'] !== derived) {
    return false;
  }
  return true;
}

/**
 * Read the factGuard payload from a PARSED `drafts.document_json` value.
 * Consumers must treat `absent`/`unsupported_version`/`malformed` as "no
 * current fact-guard result" — none of them validates anything, and NONE
 * of them ever means "true", "false" or "checked".
 */
export function readFactGuardReport(document: unknown): FactGuardReportRead {
  if (typeof document !== 'object' || document === null) {
    return { kind: 'malformed' };
  }
  const factGuard = (document as Record<string, unknown>)['factGuard'];
  if (factGuard === undefined) {
    return { kind: 'absent' };
  }
  if (typeof factGuard !== 'object' || factGuard === null) {
    return { kind: 'malformed' };
  }
  const g = factGuard as Record<string, unknown>;
  if (g['factGuardVersion'] !== FACT_GUARD_VERSION) {
    return { kind: 'unsupported_version', factGuardVersion: g['factGuardVersion'] };
  }

  const evaluationStatus = g['evaluationStatus'];
  const snapshot = g['snapshot'];
  const evidence = g['evidence'];
  const limitations = g['limitations'];
  const unassessedFields = g['unassessedFields'];
  if (
    typeof evaluationStatus !== 'string' ||
    (evaluationStatus !== 'evaluated' && evaluationStatus !== 'invalid_snapshot_identity') ||
    typeof snapshot !== 'object' ||
    snapshot === null ||
    typeof (snapshot as Record<string, unknown>)['sourceItemId'] !== 'string' ||
    typeof (snapshot as Record<string, unknown>)['contentHash'] !== 'string' ||
    typeof evidence !== 'object' ||
    evidence === null ||
    typeof (evidence as Record<string, unknown>)['evidenceId'] !== 'string' ||
    typeof (evidence as Record<string, unknown>)['excerptTruncated'] !== 'boolean' ||
    // The builder ALWAYS emits this constant — drift is not a v1 report.
    (evidence as Record<string, unknown>)['excerptMaxChars'] !== EDITORIAL_EXCERPT_MAX_CHARS ||
    !Array.isArray(limitations) ||
    !isStringArray(limitations) ||
    !isExactStringArray(limitations, FACT_GUARD_LIMITATIONS) ||
    !Array.isArray(unassessedFields) ||
    !isStringArray(unassessedFields) ||
    // v1 assesses NO headline/summary: exactly the fixed two-field tuple.
    !isExactStringArray(unassessedFields, ['headlineFa', 'summaryFa']) ||
    !Array.isArray(g['claims'])
  ) {
    return { kind: 'malformed' };
  }

  const claims = g['claims'] as unknown[];
  for (let position = 0; position < claims.length; position++) {
    if (!claimResultIsValid(claims[position], position)) {
      return { kind: 'malformed' };
    }
  }

  // ---- Counts: non-negative integers that EXACTLY describe the claims.
  const counts = g['counts'];
  if (typeof counts !== 'object' || counts === null) {
    return { kind: 'malformed' };
  }
  const c = counts as Record<string, unknown>;
  const countKeys = [
    'total',
    'claimsRequiringReview',
    'unwitnessedClaims',
    'numberFindings',
    'quotationFindings',
    'rumorFindings',
    'negationFindings',
  ] as const;
  if (!countKeys.every((key) => isNonNegativeInteger(c[key]))) {
    return { kind: 'malformed' };
  }
  if (c['total'] !== claims.length) {
    return { kind: 'malformed' };
  }
  const lensCount = (lens: FactGuardLens): number =>
    claims.filter((claim) =>
      ((claim as Record<string, unknown>)['findings'] as readonly FactGuardFinding[]).some(
        (f) => f.lens === lens,
      ),
    ).length;
  const reviewCount = claims.filter(
    (claim) => (claim as Record<string, unknown>)['reviewRequired'] === true,
  ).length;
  const witnessCount = claims.filter((claim) =>
    ((claim as Record<string, unknown>)['findings'] as readonly FactGuardFinding[]).some(
      (f) => f.lens === 'witness',
    ),
  ).length;
  if (
    c['claimsRequiringReview'] !== reviewCount ||
    c['unwitnessedClaims'] !== witnessCount ||
    c['numberFindings'] !== lensCount('numbers') ||
    c['quotationFindings'] !== lensCount('quotation') ||
    c['rumorFindings'] !== lensCount('rumor') ||
    c['negationFindings'] !== lensCount('negation')
  ) {
    return { kind: 'malformed' };
  }

  // ---- Evaluation status vs claims vs the report's OWN stored identity.
  const sourceItemId = (snapshot as Record<string, unknown>)['sourceItemId'] as string;
  const evidenceId = (evidence as Record<string, unknown>)['evidenceId'] as string;
  const claimsAllIdentityInvalid = claims.every((claim) =>
    ((claim as Record<string, unknown>)['findings'] as readonly FactGuardFinding[]).every(
      (f) => f.code === 'identity_inconsistent',
    ),
  );
  if (evaluationStatus === 'evaluated') {
    if (
      evidenceId !== sourceItemId ||
      claims.some((claim) =>
        ((claim as Record<string, unknown>)['findings'] as readonly FactGuardFinding[]).some(
          (f) => f.code === 'identity_inconsistent',
        ),
      )
    ) {
      return { kind: 'malformed' };
    }
  } else {
    // invalid_snapshot_identity: EVERY claim carries exactly the identity
    // finding; when the visible identity fields disagree, the stored shape
    // must be consistent with the report's OWN fields.
    if (claims.length > 0 && !claimsAllIdentityInvalid) {
      return { kind: 'malformed' };
    }
  }

  return { kind: 'fact_guard_v1', report: factGuard as unknown as FactGuardReport };
}
