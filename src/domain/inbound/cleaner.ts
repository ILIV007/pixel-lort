/**
 * Slice 4 — inbound cleaner (MERGE_MAP §7 step 2, DESIGN §10.1).
 *
 * The deterministic clean step before classify/rewrite. Strips spam, ads,
 * channel mentions, join/follow lines, attribution-only lines, decorative
 * emoji-only lines and AI clichés. Every URL, code fence, version, price,
 * platform and date survives verbatim — the cleaner never touches content
 * inside fenced code blocks.
 *
 * Pure: same input, same output. No I/O, no clock.
 */

/** Full-sentence AI clichés (blueprint persona §3) — the whole line goes. */
const CLICHE_PHRASES: readonly string[] = [
  'در دنیای هیجان‌انگیز بازی‌های ویدیویی',
  'خبر خوش برای گیمرها',
  'بالاخره انتظارها به پایان رسید',
];

/** A line that is ONLY an @mention (attribution, not content). */
const BARE_MENTION_LINE = /^\s*@[\w.]{1,64}\s*$/;

/** Join/follow/subscribe/عضو/دنبال calls to action. */
const JOIN_FOLLOW_LINE =
  /\b(join|follow|subscribe)\b|عضو\s*شو|دنبال\s*کن|سابسکرایب|عضویت در کانال/i;

/** Ad/sponsored lines. */
const AD_LINE = /تبلیغات|سفارش تبلیغ|تبلیغ کنید|اسپانسر/i;

/** Invite-only Telegram links (joinchat / +invite) — not source links. */
const INVITE_LINK_LINE = /^\s*https?:\/\/t\.me\/(joinchat\/|\+)\S+\s*$/i;

/** Attribution label with a URL keeps the URL, drops the label. */
const ATTRIBUTION_WITH_URL = /^\s*(منبع|source)\s*:\s*(https?:\/\/\S+)\s*$/i;
/** Attribution label without a URL is dropped entirely. */
const ATTRIBUTION_LINE = /^\s*(منبع|source)\s*:\s*$/i;

/** As-an-AI disclaimer lines (English + Persian). */
const AI_DISCLAIMER_LINE =
  /^(as an ai|as a language model|به‌عنوان یک هوش مصنوعی|به عنوان یک مدل زبانی)/i;

/** A line with no letters or digits is decoration, not content. */
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function cleanInboundText(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    if (trimmed === '') {
      kept.push('');
      continue;
    }
    if (!HAS_LETTER_OR_DIGIT.test(line)) {
      continue;
    }
    if (BARE_MENTION_LINE.test(line)) {
      continue;
    }
    if (JOIN_FOLLOW_LINE.test(line) || AD_LINE.test(line)) {
      continue;
    }
    if (INVITE_LINK_LINE.test(line)) {
      continue;
    }
    const attributionUrl = ATTRIBUTION_WITH_URL.exec(line);
    if (attributionUrl !== null) {
      kept.push(attributionUrl[2] as string);
      continue;
    }
    if (ATTRIBUTION_LINE.test(line)) {
      continue;
    }
    if (AI_DISCLAIMER_LINE.test(line)) {
      continue;
    }
    if (CLICHE_PHRASES.some((phrase) => line.includes(phrase))) {
      continue;
    }
    kept.push(line);
  }
  // Collapse runs of blank lines to at most one, trim the whole text.
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}
