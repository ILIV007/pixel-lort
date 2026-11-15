# Phase 9B — the read-only story-identity screen (`/story <storyId>`)

Status: DELIVERED (app 1.33.0, schema 6 — ZERO DDL). The EXACT R1.18/9A
house shape, applied to the story lane: an independent fail-closed flag, a
pure router grammar, an injected service with a bounded read-only SQL
budget, blueprint-derived RBAC, and the honest observation notes.

## 1. Surface

- Command: `/story <storyId>` — the EXACTLY-ONE-OPAQUE-TOKEN form ONLY.
  There is NO list form (a per-story view needs the story handle);
  undefined/empty, whitespace, control characters (C0 + DEL), or a token
  over 128 UTF-8 bytes are all the honest invalid-usage state. The parser
  is PURE and synchronous (`src/admin/story-command.ts`); the router calls
  it BEFORE any query adapter can ever be involved; the raw text is never
  echoed back.
- Flag: `ADMIN_STORY_ENABLED` ('true' | 'false', default 'false') in the
  SAME phase9 config spec — independent, non-secret, fail-closed; an
  invalid-present value records the issue and keeps the flag disabled
  (never coerced). While OFF the command keeps the exact unknown-command
  noop semantics (zero story queries) and /help never advertises it. The
  whole-spec fail-closed rule is pinned by a test: an invalid sibling flag
  value keeps this flag disabled too.
- RBAC: `story.view` — derived VERBATIM from the approved admin map (the
  TOTAL map is pinned by a test: every non-owner role holds it today, and
  a blueprint change fails loudly). The localized
  `insufficient_permission` denial path exists for future role
  vocabulary; with the CURRENT map it is unreachable through real roles —
  recorded honestly here instead of being faked in a test.
- Privacy: PRIVATE chat only; edited messages are noop; unauthorized
  actors get the fixed English denial (no data, no existence leak).

## 2. The bounded reads (the SQL budget)

Exactly TWO bounded read-only SELECTs in
`src/adapters/db/story-view-store.ts` (the ONLY story SQL the surface may
execute; both shapes are exported for the EXPLAIN evidence tests):

1. `STORY_VIEW_SQL` — the story identity by PRIMARY KEY with the working
   headline projected bounded in SQL (`substr`, 200 chars). Projects ONLY
   the durable machine-held facts: id, story_key, status, trust_status,
   content_type, priority, confidence, headline, the timeline epochs,
   version, merged_into_story_id, created_at, updated_at.
2. `STORY_PUBLICATIONS_SQL` — the story's publication history over
   `idx_publications_story (story_id, created_at DESC)` with LIMIT 9 (8
   visible rows + 1 probe row that only establishes `more_available`; no
   COUNT(*), no OFFSET). Projects identity/status/counters/stable codes
   ONLY — the EXACT /queue field discipline: never the draft document,
   never any destination-shaped value.

REAL EXPLAIN QUERY PLAN evidence (LOCAL PROXY, pinned by tests): both
plans are index SEARCHes (`stories` PK index; `idx_publications_story`),
no SCAN, no temp B-tree.

**The honest boundary: drafts are NEVER read by this surface.** No index
exists on `drafts.story_id` (the only drafts index is
`idx_drafts_status_time (status, created_at DESC)`), so a per-story drafts
listing would be a full table scan — the R1.18 real-EXPLAIN discipline
outright forbids it. The screen therefore shows the story's identity and
its publication history, NOT its draft inventory; the assertion that the
flow performs ZERO `FROM drafts` statements is pinned in the suite. The
same applies to `corrections` (no story_id index): the correction state is
surfaced only indirectly through the publication statuses (superseded).

## 3. The renderer (reserved skeleton)

`renderStoryView` (budget-first, the R1.18.1 S1 discipline): the title,
the honest send-gate note (the caller passes the parsed scheduler gate —
the observation NEVER pretends a live scheduler exists), the identity
section and the publications section are ALWAYS present; the empty
publications note is information (a zero is a fact); rows render in the
store's newest-first order capped at 8; the more-available note states the
bound. The not-found state is honest and never echoes the requested id.
The merged state (`merged_into_story_id`) is surfaced explicitly; a null
headline is stated as an em-dash, never fabricated. Labels localize
(en/fa, `src/admin/story-strings.ts`); every stored value is rendered
verbatim — never translated, never re-cased.

## 4. Wiring

- Router (`src/admin/command-router.ts`): the typed `story_view` action
  (chatId, storyId, uiLanguage); the two new noop reasons
  `story_not_private_chat` / `story_edited_message` joined the closed
  NoopReason vocabulary; the /help advertisement line is gated on
  flag ON AND `story.view`.
- Ingress (`src/application/telegram-ingress.ts`): the injected
  `adminStoryView` service executes the action; a missing service is a
  retryable `service_unavailable` wiring failure — never a silent skip,
  never a fabricated empty reply.
- Production wiring (`src/entrypoints/http/handlers/telegram-webhook.ts`):
  the gate is parsed by the SAME fail-closed phase9 config; the service is
  wired ONLY while the gate is ON, with the honest constant
  `sendGateEnabled: false` (the LIVE scheduler wiring stays BLOCKED_LIVE —
  ADR-0058; Posidon only).
- Env surfaces: `.env.example`, `.dev.vars.example`, `wrangler.jsonc` —
  `ADMIN_STORY_ENABLED=false` shipped everywhere; the version pins moved
  to 1.33.0 across all active configuration files.

## 5. Tests (RED-first held)

`tests/integration/admin-story-view.test.ts` — written FIRST with a real
RED (`Cannot find module '../../src/admin/story-command'`, exit 1) then
GREEN 32/32, registered in `test:db`:

- the grammar family (REQUIRED one token; unicode pass-through; the byte
  cap; whitespace/control/two-token rejections; NO list form);
- the fail-closed flag parse family (absent/false/true; the
  never-coerced invalid-present family; the whole-spec sibling rule);
- the TOTAL blueprint-pinned `story.view` map;
- the renderer family (the reserved skeleton; the honest empty/not-found/
  merged/null-headline states; the gate-note honesty; the 8-row cap with
  the newest-first order and the more-available note; no destination
  shapes);
- the REAL-D1 routing family (flag OFF = noop with ZERO stories-table
  statements; the owner/viewer views; the not-found honesty; the fixed
  English denial for unknown actors; group/edited noops; invalid grammar
  with ZERO story SQL; the gated /help advertisement; the missing-service
  retryable failure; the SQL LIMIT cap with the probe note; the
  ZERO-publication-writes SQL-text assertion; the ZERO `FROM drafts`
  assertion);
- the REAL EXPLAIN QUERY PLAN family (both statements: index SEARCHes
  only, no SCAN, no temp B-tree).

## 6. In-round findings

1. TEST-SIDE: the first harness run exposed the missing
   `publications.draft_id` FK target (the seeded publications need a
   stored draft row) — fixed by seeding one draft in the two affected
   tests; no shipped-code impact.
2. TEST-SIDE: the re-export of `STORY_COMMAND`/`STORY_ID_MAX_BYTES` from
   `story-command.ts` does not bring the names into the module scope (the
   parser referenced an undefined binding at runtime) — fixed by importing
   the constant explicitly; caught by the routing tests, not by the type
   checker alone.
3. SHIPPED-SIDE (caught by typecheck): the two new noop reasons were
   missing from the closed `NoopReason` vocabulary — added; the closed
   vocabulary discipline held (the compiler refused the unlisted reason).

## 7. Honest carry

The write-capable queue dispositions, the album-draft PRODUCING side, the
whole-story sweep orchestration, and the zod v4 TRACKED migration stay the
documented carries; every LIVE surface stays BLOCKED_LIVE (Posidon only).
