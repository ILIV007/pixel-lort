# Round 1.10.6.1 — bounded AI deadline corrections + roadmap

# reconciliation. Corrections/errata ledger for this round.

- **Round:** 1.10.6.1 (bounded deadline corrections on the 1.10.6-R
  adapter foundation)
- **Date:** 2026-10-28
- **Commit lineage (three DIFFERENT anchors, reported separately):**
  - Direct parent of this round's HEAD: `259836fd988aa916aa3125fd6e7fd420f5656b2b`
  - Basis of the PREVIOUS delivered round (1.10.6-R; an ancestor of this
    round's HEAD, NOT the direct parent): `220c6c5b22a1e772832eef75544b82b492eabb5a`
  - Base branch: `phase/04-corrections-round191` @ `f70205648922d0f8e60619e45e5d54e6e87b8f1b`
  - Branch/PR: `review/r1.10.3-sql-design`; Draft PR #11

## E1 — Test-count accounting correction (fixes the "65 new tests" figure)

The 1.10.6-R delivery reported the product-suite delta correctly inside
VERSION.json (56) but the "65 new tests" figure circulated in the delivery
report was a RE-ADDITION: 56 new AI unit tests + the 9-test
`tests/integration/ai-budget.test.ts` subset. The D1 ai-budget subset is
NOT part of the product suite delta — it is reported INSIDE the separate
DB-subset line (310 = 301 prior + 9). Correct standing accounting:

- Product suite (`npm test`): 1.10.6-R delivered 1206 = 1150 prior + 56 new.
- DB subset (`npm run test:db`): reported separately; never re-added to
  the product delta again.
- This round (1.10.6.1): 1219 = 1206 prior + 13 new deadline-contract
  tests (8 service + 5 adapter). No DB-subset change.

## E2 — Credential-hygiene deviation (recorded, not repeated)

During the 1.10.6-R publication the owner-supplied PAT was held in a
temporary mode-600 FILE outside the repository. That MECHANISM deviated
from the standing memory-only directive for credential use. Recorded
honestly: the token was chat-transmitted and is therefore treated as
EXPOSED; the owner has been asked to REVOKE it. NO claim of complete
removal from chat history, platform logs, or infrastructure is made. This
round: no old credential was searched for, recovered, or reused from chat,
history, or files; stale device-flow state files left by earlier attempts
were deleted BY NAME only (never read); publication uses the official
device flow (one code, immediate handover, request info kept until natural
expiry) with the token used exclusively in-memory inside the single
publication step and never written to any file, config, URL, log, commit,
or archive.

## E3 — Findings and red-first evidence (measured on 7ab64cd, pre-fix)

Reference HEAD for this round: `7ab64cd810e26a81f8e5b9603b74a0bd10645ba6`
(tree `44851d1af7dfc2f2090306370c6121437fc6ecda`). The permanent tests were
written FIRST and run against that HEAD before any product fix:

- **Finding A — budget-authorization await unbounded**
  (`src/application/ai/draft-service.ts`): `authorizeAiRequestAttempt` was
  awaited with NO deadline bound and NO post-authorization clock guard, so
  a stalled store could hang the whole invocation and a late grant could
  still reach the provider port.
  - A1 (auth never settles) — RED: test timed out (service hung).
  - A2 (auth resolves authorized after deadline) — RED: timed out.
  - A3 (auth rejects after deadline) — RED: timed out.
  - A4 (grant in time, deadline crosses before the port) — RED: assertion
    failure (provider port WAS called).
  - A5 (async store rejection stays `budget_store_error`) — already green
    on HEAD; kept as a permanent regression guard.
- **Finding B — Gemini deadline ended at the headers**
  (`src/adapters/ai/gemini-adapter.ts`): the abort timer was cleared as
  soon as the Response arrived; the body read was unbounded, so
  fast-headers + stalled/slow body could outlive the total wall deadline.
  - B1 (200 headers fast, body never completes) — RED: timed out.
  - B2 (body arrives slowly across the deadline) — RED: surfaced as
    `transient` from the late data instead of the typed deadline outcome.
  - B3 (transport ignores AbortSignal and never settles) — RED: timed out.
  - B4 (body/transport rejecting after the deadline) — RED: assertion
    failure (late outcome instead of deadline).
  - B5 (deadline must really abort the in-flight signal) — RED: timed out.
- **Section 5 — usage recording unbounded**: `recordAiUsage` was awaited
  with no bound; a stalled write would hold an already-valid draft
  hostage.
  - U1 (stalled usage write) — RED: no deadline timer armed; draft held.
  - U3 (usage write finishing after its deadline) — RED: timed out.
  - U2 (rejecting usage write never fails the draft / never refunds) —
    already green on HEAD; kept as a permanent regression guard.

Measured: 11 failed / 35 passed across the two suites on unfixed HEAD
(failure modes above from the actual run, not from any prior report).

## E4 — The implemented deadline contract (what is now guaranteed)

- ONE small injectable primitive (`src/shared/time/deadline-wait.ts`)
  bounds a pending promise by an absolute wall deadline: `completed` or
  `timed_out`; handlers stay attached for the work promise's whole
  lifetime, so a late rejection after the race settled is observed and
  absorbed — never an unhandled rejection, never a resurrection.
- The service bounds EVERY await on its path by the SAME total wall
  deadline (`AI_BOUNDS.totalWallDeadlineMs`, injected clock): the
  authorization wait, the provider call (service-level backstop — the
  adapter's internal guard is never a substitute), and the post-success
  usage recording. Each race is armed from the wait's TRUE start, so a
  mid-call clock jump cannot retroactively decide an in-flight operation
  (the pinned 1.10.6 contract — record the real outcome, stop the ladder —
  is preserved).
- Post-authorization guard: a grant that arrives inside the deadline but
  whose processing crosses it starts NO provider work.
- Conservative honesty about non-cancellable work: D1 budget writes are
  NOT cancellable — a charge that lands during/after a timed-out wait
  stays recorded (NO refunds, no imaginary cancellation); Workers AI
  binding calls cannot be natively cancelled (unchanged, documented);
  Gemini aborts its request signal for real and additionally enforces the
  deadline by race, so a non-cooperating transport/stream cannot bypass
  it (abandoned in-flight work documented, never hidden).
- Usage recording stays best-effort and non-authoritative: failure or
  timeout NEVER revokes the durable authorization, never starts another
  provider/fallback, and never changes the outcome — the draft is already
  valid; recording is post-success bookkeeping.
- Clock contract made explicit: the injected clock owns `now()` for
  orchestration decisions; the injectable scheduler decides when the
  deadline callback fires (real setTimeout/clearTimeout in production);
  adapters measure against the system wall clock because REAL cancellation
  requires real timers (documented at the port and in both adapters).
- Gemini-specific contracts preserved: byte cap, strict UTF-8,
  `redirect: 'error'`, fixed official host, key only in the
  `x-goog-api-key` header, refusal/quota semantics unchanged, no URL,
  header, or key material in any outcome or log.
- Determinism: deadline tests fire an injected manual scheduler (no real
  waiting); adapter B-tests use a 40 ms deadline against 250 ms+ late
  events with kind-based assertions only (no multi-second tolerances).

## E5 — Scope guard (nothing else claimed)

Changed in this round: the deadline primitive, the draft-service bounded
waits + post-auth guard + service-level port backstop, the Gemini
adapter deadline coverage, the permanent tests pinning them, the ROADMAP
reconciliation (intro/Phase-1B split, Phase-4 gates note, Phase-5 note,
Phase-6 status + 1.10.6.1 item, preview-vs-production wording), this
ledger, and VERSION.json. Explicitly NOT done: no engine/feature work, no
migration, no schema change, no activation, no deploy, no live inference,
no Telegram send, no Cloudflare operation, no workflow/secret/account
change, no frozen-file edit, no force push. The Free-ingestion limitation
and full-poll gates remain OPEN and NOT_READY (untouched by this round).

## E6 — Fresh measured counts for the delivered tree

- Product suite (`npm test`): 96 files / 1219 tests, ALL PASSING
  (1206 prior + 13 new).
- DB subset (`npm run test:db`): unchanged from 1.10.6-R (310 tests; no
  new DB tests this round).
- Full-gate results for the delivered HEAD are recorded in the round
  delivery report (VERSION.json `evidence` block), not in this file.
