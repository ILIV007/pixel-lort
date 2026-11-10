# Phase 7.2 self-review — the media policy domain layer (candidates, rights, R2 temporary policy, album planning)

Round: on the post-7.1 tick-record tree (7f92e25) · 1.22.0 / schema 6 ·
2026-11-11 (Asia/Tehran) · ADR-0055

Scope honored: the roadmap bullet «Media candidates, rights policy, R2
temporary storage, album planning» — delivered as the PURE typed domain
layer `src/domain/media/` per the blueprint §3 module plan and §14
pipeline. This round builds NO live capability: no fetch, no upload, no
R2 binding, no persisted album kind, no flag, no migration. Everything
below names the test that pins it — nothing rests on a report's word.

## 1. The bullet → evidence matrix

| Roadmap/blueprint clause                                                                    | Shipped behavior                                                                                                                                                                                                                        | Pinning evidence (real, in this tree)                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collect media candidates (§14 step 1)                                                       | the versioned candidate v1: origin, ordinal labels, role vocabulary, opaque dedup keys, previouslyUsed, bounded dimensions — all strict-reader validated                                                                                | `tests/unit/media-candidate.test.ts` «accepts a fully valid candidate and echoes it verbatim», the out-of-vocabulary cells, the bounded-dimension cells, the opaque-key cells, the extra-keys-are-rejected behavior via «a payload that merely CLAIMS…» family                          |
| Canonicalize URL + compare URL/hash/visual-key (§14 step 2)                                 | https-only canonicalization, byte-preserving path/query, credentials/non-ASCII/2048-cap typed rejections; identity dedup NEVER from URL munging                                                                                         | «canonicalizes an https URL…», «preserves the path and query BYTE-EXACT…», «canonicalization is idempotent…», «rejects plain http…», «rejects every non-http(s) scheme…», «rejects credentials…», «rejects non-ASCII hosts…», «rejects an over-length URL…»                             |
| HTTPS, host policy, redirect cap, byte cap, MIME (§14 step 3)                               | the fixed policy contract mrp1: 3 redirects, 10 MiB photo / 50 MiB video (documented Bot API contract), the exact four-shape allowlist, public-DNS-only hosts                                                                           | `tests/unit/media-rights.test.ts` «pins the policy version…», «pins the exact MIME allowlist…», the IP-literal/local-name cells, «0..3 redirects pass, 4 rejects», the cap boundary cells (exactly-at passes, one-over rejects)                                                         |
| Reject unknown rights, piracy, executables, YouTube (§14 step 4)                            | unknown/restricted/piracy REJECT typed; executables/archives/documents OUTSIDE the allowlist reject with ONE reason; EVERY YouTube-family host rejected on DOWNLOAD (the 7.1 binding, stricter than the blueprint's audiovisual clause) | «rejects EVERY YouTube-hosted download even with fully official rights» (6 host shapes), «the ban outranks everything below it», the executable/archive/document/markup reject cell (11 mime shapes), «unknown rights REJECT…», «restricted…; piracy…»                                  |
| Score officiality/relevance/freshness/quality/aspect (§14 step 5)                           | DELIVERED AS ORDINALS — a TOTAL deterministic comparator (officiality > relevance > freshness > unused-before-used > URL tiebreak) with NO numeric score/percent/weight field anywhere                                                  | «officiality: official > verified_source > unofficial», «relevance…», «freshness…», «never-used sorts before previously-used», «the final tiebreak…», «the comparator NEVER invents a numeric value», «the candidate type carries NO numeric score/weight/percentage vocabulary at all» |
| Select mode: none/single/album/official-video-link (§14 step 6)                             | DERIVED from the FINAL selection; an official video LINK is its own mode (never a download; a YouTube host IS admissible as a link)                                                                                                     | `tests/unit/album-plan.test.ts` «0 candidates and no link ⇒ none», «0 candidates + an official video link ⇒ official_video_link», «a YOUTUBE host is ALLOWED in link mode…», «exactly 1 ⇒ single…», «exactly 2 ⇒ album…», «candidates AND a link ⇒ …»                                   |
| Album 2–10, caption only on ordinal 0 (§14 step 7)                                          | the 2..10 window with typed size-cap exclusions; `captionAllowed` true ONLY at ordinal 0 (the 7.1 no-separation layer EXTENDED)                                                                                                         | «exactly 2 candidates ⇒ album», «12 candidates ⇒ exactly 10 items + 2 typed exclusions», «exactly 10 is inside the cap…», «captionAllowed is true ONLY at ordinal 0, false on every other item»                                                                                         |
| Default album policy (§14)                                                                  | cover first → gameplay → other → concept (or the explicit story-layer swap); videos at the END unless videoAsPrimaryNews promotes the comparator-best video; ≤2 per visualKey typed                                                     | «cover/key art first…», «the story-demand override swaps gameplay/concept (an explicit INPUT flag — never an inference)», «videos ride at the END…», «relevance primary ALONE promotes nothing…», «videoAsPrimaryNews promotes…», the visualKey cap cells                               |
| R2 temporary = 72h; file_id save → delete; no transcoding (§23, step 9–10, arch-decision 5) | the fixed rtp1 policy + the TOTAL lifecycle machine; the REUSE RULE machine-enforced (a saved file_id never re-uploads); deadline math deterministic (+72h, leap-safe)                                                                  | `tests/unit/r2-temporary-policy.test.ts` «pins the 72-hour retention…», the happy-chain cell, the failure-path cells, «file_id_saved → upload_started is rejected», «both terminal states reject every event», «skipping steps is invalid», the +72h/leap-day cells                     |
| The 7.1 binding: ambiguity ⇒ reject/defer                                                   | conflicting rights metadata DEFER with rights_ambiguous; a hard rejection outranks the conflict flag                                                                                                                                    | «CONFLICTING rights metadata DEFER with rights_ambiguous», «a hard rejection outranks a conflict flag»                                                                                                                                                                                  |
| The 7.1 binding: R2 only with an explicit policy                                            | the allow decision's destination is ALWAYS r2_temporary_only — a rights clearance never grants a publish; the R2 contract is the rtp1 policy module                                                                                     | «each cleared state allows ONLY the r2_temporary_only destination», the r2-temporary suite (whole file)                                                                                                                                                                                 |
| Input contract discipline                                                                   | duplicates (same URL or contentHash) fail the WHOLE plan typed; invalid candidates re-validated (defense in depth)                                                                                                                      | «a duplicate canonicalUrl fails the WHOLE plan», «a duplicate contentHash fails the WHOLE plan even when the URLs differ», «an INVALID candidate in the input is re-validated and fails typed»                                                                                          |
| Determinism                                                                                 | the same input is JSON-equal deterministic; exclusions always typed (never silent)                                                                                                                                                      | «two runs over identical input are JSON-equal», the exclusion-shape assertions («excluded» equality cells)                                                                                                                                                                              |

## 2. The RED-first record (honest)

The four suites were written FIRST (82 tests) and the RED was real: 4
files failing with cannot-resolve-module on the untouched tree. During
the GREEN pass, FOUR in-round findings were fixed as findings (the
tests' honest corrections, recorded here):

1. **The `[::1]` port-split bug** (the round's REAL bug, found by the
   suite): the rights decision stripped a `:port` from the host with
   `split(':')[0]`, which chopped the bracketed IPv6 literal `[::1]`
   into `[` — letting a loopback literal through the host policy. The
   fix: a bracketed host is never port-split. Pinned by «rejects
   IP-literal hosts outright (v4 and bracketed v6)».
2. The 2048-URL-cap boundary test used a 25-char prefix; the actual
   prefix `https://cdn.example.com/` is 24 — the exactly-2048/2049
   boundary is now pinned correctly.
3. The reader now distinguishes an ABSENT version (`candidate_malformed`)
   from a PRESENT wrong version (`candidate_version_unsupported`).
4. The reader now distinguishes an out-of-vocabulary role
   (`candidate_malformed`) from the OTHER kind's role
   (`candidate_role_kind_mismatch`).

The leap-day retention cell pinned the `toISOString()` millisecond
shape (`.000Z`) — a test-expectation correction, recorded for
honesty.

## 3. Structural invariants (why the contract holds)

1. **Totality**: `decideMediaRights` ALWAYS returns a decision; the
   lifecycle machine ALWAYS returns ok/invalid; the planner ALWAYS
   returns plan/failure — no partial answers, no exceptions crossing
   the boundary.
2. **Precedence is tested, not conventional**: the transport checks
   run before the rights checks; the YouTube ban outranks the MIME
   and rights checks; a hard rejection outranks the ambiguity defer —
   each pinned by a dedicated cell.
3. **The reuse rule is structural**: `file_id_saved → upload_started`
   is an invalid transition BY THE MACHINE — 7.3 cannot "forget" it.
4. **No accuracy vocabulary exists**: the candidate carries ordinals;
   the comparator outputs -1|0|1; the plan carries no score/percent/
   confidence field (asserted on the serialized JSON).

## 4. Honest limits

- NO live capability: the collection adapters, the fetch/download
  adapter, the R2 binding, the upload path and the persisted album
  media kind are 7.3+; every one of them is BLOCKED_LIVE (Posidon
  only).
- The byte caps are the DOCUMENTED Bot API contract values — NOT
  measured free-tier behavior; no numeric-accuracy claim is made
  anywhere (the Phase 6 gate condition applies verbatim).
- The visualKey cap is a deterministic proxy over an OPAQUE key — the
  module NEVER claims to know what images depict.
- The role vocabulary and the ordinal labels are the v1 policy; a
  future policy revision bumps the version fields (mrp1/rtp1/alp1 are
  pinned in tests).

## 5. Conditions carried into 7.3 (binding)

1. The three no-separation layers (model/storage/send) extend, never
   weaken: an album is a NEW media kind — its caption rides ordinal 0
   ONLY (already pinned in the plan).
2. The upload adapter MUST drive the r2-temporary lifecycle machine
   and MUST reuse a saved file_id before any new download/upload.
3. The fetch adapter MUST enforce the transport rules (https-only,
   the four-shape MIME allowlist, the caps, the redirect cap, the
   streaming byte cap when `byteCapUnchecked` is true).
4. Rights decisions flow through `decideMediaRights` — never
   re-implemented ad hoc.
5. All live surfaces stay BLOCKED_LIVE (Posidon only); PR #11
   open/draft; FF-only pushes on `review/r1.10.3-sql-design`.
