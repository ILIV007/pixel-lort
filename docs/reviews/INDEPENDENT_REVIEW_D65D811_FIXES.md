# بازبینی مستقل d65d811 — چهار ایراد P1: بازتولید، اصلاح RED-first، شواهد

مهندسی: GLM (سشن مالک‌محور 2026-11-12). مرجع گزارش: `PIXEL_REVIEW_d65d811_FA.md` (بازبینی مستقل مالک). مرجع پراب‌ها: بستهٔ `PIXEL_REVIEW_d65d811_FA_AND_PROBES.zip` — `independent-crash-probe.test.ts`، `independent-album-probe.test.ts`، `independent-caption-probe.test.ts` (سه فایل مشاهده‌ای که رفتار ناایمنِ آن‌زمان را assert می‌کردند؛ هرگز وارد مخزن نشدند و هرگز تغییری نکردند).

## ۰) قواعد این دور

- پراب‌ها **مشاهده‌ای**اند: PASS یعنی رفتار ناایمن دیده شد، نه صحت کد. برای GREEN شدن تغییریافتند؟ **نه.** پس از اصلاح دوباره روی همان SHA اجرا شدند و این‌بار **FAIL** شدند — با لاگ‌هایی که رفتار امن را نشان می‌دهد (بخش ۳).
- تست‌های موجود تضعیف نشدند؛ یک تست (pub-85 «heals the album») که دقیقاً رفتار معیوب را pin کرده بود، **اصلاح** شد تا رفتار امن را pin کند (بخش ۲، ایراد ۲).
- هیچ عملیات زنده‌ای (Cloudflare/R2/AI/Telegram/migration/حذف داده/هزینه) انجام نشد؛ همهٔ سطوح زنده BLOCKED_LIVE (فقط Posidon). Schema 6 دست‌نخورده (ZERO DDL).

## ۱) بازتولید روی d65d811 (پیش از اصلاح) — هر چهار پراب PASS = رفتار ناایمن مشاهده شد

| پراب                                                       | مشاهد registered روی درخت اصلاح‌نشده                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `INDEPENDENT_OVERLAP` (lease expiry)                       | `calls=2`؛ اسکن دوم `sent`؛ اسکن اول `fence_rejected`؛ ledger فقط `[9002]` (پیام ارسال دوم) |
| `INDEPENDENT_BLOCKED_RIGHTS`                               | `calls=1`، `outcome=sent` با asset ای که `rights_status='blocked'` شد                       |
| `INDEPENDENT_PARTIAL` (آلبوم دومواردی، شاهد تک)            | `status=published`, `messages=1`, `usages=0`, `calls=0`, `healed_from_evidence`             |
| `INDEPENDENT_CAPTION` (کپشن `text='x'` + entity offset 50) | `sends=1` سپس `send_failed` با `sentConfirmed=true`                                         |

RED-first: چهار مجموعه تست رفتاری جدید **پیش از** اصلاح نوشته و روی درخت d65d811 اجرا شدند — RED واقعی: واحد ۱۵ از ۱۷ شکست (عدم وجود exportها + رفتار ناایمن)، سه مجموعه REAL-D1 شکست (exportهای جدید/timeout روی وضعیت publishing/ادعا‌های امن برآورده نشد).

## ۲) اصلاح‌ها (طراحی و فایل‌ها)

### ایراد ۱ — دوبار ارسال در انقضای lease (P1-1)

**طراحی (بدون DDL):** وضعیت پایدار «ارسال آغاز شده» از **ترنزیشن رزروشدهٔ ماشین pol1** استفاده می‌کند: `mark_send_started: claimed -> publishing` (ADR-0058 آن را برای همین منظور تعریف کرده بود؛ موتور تاکنون استفاده‌اش نمی‌کرد).

- `publication-outbox-store.ts`:
  - `markClaimedSendStarted` — fenced by generation، `lease_until` به پنجرهٔ in-flight (`SEND_IN_FLIGHT_LEASE_MS = 600_000`، ده دقیقه) تمدید می‌شود؛ **آخرین نوشتار پیش از هر اثر شبکه‌ای**، در هر دو مسیر text و album.
  - `writeClaimedTerminal` حالا روی `status IN ('claimed','publishing')` fence می‌کند؛ ماشین برای **هر دو** وضعیت مبدأ consult می‌شود و توافق target اجباری است.
  - `parkExpiredPublishingUncertain` — ردیف `publishing` با lease تمدیدشدهٔ منقضی و بدون terminal = پنجرهٔ مبهم: park به `failed` با کد `SEND_MAY_HAVE_STARTED_ERROR='send_may_have_started'` (مسیر mark_uncertain ماشین). **هرگز auto-resend نمی‌شود**؛ تنها خروجی اثبات‌دارش heal شواهد است.
- `scheduler.ts`: نشانه‌گذاری پیش از transport (هر دو مسیر)؛ Phase A اسکن اکنون **ابتدا park** می‌کند سپس heal (یک scan، ترتیب صادقانه)؛ `reclaimExpiredClaims` فقط ردیف‌های `claimed` منقضی را برمی‌گرداند — یعنی فقط ردیف‌هایی که **اثبات‌پذیر پیش‌از-ارسال‌اند** (نشانه هرگز نوشته نشده). گزارش اسکن فیلد `uncertainParked` را صادقانه می‌آورد.

### ایراد ۲ — اثبات ناقص آلبوم → published (P1-2)

- `album-send-plan.ts`: ارزیاب خالص `evaluateAlbumDeliveryEvidence` — اثباتِ کامل = **همهٔ ordinalهای plan** ثبت‌شده به **مقصد پیکربندی‌شده** + اتصال `media_usages` برای همان مجموعه. TOTAL و deterministic.
- `scheduler.ts`: بررسی پیش‌از-ارسال شواهد اکنون shape-aware است: آلبوم → plan از سند durable مشتق می‌شود (سند نامعتبر → dead_letter تایپ‌شده قبل از هر اثر) → ارزیاب → کامل = heal؛ کامل-بدون-usages = بازسازی اتصال از ledger سپس heal؛ **ناقص/مقصد بیگانه = park uncertain با `album_evidence_incomplete`، رکوردها دست‌نخورده، صفر فراخوانی transport، هرگز auto-resend نه** (ordinalهای ثبت‌شده ممکن است در کانال باشند). مسیر text هم سخت‌گیرانه‌تر شد: دقیقاً یک رکورد به همین مقصد وگرنه `evidence_shape_anomalous` (ناهنجاری ledger هیچ‌وقت proof نیست).
- Phase A (reconcile ردیف‌های failed) همان قانون را اعمال می‌کند.
- **اصلاح تست pub-85:** تستی که heal تک‌شاهد را «مطلوب» pin کرده بود به دو تست درست تبدیل شد: اثبات کامل (هر دو ordinal + usages) → heal؛ اثبات ناقص → park + هرگز ارسال مجدد.

### ایراد ۳ — حقوق blocked/unknown در گیت خروجی (P1-3)

- `media-usage.ts`: `PUBLICATION_MEDIA_RIGHTS_V1 = ['official','licensed','attribution_required']` + `isPublishableRightsStatus` — گیت زمان-ارسال از **اکوی حقوقی durable** مصرف می‌کند؛ `blocked` (لغو) و `unknown` (هرگز پاک نشده) عبور نمی‌کنند. همین allowlist محمول `resolveAssetReuse` شد — ردیف با حقوق unknown دیگر reuse نمی‌شود (پیش‌تر فقط blocked رد می‌شد).
- `scheduler.ts` (`resolveAlbumLedgerBindings`): پیش از هر اثر transport، حقوق از ledger **در لحظهٔ انتشار** بازخوانی می‌شود؛ تخلف → `dead_letter` با کد `media_rights_not_publishable`، صفر فراخوانی.
- **مرز صادقانه:** «official بودن منبع به‌تنهایی مجوز بازنشر نیست» — کد حق را از نام منبع **اختراع نمی‌کند**؛ گیت فقط اکوی ثبت‌شدهٔ زمان-stage را دوباره می‌سنجد و لغو/نامعلوم را می‌بندد. مدل کامل شواهد حقوقی (scope/expiry/attribution به‌عنوان ورودی‌های صریح) نیازمند تصمیم مالک است و به‌عنوان carry باز ثبت شد — در کد دست‌ساز ساخته نشد.

### ایراد ۴ — کپشن نامعتبر پس از send (P1-4)

- `upload-service.ts`: `validateAlbumCaption` اکنون **خوانندهٔ واقعی سخت‌گیر** (`readRichTextEnvelopeValue`) است، پیش از هر حق‌سنجی/fetch/staging/ارسال: schemaVersion، kind، سقف واحد کپشن، انواع entity و متادیتا، قواعد تودرتویی، و قرارداد بازهٔ entity بر حسب UTF-16 (offset فراتر از متن یا شکافندهٔ surrogate = تایپ‌نامعتبر). شکل قدیمی «send موفق بعد build سند شکست → send_failed/sentConfirmed=true» برای کپشن نامعتبر دیگر ممکن نیست.

## ۳) شواهد پس از اصلاح — پراب‌های دست‌نخورده، اجرای دوباره: هر چهار FAIL با مشاهد امن

| پراب                         | مشاهد روی درخت اصلاح‌شده                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `INDEPENDENT_OVERLAP`        | **`calls=1`**؛ ledger=`[9001]` (پیام نسل اول، صادقانه ثبت)؛ اسکن دوم هیچ detail برای آن ردیف ندارد؛ پایان: `sent` |
| `INDEPENDENT_BLOCKED_RIGHTS` | **`calls=0`**؛ `dead_lettered` با `media_rights_not_publishable`                                                  |
| `INDEPENDENT_PARTIAL`        | `status=failed`، `failed_unconfirmed`/`album_evidence_incomplete`، `calls=0`                                      |
| `INDEPENDENT_CAPTION`        | **`sends=0`**؛ `caption_invalid`                                                                                  |

## ۴) تست‌های جدید (ثبت‌شده در test:db)

- `tests/unit/publication-send-safety.test.ts` — ۱۷ تست: ارزیاب کامل‌بودن شواهد (کامل/ناقص/بیگانه/بدون-usages/ورودی نامعتبر)، گیت حقوق انتشار + محمول reuse، گیت کپشن (۴ خانوادهٔ رد پیش از اثر + نگهبان عبور کپشن معتبر).
- `tests/integration/publication-87-send-inflight.test.ts` — ۵ تست REAL-D1: ارسال معلق text/album (دقیقاً یک فراخوانی transport)، crash درون-پنجره → park `send_may_have_started` + هرگز auto-resend، park+شواهد → heal بدون ارسال، مسیر اثبات‌پذیر پیش-از-ارسال (reclaim→send) حفظ شده.
- `tests/integration/publication-88-album-evidence.test.ts` — ۵ تست REAL-D1: ناقص→park+بدون-resend؛ کامل→heal؛ بدون-usages→اتصال مجدد+heal؛ مقصد بیگانه→park؛ Phase A همان قانون را روی failed ها اعمال می‌کند.
- `tests/integration/publication-89-send-rights-gate.test.ts` — ۶ تست REAL-D1: blocked/unknown/لغو-پس-از-enqueue → dead_letter تایپ‌شده با صفر فراخوانی؛ سه clearance مثبت → ارسال.
- اصلاح `publication-85-album-wiring.test.ts` (pin معیوب → دو pin امن).

## ۵) مرزهای این دور (صادقانه)

- مدل کامل شواهد حقوقی بازنشر (scope/expiry/attribution/سطح مالک) **ساخته نشد** — تصمیم مالک می‌خواهد؛ carry باز است.
- مسیرهای زنده همچنان BLOCKED_LIVE؛ این دور هیچ رفتار زنده‌ای را فعال نکرد (gateها همچنان OFF).
- راه‌اندازی واقعی scheduler (cron route، transport واقعی) همچنان کار Posidon است.
