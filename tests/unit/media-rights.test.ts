/**
 * Phase 7.2 — the RIGHTS policy decision (the RED-first adversarial suite).
 *
 * Blueprint §14 step 4 + architecture decision 5 + the 7.1 binding
 * conditions, made TYPED and total: the decision function ALWAYS returns
 * a decision (reject / defer / allow) with a typed reason — never a
 * boolean, never an exception, never a partial answer:
 *
 * - the 7.1 binding is STRICTER than the blueprint's audiovisual-only
 *   clause: YouTube stays OUTSIDE ANY download permission (link-only);
 * - SSRF posture: media hosts must be public DNS names — IP literals and
 *   local-name families are forbidden outright;
 * - the MIME allowlist is the four Bot-API media shapes
 *   (image/jpeg, image/png, image/webp, video/mp4) — executables,
 *   archives, documents, html and every unknown class are outside it and
 *   rejected WITHOUT enumerating them;
 * - byte caps are the DOCUMENTED Telegram Bot API contract limits
 *   (photo 10 MiB, video 50 MiB) — contract inputs, not measured claims;
 * - unknown/restricted/piracy rights REJECT; CONFLICTING rights metadata
 *   DEFERS (`rights_ambiguous`) — the 7.1 honesty boundary;
 * - the allow decision is ALWAYS destination 'r2_temporary_only' —
 *   a rights clearance never grants a publish, only the temporary R2
 *   staging path (the file_id/upload decisions belong to 7.3).
 */

import { describe, expect, it } from 'vitest';

import {
  decideMediaRights,
  MEDIA_FETCH_POLICY_V1,
  type MediaRightsInputV1,
} from '../../src/domain/media/media-rights';

/** A policy-clean default input; individual tests mutate one field. */
function cleanInput(overrides: Partial<MediaRightsInputV1> = {}): MediaRightsInputV1 {
  return {
    rightsState: 'official_api',
    mime: 'image/jpeg',
    url: 'https://cdn.example.com/media/screenshot-1.jpg',
    byteSize: 1024,
    redirectCount: 0,
    ...overrides,
  };
}

describe('the fixed policy contract (constants, not magic numbers at call sites)', () => {
  it('pins the policy version and the fixed transport rules', () => {
    expect(MEDIA_FETCH_POLICY_V1.policyVersion).toBe('mrp1');
    expect(MEDIA_FETCH_POLICY_V1.httpsOnly).toBe(true);
    expect(MEDIA_FETCH_POLICY_V1.maxRedirects).toBe(3);
    expect(MEDIA_FETCH_POLICY_V1.maxPhotoBytes).toBe(10 * 1024 * 1024);
    expect(MEDIA_FETCH_POLICY_V1.maxVideoBytes).toBe(50 * 1024 * 1024);
    expect(MEDIA_FETCH_POLICY_V1.youtubeDownloadForbidden).toBe(true);
  });

  it('pins the exact MIME allowlist (the four Bot-API media shapes, nothing else)', () => {
    expect([...MEDIA_FETCH_POLICY_V1.allowedMimes]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
    ]);
  });
});

describe('the YouTube download ban (the 7.1 binding — stricter than blueprint §14 step 4)', () => {
  it('rejects EVERY YouTube-hosted download even with fully official rights', () => {
    for (const host of [
      'www.youtube.com',
      'youtube.com',
      'youtu.be',
      'www.youtube-nocookie.com',
      'rr1---sn-1.googlevideo.com',
      'googlevideo.com',
    ]) {
      const decision = decideMediaRights(cleanInput({ url: `https://${host}/watch?v=x` }));
      expect(decision.decision).toBe('reject');
      expect(decision.reason).toBe('youtube_download_forbidden');
    }
  });

  it('the ban outranks everything below it (youtube + unknown rights still youtube_download_forbidden)', () => {
    const decision = decideMediaRights(
      cleanInput({
        url: 'https://youtu.be/x.mp4',
        rightsState: 'unknown',
        mime: 'application/zip',
      }),
    );
    expect(decision.decision).toBe('reject');
    expect(decision.reason).toBe('youtube_download_forbidden');
  });
});

describe('the host policy (SSRF posture — public DNS names only)', () => {
  it('rejects IP-literal hosts outright (v4 and bracketed v6)', () => {
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.10', '169.254.169.254', '0.0.0.0']) {
      expect(decideMediaRights(cleanInput({ url: `https://${host}/media.jpg` }))).toMatchObject({
        decision: 'reject',
        reason: 'host_policy_forbidden',
      });
    }
    expect(decideMediaRights(cleanInput({ url: 'https://[::1]/media.jpg' }))).toMatchObject({
      decision: 'reject',
      reason: 'host_policy_forbidden',
    });
  });

  it('rejects localhost and the local/internal name families', () => {
    for (const host of [
      'localhost',
      'media.localhost',
      'server.local',
      'vault.internal',
      'metadata.google.internal',
    ]) {
      expect(decideMediaRights(cleanInput({ url: `https://${host}/media.jpg` }))).toMatchObject({
        decision: 'reject',
        reason: 'host_policy_forbidden',
      });
    }
  });

  it('a public DNS media host passes the host check', () => {
    const decision = decideMediaRights(cleanInput());
    expect(decision.decision).toBe('allow_temporary');
  });
});

describe('URL admissibility feeds the decision (canonicalization failures are typed rejects)', () => {
  it('a plain-http or unparseable URL rejects with url_not_admissible', () => {
    expect(
      decideMediaRights(cleanInput({ url: 'http://cdn.example.com/media.jpg' })),
    ).toMatchObject({
      decision: 'reject',
      reason: 'url_not_admissible',
    });
    expect(decideMediaRights(cleanInput({ url: 'not a url' }))).toMatchObject({
      decision: 'reject',
      reason: 'url_not_admissible',
    });
  });
});

describe('the MIME allowlist (executables/archives/documents are OUTSIDE it — rejected without enumeration)', () => {
  it('admits exactly the four allowed shapes (case-insensitive, trimmed)', () => {
    for (const mime of [
      'image/jpeg',
      'image/png',
      'image/webp',
      'video/mp4',
      'IMAGE/JPEG',
      ' video/mp4 ',
    ]) {
      expect(decideMediaRights(cleanInput({ mime })).decision).toBe('allow_temporary');
    }
  });

  it('rejects executable, archive, document, markup and unknown classes with ONE typed reason', () => {
    for (const mime of [
      'application/zip',
      'application/x-msdownload',
      'application/x-executable',
      'application/pdf',
      'text/html',
      'image/svg+xml',
      'image/gif',
      'video/webm',
      'application/octet-stream',
      '',
      'not-a-mime',
    ]) {
      expect(decideMediaRights(cleanInput({ mime }))).toMatchObject({
        decision: 'reject',
        reason: 'mime_not_allowed',
      });
    }
  });
});

describe('the byte caps (documented Telegram Bot API contract limits)', () => {
  it('photo cap: exactly 10 MiB passes, one byte over rejects', () => {
    expect(decideMediaRights(cleanInput({ byteSize: 10 * 1024 * 1024 })).decision).toBe(
      'allow_temporary',
    );
    expect(decideMediaRights(cleanInput({ byteSize: 10 * 1024 * 1024 + 1 }))).toMatchObject({
      decision: 'reject',
      reason: 'byte_cap_exceeded',
    });
  });

  it('video cap: exactly 50 MiB passes, one byte over rejects', () => {
    expect(
      decideMediaRights(cleanInput({ mime: 'video/mp4', byteSize: 50 * 1024 * 1024 })).decision,
    ).toBe('allow_temporary');
    expect(
      decideMediaRights(cleanInput({ mime: 'video/mp4', byteSize: 50 * 1024 * 1024 + 1 })),
    ).toMatchObject({ decision: 'reject', reason: 'byte_cap_exceeded' });
  });

  it('an UNKNOWN size does NOT sneak through: the decision flags byteCapUnchecked for the adapter', () => {
    const decision = decideMediaRights(cleanInput({ byteSize: undefined }));
    expect(decision.decision).toBe('allow_temporary');
    if (decision.decision !== 'allow_temporary') return expect.unreachable();
    expect(decision.byteCapUnchecked).toBe(true);
  });

  it('mime determines which cap applies (a video-sized image still hits the PHOTO cap)', () => {
    expect(
      decideMediaRights(cleanInput({ mime: 'image/png', byteSize: 40 * 1024 * 1024 })),
    ).toMatchObject({ decision: 'reject', reason: 'byte_cap_exceeded' });
  });
});

describe('the redirect cap', () => {
  it('0..3 redirects pass, 4 rejects', () => {
    expect(decideMediaRights(cleanInput({ redirectCount: 3 })).decision).toBe('allow_temporary');
    expect(decideMediaRights(cleanInput({ redirectCount: 4 }))).toMatchObject({
      decision: 'reject',
      reason: 'redirect_cap_exceeded',
    });
    expect(decideMediaRights(cleanInput({ redirectCount: undefined })).decision).toBe(
      'allow_temporary',
    );
  });
});

describe('the rights states (the honesty boundary — reject, defer, or a strictly-scoped allow)', () => {
  it('unknown rights REJECT (never guess, never proceed)', () => {
    expect(decideMediaRights(cleanInput({ rightsState: 'unknown' }))).toMatchObject({
      decision: 'reject',
      reason: 'rights_unknown',
    });
  });

  it('restricted rights REJECT; piracy indications REJECT harder', () => {
    expect(decideMediaRights(cleanInput({ rightsState: 'restricted' }))).toMatchObject({
      decision: 'reject',
      reason: 'rights_restricted',
    });
    expect(decideMediaRights(cleanInput({ rightsState: 'piracy_indicated' }))).toMatchObject({
      decision: 'reject',
      reason: 'piracy_indicated',
    });
  });

  it('CONFLICTING rights metadata DEFER with rights_ambiguous — the 7.1 ambiguous⇒defer rule', () => {
    const decision = decideMediaRights(
      cleanInput({ rightsState: 'source_metadata_cleared', rightsConflict: true }),
    );
    expect(decision.decision).toBe('defer');
    expect(decision.reason).toBe('rights_ambiguous');
  });

  it('a hard rejection outranks a conflict flag (restricted + conflict ⇒ restricted reject)', () => {
    expect(
      decideMediaRights(cleanInput({ rightsState: 'restricted', rightsConflict: true })),
    ).toMatchObject({
      decision: 'reject',
      reason: 'rights_restricted',
    });
  });

  it('each cleared state allows ONLY the r2_temporary_only destination (never a publish grant)', () => {
    for (const rightsState of [
      'official_api',
      'owner_granted',
      'source_metadata_cleared',
    ] as const) {
      const decision = decideMediaRights(cleanInput({ rightsState }));
      expect(decision.decision).toBe('allow_temporary');
      if (decision.decision !== 'allow_temporary') return expect.unreachable();
      expect(decision.destination).toBe('r2_temporary_only');
    }
  });
});

describe('the documented precedence is deterministic (transport first, then rights)', () => {
  it('mime beats rights (bad mime + unknown rights ⇒ mime_not_allowed)', () => {
    expect(
      decideMediaRights(cleanInput({ mime: 'application/zip', rightsState: 'unknown' })),
    ).toMatchObject({
      decision: 'reject',
      reason: 'mime_not_allowed',
    });
  });

  it('byte cap beats redirect cap (both over ⇒ byte_cap_exceeded)', () => {
    expect(
      decideMediaRights(cleanInput({ byteSize: 99 * 1024 * 1024, redirectCount: 9 })),
    ).toMatchObject({ decision: 'reject', reason: 'byte_cap_exceeded' });
  });

  it('host policy beats mime (youtube + bad mime ⇒ youtube_download_forbidden — already pinned)', () => {
    expect(
      decideMediaRights(cleanInput({ url: 'https://youtube.com/x', mime: 'application/zip' })),
    ).toMatchObject({ decision: 'reject', reason: 'youtube_download_forbidden' });
  });

  it('every decision echoes the policy version mrp1 and a typed reason (never a bare boolean)', () => {
    const decisions = [
      decideMediaRights(cleanInput()),
      decideMediaRights(cleanInput({ rightsState: 'unknown' })),
      decideMediaRights(cleanInput({ rightsConflict: true })),
      decideMediaRights(cleanInput({ mime: 'application/pdf' })),
    ];
    for (const decision of decisions) {
      expect(decision.policyVersion).toBe('mrp1');
      expect(typeof decision.reason).toBe('string');
      expect(['allow_temporary', 'reject', 'defer']).toContain(decision.decision);
    }
  });
});
