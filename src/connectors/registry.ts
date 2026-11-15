/**
 * Implemented-connector registry (Phase 4 — ADR-0038 §2).
 *
 * Exactly the IMPLEMENTED families are registered — no fake handlers for
 * Bluesky/IGDB (their catalog entries are recognized but never scheduled;
 * ADR-0038 §2). Explicit construction, no reflection.
 */
import type { SourceConnector } from './contract';
import { createRssConnector } from './rss';
import { createSteamNewsConnector } from './steam-news';
import { createYoutubePlaylistsConnector } from './youtube-playlists';
import { createRedditOauthConnector } from './reddit-oauth';
import { createGithubReleasesConnector } from './github-releases';

export interface ConnectorRegistry {
  /** Returns the implemented connector, or undefined (catalog-only). */
  get(connector: string): SourceConnector | undefined;
  /** All implemented connector ids (diagnostics only). */
  ids(): readonly string[];
}

export function createConnectorRegistry(): ConnectorRegistry {
  const connectors: readonly SourceConnector[] = [
    createRssConnector(),
    createSteamNewsConnector(),
    createYoutubePlaylistsConnector(),
    createRedditOauthConnector(),
    createGithubReleasesConnector(),
  ];
  const byId = new Map<string, SourceConnector>();
  for (const connector of connectors) {
    if (byId.has(connector.id)) {
      throw new Error(`duplicate connector registration: ${connector.id}`);
    }
    byId.set(connector.id, connector);
  }
  return {
    get: (connector: string) => byId.get(connector),
    ids: () => [...byId.keys()],
  };
}
