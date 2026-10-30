import { describe, expect, it } from 'vitest';
import {
  ENTITY_MENTIONS_VERSION,
  ENTITY_MENTION_POLICY_VERSION,
  ENTITY_MENTION_MAX_ALIAS_TOKENS,
  ENTITY_MENTION_MAX_PHRASES,
  ENTITY_MENTION_MAX_RESULT_ROWS,
  ENTITY_MENTION_MAX_SCAN_TOKENS,
  STORY_ENTITY_MENTION_CONFIDENCE,
  STORY_ENTITY_RELATION_MENTIONED,
  buildEntityMentionPhrases,
  buildEntityMentionsReport,
  readEntityMentionsReport,
  type EntityMentionLookupRow,
} from '../../src/domain/editorial/entity-mentions';

/**
 * R1.16 (Phase 5D) unit contract — the PURE controlled-alias mention
 * policy (`em1`): normalization (NFC + whitespace collapse + trim ONLY),
 * word-boundary phrase matching (byte-exact substrings between token
 * boundaries), bounded scan windows, deterministic ambiguity resolution
 * (NO first-row-wins), the versioned report builder, and the typed reader
 * whose malformed table separates absent / unsupported_version / malformed
 * from a real v1 report.
 */

const SNAPSHOT = { sourceItemId: 'item-1', contentHash: 'hash-1' };

function fullScan(text: string) {
  const scan = buildEntityMentionPhrases(text);
  return {
    scan,
    resolution: buildEntityMentionsReport({
      snapshot: SNAPSHOT,
      scan,
      matches: [],
      resultOverflow: false,
    }),
  };
}

describe('entity mention policy em1 — normalization and phrase windows', () => {
  it('exposes the versioned policy constants', () => {
    expect(ENTITY_MENTIONS_VERSION).toBe(1);
    expect(ENTITY_MENTION_POLICY_VERSION).toBe('em1');
    expect(ENTITY_MENTION_MAX_ALIAS_TOKENS).toBe(4);
    expect(ENTITY_MENTION_MAX_PHRASES).toBe(90);
    expect(ENTITY_MENTION_MAX_RESULT_ROWS).toBe(91);
    expect(ENTITY_MENTION_MAX_SCAN_TOKENS).toBe(256);
    expect(STORY_ENTITY_RELATION_MENTIONED).toBe('mentioned');
    expect(STORY_ENTITY_MENTION_CONFIDENCE).toBe(0);
  });

  it('generates single-token phrases and multi-token windows, byte-exact with internal separators', () => {
    const { scan } = fullScan('Half-Life 3 announced');
    // "Half-Life" (2 tokens with the hyphen INSIDE the phrase) must be a
    // candidate phrase — byte-exact, not separator-normalized away.
    expect(scan.phrases).toContain('Half-Life');
    expect(scan.phrases).toContain('Half-Life 3');
    expect(scan.phrases).toContain('Half');
    expect(scan.phrases.every((phrase) => phrase.length > 0)).toBe(true);
  });

  it('folds NFC and whitespace but NEVER case (explicit registration contract)', () => {
    // NFC: decomposed form normalizes to the composed form.
    const decomposed = 'دا\u0651د';
    const { scan } = fullScan(decomposed);
    expect(scan.phrases).toContain(decomposed.normalize('NFC'));
    // Case folding is FORBIDDEN: 'DOOM' and 'doom' stay distinct — matching
    // is byte-exact under the em1 policy.
    const upper = fullScan('DOOM announced');
    const lower = fullScan('doom announced');
    expect(upper.scan.phrases).toContain('DOOM');
    expect(upper.scan.phrases).not.toContain('doom');
    expect(lower.scan.phrases).toContain('doom');
    expect(lower.scan.phrases).not.toContain('DOOM');
  });

  it('treats ZWNJ as word-INTERNAL: بازی‌سازی stays one token, بازی سازی does not equal it', () => {
    const zwnj = fullScan('استودیوی بازی‌سازی تهرانی');
    expect(zwnj.scan.phrases).toContain('بازی‌سازی');
    const spaced = fullScan('استودیوی بازی سازی تهرانی');
    expect(spaced.scan.phrases).toContain('بازی');
    expect(spaced.scan.phrases).toContain('سازی');
    expect(spaced.scan.phrases).not.toContain('بازی‌سازی');
  });

  it('is bounded: >256 tokens truncates the scan honestly; >90 distinct phrases truncates the window', () => {
    const manyTokens = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
    const { scan, resolution } = fullScan(manyTokens);
    expect(scan.scannedTokens).toBe(ENTITY_MENTION_MAX_SCAN_TOKENS);
    expect(scan.tokensTruncated).toBe(true);
    expect(scan.phrases.length).toBeLessThanOrEqual(ENTITY_MENTION_MAX_PHRASES);
    expect(scan.phrasesTruncated).toBe(true);
    expect(resolution.report.scan.phrasesConsidered).toBe(ENTITY_MENTION_MAX_PHRASES);
  });

  it('deterministic: same input → byte-identical phrases and report', () => {
    const a = fullScan('The Witcher 3 news امروز منتشر شد');
    const b = fullScan('The Witcher 3 news امروز منتشر شد');
    expect(a.scan.phrases).toEqual(b.scan.phrases);
    expect(JSON.stringify(a.resolution.report)).toBe(JSON.stringify(b.resolution.report));
  });

  it('degenerate text (separators only) → zero phrases, honest no_phrases_observed', () => {
    const { scan, resolution } = fullScan('!!! --- ???');
    expect(scan.phrases).toEqual([]);
    expect(scan.tokensTruncated).toBe(false);
    expect(resolution.report.observation).toBe('no_phrases_observed');
    expect(resolution.resolved).toEqual([]);
  });
});

describe('entity mention resolution — ambiguity, dedup, determinism', () => {
  const SCAN = buildEntityMentionPhrases('Doom منتشر شد');

  function rows(list: readonly [string, string][]): EntityMentionLookupRow[] {
    return list.map(([normalized_alias, entity_id]) => ({ normalized_alias, entity_id }));
  }

  it('unique alias resolves ONE link; multiple aliases of one entity dedup to one entity', () => {
    const resolution = buildEntityMentionsReport({
      snapshot: SNAPSHOT,
      scan: SCAN,
      matches: rows([
        ['Doom', 'ent-doom'],
        ['دوم', 'ent-doom'],
      ]),
      resultOverflow: false,
    });
    expect(resolution.report.observation).toBe('mentions_observed');
    expect(resolution.resolved).toEqual([
      { normalizedAlias: 'Doom', entityId: 'ent-doom' },
      { normalizedAlias: 'دوم', entityId: 'ent-doom' },
    ]);
    expect(resolution.report.counts.entitiesLinked).toBe(1);
    expect(resolution.report.counts.uniqueAliasesMatched).toBe(2);
    expect(resolution.report.counts.ambiguousAliasesObserved).toBe(0);
  });

  it('a shared alias with TWO owners is ambiguous — zero links, ownerCount reported, row order NEVER matters', () => {
    const ordered = buildEntityMentionsReport({
      snapshot: SNAPSHOT,
      scan: SCAN,
      matches: rows([
        ['Doom', 'ent-a'],
        ['Doom', 'ent-b'],
      ]),
      resultOverflow: false,
    });
    const reversed = buildEntityMentionsReport({
      snapshot: SNAPSHOT,
      scan: SCAN,
      matches: rows([
        ['Doom', 'ent-b'],
        ['Doom', 'ent-a'],
      ]),
      resultOverflow: false,
    });
    for (const resolution of [ordered, reversed]) {
      expect(resolution.report.observation).toBe('ambiguous_only_observed');
      expect(resolution.resolved).toEqual([]);
      expect(resolution.report.ambiguous).toEqual([{ normalizedAlias: 'Doom', ownerCount: 2 }]);
    }
    expect(JSON.stringify(ordered.report)).toBe(JSON.stringify(reversed.report));
  });

  it('result overflow → ZERO resolved and ZERO ambiguous embedded (no partial unique embedding)', () => {
    const resolution = buildEntityMentionsReport({
      snapshot: SNAPSHOT,
      scan: SCAN,
      matches: rows([['Doom', 'ent-doom']]),
      resultOverflow: true,
    });
    expect(resolution.report.observation).toBe('lookup_overflow');
    expect(resolution.resolved).toEqual([]);
    expect(resolution.report.matched).toEqual([]);
    expect(resolution.report.ambiguous).toEqual([]);
  });

  it('matches present but empty → honest no_match_observed (empty catalog is the same honest outcome)', () => {
    const resolution = buildEntityMentionsReport({
      snapshot: SNAPSHOT,
      scan: SCAN,
      matches: [],
      resultOverflow: false,
    });
    expect(resolution.report.observation).toBe('no_match_observed');
    expect(resolution.resolved).toEqual([]);
  });

  it('matched and ambiguous lists are deterministically sorted with no cross-list alias', () => {
    const resolution = buildEntityMentionsReport({
      snapshot: SNAPSHOT,
      scan: SCAN,
      matches: rows([
        ['Zelda', 'ent-z'],
        ['Doom', 'ent-doom'],
        ['Doom', 'ent-doom2'],
        ['Half-Life', 'ent-hl'],
      ]),
      resultOverflow: false,
    });
    expect(resolution.report.matched.map((m) => m.normalizedAlias)).toEqual(['Half-Life', 'Zelda']);
    expect(resolution.report.ambiguous.map((a) => a.normalizedAlias)).toEqual(['Doom']);
    expect(resolution.report.counts).toEqual({
      uniqueAliasesMatched: 2,
      ambiguousAliasesObserved: 1,
      entitiesLinked: 2,
    });
  });

  it('carries the snapshot identity and the fixed coverage/limitations contract', () => {
    const { report } = buildEntityMentionsReport({
      snapshot: SNAPSHOT,
      scan: SCAN,
      matches: [],
      resultOverflow: false,
    });
    expect(report.mentionsVersion).toBe(1);
    expect(report.policyVersion).toBe('em1');
    expect(report.snapshot).toEqual(SNAPSHOT);
    expect(report.textBasis).toBe('full_evidence_text');
    expect(report.coverage).toEqual({
      catalogScope: 'entity_aliases_table_only',
      textAddsToCatalog: false,
      historicalBackfill: false,
    });
    expect(report.limitations).toContain('controlled_aliases_only');
    expect(report.limitations).toContain('mention_not_verification');
    expect(report.limitations).toContain('confidence_zero');
    expect(report.limitations).toContain('no_fuzzy_no_translation');
    expect(report.limitations).toContain('bounded_scan_window');
    expect(report.limitations).toContain('lookup_moment_visibility');
    expect(report.limitations).toContain('reuse_drafts_not_enriched');
  });
});

describe('typed reader — round-trip and the malformed table', () => {
  function validReport() {
    const scan = buildEntityMentionPhrases('Doom منتشر شد');
    return buildEntityMentionsReport({
      snapshot: SNAPSHOT,
      scan,
      matches: [{ normalized_alias: 'Doom', entity_id: 'ent-doom' }],
      resultOverflow: false,
    }).report;
  }

  it('real builder output round-trips as entity_mentions_v1', () => {
    const document = { entityMentions: validReport() };
    const read = readEntityMentionsReport(document);
    expect(read.kind).toBe('entity_mentions_v1');
    if (read.kind === 'entity_mentions_v1') {
      expect(read.report).toEqual(validReport());
    }
  });

  it('missing key → absent (legacy documents stay legitimate)', () => {
    expect(readEntityMentionsReport({}).kind).toBe('absent');
  });

  it('unsupported version → unsupported_version, never a pass', () => {
    const document = { entityMentions: { ...validReport(), mentionsVersion: 2 } };
    const read = readEntityMentionsReport(document);
    expect(read.kind).toBe('unsupported_version');
    if (read.kind === 'unsupported_version') {
      expect(read.mentionsVersion).toBe(2);
    }
  });

  const MALFORMED_DOCUMENTS: readonly [string, unknown][] = [
    ['null document', null],
    ['primitive document', 'nope'],
    ['array document', []],
    ['null payload', { entityMentions: null }],
    ['primitive payload', { entityMentions: 7 }],
    ['array payload', { entityMentions: [] }],
    ['wrong policy version', { entityMentions: { ...validReport(), policyVersion: 'em0' } }],
    ['wrong text basis', { entityMentions: { ...validReport(), textBasis: 'title_only' } }],
    [
      'unknown observation',
      { entityMentions: { ...validReport(), observation: 'everything_matched' } },
    ],
    ['broken snapshot identity', { entityMentions: { ...validReport(), snapshot: null } }],
    [
      'empty snapshot field',
      { entityMentions: { ...validReport(), snapshot: { sourceItemId: '', contentHash: 'h' } } },
    ],
    [
      'caps tampered',
      { entityMentions: { ...validReport(), caps: { ...validReport().caps, maxPhrases: 5 } } },
    ],
    [
      'coverage tampered',
      {
        entityMentions: {
          ...validReport(),
          coverage: { ...validReport().coverage, textAddsToCatalog: true },
        },
      },
    ],
    [
      'limitations removed',
      { entityMentions: { ...validReport(), limitations: ['controlled_aliases_only'] } },
    ],
    [
      'ambiguous ownerCount < 2',
      {
        entityMentions: {
          ...validReport(),
          matched: [],
          ambiguous: [{ normalizedAlias: 'Doom', ownerCount: 1 }],
          counts: { uniqueAliasesMatched: 0, ambiguousAliasesObserved: 1, entitiesLinked: 0 },
        },
      },
    ],
    [
      'matched entry with empty alias',
      {
        entityMentions: {
          ...validReport(),
          matched: [{ normalizedAlias: '', entityId: 'ent' }],
        },
      },
    ],
    [
      'counts lie about entitiesLinked',
      {
        entityMentions: {
          ...validReport(),
          counts: { uniqueAliasesMatched: 1, ambiguousAliasesObserved: 0, entitiesLinked: 9 },
        },
      },
    ],
    [
      'lookup_overflow observation without the flag',
      { entityMentions: { ...validReport(), observation: 'lookup_overflow' } },
    ],
    [
      'resultOverflow flag without the observation',
      {
        entityMentions: { ...validReport(), scan: { ...validReport().scan, resultOverflow: true } },
      },
    ],
    [
      'phrasesTruncated without the cap count',
      {
        entityMentions: {
          ...validReport(),
          scan: { ...validReport().scan, phrasesTruncated: true },
        },
      },
    ],
  ];

  it.each(MALFORMED_DOCUMENTS)('malformed table: %s', (_label, document) => {
    expect(readEntityMentionsReport(document).kind).toBe('malformed');
  });

  it('invariants: matched list strictly ascending and deduplicated; matched ∩ ambiguous = ∅', () => {
    const base = validReport();
    const duplicated = {
      ...base,
      matched: [
        { normalizedAlias: 'Doom', entityId: 'ent-doom' },
        { normalizedAlias: 'Doom', entityId: 'ent-doom' },
      ],
    };
    expect(readEntityMentionsReport({ entityMentions: duplicated }).kind).toBe('malformed');
    const unordered = {
      ...base,
      matched: [
        { normalizedAlias: 'Zelda', entityId: 'ent-z' },
        { normalizedAlias: 'Doom', entityId: 'ent-doom' },
      ],
      counts: { uniqueAliasesMatched: 2, ambiguousAliasesObserved: 0, entitiesLinked: 2 },
    };
    expect(readEntityMentionsReport({ entityMentions: unordered }).kind).toBe('malformed');
  });
});
