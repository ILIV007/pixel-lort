/**
 * Item normalization (Phase 4 — ADR-0039 §5): canonical URLs, safe plain
 * text, deterministic content hashes, bounded provenance, timestamp
 * validation. Pure functions; no network, no storage.
 *
 * Security stance: external HTML is DATA, never markup or instructions.
 * Excerpts are plain text after full tag stripping; Telegram composition
 * is NOT this module's concern.
 */
import { INGESTION_LIMITS } from '../domain/source/source-registry';
import { sha256Hex } from '../shared/ids/idempotency-key';

/** Reviewed tracking-parameter denylist (ADR-0039 §5 — strip NOTHING else). */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'si',
  'ref_src',
  'ref_url',
  'spm',
  'cmpid',
  'ncid',
]);

/** Bounded published-at window: 1970 .. now + 1 day (absurd outliers NULL). */
const PUBLISHED_MIN_MS = 0;
const PUBLISHED_FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

export type CanonicalUrlResult =
  | { readonly ok: true; readonly canonical: string }
  | { readonly ok: false; readonly reason: 'unsafe_url' };

/**
 * Deterministic, conservative canonicalization (ADR-0039 §5):
 * https only, credentials/ports rejected, host lowercased, path case
 * PRESERVED, fragment dropped, query parameters sorted, only reviewed
 * tracking fields stripped. Distinct resources never collapse.
 */
export function canonicalizeItemUrl(rawUrl: string): CanonicalUrlResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'unsafe_url' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsafe_url' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'unsafe_url' };
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    return { ok: false, reason: 'unsafe_url' };
  }
  if (parsed.hostname === '') {
    return { ok: false, reason: 'unsafe_url' };
  }
  // Reject IP-literal hosts in item links too (same literal layer as
  // fetches — a feed pointing at an IP is not a canonical public URL).
  const host = parsed.hostname;
  if (/^\[.*\]$/.test(host) || /^[\d.]+$/.test(host) || /^0[xX][0-9a-fA-F]+$/.test(host)) {
    return { ok: false, reason: 'unsafe_url' };
  }

  const kept: Array<[string, string]> = [];
  for (const [name, value] of parsed.searchParams.entries()) {
    if (!TRACKING_PARAMS.has(name.toLowerCase())) {
      kept.push([name, value]);
    }
  }
  kept.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));

  const search = kept.length === 0 ? '' : `?${kept.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&')}`;
  // Preserve the path exactly (case and trailing slash semantics).
  const canonical = `https://${parsed.hostname.toLowerCase()}${parsed.pathname}${search}`;
  return { ok: true, canonical };
}

/**
 * Strip HTML tags and decode a bounded single pass of entities into safe
 * plain text. Unknown named entities stay literal (never expanded from
 * any table); control characters are removed; whitespace collapsed.
 */
export function htmlToPlainText(input: string): string {
  if (input === '') {
    return '';
  }
  // Remove script/style blocks entirely, then all tags.
  const withoutBlocks = input
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ');
  const withoutTags = withoutBlocks.replace(/<[^>]*>/g, ' ');
  const decoded = decodeBoundedEntities(withoutTags);
  // Remove control characters except tab (turned into space below).
  // eslint-disable-next-line no-control-regex -- deliberate control-char strip
  const withoutControl = decoded.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return withoutControl.replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeBoundedEntities(input: string): string {
  if (!input.includes('&')) {
    return input;
  }
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isInteger(code) && code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    const mapped = NAMED_ENTITIES[body.toLowerCase()];
    return mapped ?? match; // unknown named entity stays literal
  });
}

/** Truncate deterministically without splitting a surrogate pair. */
export function truncateBounded(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  let cut = maxChars;
  // A HIGH surrogate at the cut end would orphan its low half — back off one.
  const lastUnit = input.charCodeAt(cut - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) {
    cut -= 1;
  }
  return input.slice(0, cut);
}

/** Parse an RFC-822 (RSS) or ISO-8601 (Atom/API) timestamp safely. */
export function parsePublishedTimestamp(raw: string | null, nowMs: number): number | null {
  if (raw === null || raw.length === 0 || raw.length > 64) {
    return null;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed < PUBLISHED_MIN_MS || parsed > nowMs + PUBLISHED_FUTURE_SLACK_MS) {
    return null;
  }
  return parsed;
}

/** Deterministic content hash over the normalized semantic tuple. */
export async function computeContentHash(parts: {
  readonly title: string;
  readonly excerpt: string | null;
  readonly publishedAtMs: number | null;
  readonly canonicalUrl: string | null;
}): Promise<string> {
  const canonical = [
    parts.title,
    parts.excerpt ?? '',
    parts.publishedAtMs === null ? '' : String(parts.publishedAtMs),
    parts.canonicalUrl ?? '',
  ].join('');
  return sha256Hex(canonical);
}

/** Deterministic synthesized external id for feeds without stable ids. */
export function synthesizedExternalId(
  connector: string,
  contentHash: string,
): string {
  return `${connector}:c:${contentHash.slice(0, 16)}`;
}

/** Download-shaped link policy (stripDownloadLinks / noPiracyDownloadLinks). */
const DOWNLOAD_LINK_PATTERN =
  /\b(?:magnet:\?xt=urn:[^\s"'<>]+|https?:\/\/[^\s"'<>]+?\.(?:torrent|zip|rar|7z|exe|apk|dmg|iso)(?:[?#][^\s"'<>]*)?)\b/gi;

/** Strip download/piracy-shaped links from text; returns cleaned text + count. */
export function stripDownloadLinks(text: string): { text: string; count: number } {
  let count = 0;
  const cleaned = text.replace(DOWNLOAD_LINK_PATTERN, () => {
    count += 1;
    return ' ';
  });
  return { text: cleaned.replace(/\s+/g, ' ').trim(), count };
}

/** Build the bounded raw-provenance object (never a raw payload dump). */
export function buildRawProvenance(fields: {
  readonly connector: string;
  readonly sourceId: string;
  readonly itemId: string | null;
  readonly link: string | null;
  readonly publishedRaw: string | null;
  readonly fetchedAtMs: number;
  readonly originLabel: string;
}): Record<string, unknown> {
  const provenance: Record<string, unknown> = {
    connector: fields.connector,
    sourceId: fields.sourceId,
    origin: fields.originLabel,
    fetchedAtMs: fields.fetchedAtMs,
  };
  if (fields.itemId !== null) {
    provenance.itemId = truncateBounded(fields.itemId, 256);
  }
  if (fields.link !== null) {
    provenance.link = truncateBounded(fields.link, 512);
  }
  if (fields.publishedRaw !== null) {
    provenance.publishedRaw = truncateBounded(fields.publishedRaw, 64);
  }
  // Enforce the byte bound defensively (structured fields stay far below).
  if (JSON.stringify(provenance).length > INGESTION_LIMITS.rawJsonMaxBytes) {
    delete provenance.link;
    delete provenance.publishedRaw;
    delete provenance.itemId;
  }
  return provenance;
}

/** Normalize one raw item into the persistence shape. */
export async function normalizeRawItem(input: {
  readonly connector: string;
  readonly sourceId: string;
  readonly originLabel: string;
  readonly raw: {
    readonly id: string | null;
    readonly link: string | null;
    readonly title: string | null;
    readonly bodyText: string | null;
    readonly author: string | null;
    readonly publishedRaw: string | null;
    readonly guidPermalink?: string | null;
  };
  readonly stripDownloads: boolean;
  readonly nowMs: number;
}): Promise<
  | { ok: true; item: NormalizedItemOut; strippedDownloadLinkCount: number }
  | { ok: false; reason: 'title_missing' }
> {
  const raw = input.raw;
  // Best link: explicit link, else RSS guid permalink.
  const linkCandidate = raw.link ?? raw.guidPermalink ?? null;
  let canonicalUrl: string | null = null;
  if (linkCandidate !== null) {
    const canonical = canonicalizeItemUrl(linkCandidate);
    if (canonical.ok) {
      canonicalUrl = canonical.canonical;
    }
    // Unsafe/absent canonical URL: item still persists, dedup by id/hash.
  }

  let bodyText = raw.bodyText === null ? '' : htmlToPlainText(raw.bodyText);
  let strippedCount = 0;
  if (input.stripDownloads) {
    const stripped = stripDownloadLinks(bodyText);
    bodyText = stripped.text;
    strippedCount = stripped.count;
  }
  const excerpt = bodyText === '' ? null : truncateBounded(bodyText, INGESTION_LIMITS.excerptMaxChars);

  const titleSource = raw.title === null ? '' : htmlToPlainText(raw.title);
  if (titleSource === '') {
    return { ok: false, reason: 'title_missing' };
  }
  const title = truncateBounded(titleSource, INGESTION_LIMITS.titleMaxChars);
  const author =
    raw.author === null || raw.author.trim() === ''
      ? null
      : truncateBounded(htmlToPlainText(raw.author), INGESTION_LIMITS.authorMaxChars);
  const publishedAtMs = parsePublishedTimestamp(raw.publishedRaw, input.nowMs);
  const contentHash = await computeContentHash({
    title,
    excerpt,
    publishedAtMs,
    canonicalUrl,
  });

  const externalId =
    raw.id !== null && raw.id.trim() !== ''
      ? `${input.connector}:${truncateBounded(raw.id.trim(), 256)}`
      : synthesizedExternalId(input.connector, contentHash);

  return {
    ok: true,
    item: {
      externalId,
      canonicalUrl,
      title,
      excerpt,
      author,
      publishedAtMs,
      contentHash,
      rawJson: buildRawProvenance({
        connector: input.connector,
        sourceId: input.sourceId,
        itemId: raw.id,
        link: linkCandidate,
        publishedRaw: raw.publishedRaw,
        fetchedAtMs: input.nowMs,
        originLabel: input.originLabel,
      }),
    },
    strippedDownloadLinkCount: strippedCount,
  };
}

/** Output shape (mirrors domain NormalizedItem + provenance extras). */
export interface NormalizedItemOut {
  readonly externalId: string;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly excerpt: string | null;
  readonly author: string | null;
  readonly publishedAtMs: number | null;
  readonly contentHash: string;
  readonly rawJson: Record<string, unknown>;
}
