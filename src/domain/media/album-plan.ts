/**
 * Phase 7.2 — ALBUM PLANNING (blueprint §14 steps 6–8 + the Default
 * album policy): a TOTAL, DETERMINISTIC, PURE planning derivation over
 * already-validated media candidates.
 *
 * THE DERIVED SELECT MODE (never guessed, never inferred from vibes):
 *   0 candidates + no link            ⇒ 'none'
 *   0 candidates + an official link   ⇒ 'official_video_link'
 *   1 item                            ⇒ 'single'  (never a 1-item album)
 *   2..10 items                       ⇒ 'album'
 *   over 10                           ⇒ the policy-ordered top 10, the
 *                                       remainder EXCLUDED typed
 *                                       ('album_size_cap') — never
 *                                       silently dropped, never a failure
 *
 * THE ORDERING POLICY (blueprint Default album policy, deterministic):
 *   cover/key art first → gameplay → other screenshots → concept art
 *   (the story layer may swap gameplay/concept ONLY via the explicit
 *   `storyDemandsConceptBeforeGameplay` input flag — never an
 *   inference) → non-primary videos at the END; `videoAsPrimaryNews`
 *   promotes the comparator-best video to the FRONT (relevance
 *   'primary' ALONE promotes NOTHING — the story layer decides).
 *
 * THE PRESERVATION CONDITIONS (carried from 7.1, binding):
 *   - the caption rides ONLY ordinal 0 (`captionAllowed` true at
 *     ordinal 0, false everywhere else) — the no-separation layer
 *     EXTENDED to the album plan, never weakened;
 *   - the ≤2-per-`visualKey` cap is a typed policy over the OPAQUE key
 *     (a deterministic proxy — NEVER an accuracy claim about what the
 *     images actually depict);
 *   - every excluded candidate carries a typed reason — exclusions are
 *     visible, not silent;
 *   - a YouTube URL is admissible HERE only as a LINK (the
 *     official_video_link mode) — the download ban (media-rights) is
 *     untouched: linking is not downloading.
 *
 * THE INPUT CONTRACT: candidates are re-validated (defense in depth);
 * duplicate canonicalUrl OR duplicate contentHash is an INPUT contract
 * violation and fails the WHOLE plan typed.
 *
 * THE HONEST TARGET NOTE: the blueprint's 3–6 "target" is guidance for
 * the COLLECTORS (how many candidates to propose) — the planner NEVER
 * pads a plan to reach it (2 real candidates ⇒ an album of 2, never a
 * fabricated filler). This module BUILDS NO persisted album kind and
 * sends NOTHING: the album media kind and the upload path are 7.3.
 *
 * BOUNDARY: pure — no I/O, no clock, no network, no Telegram/R2 types.
 */

import {
  canonicalizeMediaUrl,
  compareMediaCandidates,
  readMediaCandidateV1,
  type MediaCandidateV1,
} from './media-candidate';

export type MediaSelectModeV1 = 'none' | 'single' | 'album' | 'official_video_link';

export interface PlannedMediaItemV1 {
  readonly ordinal: number;
  readonly candidate: MediaCandidateV1;
  /** TRUE only at ordinal 0 — the no-separation layer, extended. */
  readonly captionAllowed: boolean;
}

export interface MediaAlbumExclusionV1 {
  readonly canonicalUrl: string;
  readonly reason: 'visually_similar_cap' | 'album_size_cap';
}

export interface MediaAlbumPlanV1 {
  readonly schemaVersion: 1;
  readonly planningVersion: 'alp1';
  readonly mode: MediaSelectModeV1;
  readonly items: readonly PlannedMediaItemV1[];
  /** 0 when items exist (the caption's ONLY legal ordinal), null otherwise. */
  readonly captionOrdinal: 0 | null;
  readonly excluded: readonly MediaAlbumExclusionV1[];
  /** The canonical official-video link companion (never merged into a group). */
  readonly companionOfficialLink?: string;
}

export interface AlbumPlanningInputV1 {
  readonly candidates: readonly MediaCandidateV1[];
  /** The official video LINK (link-only mode; never downloaded). */
  readonly officialVideoLink?: string | null;
  /** The story layer's explicit promotion of the video to the primary item. */
  readonly videoAsPrimaryNews?: boolean;
  /** The story layer's explicit gameplay/concept order override. */
  readonly storyDemandsConceptBeforeGameplay?: boolean;
}

export type AlbumPlanReasonV1 =
  'candidate_malformed' | 'duplicate_media_candidates' | 'official_video_link_invalid';

export type AlbumPlanOutcome =
  { ok: true; plan: MediaAlbumPlanV1 } | { ok: false; reason: AlbumPlanReasonV1 };

const ALBUM_MAX_ITEMS = 10;
const VISUALLY_SIMILAR_CAP = 2;

export function planAlbumMedia(input: AlbumPlanningInputV1): AlbumPlanOutcome {
  // 0. The input SHAPE gate (fail-closed): garbage input (a raw array, a
  //    null, a missing candidates list) is a typed failure — never a
  //    silently-EMPTY 'none' plan (the silent-none would launder a caller
  //    bug into a valid-looking outcome).
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    !Array.isArray(input.candidates)
  ) {
    return { ok: false, reason: 'candidate_malformed' };
  }
  // 1. Re-validate EVERY input candidate (defense in depth).
  const candidates: MediaCandidateV1[] = [];
  for (const raw of input.candidates ?? []) {
    const read = readMediaCandidateV1(raw);
    if (!read.ok) return { ok: false, reason: 'candidate_malformed' };
    candidates.push(read.candidate);
  }

  // 2. The input dedup contract (same URL or same contentHash twice ⇒ typed failure).
  const seenUrls = new Set<string>();
  const seenHashes = new Set<string>();
  for (const candidate of candidates) {
    if (seenUrls.has(candidate.canonicalUrl))
      return { ok: false, reason: 'duplicate_media_candidates' };
    seenUrls.add(candidate.canonicalUrl);
    if (candidate.contentHash !== undefined) {
      if (seenHashes.has(candidate.contentHash))
        return { ok: false, reason: 'duplicate_media_candidates' };
      seenHashes.add(candidate.contentHash);
    }
  }

  // 3. The official video LINK (admissible as a LINK; never a download).
  let companionOfficialLink: string | undefined;
  if (typeof input.officialVideoLink === 'string' && input.officialVideoLink.length > 0) {
    const canonical = canonicalizeMediaUrl(input.officialVideoLink);
    if (!canonical.ok) return { ok: false, reason: 'official_video_link_invalid' };
    companionOfficialLink = canonical.url;
  }

  // 4. The deterministic candidate order (the TOTAL comparator), then the
  //    visual-similarity cap (photos only, ≤2 per opaque key, typed exclusions).
  const sorted = [...candidates].sort(compareMediaCandidates);
  const excluded: MediaAlbumExclusionV1[] = [];
  const keyCounts = new Map<string, number>();
  const kept: MediaCandidateV1[] = [];
  for (const candidate of sorted) {
    if (candidate.kind === 'photo' && candidate.visualKey !== undefined) {
      const count = keyCounts.get(candidate.visualKey) ?? 0;
      keyCounts.set(candidate.visualKey, count + 1);
      if (count >= VISUALLY_SIMILAR_CAP) {
        excluded.push({ canonicalUrl: candidate.canonicalUrl, reason: 'visually_similar_cap' });
        continue;
      }
    }
    kept.push(candidate);
  }

  // 5. The policy ordering (buckets; the comparator order survives inside
  //    each bucket because `kept` is comparator-sorted and sort is stable).
  if (kept.length >= 2) {
    const primaryVideo =
      input.videoAsPrimaryNews === true
        ? kept.find((candidate) => candidate.kind === 'video')
        : undefined;
    const bucketOf = (candidate: MediaCandidateV1): number => {
      if (candidate.kind === 'video') {
        return candidate === primaryVideo ? -1 : 4;
      }
      switch (candidate.role) {
        case 'cover_key_art':
          return 0;
        case 'concept_art':
          return input.storyDemandsConceptBeforeGameplay === true ? 1 : 3;
        case 'gameplay':
          return input.storyDemandsConceptBeforeGameplay === true ? 3 : 1;
        case 'other_screenshot':
          return 2;
        case 'video':
          return 4;
      }
    };
    kept.sort((a, b) => bucketOf(a) - bucketOf(b));
  }

  // 6. The size cap (10): the policy-ordered top 10 stay, the rest excluded typed.
  const selected = kept.slice(0, ALBUM_MAX_ITEMS);
  for (const candidate of kept.slice(ALBUM_MAX_ITEMS)) {
    excluded.push({ canonicalUrl: candidate.canonicalUrl, reason: 'album_size_cap' });
  }

  // 7. The DERIVED mode (from the final selection — never guessed).
  const mode: MediaSelectModeV1 =
    selected.length === 0
      ? companionOfficialLink !== undefined
        ? 'official_video_link'
        : 'none'
      : selected.length === 1
        ? 'single'
        : 'album';

  const plan: MediaAlbumPlanV1 = {
    schemaVersion: 1,
    planningVersion: 'alp1',
    mode,
    items: selected.map((candidate, ordinal) => ({
      ordinal,
      candidate,
      captionAllowed: ordinal === 0,
    })),
    captionOrdinal: selected.length > 0 ? 0 : null,
    excluded,
    ...(companionOfficialLink !== undefined ? { companionOfficialLink } : {}),
  };
  return { ok: true, plan };
}
