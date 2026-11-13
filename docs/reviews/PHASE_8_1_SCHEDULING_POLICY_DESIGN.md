# Phase 8.1 self-review — the publication scheduling policy layer (Tehran windows, priority classes, anti-robot rules)

Round: on the post-7.3 tick-record tree (3e23999) · 1.24.0 / schema 6 ·
2026-11-11 (Asia/Tehran) · ADR-0057

Scope honored: the roadmap Phase 8 bullet «Tehran-window scheduling,
anti-robot rules, priority classes» — delivered as the PURE typed domain
layer `src/domain/publishing/` following the blueprint §16 scheduling
policy and the Phase 7.2 house pattern (pure policy first, the durable
scheduler is the NEXT slice). This round builds NO live capability: no
migration, no store, no job handler, no send, no flag change. Everything
below names the test that pins it — nothing rests on a report's word.

## 1. The bullet → evidence matrix

| Blueprint §16 clause                                                                                                                                                                                                                                                                                    | Shipped behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Pinning evidence (real, in this tree)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tehran windows: 09:30–11:30 morning scan; 13:00–15:30 midday; 17:00–19:30 evening; 20:00–23:00 prime; 23:00–00:45 late-night/radar; 01:00–08:30 quiet for P2/P3                                                                                                                                         | the pinned `twp1` segment table: the day TOTALLY partitioned into 5 ACTIVE windows + quiet + 5 named gaps; the [start, end) boundary convention; late_night_radar represented wrap-aware ([00:00,00:45) ∪ [23:00,24:00)) with TRUE occurrence bounds crossing midnight                                                                                                                                                                                                                                                                                                                          | `tests/unit/tehran-windows.test.ts`: the per-minute EXHAUSTIVE sweep over three Tehran days (4320 minutes) against an independent spec table; the boundary cells (09:29:59.999/09:30:00.000, 11:29:59.999/11:30:00.000, 22:59:59.999/23:00:00.000, 00:44:59.999/00:45:00.000, 00:59:59.999/01:00:00.000, 08:29:59.999/08:30:00.000); the cross-midnight bounds cells (23:30 → [today 23:00, tomorrow 00:45); 00:15 → [yesterday 23:00, today 00:45)); the sorted-chain coverage cell                                                                                                                                                                                                                                 |
| Priority: P0 (90–100) no daily cap, bypass quiet hours; P1 (75–89) within 5–20 minutes; P2 (40–74) dynamic window; P3 (0–39) evergreen filler only                                                                                                                                                      | the pinned `pcp1` classification + descriptors carrying EXACTLY the blueprint facts (+ the documented P1 quiet pin below); integers-only 0..100, everything else typed `invalid_score`                                                                                                                                                                                                                                                                                                                                                                                                          | `tests/unit/priority-classes.test.ts`: the 8 boundary cells (0/39/40/74/75/89/90/100), the descriptor-fact cells (P0 dailyCap false + bypass, P1 latency {5,20}min, P2 dynamic_window, P3 filler_only), the quiet matrix, the invalid-score family (-1, 101, 74.5, NaN, ±Infinity)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Anti-robot: 25–45 min normal gap; 8–15 min P1 gap; unrelated P0 bypass with a small anti-flood gap; same-game cooldown 90 min unless meaningful update; same layout max 3 consecutive; same category ≤40% of rolling six unless event-driven; content mix over rolling seven days, never forced per day | the pinned `arp1` rules: band selection by class/relatedness with the caller-supplied deterministic jitter validated against the SELECTED band; the «small» anti-flood pin HONESTLY quantified as 2–4 min (a policy pin, recorded — the blueprint leaves it unquantified); the 90-min cooldown with the EXPLICIT story-layer flag; the trailing-run layout cap; the rolling-six category cap in EXACT integer math ((count+1) ≤ 2, never a float share); the weekly mix over the CLOSED ten-category vocabulary with per-mille targets and integer-exact status math over a rolling 168h window | `tests/unit/anti-robot.test.ts`: the constants-pinning cells; the band-selection family (no-prev / unrelated-P0 / related-P0-conservative / P1 / P2+P3); the exact-band-boundary cells (2/4, 25/45, 8/15 min — at-bound passes, one-over rejects); the cooldown family (90:00 boundary inclusive, 89:59 blocked with exact eligibleAt, meaningful-update bypass, future-history typed fail); the layout family (run 0/1/2/3, the END-anchored cells, the alternating history); the share family (0/1/2 counts, the SEVEN-entry rolling-window proof, event-driven bypass, unknown_category); the mix family (targets sum = 1000, the (now−168h, now] boundary cells, the integer-exact on/under/over cells, no_data) |
| The composed decision                                                                                                                                                                                                                                                                                   | the `psp1` composition `planPublicationTime`: documented precedence layout > category > mix (NON-time-resolvable ⇒ typed DEFER with dueAtMs NULL) > time computation (P0 gap; P1 latency + fixed 8-min spacing floor; P2/P3 clamped-never-past) > cooldown shift > the window gate LAST for quiet-gated classes only; every applied rule recorded; the four policy versions carried                                                                                                                                                                                                             | `tests/unit/publication-schedule.test.ts`: the P0 quiet-bypass cell (window.kind 'quiet' RECORDED, no gate), the related-P0 cell, the P1 floor-dominates cell, the P1-in-quiet cell, the exact-epoch deferral cells (quiet → 09:30; gap 11:45 → 13:00), the late-night-is-active cell, the clamp cell, the cooldown-then-gate cells, the P3-filler mix defer + the advisory-only news cell, the precedence cell, the schema-version/score/jitter/vocabulary typed-failure family, the JSON-equal determinism cell                                                                                                                                                                                                    |
| Honesty guards                                                                                                                                                                                                                                                                                          | no randomness inside the domain (jitter ALWAYS an input); no floating-point share/percentage anywhere; a deferred decision NEVER fabricates a timestamp; future-dated history fails typed; JSON-equal determinism pinned in all four suites                                                                                                                                                                                                                                                                                                                                                     | the determinism cells ×4; the future-timestamp typed failures; the integer-math mix cells                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 2. The RED-first record (honest)

The four suites were written FIRST (101 tests) and the RED was real:
4 files failing with cannot-resolve-module on the untouched tree (exit 1,
recorded before any implementation existed in `src/domain/publishing/`).
During the GREEN pass, EIGHT in-round findings surfaced and were fixed as
findings — THREE real implementation defects and FIVE test-side defects
(all recorded here, none hidden):

1. **[IMPLEMENTATION] The wrap-piece start bug**: the classifier resolved
   the late-night wrap piece [00:00,00:45) with `startAbs = dayBase − 24h`,
   i.e. YESTERDAY 00:00 instead of YESTERDAY 23:00 — a 22h45m phantom
   interval that misclassified the post-midnight tail. Found by the
   cross-midnight bounds cells; fixed by the occurrence model.
2. **[IMPLEMENTATION] The midnight-split ends bug**: representing the
   late-night window as two minute-pieces made the classifier report the
   PIECE end (midnight) instead of the SEGMENT end (00:45) — a stored
   bounds lie for every evening occurrence. Fixed by the occurrence model:
   the two pieces are one SEGMENT occurrence with TRUE absolute bounds
   (today 23:00 → tomorrow 00:45 / yesterday 23:00 → today 00:45).
3. **[IMPLEMENTATION] The composition's missing candidate identity**: the
   first draft of the composition input carried the category history but
   NO candidate category/layout — the layout cap and the mix gate had no
   subject. Caught while writing the GREEN pass; fixed by adding the
   required `category` (closed vocabulary) and `candidateLayout` inputs
   BEFORE any GREEN claim (the RED suites were amended in the same
   pre-GREEN pass — no test was weakened to pass).
4. **[TEST] The 21:00 next-window cell contradicted the module's own
   contract**: from inside prime the next active start is the same
   evening's 23:00 late_night (strictly-after semantics), not tomorrow
   09:30. The implementation was right; the cell was corrected to the
   contract.
5. **[TEST] The coverage cell assumed per-segment contiguity** and broke
   on the legitimate wrap representation; fixed with the wrap-aware
   sorted-chain walk.
6. **[TEST] `30.5 * MIN` is an EXACT integer ms inside the normal band**
   (1,830,000) — the intended fractional-jitter cell actually tested a
   valid input. Replaced with a true non-integer ms value.
7. **[TEST] The two-crack mix fixture dropped the first crack**
   (`slice(1)` removed the entry it meant to keep) — the over-target
   assertion never had two cracks. Fixed to the full history + one more.
8. **[TEST] The P3 over-target fixture tripped the CATEGORY cap before
   the MIX gate** (two same-category posts in the rolling six) — the mix
   defer was unreachable with that data. Re-built on esports (target
   30‰): one post in three is far over target while the share cap still
   admits the candidate — the two gates are now genuinely isolated.

## 3. The documented policy pins (decisions this round OWNS)

- **The anti-flood pin**: blueprint «small anti-flood gap» is
  unquantified; `arp1` pins 2–4 minutes. A pin, not a quote — recorded
  here, in the module header and in ADR-0057.
- **The related-P0 pin**: the blueprint grants the bypass to UNRELATED
  P0 only and is silent about related ones; `arp1` takes the conservative
  reading (related P0 → the normal 25–45 band).
- **The P1 quiet pin**: the blueprint's quiet label names «P2/P3» ONLY;
  P0's bypass is explicit; P1's 5–20-minute contract is incompatible
  with a quiet deferral — so the quiet gate binds P2/P3 only. This is the
  literal blueprint text, pinned and tested.
- **The window-gate pin**: P2/P3 defer to the next ACTIVE WINDOW START
  (not merely quiet's end) — the windows are the publishing windows.
- **The mix-enforcement pin**: the hard mix gate binds ONLY P3 filler
  discretion; P0/P1/P2 carry the report as an advisory — «never forced
  per day» honored because the mix gate never blocks news.
- **The layout/category pins**: the layout cap and the category share
  cap are NOT time-resolvable (waiting alone changes neither the
  trailing run nor the rolling six) — a block is a typed DEFER with
  `dueAtMs: null`, never a fabricated future timestamp.

## 4. Honest limits

- The DURABLE scheduler (the `publications` outbox, the claim/lease
  path, the reconciliation of ADR-0032's gate) is NOT built here — this
  is the policy layer the next Phase 8 slice will consume. The GATE
  checkbox stays open.
- The category vocabulary is CLOSED at the ten blueprint mix labels;
  widening it is a policy-version change (`arp1`), never a silent pass.
- The weekly-mix window is a rolling 168 hours (pinned), not a Tehran
  calendar week — the blueprint says «rolling seven days».
- No measured audience/flood claims anywhere: every number is either a
  blueprint quote or a marked `arp1`/`psp1` pin.
- BLOCKED_LIVE unchanged (Posidon only): no send, no channel
  operation, no flag enabled, schema 6 untouched, zero DDL.

## 5. The completion round's gate findings (honest, THIS round)

The in-flight tree's GREEN claim (101/101) was true for vitest — but the
tree had NEVER been through the full `npm run check` gate. Running the
real gates surfaced THREE findings, all fixed in-round before any commit
(recorded here because an un-gated GREEN is not a delivery):

1. **[GATE] The formatting gate had never run**: `prettier --check`
   failed on all TEN new files (exit 1, real). Fixed with
   `prettier --write` (whitespace-only; zero semantic change; the four
   suites re-run green after the reformat).
2. **[GATE] The typecheck gate had never run**: `tsc --noEmit` failed
   with SIXTEEN strict-mode errors (exit 2, real) under the repo's
   `strict` + `noUncheckedIndexedAccess` config:
   - **SIX in `tehran-windows.ts`**: indexed access over the pinned
     table (`segment.pieces[0]`/`[1]`, `candidates[0]`) yields
     `T | undefined`. Fixed with a TOTAL `pinnedPiece` accessor — the
     table is a compile-time constant whose structure is pinned by
     test, so a missing piece is a TABLE-INVARIANT violation that
     throws LOUDLY (never `!`-asserted away, never silently guessed
     around) — and the `earliest !== undefined` guard on the
     next-window search (an empty candidate array continues the bounded
     day loop, equivalent to the previous length check).
   - **NINE in `tests/unit/tehran-windows.test.ts`**: the double-call
     idiom `classifyTehranWindow(x).ok && classifyTehranWindow(x).value?.name`
     — TypeScript can never narrow the union ACROSS two independent
     calls, and the assertion read `.value` off a SECOND classification
     (deterministic, so behavior-identical, but type-unsafe and a
     double evaluation). Fixed with the single-call `mustClassify`
     helper (one classification, narrowed through one variable, failing
     the cell loudly on any typed rejection) — every boundary cell kept
     its full strength, none weakened.
3. **[PROCESS] An un-gated GREEN is not a delivery**: the RED-first
   record above is unchanged and true, but this round's gate run is the
   FIRST real `npm run check` this slice has passed. The lesson is the
   house lesson: a slice is delivered by its GATES, not by its suite
   output alone.

Post-fix gate exits (real, on the delivery tree): `tsc --noEmit` exit 0,
`prettier --check` clean, the four suites 101/101 green, then the FULL
`npm run check` and `npm run test:db` re-run for the round (exits
recorded in the tick report and PROJECT_STATUS.md).
