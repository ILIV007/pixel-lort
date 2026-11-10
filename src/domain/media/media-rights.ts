/**
 * Phase 7.2 — the RIGHTS policy decision (blueprint §14 steps 3–4 +
 * architecture decision 5 + the 7.1 binding conditions).
 *
 * A TOTAL typed decision function: every input yields a decision
 * (allow_temporary / reject / defer) with a typed reason and the fixed
 * policy version — never a boolean, never an exception, never a
 * partial answer, never a guessed continuation.
 *
 * THE RULES (in the DOCUMENTED, TESTED precedence order):
 * 1. URL admissibility — the candidate URL must canonicalize under the
 *    media-candidate https-only discipline (a failure ⇒
 *    `url_not_admissible`);
 * 2. the YouTube DOWNLOAD ban — the 7.1 binding is STRICTER than the
 *    blueprint's audiovisual-only clause: EVERY YouTube-family host
 *    (youtube.com / youtu.be / youtube-nocookie.com / googlevideo.com
 *    and their subdomains) is OUTSIDE ANY download permission. YouTube
 *    is reachable only as a LINK (album-plan's official_video_link mode
 *    — linking is not downloading);
 * 3. the host policy (SSRF posture) — media hosts must be PUBLIC DNS
 *    names: IP literals (v4 and bracketed v6) and the local-name
 *    families (localhost / .localhost / .local / .internal) are
 *    forbidden outright;
 * 4. the MIME allowlist — EXACTLY the four Bot-API media shapes
 *    (image/jpeg, image/png, image/webp, video/mp4). Executables,
 *    archives, documents, markup, every unknown class are OUTSIDE the
 *    allowlist and rejected with ONE typed reason — nothing is
 *    enumerated because nothing else is permitted;
 * 5. the byte caps — the DOCUMENTED Telegram Bot API contract limits
 *    (photo 10 MiB, video 50 MiB). An UNKNOWN size does NOT sneak
 *    through: the allow decision carries `byteCapUnchecked: true` so
 *    the adapter must enforce the cap on the stream;
 * 6. the redirect cap (3);
 * 7. the rights states — unknown / restricted / piracy_indicated REJECT;
 *    CONFLICTING rights metadata DEFERS (`rights_ambiguous`, the 7.1
 *    ambiguous⇒defer rule). A hard rejection outranks a conflict flag.
 *
 * THE ALLOW IS STRICTLY SCOPED: destination is ALWAYS
 * `r2_temporary_only` — a rights clearance NEVER grants a publish. The
 * file_id-reuse and upload decisions belong to 7.3.
 *
 * BOUNDARY: pure — no fetch, no I/O, no clock; the adapter measures real
 * usage (the Phase 6 gate condition: no accuracy claims).
 */

import { canonicalizeMediaUrl } from './media-candidate';

export type MediaRightsStateV1 =
  | 'official_api'
  | 'owner_granted'
  | 'source_metadata_cleared'
  | 'unknown'
  | 'restricted'
  | 'piracy_indicated';

export interface MediaRightsInputV1 {
  readonly rightsState: MediaRightsStateV1;
  /** Conflicting rights metadata across provenance records (the defer input). */
  readonly rightsConflict?: boolean;
  readonly mime: string;
  readonly byteSize?: number;
  readonly redirectCount?: number;
  /** Raw URL — canonicalized under the media-candidate discipline inside. */
  readonly url: string;
}

export type MediaRightsReasonV1 =
  | 'rights_cleared_and_policy_compliant'
  | 'url_not_admissible'
  | 'youtube_download_forbidden'
  | 'host_policy_forbidden'
  | 'mime_not_allowed'
  | 'byte_cap_exceeded'
  | 'redirect_cap_exceeded'
  | 'rights_unknown'
  | 'rights_restricted'
  | 'piracy_indicated'
  | 'rights_ambiguous';

export type MediaRightsDecisionV1 =
  | {
      readonly decision: 'allow_temporary';
      readonly reason: Extract<MediaRightsReasonV1, 'rights_cleared_and_policy_compliant'>;
      readonly destination: 'r2_temporary_only';
      readonly byteCapUnchecked: boolean;
      readonly policyVersion: 'mrp1';
    }
  | {
      readonly decision: 'reject';
      readonly reason: Exclude<
        MediaRightsReasonV1,
        'rights_cleared_and_policy_compliant' | 'rights_ambiguous'
      >;
      readonly policyVersion: 'mrp1';
    }
  | {
      readonly decision: 'defer';
      readonly reason: Extract<MediaRightsReasonV1, 'rights_ambiguous'>;
      readonly policyVersion: 'mrp1';
    };

/** The FIXED fetch policy contract (constants — no magic numbers at call sites). */
export const MEDIA_FETCH_POLICY_V1 = {
  policyVersion: 'mrp1',
  httpsOnly: true,
  maxRedirects: 3,
  maxPhotoBytes: 10 * 1024 * 1024,
  maxVideoBytes: 50 * 1024 * 1024,
  allowedMimes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'],
  youtubeDownloadForbidden: true,
} as const;

const RIGHTS_STATES: readonly MediaRightsStateV1[] = [
  'official_api',
  'owner_granted',
  'source_metadata_cleared',
  'unknown',
  'restricted',
  'piracy_indicated',
];

const YOUTUBE_FAMILY = ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com'];

function isYoutubeHost(host: string): boolean {
  return YOUTUBE_FAMILY.some((family) => host === family || host.endsWith(`.${family}`));
}

function isForbiddenHost(host: string): boolean {
  // IP literals (v4 dotted-quad or a bracketed v6) and the local-name
  // families are forbidden outright — public DNS names only.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (/^\[.+\]$/.test(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  return false;
}

function isAllowedMime(mime: string): boolean {
  if (typeof mime !== 'string') return false;
  const normalized = mime.trim().toLowerCase();
  return (MEDIA_FETCH_POLICY_V1.allowedMimes as readonly string[]).includes(normalized);
}

/**
 * The total rights-policy decision (the documented precedence: URL >
 * YouTube ban > host policy > MIME > byte cap > redirect cap > rights).
 */
export function decideMediaRights(input: MediaRightsInputV1): MediaRightsDecisionV1 {
  const reject = (
    reason: Extract<
      MediaRightsReasonV1,
      | 'youtube_download_forbidden'
      | 'host_policy_forbidden'
      | 'mime_not_allowed'
      | 'byte_cap_exceeded'
      | 'redirect_cap_exceeded'
      | 'rights_unknown'
      | 'rights_restricted'
      | 'piracy_indicated'
      | 'url_not_admissible'
    >,
  ): MediaRightsDecisionV1 => ({
    decision: 'reject',
    reason,
    policyVersion: MEDIA_FETCH_POLICY_V1.policyVersion,
  });

  // 1. URL admissibility (the https-only canonical discipline).
  const canonical = canonicalizeMediaUrl(typeof input.url === 'string' ? input.url : '');
  if (!canonical.ok) return reject('url_not_admissible');
  // The canonical form is https://<host>[:port]<path> — strip any port
  // before the host-policy checks so a nonstandard port cannot dodge them.
  // A bracketed IPv6 literal is NOT port-split (the colon-stripper would
  // otherwise chop the address itself and let it through the policy).
  const hostPart = (canonical.url.split('/')[2] ?? '').toLowerCase();
  const host = hostPart.startsWith('[') ? hostPart : (hostPart.split(':')[0] ?? '');

  // 2. the YouTube download ban (the 7.1 binding).
  if (isYoutubeHost(host)) return reject('youtube_download_forbidden');

  // 3. the host policy (SSRF posture).
  if (host === '' || isForbiddenHost(host)) return reject('host_policy_forbidden');

  // 4. the MIME allowlist.
  if (!isAllowedMime(input.mime)) return reject('mime_not_allowed');

  // 5. the byte caps (mime determines which cap; unknown size ⇒ unchecked flag).
  const normalizedMime = typeof input.mime === 'string' ? input.mime.trim().toLowerCase() : '';
  const isVideo = normalizedMime.startsWith('video/');
  const cap = isVideo ? MEDIA_FETCH_POLICY_V1.maxVideoBytes : MEDIA_FETCH_POLICY_V1.maxPhotoBytes;
  let byteCapUnchecked = false;
  if (input.byteSize === undefined) {
    byteCapUnchecked = true;
  } else if (
    typeof input.byteSize === 'number' &&
    Number.isFinite(input.byteSize) &&
    input.byteSize < 0
  ) {
    byteCapUnchecked = true;
  } else if (
    typeof input.byteSize === 'number' &&
    Number.isFinite(input.byteSize) &&
    input.byteSize > cap
  ) {
    return reject('byte_cap_exceeded');
  } else if (typeof input.byteSize !== 'number' || !Number.isFinite(input.byteSize)) {
    byteCapUnchecked = true;
  }

  // 6. the redirect cap.
  if (
    input.redirectCount !== undefined &&
    input.redirectCount > MEDIA_FETCH_POLICY_V1.maxRedirects
  ) {
    return reject('redirect_cap_exceeded');
  }

  // 7. the rights states (hard rejections outrank the conflict defer).
  const rightsState = RIGHTS_STATES.includes(input.rightsState) ? input.rightsState : 'unknown';
  if (rightsState === 'unknown') return reject('rights_unknown');
  if (rightsState === 'restricted') return reject('rights_restricted');
  if (rightsState === 'piracy_indicated') return reject('piracy_indicated');
  if (input.rightsConflict === true) {
    return {
      decision: 'defer',
      reason: 'rights_ambiguous',
      policyVersion: MEDIA_FETCH_POLICY_V1.policyVersion,
    };
  }

  return {
    decision: 'allow_temporary',
    reason: 'rights_cleared_and_policy_compliant',
    destination: 'r2_temporary_only',
    byteCapUnchecked,
    policyVersion: MEDIA_FETCH_POLICY_V1.policyVersion,
  };
}
