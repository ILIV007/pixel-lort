import { describe, expect, it } from 'vitest';
import blueprintRegistry from '../../docs/blueprint/v1/pixel_source_registry_v1.json';
import { parseEmbeddedRegistry } from '../../src/domain/source/source-registry';
import { TARGET_CHANNEL_PATTERN } from '../../src/shared/config/phase2';
import { createRssConnector } from '../../src/connectors/rss';
import { createGithubReleasesConnector } from '../../src/connectors/github-releases';
import { createRedditOauthConnector } from '../../src/connectors/reddit-oauth';
import { createFetchMock, connectorEffects } from '../helpers/fetch-mock';

/**
 * Owner channel identity (rename slice, 2026-11-20): the public CHANNEL is
 * "Pixel lore's" (@pixellores, https://t.me/pixellores). The Telegram
 * bot/persona ("Pixel"), repository slug, and Cloudflare resource names are
 * deliberately NOT renamed (owner instruction — channel ≠ bot ≠ resources).
 *
 * Positive branding contract:
 *   1. the new target handle satisfies the existing non-secret config
 *      validation contract (ADR-0009 — no new validation rule introduced);
 *   2. the live-consumed source registry brand block (channelUsername /
 *      footerHtml href AND label) agrees with the owner identity and keeps
 *      the bot persona intact;
 *   3. channel-facing outbound contact URLs (connector User-Agent strings)
 *      carry the new identity on every request (behavioral, via the scripted
 *      SafeFetch fake — no live network, AGENTS.md §4).
 *
 * Known frozen divergence: docs/blueprint/v1/ is preserved verbatim
 * (AGENTS.md §6), so the registry's brand.channelName still carries the
 * pre-rename display form. It is NOT asserted against the live display
 * name below — the divergence test pins that the two differ, so a future
 * unfreezing of the blueprint forces this test to be re-aligned.
 */

const OWNER_CHANNEL_NAME = "Pixel lore's";
const OWNER_CHANNEL_USERNAME = '@pixellores';
const OWNER_CHANNEL_URL = 'https://t.me/pixellores';
const BOT_PERSONA = 'Pixel';

describe('owner channel identity — target handle validation contract', () => {
  it('accepts the new @pixellores handle under the existing pattern', () => {
    expect(TARGET_CHANNEL_PATTERN.test(OWNER_CHANNEL_USERNAME)).toBe(true);
  });

  it('still rejects the bare username without the leading @', () => {
    expect(TARGET_CHANNEL_PATTERN.test('pixellores')).toBe(false);
  });
});

describe('owner channel identity — embedded registry brand block', () => {
  it('parses the embedded registry successfully', () => {
    expect(parseEmbeddedRegistry().ok).toBe(true);
  });

  it('carries the exact owner channel username and unchanged bot persona', () => {
    expect(blueprintRegistry.brand.channelUsername).toBe(OWNER_CHANNEL_USERNAME);
    expect(blueprintRegistry.brand.botPersona).toBe(BOT_PERSONA);
  });

  it('flags the frozen blueprint display name as a known divergence', () => {
    // The frozen registry brand block still carries the pre-rename display
    // form; it must differ from the live display name until the blueprint
    // itself is unfrozen and updated.
    expect(blueprintRegistry.brand.channelName).not.toBe(OWNER_CHANNEL_NAME);
    expect(typeof blueprintRegistry.brand.channelName).toBe('string');
  });

  it('footer href and label BOTH name the new channel and agree with each other', () => {
    const footerHtml: string = blueprintRegistry.brand.footerHtml;
    expect(footerHtml).toContain(`href="${OWNER_CHANNEL_URL}"`);
    expect(footerHtml).toContain(`>${OWNER_CHANNEL_USERNAME}</a>`);
    expect(footerHtml).not.toContain('@pixellort');
  });
});

describe('owner channel identity — connector contact URLs (behavioral)', () => {
  it('rss connector sends the new contact URL in the User-Agent', async () => {
    const mock = createFetchMock([
      {
        status: 200,
        headers: { 'content-type': 'application/rss+xml' },
        bodyText:
          '<?xml version="1.0"?><rss version="2.0"><channel><title>T</title></channel></rss>',
      },
    ]);
    const result = await createRssConnector().fetch({
      sourceId: 'rss_identity_probe',
      config: { endpoint: 'https://blog.playstation.com/feed/' },
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('changed');
    for (const call of mock.calls) {
      expect(call.headers['user-agent']).toContain('PixelEditorialAgent/1.4');
      expect(call.headers['user-agent']).toContain(`+${OWNER_CHANNEL_URL}`);
    }
  });

  it('github-releases connector sends the new contact URL in every User-Agent', async () => {
    const mock = createFetchMock([
      { status: 200, bodyText: '[]' },
      { status: 200, bodyText: '[]' },
    ]);
    const result = await createGithubReleasesConnector().fetch({
      sourceId: 'github_identity_probe',
      config: { repositories: ['owner/repo-a'], includePrereleases: false },
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn),
    });
    expect(result.status).toBe('changed');
    expect(mock.calls.length).toBeGreaterThanOrEqual(1);
    for (const call of mock.calls) {
      expect(call.headers['user-agent']).toContain('PixelEditorialAgent/1.4');
      expect(call.headers['user-agent']).toContain(`+${OWNER_CHANNEL_URL}`);
    }
  });

  it('reddit connector sends the new contact URL on BOTH the token and listing paths', async () => {
    const mock = createFetchMock([
      {
        status: 200,
        bodyText: JSON.stringify({ access_token: 'identity-probe-token', token_type: 'bearer' }),
      },
      { status: 200, bodyText: JSON.stringify({ data: { after: null, children: [] } }) },
    ]);
    const result = await createRedditOauthConnector().fetch({
      sourceId: 'reddit_identity_probe',
      config: { subreddits: ['CrackWatch'], limit: 25, stripDownloadLinks: true },
      state: { etag: null, lastModified: null, cursor: null },
      effects: connectorEffects(mock.fetchFn, {
        REDDIT_CLIENT_ID: 'identity-probe-cid',
        REDDIT_CLIENT_SECRET: 'identity-probe-secret',
      }),
    });
    expect(result.status).toBe('changed');
    expect(mock.calls.length).toBe(2); // token call + listing call
    for (const call of mock.calls) {
      expect(call.headers['user-agent']).toContain('PixelEditorialAgent/1.4');
      expect(call.headers['user-agent']).toContain(`+${OWNER_CHANNEL_URL}`);
    }
  });
});
