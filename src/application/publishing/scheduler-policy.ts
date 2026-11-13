/**
 * Phase 8.2 — the scheduler's PURE policy pieces.
 *
 * 1. `mapContentTypeToMixCategory` — the TOTAL, EXPLICIT map from the closed
 *    24-label `stories.content_type` vocabulary (migration 0001) onto the
 *    closed ten-label mix vocabulary of arp1. Every label maps; every
 *    unknown label fails typed — a future vocabulary growth can never be
 *    silently miscategorized into a wrong mix cell. The map is the labeled
 *    correspondence the blueprint §16 mix section names (each mix label
 *    concatenates exactly the content-type labels it covers); it introduces
 *    NO weights, NO scores and NO new policy numbers.
 *
 * 2. `deriveDeterministicJitterMs` / `scanJitterForCandidate` — the
 *    per-candidate deterministic humanizing jitter. The DOMAIN has no
 *    randomness (the 8.1 rule); the jitter is ALWAYS a caller-supplied
 *    validated input. The scheduler derives it from a hash of the candidate
 *    id positioned inside the candidate's class band — reproducible,
 *    bounded, spread across candidates (the anti-robot intent), and
 *    cross-validated by the unit suite: for EVERY class and context
 *    combination the derived jitter is accepted by the real psp1
 *    `planPublicationTime` (never jitter_out_of_bounds).
 *
 * Pure: no I/O, no clock, no SQL, no randomness; JSON-equal deterministic.
 */

import {
  classifyPriority,
  type PublicationPriorityClass,
} from '../../domain/publishing/priority-classes';
import type { MixCategory } from '../../domain/publishing/anti-robot';

/** The explicit 24 -> 10 correspondence (reviewable data, never inference). */
const CONTENT_TYPE_TO_MIX: Readonly<Record<string, MixCategory>> = {
  crack_status: 'crack_drm',
  drm_update: 'crack_drm',
  leak: 'leak_rumor',
  rumor: 'leak_rumor',
  mod: 'mods',
  emulator: 'emulator_homebrew_jailbreak',
  homebrew: 'emulator_homebrew_jailbreak',
  jailbreak: 'emulator_homebrew_jailbreak',
  official_news: 'mainstream_industry',
  breaking: 'mainstream_industry',
  industry: 'mainstream_industry',
  analysis: 'mainstream_industry',
  community: 'mainstream_industry',
  release: 'release_trailer_patch_dlc',
  trailer: 'release_trailer_patch_dlc',
  patch: 'release_trailer_patch_dlc',
  dlc: 'release_trailer_patch_dlc',
  gameplay: 'release_trailer_patch_dlc',
  mobile: 'mobile',
  hardware: 'hardware',
  free_game: 'free_discount_indie',
  discount: 'free_discount_indie',
  indie: 'free_discount_indie',
  esports: 'esports',
};

export type MixCategoryMapResult =
  | { readonly ok: true; readonly category: MixCategory }
  | { readonly ok: false; readonly reason: 'unknown_content_type' };

export function mapContentTypeToMixCategory(contentType: string): MixCategoryMapResult {
  if (typeof contentType !== 'string') {
    return { ok: false, reason: 'unknown_content_type' };
  }
  const mapped = CONTENT_TYPE_TO_MIX[contentType];
  if (mapped === undefined) {
    return { ok: false, reason: 'unknown_content_type' };
  }
  return { ok: true, category: mapped };
}

/**
 * The gap/latency bands. The gap bands are the EXPORTED arp1 constants' own
 * values; the P1 latency band mirrors psp1's private constants — the unit
 * suite's CROSS-VALIDATION against the real psp1 is the standing guard (a
 * psp1 bound change makes the cross-validation fail loudly).
 */
const P1_LATENCY_BAND_MIN_MS = 5 * 60_000;
const P1_LATENCY_BAND_MAX_MS = 20 * 60_000;
const NORMAL_GAP_BAND_MIN_MS = 25 * 60_000;
const NORMAL_GAP_BAND_MAX_MS = 45 * 60_000;
const ANTI_FLOOD_BAND_MIN_MS = 2 * 60_000;
const ANTI_FLOOD_BAND_MAX_MS = 4 * 60_000;

type JitterBand = { readonly minMs: number; readonly maxMs: number };

function bandFor(input: {
  readonly priorityClass: PublicationPriorityClass;
  readonly hasPreviousSend: boolean;
  readonly related: boolean;
}): JitterBand | null {
  if (!input.hasPreviousSend) {
    // No previous send: the arp1 gap rule yields zero regardless of the
    // jitter — EXCEPT P1, whose latency band is validated unconditionally
    // by psp1.
    if (input.priorityClass === 'P1') {
      return { minMs: P1_LATENCY_BAND_MIN_MS, maxMs: P1_LATENCY_BAND_MAX_MS };
    }
    return null;
  }
  if (input.priorityClass === 'P0' && !input.related) {
    return { minMs: ANTI_FLOOD_BAND_MIN_MS, maxMs: ANTI_FLOOD_BAND_MAX_MS };
  }
  if (input.priorityClass === 'P1') {
    return { minMs: P1_LATENCY_BAND_MIN_MS, maxMs: P1_LATENCY_BAND_MAX_MS };
  }
  return { minMs: NORMAL_GAP_BAND_MIN_MS, maxMs: NORMAL_GAP_BAND_MAX_MS };
}

/** One deterministic 32-bit position from the candidate id (FNV-1a — stable across runtimes, no Math.random). */
function hashPosition(candidateId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < candidateId.length; index += 1) {
    hash ^= candidateId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export type JitterDerivationInput = {
  readonly candidateId: string;
  readonly priorityClass: PublicationPriorityClass;
  readonly hasPreviousSend: boolean;
  readonly related: boolean;
};

/**
 * The deterministic per-candidate jitter: a stable hash position of the
 * candidate id mapped into the candidate's band. JSON-equal deterministic,
 * spread across candidates, always inside the band (or exactly 0 when the
 * gap rule ignores the jitter).
 */
export function deriveDeterministicJitterMs(input: JitterDerivationInput): number {
  const band = bandFor(input);
  if (band === null) {
    return 0;
  }
  const span = band.maxMs - band.minMs;
  const position = hashPosition(input.candidateId) / 0x1_0000_0000;
  return band.minMs + Math.floor(position * (span + 1));
}

export type ScanJitterResult =
  | {
      readonly ok: true;
      readonly jitterMs: number;
      readonly priorityClass: PublicationPriorityClass;
    }
  | { readonly ok: false; readonly reason: 'invalid_score' };

/**
 * Compose classifyPriority + the derivation from the raw durable score (the
 * publications.priority column). An invalid score fails typed — the
 * scheduler never fabricates a class.
 */
export function scanJitterForCandidate(input: {
  readonly candidateId: string;
  readonly priorityScore: number;
  readonly hasPreviousSend: boolean;
  readonly related: boolean;
}): ScanJitterResult {
  const classified = classifyPriority(input.priorityScore);
  if (!classified.ok) {
    return { ok: false, reason: 'invalid_score' };
  }
  const jitterMs = deriveDeterministicJitterMs({
    candidateId: input.candidateId,
    priorityClass: classified.value.class,
    hasPreviousSend: input.hasPreviousSend,
    related: input.related,
  });
  return { ok: true, jitterMs, priorityClass: classified.value.class };
}
