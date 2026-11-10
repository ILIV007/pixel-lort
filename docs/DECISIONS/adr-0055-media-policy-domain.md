# ADR-0055: Phase 7.2 — the media policy domain layer (candidates, rights, R2 temporary policy, album planning)

- Status: Accepted (V4 local engineering round; Posidon independent acceptance still outstanding for every live surface)
- Date: 2026-11-11 (Asia/Tehran)
- Round: 1.22.0 / schema 6 (no migration, no SQL)
- Baseline: 7f92e25b48ca5999cce07015b7f67c450f4e8171 (the post-7.1 tick-record tip, which includes the parallel sibling's 6-gate + 7.1 records)
- Roadmap anchor: Phase 7 bullet «Media candidates, rights policy, R2 temporary storage, album planning»
- Blueprint anchors: §3 (`domain/media`: Media candidate, rights state, album plan, usage history), §14 (the media pipeline + the Default album policy), architecture decision 5 (R2 stores temporary, rights-cleared media only; YouTube audiovisual content is never downloaded), §23 (temporary R2: 72 hours)
- Owner directive in force: FULLER steps — every round delivered at full depth (2026-11-10 order)

## Context

Phase 7.1 (the previous round) verified the EXISTING single photo/video
surface clause by clause and carried BINDING conditions into 7.2/7.3:
the three no-separation layers (model/storage/send) are preservation
requirements an album must extend never weaken; ambiguous rights ⇒
reject/defer with a typed reason; YouTube stays OUTSIDE any download
permission; R2 only with an explicit policy, rights and free-limit
design; no accuracy claims without a real benchmark. The roadmap's
Phase 7 remaining bullets were: (a) media candidates, rights policy, R2
temporary storage, album planning — this round; (b) Telegram upload
with `file_id` reuse and R2 retention cleanup — 7.3 (with the album
media kind).

`src/domain/media/` was empty (the domain README listed it as the
Phase 7 placeholder). Nothing below adds a live surface, a flag, a
migration, or an adapter.

## Decision

1. **Four PURE domain modules in `src/domain/media/`** (the blueprint §3
   plan, delivered at the policy-contract depth; zero I/O, zero SQL,
   zero network, zero flags — the adapters that will consume them are
   7.3+ and Posidon-live):

   - **`media-candidate.ts`** — the versioned candidate model (v1):
     origin (`official_api` | `source_metadata`), the ORDINAL labels
     (officiality official > verified_source > unofficial; relevance
     primary > supporting; freshness current_cycle > recent > aged),
     the role vocabulary (photo: cover_key_art | gameplay |
     concept_art | other_screenshot; video: video), the OPAQUE dedup
     keys (canonicalUrl + optional bounded printable-ASCII
     contentHash/visualKey — never interpreted), the usage-history
     presence (`previouslyUsed`) and bounded declared dimensions
     (1..10000). PLUS: the https-only, byte-preserving URL
     canonicalization (host lower-cased, fragment dropped, port 443
     dropped; credentials, non-ASCII hosts — no punycode
     interpretation — and over-2048 URLs rejected typed); the strict
     fail-closed reader (an ABSENT version is malformed, a PRESENT
     wrong version is version-unsupported; role/kind mismatch is
     distinct from an out-of-vocabulary role; extra keys fail; the
     stored canonicalUrl must re-canonicalize to itself); and the
     TOTAL deterministic comparator (officiality > relevance >
     freshness > unused-before-used > URL lexicographic) — outputs
     only -1|0|1, NO score/percent/weight/confidence field exists.

   - **`media-rights.ts`** — the TOTAL typed decision function
     (allow_temporary | reject | defer, each with a reason and the
     fixed policyVersion `mrp1`) under the DOCUMENTED, TESTED
     precedence: URL admissibility > the YouTube download ban > the
     host policy > the MIME allowlist > the byte caps > the redirect
     cap > the rights states. The 7.1 binding is adopted STRICTER than
     blueprint §14 step 4: EVERY YouTube-family host (youtube.com,
     youtu.be, youtube-nocookie.com, googlevideo.com + subdomains) is
     outside ANY download permission (linking stays possible — the
     album-plan link mode — because linking is not downloading). The
     SSRF posture: media hosts must be PUBLIC DNS names — IP literals
     (v4 and bracketed v6) and localhost/.localhost/.local/.internal
     are forbidden outright; the bracketed-IPv6 literal is NOT
     port-split (the in-round RED-found bug: `split(':')[0]` chopped
     `[::1]` into `[` and let it through — fixed and pinned). The MIME
     allowlist is EXACTLY image/jpeg, image/png, image/webp, video/mp4
     — executables, archives, documents, markup and every unknown
     class are OUTSIDE it and rejected with ONE typed reason without
     enumeration. The byte caps are the DOCUMENTED Telegram Bot API
     contract limits (photo 10 MiB, video 50 MiB); an UNKNOWN size
     NEVER sneaks through — the allow carries `byteCapUnchecked: true`
     for the streaming adapter. Redirects cap at 3. Rights:
     unknown/restricted/piracy_indicated REJECT; CONFLICTING rights
     metadata DEFERS (`rights_ambiguous` — the 7.1 rule); a hard
     rejection outranks a conflict flag. The allow is ALWAYS
     destination `r2_temporary_only` — a rights clearance NEVER grants
     a publish.

   - **`r2-temporary.ts`** — the fixed policy contract (72-hour
     retention, delete-after-file_id-save, file_id-reuse-before-upload,
     transcoding-forbidden) + the TOTAL lifecycle state machine:
     staged → upload_in_progress → file_id_saved → r2_object_deleted
     (terminal); upload_failed → retry_scheduled → staged (a bounded
     retry re-STAGES) or retention_lapsed → retention_expired
     (terminal). THE REUSE RULE IS ENFORCED BY THE MACHINE:
     `file_id_saved → upload_started` is an invalid transition — a
     saved file_id never re-uploads (the 7.3 economy rule pinned at
     the policy layer). An invalid fileId fails typed BEFORE any
     state changes. The deadline math is deterministic ISO (+72h,
     leap-safe, sub-second preserved; invalid input typed). NO
     measured free-tier usage claim anywhere — the real numbers are
     Posidon's to measure.

   - **`album-plan.ts`** — the DERIVED select mode (0 candidates ⇒
     none, or official_video_link when ONLY a link exists; 1 ⇒
     single; 2..10 ⇒ album; over 10 ⇒ the policy-ordered top 10 with
     typed `album_size_cap` exclusions) and the deterministic
     blueprint ordering: cover/key art first → gameplay → other
     screenshots → concept art (the story layer may swap
     gameplay/concept ONLY via the explicit
     `storyDemandsConceptBeforeGameplay` flag); videos ride at the
     END unless `videoAsPrimaryNews` promotes the comparator-best
     video to the front (relevance 'primary' ALONE promotes NOTHING —
     the story layer decides). The ≤2-per-`visualKey` cap produces
     TYPED exclusions (`visually_similar_cap`) — never silent, never
     an accuracy claim about image content. The caption rides ONLY
     ordinal 0 (`captionAllowed` true at ordinal 0, false elsewhere)
     — the 7.1 no-separation layer EXTENDED to the album plan. Mixed
     photo+video albums compose (the Bot API media group supports
     it); duplicates (same canonicalUrl or contentHash) fail the
     WHOLE plan typed; input candidates are RE-VALIDATED (defense in
     depth). A YouTube URL is admissible here ONLY as the LINK
     companion (`companionOfficialLink`, canonical under the same
     https discipline) — never merged into a group, never downloaded.
     The SAME input is JSON-equal deterministic. The blueprint's 3–6
     "target" is COLLECTOR guidance — the planner NEVER pads.

2. **RED-first discipline held**: the four adversarial suites (82
   tests) were written FIRST and recorded their real RED (4 files
   failing — cannot-resolve-module) on the untouched tree; the
   in-round RED findings that SURVIVED into the implementation were
   fixed as findings, not test edits: the `[::1]` port-split bug
   above, the boundary off-by-one in the 2048 URL-cap test (the
   prefix is 24 chars, not 25), the absent-vs-wrong version reason
   distinction, and the out-of-vocabulary-role vs cross-kind-role
   distinction. The `toISOString()` millisecond shape (`.000Z`) was
   pinned in the leap-day retention cell.

3. **What this round deliberately does NOT do** (honest boundary): no
   persisted album media kind, no R2 binding, no upload path, no
   fetch/download adapter, no flag, no migration (schema stays 6), no
   collector wiring, no numeric-accuracy claim of any kind — those
   are 7.3's design+build work and the live paths stay BLOCKED_LIVE
   (Posidon only). The four modules are the CONTRACT 7.3 must obey;
   the three no-separation layers extend, never weaken.

## Consequences

- 7.3 can build the album media kind and the upload/R2 adapter
  against TYPED, tested policy contracts instead of re-deciding them.
- The rights decision is total and auditable (every outcome carries
  the policy version + a typed reason) — future integration suites
  can replay it.
- The reuse rule, the retention, the similarity cap and the caption
  ordinal are MACHINE-ENFORCED, not conventions.
- No behavior of the shipped surface changes this round (pure
  additions; every existing suite's contract unchanged).

## Verification

- RED recorded (4 files, cannot-resolve-module, real failure output).
- GREEN: `npx vitest run tests/unit/media-candidate.test.ts
tests/unit/media-rights.test.ts tests/unit/r2-temporary-policy.test.ts
tests/unit/album-plan.test.ts` → 4 files / 82 tests passed, exit 0.
- Full gates re-run for the round (npm run check, npm run test:db) —
  real exits recorded in the round delivery message and
  PROJECT_STATUS.
