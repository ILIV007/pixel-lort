/**
 * Slice 4 — preservation guard (MERGE_MAP §7 step 5, DESIGN §10.1).
 *
 * Every URL, game name, version, price, platform and date in the cleaned
 * original MUST survive the AI rewrite, else the pipeline falls back to the
 * cleaned text. The guard is deterministic string evidence — it cannot
 * prove the rewrite is true, only that it did not drop or alter a fact
 * the owner supplied.
 *
 * Magnet links are never publishable (blueprint piracy ban): they are
 * detected here and refused upstream, never rewritten around.
 */

export interface ExtractedFacts {
  readonly urls: readonly string[];
  readonly versions: readonly string[];
  readonly prices: readonly string[];
  readonly platforms: readonly string[];
  readonly dates: readonly string[];
  /** Game names from «...» / "..." quotes in the original. */
  readonly quotedNames: readonly string[];
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]}]+/g;
const VERSION_PATTERN = /\bv?\d+\.\d+(?:\.\d+){0,2}\b/g;
const PRICE_PATTERN = /(?:[$€£¥]\s?\d[\d,.]*)|(?:\d[\d,.]*\s?(?:تومان|دلار|یورو|پوند))/g;
const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g;
const ENGLISH_DATE_PATTERN =
  /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\b/gi;
const PERSIAN_DATE_PATTERN =
  /\b\d{1,2}\s+(?:فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\b/g;
const QUOTED_GUILLEMET_PATTERN = /«([^»]{1,120})»/g;
const QUOTED_DOUBLE_PATTERN = /"([^"]{1,120})"/g;
const MAGNET_PATTERN = /magnet:\?[^\s<>"')]+/gi;

/** Platforms whose mention must survive a rewrite (appearance order). */
const PLATFORMS: readonly string[] = [
  'Xbox Series X',
  'Xbox Series S',
  'Xbox One',
  'PS5',
  'PS4',
  'PS3',
  'Xbox',
  'Switch',
  'Steam',
  'Epic',
  'PC',
  'iOS',
  'Android',
  'macOS',
  'Linux',
];

function uniqueOrdered(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function stripTrailingUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!؟)\]}]+$/u, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Persian/Arabic digits → Latin, Arabic yeh/kaf → Persian, Latin lowercased. */
export function normalizeForCompare(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .toLowerCase();
}

export function extractFacts(text: string): ExtractedFacts {
  const urls = uniqueOrdered(
    [...text.matchAll(URL_PATTERN)].map((match) => stripTrailingUrlPunctuation(match[0])),
  );
  const versions = uniqueOrdered([...text.matchAll(VERSION_PATTERN)].map((match) => match[0]));
  const prices = uniqueOrdered([...text.matchAll(PRICE_PATTERN)].map((match) => match[0].trim()));
  const dates = uniqueOrdered([
    ...[...text.matchAll(ISO_DATE_PATTERN)].map((match) => match[0]),
    ...[...text.matchAll(ENGLISH_DATE_PATTERN)].map((match) => match[0]),
    ...[...text.matchAll(PERSIAN_DATE_PATTERN)].map((match) => match[0]),
  ]);
  const quotedNames = uniqueOrdered([
    ...[...text.matchAll(QUOTED_GUILLEMET_PATTERN)].map((match) => match[1] as string),
    ...[...text.matchAll(QUOTED_DOUBLE_PATTERN)].map((match) => match[1] as string),
  ]);
  // Platforms in order of appearance in the text.
  const found: { readonly index: number; readonly name: string }[] = [];
  for (const platform of PLATFORMS) {
    const pattern = new RegExp(`\\b${escapeRegExp(platform)}\\b`, 'i');
    const match = pattern.exec(text);
    if (match !== null) {
      found.push({ index: match.index, name: platform });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return {
    urls,
    versions,
    prices,
    platforms: uniqueOrdered(found.map((entry) => entry.name)),
    dates,
    quotedNames,
  };
}

export interface PreservationCheck {
  readonly ok: boolean;
  /** Facts present in the original but missing (or altered) in the rewrite. */
  readonly missing: readonly string[];
}

export function checkPreservation(facts: ExtractedFacts, rewrittenText: string): PreservationCheck {
  const missing: string[] = [];
  const haystack = normalizeForCompare(rewrittenText);
  const present = (fact: string): boolean =>
    rewrittenText.includes(fact) || haystack.includes(normalizeForCompare(fact));
  for (const fact of [
    ...facts.urls,
    ...facts.versions,
    ...facts.prices,
    ...facts.platforms,
    ...facts.dates,
    ...facts.quotedNames,
  ]) {
    if (!present(fact)) {
      missing.push(fact);
    }
  }
  return { ok: missing.length === 0, missing };
}

/** Magnet links in the text (never publishable — refused upstream). */
export function findUnsafeLinks(text: string): string[] {
  return uniqueOrdered([...text.matchAll(MAGNET_PATTERN)].map((match) => match[0]));
}
