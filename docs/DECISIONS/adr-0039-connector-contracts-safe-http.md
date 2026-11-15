# ADR-0039: Connector family contracts, safe HTTP, safe XML, and normalization

- **Status:** Accepted
- **Phase:** 4 (source registry and initial connectors, blueprint §26 step 4)
- **Date:** 2026-10-09
- **Decided by:** Alexios

## Context

ADR-0038 fixed the scheduling/ownership/budget semantics. This ADR fixes
the connector-side contracts: the five implemented families (RSS/Atom,
Steam News, YouTube playlists, Reddit OAuth, GitHub releases), the shared
safe-HTTP layer with its SSRF posture, the safe XML parser decision, and
the normalization/canonicalization rules that feed `source_items`.

## Decision

### 1. Connector contract (blueprint §8, domain-typed)

Domain types live in `src/domain/source/` with NO Cloudflare/provider/HTTP
SDK types; connectors live in `src/connectors/` and receive all effects
(fetch, clock, random, logger) through injected ports.

```ts
interface FetchContext { sourceId, config, state (etag/lastModified/cursor),
                         nowMs, fetch: SafeFetch, signal bounds }
interface FetchResult  { status: 'changed'|'not_modified'|'rate_limited'|'failed',
                         items: RawItem[], cursor?, etag?, lastModified?,
                         retryAfterSeconds?, requestCount, malformedCount? }
```

Per-family behavior (all fixture-tested; documented real request contracts):

| Family            | Endpoint (header auth only)                                                                                                                                                                                                           | Pagination / conditional                                                | Limits                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| rss               | configured `endpoint` or bounded `endpointTemplates` list; `If-None-Match` + `If-Modified-Since`                                                                                                                                      | per-feed etag/last-modified stored in the cursor JSON                   | ≤ 100 items/feed/poll; feed cap 2 MiB                         |
| steam-news        | `GET ISteamNews/GetNewsForApp/v2/` (keyless, documented) `appid, count, maxlength`                                                                                                                                                    | no cursor; per-app `count=maxItemsPerApp`                               | appsPerBatch ≤ 10 (watchlist empty → blocked)                 |
| youtube-playlists | `GET /youtube/v3/playlistItems` + `GET /youtube/v3/videos`; **`X-Goog-Api-Key` HEADER** (no query-string secrets); `useSearchEndpoint:false`, `downloadVideo:false` enforced                                                          | `pageToken` cursor, 1 page/poll                                         | ≤ 25 items/page; watchlist of playlist IDs required           |
| reddit-oauth      | token `POST https://www.reddit.com/api/v1/access_token` (`grant_type=client_credentials`, `Authorization: Basic`) then `GET https://oauth.reddit.com/r/{subreddit}/new?limit=` ; template materialized from VALIDATED subreddits only | `after` fullname cursor                                                 | ≤ 25/subreddit; `stripDownloadLinks` honored in excerpts      |
| github-releases   | `GET /repos/{owner}/{repo}/releases?per_page=100&page=1` (`Accept: application/vnd.github+json`; optional `Authorization: Bearer` if GITHUB_TOKEN configured)                                                                         | `Link`-header-free bounded pagination (≤ 2 pages/poll), `If-None-Match` | watchlist of `owner/repo` required; prerelease policy applied |

Handlers never call AI or Telegram; raw provider data stays behind
normalization; connectors never retry internally (ADR-0038 §4).

### 2. Safe HTTP layer (shared by all connectors)

One `safeFetch` port with hard bounds (registry `globalPolicies`):
HTTPS only (allowHttp=false); total 10 s timeout covering HEADERS AND BODY
(AbortController wired through bounded stream reads — a slow-drip body is
cut off at the deadline, tested); feed cap 2 MiB streamed-byte cap via the
existing `readStreamBounded` primitive (Content-Length is an early
rejection hint, never trusted); maximum TWO redirects, each hop manually
validated (automatic following disabled) — scheme/host/port re-guarded,
`Authorization`/`Cookie`/`X-Goog-Api-Key`/api-key headers STRIPPED on any
origin change, hop count and per-hop status bounded; unexpected content
types rejected (`rss`: xml-family only, `+json` for API connectors);
invalid UTF-8 rejected (strict decoder).

**SSRF posture — honest:** Workers cannot resolve DNS, so no code may
claim "DNS-safe". The REAL control is a positive allowlist: each connector
may only call the exact host(s) of its configured endpoints (RSS: exactly
the configured feed hosts; steam: `api.steampowered.com`; youtube:
`www.googleapis.com`; reddit: `www.reddit.com` + `oauth.reddit.com`;
github: `api.github.com`). Defense-in-depth literal checks STILL reject:
non-https schemes, explicit ports (only 443), userinfo in URLs, and IP
literals of loopback/private/link-local/metadata/CGNAT/benchmark/reserved
ranges — including decimal/octal/hex IPv4 encodings (`2130706433`,
`0x7f.1`, `0177.0.0.1`) and IPv6/IPv4-mapped forms. Hostname allowlisting
plus literal rejection is the documented boundary; a hostname that later
resolves privately cannot be excluded at fetch time inside Workers, and
the endpoint allowlist is what keeps targets pinned (documented in
SECURITY_MODEL and the runbook).

### 3. Safe XML decision — hand-rolled bounded parser, zero new dependencies

Runtime dependencies stay minimal (ADR-0003 spirit; the only runtime
dependency remains Zod). A hand-rolled, bounded, pull-style XML scanner
(`src/connectors/xml/safe-xml.ts`) serves RSS 2.0 + Atom:

- `<!DOCTYPE` and `<!ENTITY` are rejected outright (fail-safe — no entity
  expansion, no network resolution, no billion-laughs surface);
  conditional sections (`<![INCLUDE/[IGNORE`) rejected; comments/PIs
  skipped with bounds.
- Only the five predefined XML entities plus numeric character references
  are decoded; any other named entity is a parse failure (item dropped /
  feed rejected) — never an expansion table.
- Hard bounds: depth ≤ 64, elements ≤ 20 000, text node ≤ 65 536 chars,
  attributes ≤ 32, attribute value ≤ 4 096; malformed input fails safely.
- CDATA is literal text (except the `]]>` terminator); namespaced tags are
  matched by local name for a reviewed field set
  (`content:encoded`, `dc:creator`).

The feed reader (`feed-reader.ts`) maps bounded RSS/Atom structures onto
raw items with a documented deterministic field order (RSS: guid → link →
title → pubDate → description; Atom: id → link[rel=alternate] → title →
published/updated → summary/content). Malformed feeds fail safe; item
count bounded per feed.

### 4. API JSON contracts

Every API connector validates its response with strict Zod schemas;
missing optional fields and unparseable timestamps degrade safely
(`published_at` NULL is valid); unexpected extra fields are ignored;
pagination tokens are bounded strings; a schema-invalid response is a
`failed` poll (source-class backoff), never a partial store.

### 5. Normalization, canonicalization, content safety

- Canonical URL: parse → reject unsafe (non-https by policy, credentials,
  non-443 ports, IP-literal hosts) → lowercase scheme+host, keep path
  case, drop fragment, drop the port, sort query parameters
  deterministically, strip ONLY a reviewed tracking denylist
  (`utm_*`, `fbclid`, `gclid`, `mc_cid/eid`, `igshid`, `si`, `ref_src`,
  `ref_url`, `spm`, `cmpid`, `ncid`) — everything else is retained so
  distinct provider identifiers never collapse. Discovered article/media
  links are NEVER fetched merely to canonicalize them.
- Excerpt: HTML stripped (external markup is DATA, never Telegram markup
  or instructions), entities decoded in ONE bounded pass over a reviewed
  named-entity set, control characters removed, whitespace collapsed,
  truncated to 512 chars at a deterministic boundary.
- `content_hash` = SHA-256 over the normalized semantic tuple
  (title ‖ excerpt ‖ publishedAt ‖ canonicalUrl) — deterministic across
  polls, stable for downstream story matching (which does NOT happen in
  this phase).
- `raw_json` provenance is BOUNDED (≤ 8 KiB) and built from selected,
  individually truncated fields (provider item id, raw link, raw
  timestamp, connector, feedUrl, fetchedAt) — never a raw payload dump.
- Community signals remain signals: trust/lane/attribution/approval
  policy come from the registry; `signal_only` sources can never satisfy
  auto-publish; `stripDownloadLinks`/`noPiracyDownloadLinks` are honored
  by dropping download-shaped links from stored text (policy, not a
  publishing subsystem).
- `published_at` is validated (parse RFC-822/ISO-8601, reject absurd
  future/past outliers — bounded window) else NULL.

## Consequences

- Zero new runtime dependencies; no Node-only APIs; everything runs on
  workerd primitives (`fetch`, `AbortController`, streams, `TextDecoder`,
  Web Crypto, `URL`, `URLSearchParams`).
- The hand-rolled parser concentrates risk in one small, exhaustively
  fuzz-style-tested module instead of a supply-chain dependency whose
  entity-expansion behavior must be audited per release.
- Real provider behavior may drift (feed formats, rate limits); the
  fixture contract tests pin TODAY's documented request shapes, and
  drift surfaces as bounded `failed` polls with stable codes, not crashes.
