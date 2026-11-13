/**
 * Phase 7.2 — media CANDIDATE model (the RED-first adversarial suite).
 *
 * The blueprint §14 media pipeline starts at "collect media candidates
 * from source metadata and official APIs" and continues with URL
 * canonicalization + URL/hash/visual-key history comparison. This suite
 * pins the TYPED candidate contract BEFORE the module exists (RED on the
 * untouched tree), then the module makes it GREEN:
 *
 * - https-only, conservative, DETERMINISTIC URL canonicalization
 *   (byte-preserving path/query — identity-grade dedup comes from
 *   content/visual keys, NEVER from URL munging — the 5.3 lesson);
 * - the bounded candidate reader (R1.12.1 lesson applied from birth: a
 *   stored/claimed shape that merely CLAIMS the version is malformed);
 * - the deterministic PRECEDENCE comparator over ORDINAL labels —
 *   officiality > relevance > freshness > unused-before-used > URL
 *   tiebreak — with NO numeric score, NO percentage, NO weight anywhere
 *   (the Phase 6 gate condition: no accuracy vocabulary without a real
 *   benchmark).
 */

import { describe, expect, it } from 'vitest';

import {
  canonicalizeMediaUrl,
  compareMediaCandidates,
  readMediaCandidateV1,
  type MediaCandidateV1,
} from '../../src/domain/media/media-candidate';

/** A fully-valid photo candidate; individual tests mutate one field. */
function validPhoto(
  overrides: Partial<Omit<MediaCandidateV1, 'schemaVersion'>> = {},
): MediaCandidateV1 {
  return {
    schemaVersion: 1,
    kind: 'photo',
    role: 'gameplay',
    origin: 'official_api',
    officiality: 'official',
    relevance: 'supporting',
    freshness: 'recent',
    canonicalUrl: 'https://cdn.example.com/media/screenshot-1.jpg',
    previouslyUsed: false,
    ...overrides,
  };
}

describe('media candidate URL canonicalization (blueprint §14 step 2)', () => {
  it('canonicalizes an https URL: host lowercased, fragment dropped, port 443 dropped', () => {
    const outcome = canonicalizeMediaUrl('HTTPS://CDN.Example.COM:443/media/Shot.jpg#fragment');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.url).toBe('https://cdn.example.com/media/Shot.jpg');
  });

  it('preserves the path and query BYTE-EXACT (no tracking-param guessing)', () => {
    const outcome = canonicalizeMediaUrl('https://cdn.example.com/a/b%20c.JPG?x=1&y=%2Fz');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.url).toBe('https://cdn.example.com/a/b%20c.JPG?x=1&y=%2Fz');
  });

  it('canonicalization is idempotent (canonical(canonical(x)) === canonical(x))', () => {
    const first = canonicalizeMediaUrl('HTTPS://Example.COM:443/p?q=1#frag');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = canonicalizeMediaUrl(first.url);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.url).toBe(first.url);
  });

  it('rejects plain http (https-only is a FIXED transport rule)', () => {
    const outcome = canonicalizeMediaUrl('http://cdn.example.com/media/screenshot-1.jpg');
    expect(outcome).toMatchObject({ ok: false, reason: 'non_https_media_url' });
  });

  it('rejects every non-http(s) scheme (ftp/javascript/data/mailto)', () => {
    for (const raw of [
      'ftp://cdn.example.com/f.jpg',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'mailto:media@example.com',
      'file:///etc/passwd.jpg',
    ]) {
      expect(canonicalizeMediaUrl(raw)).toMatchObject({
        ok: false,
        reason: 'unsupported_url_scheme',
      });
    }
  });

  it('rejects credentials embedded in the URL (user:pass@host)', () => {
    const outcome = canonicalizeMediaUrl('https://user:secret@cdn.example.com/media.jpg');
    expect(outcome).toMatchObject({ ok: false, reason: 'url_credentials_forbidden' });
  });

  it('rejects non-ASCII hosts (conservative: no punycode interpretation)', () => {
    expect(canonicalizeMediaUrl('https://例え.example.com/media.jpg')).toMatchObject({
      ok: false,
      reason: 'unsupported_host_characters',
    });
  });

  it('rejects an over-length URL (the bounded 2048-char contract; exactly-2048 ok, 2049 fails TYPED)', () => {
    // The prefix "https://cdn.example.com/" is exactly 24 chars.
    const boundary2048 = canonicalizeMediaUrl(`https://cdn.example.com/${'b'.repeat(2048 - 24)}`);
    expect(boundary2048.ok).toBe(true);
    const over2049 = canonicalizeMediaUrl(`https://cdn.example.com/${'b'.repeat(2049 - 24)}`);
    expect(over2049).toMatchObject({ ok: false, reason: 'url_over_bound' });
  });

  it('rejects an empty or whitespace-only URL', () => {
    expect(canonicalizeMediaUrl('')).toMatchObject({ ok: false, reason: 'unsupported_url_scheme' });
    expect(canonicalizeMediaUrl('   ')).toMatchObject({
      ok: false,
      reason: 'unsupported_url_scheme',
    });
  });
});

describe('the bounded media-candidate reader (versioned v1, fail-closed)', () => {
  it('accepts a fully valid candidate and echoes it verbatim', () => {
    const outcome = readMediaCandidateV1(validPhoto());
    expect(outcome.ok).toBe(true);
    if (outcome.ok)
      expect(outcome.candidate).toMatchObject({
        schemaVersion: 1,
        kind: 'photo',
        role: 'gameplay',
      });
  });

  it('a payload that merely CLAIMS schemaVersion 1 with a wrong-typed shape is malformed', () => {
    expect(readMediaCandidateV1(null)).toMatchObject({ ok: false, reason: 'candidate_malformed' });
    expect(readMediaCandidateV1(42)).toMatchObject({ ok: false, reason: 'candidate_malformed' });
    expect(readMediaCandidateV1({})).toMatchObject({ ok: false, reason: 'candidate_malformed' });
    expect(readMediaCandidateV1({ ...validPhoto(), schemaVersion: 2 })).toMatchObject({
      ok: false,
      reason: 'candidate_version_unsupported',
    });
  });

  it('rejects every out-of-vocabulary kind/role/origin/officiality/relevance/freshness', () => {
    expect(readMediaCandidateV1(validPhoto({ kind: 'gif' as never }))).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
    expect(readMediaCandidateV1(validPhoto({ role: 'trailer' as never }))).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
    expect(readMediaCandidateV1(validPhoto({ origin: ' scraped ' as never }))).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
    expect(readMediaCandidateV1(validPhoto({ officiality: 'random_blog' as never }))).toMatchObject(
      {
        ok: false,
        reason: 'candidate_malformed',
      },
    );
    expect(readMediaCandidateV1(validPhoto({ relevance: 'decor' as never }))).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
    expect(readMediaCandidateV1(validPhoto({ freshness: 'ancient' as never }))).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
  });

  it('the role must MATCH the kind (a photo cannot carry the video role and vice versa)', () => {
    expect(readMediaCandidateV1(validPhoto({ role: 'video' }))).toMatchObject({
      ok: false,
      reason: 'candidate_role_kind_mismatch',
    });
    const video = validPhoto({
      kind: 'video',
      role: 'video',
      canonicalUrl: 'https://cdn.example.com/media/clip.mp4',
    });
    expect(readMediaCandidateV1(video)).toMatchObject({ ok: true });
    expect(readMediaCandidateV1({ ...video, role: 'cover_key_art' })).toMatchObject({
      ok: false,
      reason: 'candidate_role_kind_mismatch',
    });
  });

  it('the canonicalUrl must ALREADY be canonical (a non-canonical candidate is malformed)', () => {
    expect(
      readMediaCandidateV1(
        validPhoto({ canonicalUrl: 'HTTPS://CDN.Example.COM/media/shot.jpg#frag' }),
      ),
    ).toMatchObject({ ok: false, reason: 'candidate_url_not_canonical' });
    expect(
      readMediaCandidateV1(validPhoto({ canonicalUrl: 'http://cdn.example.com/media/shot.jpg' })),
    ).toMatchObject({ ok: false, reason: 'candidate_url_not_canonical' });
  });

  it('declared dimensions are bounded (1..10000 integers; 0 and 10001 fail typed)', () => {
    expect(
      readMediaCandidateV1(validPhoto({ declaredDimensions: { width: 1920, height: 1080 } })),
    ).toMatchObject({
      ok: true,
    });
    expect(
      readMediaCandidateV1(validPhoto({ declaredDimensions: { width: 0, height: 1080 } })),
    ).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
    expect(
      readMediaCandidateV1(validPhoto({ declaredDimensions: { width: 1920.5, height: 1080 } })),
    ).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
    expect(
      readMediaCandidateV1(validPhoto({ declaredDimensions: { width: 10001, height: 1080 } })),
    ).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
  });

  it('contentHash and visualKey are bounded OPAQUE strings (printable ASCII, 1..256 units)', () => {
    expect(readMediaCandidateV1(validPhoto({ contentHash: 'abc123DEF_-.' }))).toMatchObject({
      ok: true,
    });
    expect(readMediaCandidateV1(validPhoto({ contentHash: '' }))).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
    expect(readMediaCandidateV1(validPhoto({ contentHash: 'a'.repeat(257) }))).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
    expect(readMediaCandidateV1(validPhoto({ visualKey: 'ключ' }))).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
    expect(readMediaCandidateV1(validPhoto({ previouslyUsed: 'no' as never }))).toMatchObject({
      ok: false,
      reason: 'candidate_malformed',
    });
  });

  it('the candidate type carries NO numeric score/weight/percentage vocabulary at all', () => {
    const outcome = readMediaCandidateV1(validPhoto());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const keys = Object.keys(outcome.candidate).sort();
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain('score');
      expect(key.toLowerCase()).not.toContain('percent');
      expect(key.toLowerCase()).not.toContain('weight');
      expect(key.toLowerCase()).not.toContain('confidence');
    }
  });
});

describe('the deterministic precedence comparator (ordinals — never scores)', () => {
  function pair(
    a: Partial<Omit<MediaCandidateV1, 'schemaVersion'>>,
    b: Partial<Omit<MediaCandidateV1, 'schemaVersion'>>,
  ) {
    const left = readMediaCandidateV1(
      validPhoto({ canonicalUrl: 'https://cdn.example.com/a.jpg', ...a }),
    );
    const right = readMediaCandidateV1(
      validPhoto({ canonicalUrl: 'https://cdn.example.com/b.jpg', ...b }),
    );
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) return null;
    return { left: left.candidate, right: right.candidate };
  }

  it('officiality: official > verified_source > unofficial', () => {
    const cells = pair({ officiality: 'official' }, { officiality: 'verified_source' });
    const cells2 = pair({ officiality: 'verified_source' }, { officiality: 'unofficial' });
    const cells3 = pair({ officiality: 'official' }, { officiality: 'unofficial' });
    expect(cells && compareMediaCandidates(cells.left, cells.right)).toBe(-1);
    expect(cells2 && compareMediaCandidates(cells2.left, cells2.right)).toBe(-1);
    expect(cells3 && compareMediaCandidates(cells3.left, cells3.right)).toBe(-1);
  });

  it('relevance: primary > supporting (only when officiality ties)', () => {
    const cells = pair({ relevance: 'primary' }, { relevance: 'supporting' });
    expect(cells && compareMediaCandidates(cells.left, cells.right)).toBe(-1);
    const flipped = pair(
      { officiality: 'unofficial', relevance: 'primary' },
      { officiality: 'official', relevance: 'supporting' },
    );
    // officiality outranks relevance: the unofficial-primary sorts AFTER the official-supporting.
    expect(flipped && compareMediaCandidates(flipped.left, flipped.right)).toBe(1);
  });

  it('freshness: current_cycle > recent > aged (only when the higher ranks tie)', () => {
    const cells = pair({ freshness: 'current_cycle' }, { freshness: 'recent' });
    const cells2 = pair({ freshness: 'recent' }, { freshness: 'aged' });
    expect(cells && compareMediaCandidates(cells.left, cells.right)).toBe(-1);
    expect(cells2 && compareMediaCandidates(cells2.left, cells2.right)).toBe(-1);
  });

  it('never-used sorts before previously-used (the file_id-reuse economy is NOT a ranking penalty)', () => {
    const cells = pair({ previouslyUsed: false }, { previouslyUsed: true });
    expect(cells && compareMediaCandidates(cells.left, cells.right)).toBe(-1);
  });

  it('the final tiebreak is the canonicalUrl lexicographic order (a TOTAL deterministic order)', () => {
    const a = readMediaCandidateV1(validPhoto({ canonicalUrl: 'https://cdn.example.com/aaa.jpg' }));
    const b = readMediaCandidateV1(validPhoto({ canonicalUrl: 'https://cdn.example.com/bbb.jpg' }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(compareMediaCandidates(a.candidate, b.candidate)).toBe(-1);
    expect(compareMediaCandidates(b.candidate, a.candidate)).toBe(1);
    expect(compareMediaCandidates(a.candidate, a.candidate)).toBe(0);
  });

  it('the order is a strict weak ordering: sorting an array twice yields the SAME sequence', () => {
    const raw = [
      validPhoto({ canonicalUrl: 'https://cdn.example.com/1.jpg', officiality: 'unofficial' }),
      validPhoto({ canonicalUrl: 'https://cdn.example.com/2.jpg', officiality: 'official' }),
      validPhoto({
        canonicalUrl: 'https://cdn.example.com/3.jpg',
        officiality: 'verified_source',
        freshness: 'aged',
      }),
      validPhoto({
        canonicalUrl: 'https://cdn.example.com/4.jpg',
        officiality: 'verified_source',
        freshness: 'recent',
      }),
      validPhoto({
        canonicalUrl: 'https://cdn.example.com/5.jpg',
        officiality: 'official',
        previouslyUsed: true,
      }),
    ];
    const candidates = raw
      .map((entry) => readMediaCandidateV1(entry))
      .map((entry) => (entry.ok ? entry.candidate : null));
    const list = candidates.filter((entry): entry is MediaCandidateV1 => entry !== null);
    const first = [...list].sort(compareMediaCandidates);
    const second = [...list].sort(compareMediaCandidates);
    expect(first.map((entry) => entry.canonicalUrl)).toEqual(
      second.map((entry) => entry.canonicalUrl),
    );
    // official (unused) → official (used) → verified_source recent → verified_source aged → unofficial
    expect(first.map((entry) => entry.canonicalUrl)).toEqual([
      'https://cdn.example.com/2.jpg',
      'https://cdn.example.com/5.jpg',
      'https://cdn.example.com/4.jpg',
      'https://cdn.example.com/3.jpg',
      'https://cdn.example.com/1.jpg',
    ]);
  });

  it('the comparator NEVER invents a numeric value (outputs are only -1, 0, 1)', () => {
    const a = readMediaCandidateV1(validPhoto({ canonicalUrl: 'https://cdn.example.com/a.jpg' }));
    const b = readMediaCandidateV1(validPhoto({ canonicalUrl: 'https://cdn.example.com/b.jpg' }));
    if (!a.ok || !b.ok) return expect.unreachable();
    const outcomes = new Set([
      compareMediaCandidates(a.candidate, b.candidate),
      compareMediaCandidates(b.candidate, a.candidate),
    ]);
    for (const value of outcomes) expect([-1, 0, 1]).toContain(value);
  });
});
