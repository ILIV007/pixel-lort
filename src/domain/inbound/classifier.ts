/**
 * Slice 4 — gaming classifier (MERGE_MAP §7 step 3, DESIGN §10.1).
 *
 * Deterministic, keyword/signal-based classification of a cleaned inbound
 * post into gaming categories. No model is involved: the same text always
 * yields the same category, so routing (direct vs approval in `safe-auto`)
 * is reproducible and testable.
 *
 * Leak / rumor / crack are SIGNAL-ONLY (DESIGN §10.2): in `safe-auto` mode
 * they route to approval instead of direct publish — an unverified claim
 * never goes out as fact.
 */

export const GAMING_CATEGORIES = [
  'trailer',
  'patch',
  'dlc',
  'leak',
  'rumor',
  'crack',
  'mod',
  'esports',
  'release',
  'free_game',
  'hardware',
  'mobile',
  'news',
  'general',
] as const;

export type GamingCategory = (typeof GAMING_CATEGORIES)[number];

/** Signal-only categories: never direct-published in `safe-auto` mode. */
export const SIGNAL_ONLY_CATEGORIES: readonly GamingCategory[] = ['leak', 'rumor', 'crack'];

export function isSignalOnlyCategory(category: GamingCategory): boolean {
  return (SIGNAL_ONLY_CATEGORIES as readonly string[]).includes(category);
}

export interface GamingClassification {
  readonly category: GamingCategory;
  /** 'high' when a strong signal matched or ≥2 signals matched. */
  readonly confidence: 'high' | 'low';
  readonly signalOnly: boolean;
  /** The distinct signal patterns that matched (stable names, for logs). */
  readonly signals: readonly string[];
}

interface CategoryRule {
  readonly category: GamingCategory;
  /** Strong signals: one match is enough for high confidence. */
  readonly strong: readonly { readonly name: string; readonly pattern: RegExp }[];
  /** Weak signals: count toward the category, need a second signal for high. */
  readonly weak: readonly { readonly name: string; readonly pattern: RegExp }[];
}

/**
 * Priority order breaks ties: a leaked trailer is a LEAK, a patch note that
 * also announces a release is a PATCH. Rules are evaluated in this order.
 */
const RULES: readonly CategoryRule[] = [
  {
    category: 'leak',
    strong: [
      { name: 'leak_fa', pattern: /لیک/ },
      { name: 'leak_en', pattern: /leak/i },
      { name: 'leaked_fa', pattern: /لو\s?رفت/ },
    ],
    weak: [{ name: 'unverified_info', pattern: /اطلاعات لو/i }],
  },
  {
    category: 'rumor',
    strong: [
      { name: 'rumor_fa', pattern: /شایعه/ },
      { name: 'rumor_en', pattern: /rumou?r/i },
    ],
    weak: [{ name: 'unconfirmed', pattern: /تأیید\s?نشده|تایید\s?نشده/ }],
  },
  {
    category: 'crack',
    strong: [
      { name: 'crack_fa', pattern: /کرک/ },
      { name: 'crack_en', pattern: /crack/i },
      { name: 'denuvo', pattern: /denuvo|دنیوو/i },
    ],
    weak: [
      { name: 'drm', pattern: /\bdrm\b/i },
      { name: 'crack_status', pattern: /crack\s*status/i },
    ],
  },
  {
    category: 'trailer',
    strong: [
      { name: 'trailer_fa', pattern: /تریلر/ },
      { name: 'trailer_en', pattern: /trailer/i },
    ],
    weak: [
      { name: 'gameplay', pattern: /gameplay|گیم‌پلی|گیم‌پلی/i },
      { name: 'teaser', pattern: /teaser|تیزر/i },
    ],
  },
  {
    category: 'patch',
    strong: [
      { name: 'patch_fa', pattern: /پچ/ },
      { name: 'patch_en', pattern: /\bpatch\b/i },
      { name: 'hotfix', pattern: /hotfix|هات‌فیکس/i },
    ],
    weak: [{ name: 'bugfix', pattern: /رفع (باگ|اشکال)|باگ‌ها رفع/ }],
  },
  {
    category: 'dlc',
    strong: [
      { name: 'dlc_en', pattern: /\bdlc\b/i },
      { name: 'expansion', pattern: /expansion|بسته\s?الحاقی|دی‌ال‌سی/i },
    ],
    weak: [{ name: 'season_pass', pattern: /season\s?pass|سیزن\s?پس/i }],
  },
  {
    category: 'mod',
    strong: [
      { name: 'mod_fa', pattern: /ماد/ },
      { name: 'mod_en', pattern: /\bmod\b/i },
    ],
    weak: [{ name: 'modding', pattern: /modding|مادسازی/i }],
  },
  {
    category: 'esports',
    strong: [
      { name: 'esports_fa', pattern: /ای‌اسپورت|ای\s?اسپورت/ },
      { name: 'esports_en', pattern: /esports/i },
      { name: 'tournament', pattern: /تورنمنت|مسابقات|tournament|championship/i },
    ],
    weak: [{ name: 'match_final', pattern: /فینال|نیمه‌نهایی/ }],
  },
  {
    category: 'free_game',
    strong: [
      { name: 'free_fa', pattern: /رایگان شد|رایگان است/ },
      { name: 'free_en', pattern: /free\s+(game|to\s+play)/i },
    ],
    weak: [{ name: 'giveaway', pattern: /گیووی|هدیه|giveaway/i }],
  },
  {
    category: 'release',
    strong: [
      { name: 'release_fa', pattern: /منتشر شد|عرضه شد/ },
      { name: 'release_en', pattern: /\brelease\b|\blaunch\b/i },
    ],
    weak: [{ name: 'available', pattern: /در دسترس|منتشر می‌شود/ }],
  },
  {
    category: 'hardware',
    strong: [
      { name: 'gpu', pattern: /\bgpu\b|گرافیک|کارت گرافیک/i },
      { name: 'console', pattern: /کنسول|console/i },
      { name: 'cpu', pattern: /\bcpu\b|پردازنده/i },
    ],
    weak: [{ name: 'hardware', pattern: /سخت‌افزار|hardware/i }],
  },
  {
    category: 'mobile',
    strong: [
      { name: 'mobile_fa', pattern: /موبایل/ },
      { name: 'mobile_en', pattern: /\bmobile\b/i },
      { name: 'android_ios', pattern: /اندروید|آیفون|\bios\b|android/i },
    ],
    weak: [],
  },
  {
    category: 'news',
    strong: [
      { name: 'announce_fa', pattern: /معرفی شد|اعلام شد|اعلام کرد/ },
      { name: 'announce_en', pattern: /announced|revealed/i },
    ],
    weak: [
      { name: 'news_fa', pattern: /خبر|اخبار/ },
      { name: 'news_en', pattern: /\bnews\b/i },
    ],
  },
];

export function classifyGaming(cleanedText: string): GamingClassification {
  let best: GamingClassification | null = null;
  for (const rule of RULES) {
    const matchedStrong: string[] = [];
    const matchedWeak: string[] = [];
    for (const signal of rule.strong) {
      if (signal.pattern.test(cleanedText)) {
        matchedStrong.push(signal.name);
      }
    }
    for (const signal of rule.weak) {
      if (signal.pattern.test(cleanedText)) {
        matchedWeak.push(signal.name);
      }
    }
    const signals = [...matchedStrong, ...matchedWeak];
    if (signals.length === 0) {
      continue;
    }
    const confidence: 'high' | 'low' =
      matchedStrong.length > 0 || signals.length >= 2 ? 'high' : 'low';
    const candidate: GamingClassification = {
      category: rule.category,
      confidence,
      signalOnly: isSignalOnlyCategory(rule.category),
      signals,
    };
    if (best === null) {
      best = candidate;
      continue;
    }
    // A later rule wins only on a strictly higher signal count — the
    // priority order above already encodes the tie-break.
    if (signals.length > best.signals.length) {
      best = candidate;
    }
  }
  if (best !== null) {
    return best;
  }
  return { category: 'general', confidence: 'low', signalOnly: false, signals: [] };
}
