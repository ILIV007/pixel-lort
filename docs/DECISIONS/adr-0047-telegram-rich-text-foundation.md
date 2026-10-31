# ADR-0047 — R1.19: Telegram rich-text foundation (faithful entities IN → validated entities OUT)

Date: 2025-10-31
Round: R1.19
Baseline: `7af421c39b8ea0a4d8fec13bf60a0aaf8953fc6d` (tree `e629536a071b07098962eed9e6e26abd6c2951af`, accepted app 1.13.1 / schema 3)
Application version: **1.14.0 candidate**, schema **3 unchanged** (no DDL, no DB access)
Status: Accepted (offline, under independent review — Draft PR #11)

## Context

The owner requires that a formatted Telegram post sent to the bot stays formatted through later preview and
human-approved channel publication. Telegram's native rich text is `text + entities` (or `caption +
caption_entities`) — NOT raw Markdown. Direct entity transport is the canonical format; converting native
entities to Markdown/HTML and re-parsing is forbidden by design, and raw Markdown/HTMLV2 input parsing is
explicitly deferred as a separate future mode (raw `*x*`, `<b>x</b>`, backticks with no entities MUST stay
literal text).

This round implements ONLY the prerequisite foundation: bounded parsing, a versioned lossless envelope,
defensive storage serialization, and real Bot API client serialization of entity-based output with an
offline end-to-end transport demo. It deliberately DOES NOT implement an inbox/manual-draft workflow, a
durable capture route, an approval action, channel publication or live sending — later slices will persist
authorized incoming posts, preview them, and integrate approval/outbox publication.

## Decision

### 1. Bounded typed extraction in the REAL parser (passive metadata)

`parseTelegramUpdate` (message and `edited_message`) now extracts `text`/`entities` and
`caption`/`caption_entities` into explicit typed metadata (`richText` / `richCaption`):

- SHALLOW and bounded only: each entity must be an object with a non-empty `type` (≤64 units); the
  documented metadata fields are projected (Telegram wire snake_case → camelCase projection) and
  everything undocumented is DROPPED (consistent ignore policy). Full validation belongs to the envelope.
- Explicit outcomes: absent metadata → no field; empty entity list → `ok: true` with `[]`; malformed →
  `ok: false` `entities_malformed`; >100 entries → `entities_too_many`; caption >1024 UTF-16 units →
  `caption_too_large`. Malformed rich metadata NEVER erases a legitimate command and never triggers new
  routing; captions NEVER become commands; a hostile payload carrying both text and caption keeps BOTH
  extractions (neither silently selected over the other). `channel_post`/forwards/replies/media ingestion
  and nested-message parsing are NOT added.

### 2. The pure versioned envelope (`src/domain/telegram/rich-text-envelope.ts`)

A pure domain value — no DB, no fetch, no clock. `{ schemaVersion: 1, kind: 'text' | 'caption', text,
entities }` with:

- **Text identity absolute**: preserved byte-for-byte — no trim, no NFC folding (tested with a truly
  NFC-composing sequence), no HTML escaping, no Markdown interpretation. Offsets/lengths are UTF-16 code
  units (never converted to code-point indexes). Unpaired surrogates in the text are typed-rejected
  (`text_unpaired_surrogate`); no range boundary may split a surrogate pair (`range_surrogate_split`); a
  range around the second character after a surrogate-pair emoji stays correct.
- **All 20 current Bot API entity types explicitly classified** — mention, hashtag, cashtag, bot_command,
  url, email, phone_number, bold, italic, underline, strikethrough, spoiler, blockquote,
  expandable_blockquote, code, pre, text_link, text_mention, custom_emoji, **date_time**. Unknown future
  types are typed-unsupported (`unsupported_entity_type`, distinguishable from malformed ranges by
  `entityIndex`). Documented metadata on a type that must not carry it is rejected
  (`unexpected_metadata`).
- **Conservative named application caps** (not claims about Telegram's exact character-count semantics):
  text 4096 / caption 1024 UTF-16 units; ≤100 entities; URL ≤2048 UTF-8 bytes; pre language ≤64 units;
  custom_emoji id ≤128 units; bounded minimal `text_mention` User (positive safe integer id, boolean
  is_bot, bounded first/last name, username, language code; EXACT documented field set — arbitrary raw
  nested fields rejected); date_time unix_time safe integer 0..4102444800 (the SAME conservative bound the
  parser applies to message dates, ADR-0035 — no invented tighter cap) with the exact full-match
  `r|w?[dD]?[tT]?` grammar including the valid empty string. Total serialized envelope ≤128 KiB measured
  on ACTUAL UTF-8 bytes, failing typed before any success — never truncated to fit.
- **Range validation fail-closed**: finite safe integers, offset ≥0, length >0, overflow-safe
  `offset + length ≤ text.length`.
- **Documented nesting matrix**: crossing overlaps invalid; code/pre isolated (neither contain nor be
  contained — disjoint isolated entities are legal); quote types never nest (quotes may hold non-quote
  children but never nest inside anything); only the formatting styles (bold/italic/underline/
  strikethrough/spoiler) and quotes may contain; all other types are atomic leaves. Identical ranges with
  the SAME type are rejected as duplicates (no silent widening/repositioning/dedup); equal ranges of
  DIFFERENT types are legal when at least one containment direction is legal (bold+italic, bold+text_link).
- **Deterministic canonical ordering** (offset asc, length desc, type, metadata) — entity array order
  carries no Telegram semantics; byte-identical original JSON array order is explicitly NOT claimed.
- **URL policy**: validation is NOT a fetch — nothing is ever dereferenced. Schemes allowlisted to
  http/https/tg/mailto/tel; javascript/data/file/unknown typed-rejected with no unsafe fallback; opaque
  URLs preserved EXACTLY (no decoding, case folding, or query rewriting).
- **Forward-compatibility policy (documented)**: unknown extra ENVELOPE-level fields are ignored on read,
  while every required field is re-validated; schemaVersion must be exactly 1 (`unsupported_version`
  otherwise); absent/unsupported-version/malformed outcomes stay explicit and distinct — unknown types and
  policy-limit failures never silently become empty entities or absent text.

### 3. Canonical serialization + defensive reading (future persistence compatibility ONLY)

`serializeRichTextEnvelope` emits the canonical JSON document (entities in exact Bot API wire shape so the
transport can forward them without re-mapping). `readRichTextEnvelope` pre-bounds the input (128 KiB
UTF-8, checked before parse), gates the schema version, and re-runs the FULL validation. This proves
future `document_json` persistence compatibility — it is NOT a durable write path, and no such claim is
made.

### 4. Separate typed entity-based transport on the EXISTING client factory

`createBotApiClient` returns the same client plus a cohesive capability interface
(`TelegramRichTextClient`), kept separate from `TelegramBotApiClient` so every existing admin-HTML
consumer/fake stays untouched: `sendMessageRich` / `editMessageTextRich` / `editMessageCaptionRich` send
EXACT `text` + `entities` or `caption` + `caption_entities` with NO `parse_mode` property. Runtime
re-validation through the domain validator (a forged cast cannot bypass the boundary — invalid content
fails typed with ZERO fetch calls); text/caption kind mismatches fail typed before fetch; link previews
stay disabled by default (existing policy); metadata for text_link/pre/text_mention/custom_emoji/date_time
is preserved end-to-end. custom_emoji OUTPUT requires an explicit trusted `customEmojiEligible`
capability; restricted → `custom_emoji_not_eligible` typed outcome BEFORE fetch (no drop/replace, no
pretend formatting success). Retention of an id is NOT a promise of delivery/rendering — Telegram's
bot/chat capabilities decide that, and client acceptance is not a guarantee of rendered appearance (also
true for text_mention/date_time). No media upload/sendPhoto/sendVideo/sendMediaGroup, album cloning, file
download, chunking, automatic truncation or edit workflow is added; the caption path is exercised through
a real `editMessageCaption` payload with fake target ids and is NOT media-forwarding support. The existing
admin-safe branded HTML path (runtime `isSafeTelegramHtml` gate, `parse_mode: 'HTML'`) is unchanged and
raw values cannot exploit it.

### 5. Honesty guardrails

- The R1.19 tests were written FIRST and ran RED on the untouched baseline with the honest label
  **capability absent** (the envelope module did not exist; 3 of 4 files failed collection; the parser
  file failed 12/16 probes). This is a NEW capability — NOT a historical correctness defect — and no
  fabricated historical red was recorded.
- All previous regressions remain green, including the ORIGINAL Posidon R1.18 S1/V1/C1 probes and the
  event-relation ORIGINAL A2/D2 probes.
- Zero AI calls, zero charges, zero DB writes, zero real network calls in tests and the demo; the demo's
  fetch is a captured fake with clearly fictional data; no tokens or personal data printed.

## Consequences

- The owner's final end-to-end publication scenario is NOT complete: no durable capture, no preview, no
  approval action, no channel publication, no live sending. All activation flags remain off/unchanged; no
  new admin command; no channel target wiring; TARGET_CHANNEL_ID untouched.
- Raw Markdown/HTMLV2 input parsing is deferred as a separate future mode.
- Later slices (tasked independently after review) will persist authorized incoming posts using THIS
  envelope, preview them, and integrate approval/outbox publication with the Phase 8 duplicate-mitigation
  gate (ADR-0032).
- Test/persistence note: the new suites are pure parser/transport tests (no DB) and are deliberately NOT
  registered in the `test:db` subset; no DB suite was added.

## Verification

- `npm run check` — version consistency (1.14.0 / schema 3) and lint.
- `npm run test:db` — unchanged subset, green.
- Six offline demos incl. the NEW `npm run demo:telegram-rich-text` — real parser → envelope → serializer →
  defensive reader → real client factory with fake fetch; captured payloads compared field-by-field;
  counts of synthetic requests, rejections before fetch, zero real network/AI/charge/DB writes.
