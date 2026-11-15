/**
 * RSS 2.0 + Atom feed reader over the bounded XML scanner (Phase 4 —
 * ADR-0039 §3). Deterministic field selection, bounded item count,
 * malformed structures fail safe.
 *
 * Field order (documented contract, ADR-0039 §3):
 * - RSS item:   guid → link → title → pubDate/dc:date → description /
 *               content:encoded → author/dc:creator
 * - Atom entry: id → link[rel=alternate, else first link] → title →
 *               published else updated → summary/content → author/name
 *
 * Raw values flow to normalization unsanitized; this reader only selects
 * fields. It never fetches anything.
 */
import { scanXmlDocument } from './safe-xml';

/** Hard item bound per feed document (ADR-0039 §1). Newer-first order
 * means the cap retains the freshest items; excess entries are ignored
 * (bounded, never an error — a prolific feed must not fail forever). */
export const MAX_ITEMS_PER_FEED = 100;

export interface ParsedFeedItem {
  readonly id: string | null;
  /** Selected best link (RSS link text, Atom alternate href). */
  readonly link: string | null;
  /** RSS guid with isPermaLink="true" that looks like an https URL. */
  readonly guidPermalink: string | null;
  readonly title: string | null;
  readonly bodyText: string | null;
  readonly author: string | null;
  readonly publishedRaw: string | null;
}

export interface ParsedFeed {
  readonly kind: 'rss' | 'atom';
  readonly title: string | null;
  readonly items: readonly ParsedFeedItem[];
}

export type FeedParseResult =
  | { readonly ok: true; readonly feed: ParsedFeed }
  | { readonly ok: false; readonly reason: 'feed_malformed' };

interface ItemDraft {
  id: string | null;
  links: Array<{ rel: string | null; href: string | null }>;
  guid: string | null;
  guidIsPermalink: boolean;
  title: string | null;
  bodyText: string | null;
  author: string | null;
  publishedRaw: string | null;
}

function freshDraft(): ItemDraft {
  return {
    id: null,
    links: [],
    guid: null,
    guidIsPermalink: false,
    title: null,
    bodyText: null,
    author: null,
    publishedRaw: null,
  };
}

/** RSS leaf fields captured by local name. */
const RSS_FIELDS = new Set([
  'guid',
  'link',
  'title',
  'pubDate',
  'date', // dc:date
  'description',
  'encoded', // content:encoded
  'creator', // dc:creator
  'author',
]);

/** Atom leaf fields captured by local name. */
const ATOM_FIELDS = new Set([
  'id',
  'link',
  'title',
  'published',
  'updated',
  'summary',
  'content',
  'name',
]);

/**
 * Parse an RSS 2.0 or Atom document into bounded feed items.
 */
export function parseFeedDocument(xml: string): FeedParseResult {
  const scan = scanXmlDocument(xml);
  if (!scan.ok) {
    return { ok: false, reason: 'feed_malformed' };
  }
  const events = scan.events;

  // Root detection from the first open event.
  const firstOpen = events.find((event) => event.kind === 'open');
  if (firstOpen === undefined || firstOpen.kind !== 'open') {
    return { ok: false, reason: 'feed_malformed' };
  }
  const kind: 'rss' | 'atom' | null =
    firstOpen.name === 'rss' ? 'rss' : firstOpen.name === 'feed' ? 'atom' : null;
  if (kind === null) {
    return { ok: false, reason: 'feed_malformed' };
  }

  const items: ParsedFeedItem[] = [];
  let feedTitle: string | null = null;
  const nameStack: string[] = [];
  let inChannel = false; // inside <channel> (RSS) or directly under <feed>
  let inItem = false;
  let draft: ItemDraft | null = null;
  interface Capture {
    readonly field: string;
    readonly attrs: Readonly<Record<string, string>>;
    readonly parts: string[];
    readonly closeDepth: number;
    readonly target: 'item' | 'feed';
  }
  let capture: Capture | null = null;

  const finishCapture = (): void => {
    if (capture === null) {
      return;
    }
    if (capture.target === 'item') {
      applyItemField(draft, capture, kind);
    } else if (capture.field === 'title' && feedTitle === null) {
      const text = capture.parts.join('').trim();
      if (text !== '') {
        feedTitle = text;
      }
    }
    capture = null;
  };

  const applyItemField = (
    draftOrNull: ItemDraft | null,
    cap: Capture,
    feedKind: 'rss' | 'atom',
  ): void => {
    if (draftOrNull === null) {
      return;
    }
    const draft = draftOrNull;
    const text = cap.parts.join('').trim();
    const attrs = cap.attrs;
    switch (cap.field) {
      case 'guid':
        if (draft.guid === null) {
          draft.guid = text === '' ? null : text;
          draft.guidIsPermalink =
            attrs['isPermaLink'] !== undefined && /true/i.test(attrs['isPermaLink']);
        }
        break;
      case 'id':
        if (draft.id === null && text !== '') {
          draft.id = text;
        }
        break;
      case 'link': {
        if (feedKind === 'atom') {
          const href = attrs['href'] ?? null;
          const rel = attrs['rel'] ?? null;
          if (href !== null) {
            draft.links.push({ rel, href });
          }
        } else if (draft.links.length === 0 && text !== '') {
          draft.links.push({ rel: null, href: text });
        }
        break;
      }
      case 'title':
        if (draft.title === null && text !== '') {
          draft.title = text;
        }
        break;
      case 'pubDate':
      case 'date':
      case 'published':
      case 'updated':
        if (draft.publishedRaw === null && text !== '') {
          draft.publishedRaw = text;
        }
        break;
      case 'description':
      case 'encoded':
      case 'summary':
      case 'content':
        if (draft.bodyText === null && text !== '') {
          draft.bodyText = text;
        }
        break;
      case 'author':
      case 'creator': // dc:creator
        if (feedKind === 'rss' && draft.author === null && text !== '') {
          draft.author = text;
        }
        break;
      case 'name':
        // Atom author/name — only inside an <author> container.
        if (
          feedKind === 'atom' &&
          nameStack.includes('author') &&
          draft.author === null &&
          text !== ''
        ) {
          draft.author = text;
        }
        break;
    }
  };

  for (const event of events) {
    if (event.kind === 'open') {
      // Self-closing elements never receive a close event: capture their
      // attribute payload directly (Atom <link href=.../>) and keep the
      // name stack in sync by NOT pushing.
      if (event.selfClosing) {
        if (kind === 'atom' && inItem && draft !== null && event.name === 'link') {
          const href = event.attributes['href'] ?? null;
          const rel = event.attributes['rel'] ?? null;
          if (href !== null) {
            draft.links.push({ rel, href });
          }
        }
        continue;
      }
      nameStack.push(event.name);
      const depth = nameStack.length;

      if (!inItem && depth === 2 && event.name === 'channel' && kind === 'rss') {
        inChannel = true;
        continue;
      }
      const itemParentOk =
        (kind === 'rss' && event.name === 'item' && inChannel && depth === 3) ||
        (kind === 'atom' && event.name === 'entry' && depth === 2);
      if (!inItem && itemParentOk) {
        if (items.length >= MAX_ITEMS_PER_FEED) {
          // Bounded: keep the (newer-first) cap, ignore older overflow.
          continue;
        }
        inItem = true;
        draft = freshDraft();
        continue;
      }
      const captureTarget: 'item' | 'feed' | null = inItem
        ? 'item'
        : !inItem && (inChannel || (kind === 'atom' && depth === 1))
          ? 'feed'
          : null;
      if (capture === null && captureTarget !== null) {
        const fields = kind === 'rss' ? RSS_FIELDS : ATOM_FIELDS;
        // Atom <author> is a CONTAINER (its <name> child carries the text);
        // every other captured field is a leaf.
        const isContainer = kind === 'atom' && event.name === 'author';
        if (
          fields.has(event.name) &&
          !isContainer &&
          (captureTarget === 'item' || event.name === 'title')
        ) {
          capture = {
            field: event.name,
            attrs: event.attributes,
            parts: [],
            closeDepth: depth,
            target: captureTarget,
          };
        }
      }
      continue;
    }
    if (event.kind === 'text') {
      if (capture !== null) {
        capture.parts.push(event.text);
      }
      continue;
    }
    // close event
    nameStack.pop();
    if (capture !== null && nameStack.length + 1 === capture.closeDepth) {
      finishCapture();
      continue;
    }
    const itemClose =
      (kind === 'rss' && event.name === 'item' && inChannel) ||
      (kind === 'atom' && event.name === 'entry');
    if (inItem && itemClose) {
      if (draft !== null) {
        items.push(finishItem(draft));
      }
      inItem = false;
      draft = null;
    }
  }

  return {
    ok: true,
    feed: { kind, title: feedTitle, items },
  };
}

function finishItem(draft: ItemDraft): ParsedFeedItem {
  let link: string | null = null;
  const alternate = draft.links.find((candidate) => candidate.rel === 'alternate');
  const chosen = alternate ?? draft.links[0];
  if (chosen !== undefined) {
    link = chosen.href;
  }
  const guidPermalink =
    draft.guidIsPermalink && draft.guid !== null && /^https:\/\//i.test(draft.guid)
      ? draft.guid
      : null;
  return {
    id: draft.id ?? draft.guid,
    link,
    guidPermalink,
    title: draft.title,
    bodyText: draft.bodyText,
    author: draft.author,
    publishedRaw: draft.publishedRaw,
  };
}
