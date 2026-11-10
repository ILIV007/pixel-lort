/**
 * Phase 7.2 — ALBUM PLANNING (the RED-first adversarial suite).
 *
 * Blueprint §14 steps 6–8 + the Default album policy, as a TOTAL,
 * DETERMINISTIC, PURE planning derivation over already-validated
 * candidates:
 *
 * - the select mode is DERIVED, never guessed: 0 candidates ⇒ none (or
 *   official_video_link when ONLY a link exists), 1 ⇒ single, 2..10 ⇒
 *   album, over-10 ⇒ the policy-ordered top 10 with the remainder
 *   EXCLUDED typed (never silently dropped);
 * - the blueprint ordering policy is deterministic: cover/key art
 *   first, gameplay before concept art UNLESS the story layer demands
 *   otherwise (an explicit input flag — never an inference), videos at
 *   the END unless videoAsPrimaryNews promotes the best video to the
 *   front (relevance 'primary' ALONE promotes NOTHING — the story layer
 *   decides);
 * - "no more than two visually similar screenshots" is a typed cap over
 *   the opaque visualKey (a deterministic proxy — never an accuracy
 *   claim);
 * - the caption rides ONLY ordinal 0 (`captionAllowed` true at ordinal
 *   0, false everywhere else) — the 7.1 no-separation layer EXTENDED to
 *   the album plan, never weakened;
 * - mixed photo+video albums compose (the Bot API media group supports
 *   it); duplicates (same canonicalUrl or contentHash) are an INPUT
 *   contract violation and fail the whole plan typed;
 * - the SAME input ALWAYS yields the SAME plan (JSON-equal determinism).
 */

import { describe, expect, it } from 'vitest';

import { planAlbumMedia, type AlbumPlanningInputV1 } from '../../src/domain/media/album-plan';
import {
  readMediaCandidateV1,
  type MediaCandidateV1,
} from '../../src/domain/media/media-candidate';

function photo(overrides: Partial<Omit<MediaCandidateV1, 'schemaVersion'>> = {}): MediaCandidateV1 {
  return {
    schemaVersion: 1,
    kind: 'photo',
    role: 'gameplay',
    origin: 'official_api',
    officiality: 'official',
    relevance: 'supporting',
    freshness: 'recent',
    canonicalUrl: 'https://cdn.example.com/media/photo.jpg',
    previouslyUsed: false,
    ...overrides,
  };
}

function video(overrides: Partial<Omit<MediaCandidateV1, 'schemaVersion'>> = {}): MediaCandidateV1 {
  return {
    schemaVersion: 1,
    kind: 'video',
    role: 'video',
    origin: 'official_api',
    officiality: 'official',
    relevance: 'supporting',
    freshness: 'recent',
    canonicalUrl: 'https://cdn.example.com/media/clip.mp4',
    previouslyUsed: false,
    ...overrides,
  };
}

function readList(raw: readonly MediaCandidateV1[]): MediaCandidateV1[] {
  const read = raw.map((entry) => readMediaCandidateV1(entry));
  const failed = read.find((entry) => !entry.ok);
  if (failed || !read.every((entry) => entry.ok)) throw new Error('test fixture candidate invalid');
  return read.map((entry) => (entry.ok ? entry.candidate : (null as never))).filter(Boolean);
}

function plan(raw: readonly MediaCandidateV1[], overrides: Partial<AlbumPlanningInputV1> = {}) {
  return planAlbumMedia({ candidates: readList(raw), ...overrides });
}

describe('the derived select mode (blueprint §14 step 6 — none/single/album/official_video_link)', () => {
  it('0 candidates and no link ⇒ mode none with NO items and NO caption ordinal', () => {
    const outcome = plan([]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mode).toBe('none');
    expect(outcome.plan.items).toEqual([]);
    expect(outcome.plan.captionOrdinal).toBeNull();
  });

  it('0 candidates + an official video link ⇒ mode official_video_link (LINK-only, never a download)', () => {
    const outcome = plan([], { officialVideoLink: 'HTTPS://WWW.YouTube.COM/watch?v=abc#t=30' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mode).toBe('official_video_link');
    expect(outcome.plan.items).toEqual([]);
    expect(outcome.plan.companionOfficialLink).toBe('https://www.youtube.com/watch?v=abc');
  });

  it('a YOUTUBE host is ALLOWED in link mode — the download ban does not reach the link pass-through', () => {
    const outcome = plan([], { officialVideoLink: 'https://youtu.be/shortid' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mode).toBe('official_video_link');
    expect(outcome.plan.companionOfficialLink).toBe('https://youtu.be/shortid');
  });

  it('a non-canonical or plain-http link fails typed (official_video_link_invalid)', () => {
    expect(plan([], { officialVideoLink: 'http://youtube.com/watch?v=x' })).toMatchObject({
      ok: false,
      reason: 'official_video_link_invalid',
    });
    expect(plan([], { officialVideoLink: 'not a url' })).toMatchObject({
      ok: false,
      reason: 'official_video_link_invalid',
    });
  });

  it('exactly 1 candidate ⇒ single (never a one-item album)', () => {
    const outcome = plan([photo({ canonicalUrl: 'https://cdn.example.com/media/only.jpg' })]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mode).toBe('single');
    expect(outcome.plan.items).toHaveLength(1);
    expect(outcome.plan.items[0]?.captionAllowed).toBe(true);
    expect(outcome.plan.captionOrdinal).toBe(0);
  });

  it('exactly 2 candidates ⇒ album (the Bot API media-group minimum)', () => {
    const outcome = plan([
      photo({ canonicalUrl: 'https://cdn.example.com/media/a.jpg' }),
      photo({ canonicalUrl: 'https://cdn.example.com/media/b.jpg' }),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mode).toBe('album');
    expect(outcome.plan.items).toHaveLength(2);
  });

  it('candidates AND a link ⇒ the candidates decide the mode; the link rides as the companion (never merged)', () => {
    const outcome = plan(
      [
        photo({ canonicalUrl: 'https://cdn.example.com/media/a.jpg' }),
        photo({ canonicalUrl: 'https://cdn.example.com/media/b.jpg' }),
      ],
      { officialVideoLink: 'https://youtube.com/watch?v=x' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mode).toBe('album');
    expect(outcome.plan.companionOfficialLink).toBe('https://youtube.com/watch?v=x');
    expect(outcome.plan.items.every((item) => item.candidate.kind === 'photo')).toBe(true);
  });
});

describe('the deterministic ordering policy (blueprint Default album policy)', () => {
  const album = [
    photo({ role: 'concept_art', canonicalUrl: 'https://cdn.example.com/media/concept.jpg' }),
    photo({ role: 'gameplay', canonicalUrl: 'https://cdn.example.com/media/gameplay.jpg' }),
    photo({ role: 'cover_key_art', canonicalUrl: 'https://cdn.example.com/media/cover.jpg' }),
    photo({ role: 'other_screenshot', canonicalUrl: 'https://cdn.example.com/media/other.jpg' }),
  ];

  it('cover/key art first, then gameplay, then other screenshots, concept art LAST (default)', () => {
    const outcome = plan(album);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.items.map((item) => item.candidate.role)).toEqual([
      'cover_key_art',
      'gameplay',
      'other_screenshot',
      'concept_art',
    ]);
  });

  it('the story-demand override swaps gameplay/concept (an explicit INPUT flag — never an inference)', () => {
    const outcome = plan(album, { storyDemandsConceptBeforeGameplay: true });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.items.map((item) => item.candidate.role)).toEqual([
      'cover_key_art',
      'concept_art',
      'other_screenshot',
      'gameplay',
    ]);
  });

  it('videos ride at the END (video at last unless the primary news item)', () => {
    const outcome = plan([
      photo({ role: 'gameplay', canonicalUrl: 'https://cdn.example.com/media/g.jpg' }),
      video({ canonicalUrl: 'https://cdn.example.com/media/v.mp4' }),
      photo({ role: 'cover_key_art', canonicalUrl: 'https://cdn.example.com/media/c.jpg' }),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.items.map((item) => item.candidate.kind)).toEqual([
      'photo',
      'photo',
      'video',
    ]);
  });

  it('relevance primary ALONE promotes nothing — only videoAsPrimaryNews moves the video to the front', () => {
    const outcome = plan([
      photo({ role: 'cover_key_art', canonicalUrl: 'https://cdn.example.com/media/c.jpg' }),
      video({ relevance: 'primary', canonicalUrl: 'https://cdn.example.com/media/v.mp4' }),
      photo({ role: 'gameplay', canonicalUrl: 'https://cdn.example.com/media/g.jpg' }),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.items[2]?.candidate.kind).toBe('video');
  });

  it('videoAsPrimaryNews promotes the comparator-best video to the FRONT', () => {
    const outcome = plan(
      [
        photo({ role: 'cover_key_art', canonicalUrl: 'https://cdn.example.com/media/c.jpg' }),
        video({ canonicalUrl: 'https://cdn.example.com/media/v.mp4' }),
        photo({ role: 'gameplay', canonicalUrl: 'https://cdn.example.com/media/g.jpg' }),
      ],
      { videoAsPrimaryNews: true },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.items[0]?.candidate.kind).toBe('video');
    expect(outcome.plan.items.map((item) => item.candidate.kind)).toEqual([
      'video',
      'photo',
      'photo',
    ]);
  });
});

describe('the visual-similarity cap (≤2 per opaque visualKey — typed exclusions, never silent drops)', () => {
  it('three photos sharing ONE visualKey: the first two stay, the third is EXCLUDED typed', () => {
    const outcome = plan([
      photo({ visualKey: 'same-shot', canonicalUrl: 'https://cdn.example.com/media/1.jpg' }),
      photo({ visualKey: 'same-shot', canonicalUrl: 'https://cdn.example.com/media/2.jpg' }),
      photo({ visualKey: 'same-shot', canonicalUrl: 'https://cdn.example.com/media/3.jpg' }),
      photo({ visualKey: 'different', canonicalUrl: 'https://cdn.example.com/media/4.jpg' }),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.items).toHaveLength(3);
    expect(outcome.plan.excluded).toEqual([
      { canonicalUrl: 'https://cdn.example.com/media/3.jpg', reason: 'visually_similar_cap' },
    ]);
  });

  it('two per key is allowed (the cap boundary)', () => {
    const outcome = plan([
      photo({ visualKey: 'same-shot', canonicalUrl: 'https://cdn.example.com/media/1.jpg' }),
      photo({ visualKey: 'same-shot', canonicalUrl: 'https://cdn.example.com/media/2.jpg' }),
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.items).toHaveLength(2);
    expect(outcome.plan.excluded).toEqual([]);
  });
});

describe('the album size cap (maximum 10 — policy-ordered truncation with typed exclusions)', () => {
  // Zero-padded names so the lexicographic tiebreak equals the numeric order.
  const twelve = Array.from({ length: 12 }, (_, index) =>
    photo({
      canonicalUrl: `https://cdn.example.com/media/p${String(index).padStart(2, '0')}.jpg`,
      role: 'gameplay',
    }),
  );

  it('12 candidates ⇒ exactly 10 items + 2 typed exclusions (never silent, never a failure)', () => {
    const outcome = plan(twelve);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.mode).toBe('album');
    expect(outcome.plan.items).toHaveLength(10);
    expect(outcome.plan.excluded).toEqual([
      { canonicalUrl: 'https://cdn.example.com/media/p10.jpg', reason: 'album_size_cap' },
      { canonicalUrl: 'https://cdn.example.com/media/p11.jpg', reason: 'album_size_cap' },
    ]);
  });

  it('exactly 10 is inside the cap with zero exclusions', () => {
    const ten = twelve.slice(0, 10);
    const outcome = plan(ten);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.items).toHaveLength(10);
    expect(outcome.plan.excluded).toEqual([]);
  });
});

describe('the input contract violations (typed whole-plan failures)', () => {
  it('a duplicate canonicalUrl fails the WHOLE plan (duplicate_media_candidates)', () => {
    expect(
      plan([
        photo({ canonicalUrl: 'https://cdn.example.com/media/same.jpg' }),
        photo({ canonicalUrl: 'https://cdn.example.com/media/same.jpg', role: 'concept_art' }),
      ]),
    ).toMatchObject({ ok: false, reason: 'duplicate_media_candidates' });
  });

  it('a duplicate contentHash fails the WHOLE plan even when the URLs differ', () => {
    expect(
      plan([
        photo({ contentHash: 'hash-1', canonicalUrl: 'https://cdn.example.com/media/a.jpg' }),
        photo({ contentHash: 'hash-1', canonicalUrl: 'https://cdn.example.com/media/b.jpg' }),
      ]),
    ).toMatchObject({ ok: false, reason: 'duplicate_media_candidates' });
  });

  it('an INVALID candidate in the input is re-validated and fails typed (defense in depth)', () => {
    expect(
      planAlbumMedia({
        candidates: [
          {
            schemaVersion: 1,
            kind: 'photo',
            role: 'video', // role/kind mismatch — invalid even though the type compiles
            origin: 'official_api',
            officiality: 'official',
            relevance: 'supporting',
            freshness: 'recent',
            canonicalUrl: 'https://cdn.example.com/media/a.jpg',
            previouslyUsed: false,
          },
        ],
      }),
    ).toMatchObject({ ok: false, reason: 'candidate_malformed' });
  });
});

describe('the caption ordinal invariant (the 7.1 no-separation layer EXTENDED — never weakened)', () => {
  it('captionAllowed is true ONLY at ordinal 0, false on every other item', () => {
    const outcome = plan(
      Array.from({ length: 6 }, (_, index) =>
        photo({ canonicalUrl: `https://cdn.example.com/media/c${index}.jpg` }),
      ),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.captionOrdinal).toBe(0);
    outcome.plan.items.forEach((item, ordinal) => {
      expect(item.ordinal).toBe(ordinal);
      expect(item.captionAllowed).toBe(ordinal === 0);
    });
  });

  it('the plan record carries the fixed version labels and NO accuracy vocabulary', () => {
    const outcome = plan([photo(), video()]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.schemaVersion).toBe(1);
    expect(outcome.plan.planningVersion).toBe('alp1');
    const keys = JSON.stringify(outcome.plan).toLowerCase();
    expect(keys).not.toContain('score');
    expect(keys).not.toContain('percent');
    expect(keys).not.toContain('confidence');
  });
});

describe('the determinism contract (the SAME input ALWAYS yields the SAME plan)', () => {
  it('two runs over identical input are JSON-equal', () => {
    const raw = [
      photo({
        role: 'concept_art',
        visualKey: 'kv',
        canonicalUrl: 'https://cdn.example.com/media/a.jpg',
      }),
      photo({ role: 'cover_key_art', canonicalUrl: 'https://cdn.example.com/media/b.jpg' }),
      video({ visualKey: 'kv2', canonicalUrl: 'https://cdn.example.com/media/v.mp4' }),
      photo({
        role: 'gameplay',
        visualKey: 'kv',
        canonicalUrl: 'https://cdn.example.com/media/c.jpg',
      }),
    ];
    const first = plan(raw, { officialVideoLink: 'https://youtube.com/watch?v=x' });
    const second = plan(raw, { officialVideoLink: 'https://youtube.com/watch?v=x' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(first.plan)).toBe(JSON.stringify(second.plan));
  });
});
