/**
 * Phase 9B — the read-only `/story` surface helpers: the argument parser
 * (the R1.18.1 grammar discipline) and the budget-first renderer.
 *
 * - The parser: `/story` documents the EXACTLY-ONE-OPAQUE-TOKEN form ONLY
 *   (`/story <storyId>`) — there is NO list form, because a per-story view
 *   needs the story handle. undefined/empty, whitespace, control characters,
 *   or an over-cap token are all `invalid`. The raw text is never echoed
 *   back.
 * - The renderer: composeTelegramHtml + escapeTelegramHtml ONLY; the whole
 *   skeleton is RESERVED before the variable content (the R1.18.1 S1
 *   discipline) — the identity section and the publications section are
 *   ALWAYS present, the empty publications note is information, and the
 *   not-found state is honest without echoing the requested id. The rows
 *   carry identity/status/counters/stable codes — never draft content,
 *   never destinations. The result is a bounded safe HTML value.
 */
import {
  composeTelegramHtml,
  escapeTelegramHtml,
  telegramBold,
  type TelegramSafeHtml,
} from './telegram-html';
import { ADMIN_STORY_STRINGS, STORY_ID_MAX_BYTES } from './story-strings';
import type { AdminUiLanguage } from './ui-language';

export { STORY_COMMAND, STORY_ID_MAX_BYTES } from './story-strings';

export type StoryArgumentParse =
  { readonly kind: 'view'; readonly storyId: string } | { readonly kind: 'invalid' };

/** No whitespace of any kind may appear inside a story-id token. */
const STORY_ID_FORBIDDEN_WHITESPACE = /\s/u;

/**
 * Validate the whole remainder after `/story` (R1.18 §3.C discipline):
 * the remainder must be a single opaque token — 1..128 UTF-8 bytes, NO
 * whitespace, NO control characters (C0 and DEL). Everything else —
 * including the no-argument form — is `invalid`: the parser is PURE and
 * synchronous, and the router calls it BEFORE any query adapter exists.
 */
export function parseStoryArgument(remainder: string | undefined): StoryArgumentParse {
  if (remainder === undefined || remainder === '') {
    return { kind: 'invalid' };
  }
  if (STORY_ID_FORBIDDEN_WHITESPACE.test(remainder)) {
    return { kind: 'invalid' };
  }
  const bytes = new TextEncoder().encode(remainder);
  if (bytes.length === 0 || bytes.length > STORY_ID_MAX_BYTES) {
    return { kind: 'invalid' };
  }
  for (const character of remainder) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return { kind: 'invalid' };
    }
  }
  return { kind: 'view', storyId: remainder };
}

/** The bounded per-story publications cap of the screen (visible rows). */
export const STORY_PUBLICATIONS_VISIBLE_LIMIT = 8;
/** Probe limit (visible + 1) — establishes `moreAvailable` without COUNT(*). */
export const STORY_PUBLICATIONS_PROBE_LIMIT = STORY_PUBLICATIONS_VISIBLE_LIMIT + 1;

/**
 * The projected story identity — the durable machine-held facts ONLY. No
 * editorial draft content, no destinations, no message text (the columns
 * are projected bounded in the store; this type pins the shape).
 */
export interface StoryViewRow {
  readonly id: string;
  readonly storyKey: string;
  readonly status: string;
  readonly trustStatus: string;
  readonly contentType: string;
  readonly priority: number;
  readonly confidence: number;
  readonly workingHeadline: string | null;
  readonly firstSeenAt: number;
  readonly lastEvidenceAt: number;
  readonly lastPublishedAt: number | null;
  readonly version: number;
  readonly mergedIntoStoryId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * One capped publication-history row — the EXACT /queue field discipline:
 * identity/status/counters/stable codes only. The draft document, the
 * rendered text and every destination-shaped value never cross this type.
 */
export interface StoryViewPublicationRow {
  readonly id: string;
  readonly status: string;
  readonly priority: number;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly publishedAt: number | null;
}

/** The publication-history row line — the SAME shape as the /queue rows. */
function publicationLine(row: StoryViewPublicationRow): string {
  const errorSuffix = row.lastError !== null ? ` · ${row.lastError}` : '';
  const publishedSuffix = row.publishedAt !== null ? ` · published ${row.publishedAt}` : '';
  return `${row.id.slice(0, 18)} · ${row.status} · P${row.priority} · ${row.attempts}/${row.maxAttempts}${errorSuffix}${publishedSuffix}`;
}

export function renderStoryView(input: {
  readonly uiLanguage: AdminUiLanguage;
  /** The projected story row; null renders the honest not-found state. */
  readonly story: StoryViewRow | null;
  readonly publications: readonly StoryViewPublicationRow[];
  readonly morePublications: boolean;
  readonly sendGateEnabled: boolean;
}): TelegramSafeHtml {
  const s = ADMIN_STORY_STRINGS[input.uiLanguage];
  if (input.story === null) {
    // The not-found state NEVER echoes the requested id (the raw input is
    // never part of any rendered output).
    return composeTelegramHtml([telegramBold(s.notFoundTitle), escapeTelegramHtml(s.notFoundBody)]);
  }
  const story = input.story;
  const parts: TelegramSafeHtml[] = [
    telegramBold(s.emptyTitle),
    escapeTelegramHtml(input.sendGateEnabled ? s.gateOn : s.gateOff),
    escapeTelegramHtml(s.identityTitle),
    escapeTelegramHtml(`${s.labels.id} ${story.id}`),
    escapeTelegramHtml(`${s.labels.key} ${story.storyKey}`),
    escapeTelegramHtml(
      `${s.labels.status} ${story.status} · ${s.labels.trust} ${story.trustStatus} · ${s.labels.type} ${story.contentType}`,
    ),
    escapeTelegramHtml(
      `${s.labels.priority} ${story.priority} · ${s.labels.confidence} ${story.confidence} · ${s.labels.version} ${story.version}`,
    ),
    escapeTelegramHtml(`${s.labels.headline} ${story.workingHeadline ?? s.noHeadline}`),
    escapeTelegramHtml(
      `${s.labels.firstSeen} ${story.firstSeenAt} · ${s.labels.lastEvidence} ${story.lastEvidenceAt}`,
    ),
    escapeTelegramHtml(
      `${s.labels.lastPublished} ${story.lastPublishedAt === null ? s.noHeadline : story.lastPublishedAt}`,
    ),
  ];
  if (story.mergedIntoStoryId !== null) {
    parts.push(escapeTelegramHtml(`${s.labels.mergedInto} ${story.mergedIntoStoryId}`));
  }
  parts.push(escapeTelegramHtml(s.publicationsTitle));
  if (input.publications.length === 0) {
    parts.push(escapeTelegramHtml(s.emptyPublications));
  } else {
    for (const row of input.publications.slice(0, STORY_PUBLICATIONS_VISIBLE_LIMIT)) {
      parts.push(escapeTelegramHtml(publicationLine(row)));
    }
    if (input.morePublications) {
      parts.push(escapeTelegramHtml(s.morePublications));
    }
  }
  return composeTelegramHtml(parts);
}
