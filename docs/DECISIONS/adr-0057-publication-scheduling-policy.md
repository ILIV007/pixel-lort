# ADR-0057: Phase 8.1 — the publication scheduling policy layer (Tehran windows, priority classes, anti-robot rules)

- **Status:** Accepted (V4 local slice; the durable scheduler is a
  separate future slice)
- **Phase:** 8 (first open roadmap bullet: «Tehran-window scheduling,
  anti-robot rules, priority classes»)
- **Date:** 2026-11-11
- **Decided by:** the V4 autopilot under the owner's FULLER-steps order

## Context

Blueprint §16 defines the channel's scheduling policy: the Tehran
publishing windows (five ACTIVE windows + the 01:00–08:30 quiet window
named «for P2/P3»), the P0–P3 priority classes over the 0–100 editorial
score, and the anti-robot rules (gap bands, the unrelated-P0 anti-flood
bypass, the 90-minute same-game cooldown, the three-consecutive layout
cap, the 40%-of-rolling-six category cap, the rolling-seven-day content
mix). Phase 8's first open roadmap bullet asks for exactly this policy.
No publishing-side code exists yet: the `publications` /
`publication_messages` outbox of the GATE (ADR-0032) is still unbuilt,
and the applied schema is 6. Iran has had no DST since 2022 — the civil
offset is the fixed UTC+03:30 already used by the Phase 4 budget day.

## Decision

- **A PURE domain policy layer, not a durable engine.** Four modules in
  `src/domain/publishing/` — `tehran-windows.ts` (twp1),
  `priority-classes.ts` (pcp1), `anti-robot.ts` (arp1),
  `publication-schedule.ts` (psp1, the composition). Zero I/O, zero SQL,
  zero network, zero flags, zero DDL — the Phase 7.2 house pattern. The
  durable scheduler that CONSUMES this policy is the next Phase 8 slice
  and remains gated by the ADR-0032 reconciliation requirement.
- **The day is TOTALLY partitioned.** The `twp1` segment table covers
  [00:00, 24:00) Tehran with no hole and no overlap: five ACTIVE
  windows (morning_scan 09:30–11:30, midday 13:00–15:30, evening
  17:00–19:30, prime 20:00–23:00, late_night_radar 23:00–00:45), the
  QUIET window (01:00–08:30), and five NAMED gaps. Boundaries are
  [start, end). late_night_radar crosses midnight and is handled by
  TRUE SEGMENT OCCURRENCES (today 23:00 → tomorrow 00:45; the wrapped
  tail reports yesterday 23:00 → today 00:45) — never split at
  midnight, never a phantom interval (the RED round found and fixed
  exactly these two defects; see the review doc §2).
- **The priority classes carry exactly the blueprint facts.** `pcp1`
  pins the boundaries (90/75/40), P0's no-daily-cap and explicit quiet
  bypass, P1's 5–20-minute latency bound, P2's dynamic window, P3's
  filler-only role. Scores are integers in [0, 100]; everything else
  fails typed.
- **The documented policy pins (owned by this ADR):**
  1. _anti-flood_ — blueprint «small» is unquantified; `arp1` pins
     2–4 minutes for the UNRELATED-P0 bypass. A RELATED P0 does not
     bypass (the conservative reading of the blueprint's
     «unrelated P0 can bypass»).
  2. _quiet scope_ — the quiet gate binds P2/P3 ONLY (the blueprint
     label names them; P0's bypass is explicit; P1's latency contract
     is incompatible with a quiet deferral). P1 publishes through
     quiet hours within its 5–20-minute bound.
  3. _window gate_ — a P2/P3 due outside an ACTIVE window defers to
     the next active window START (never merely quiet's end, never
     into a window already in progress).
  4. _mix enforcement_ — the rolling-168-hour mix report over the
     CLOSED ten-category vocabulary is a HARD gate ONLY for P3 filler
     discretion; news classes carry it as an advisory («never forced
     per day» honored — the mix gate never blocks news).
  5. _non-time-resolvable caps_ — the layout run cap and the category
     share cap cannot be fixed by waiting (the trailing run and the
     rolling six change only when new posts publish): a block is a
     typed DEFER with `dueAtMs: null`, never a fabricated timestamp.
- **No randomness inside the domain.** The humanizing jitter is ALWAYS
  a caller-supplied deterministic input validated against the selected
  band; spacing floors are fixed constants; every decision is
  JSON-equal deterministic. No floating-point share exists anywhere —
  the category cap is exact integer math ((count+1) ≤ 2 of six) and
  the mix comparison is count×1000 vs total×target-per-mille.
- **The composition is the Phase 8.1 deliverable surface.**
  `planPublicationTime` (psp1) evaluates every rule, records every
  applied rule (send_gap / latency_bound / window_gate /
  same_game_cooldown / layout_run_cap / category_share_cap /
  mix_target), carries the four component policy versions, and yields
  schedule (with dueAtMs + the window classification) or defer (typed
  reason) or a typed input failure — a TOTAL function.

## Consequences

- The next Phase 8 slice (the durable `publications` outbox + the
  scheduler job + the ADR-0032 reconciliation design) consumes these
  modules directly; the policy cannot drift from the tests without the
  gates failing.
- The pins are POLICY, not measurements: changing any of them is a
  policy-version change (twp1/pcp1/arp1/psp1) with its own review.
- The category vocabulary is closed at the ten blueprint labels;
  widening is a versioned change, never a silent pass.
- No live capability is created: BLOCKED_LIVE unchanged (Posidon
  only), schema 6 untouched, all flags stay OFF, Free readiness stays
  NOT_READY.

## Verification highlights

- RED-first held: 101 tests written first, real RED recorded (4 files
  cannot-resolve-module, exit 1), then 101/101 GREEN with EIGHT
  in-round findings recorded in docs/reviews/PHASE_8_1_SCHEDULING_POLICY_DESIGN.md
  §2 — three REAL implementation defects (the wrap-piece start bug, the
  midnight-split ends bug, the composition's missing candidate
  identity) and five test-side defects; the per-minute exhaustive
  sweep (4320 minutes over three Tehran days) pins the total
  partitioning; every number in the policy is either a blueprint quote
  or a marked pin.
