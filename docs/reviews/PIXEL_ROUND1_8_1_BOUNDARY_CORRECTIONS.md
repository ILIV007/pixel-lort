# Round 1.8.1 — LOCAL boundary corrections for B1–B4 (findings response)

Status: LOCAL corrective review candidate. Parent = the UNACCEPTED Round 1.8
candidate (ZIP sha256 `c41972d16c571c468af0e3953b5d28471ab707492baf4e637649ae
0287bae9e2`, 283 source files, byte-identical `source/` in the review package).
Last ACCEPTED source remains `f6337e54434126090be7f7a6fc1a7b28612941bd`
(`phase/04-corrections-round17`). Round 1.8.1 is corrective work for B1–B4
ONLY: no R09 work, no schema bump / migration 0004, no commits, pushes,
merges, remote or Cloudflare operations, no deployment/activation, no new
dependencies, no version bump, no delivery-page work, no fabricated
acceptance labels.

## 0. Evidence reproduction (BEFORE any edit, pristine candidate)

- Counterexample file copied byte-identical (sha256
  `b91696c4fc2c0fdd77f259dba284bb26fb08cf6e35182489a917f34f0313b998`) into a
  fresh scratch copy of the 283-file candidate: 7 FAILED / 1 CONTROL PASSED,
  exit 1 (log: `review/logs/reproduction-counterexamples-baseline.log`).
- Full suite (per-file chunked aggregation — this sandbox reaps long single
  runs; every test executed exactly once): 1071 passed / 1 failed of 1072,
  failing file exactly `tests/integration/extended-review.test.ts` (R09),
  exit 1 (`review/logs/reproduction-full-suite-baseline.log`).
- `npm run test:db`: 301/301 in 22 files, exit 0
  (`review/logs/reproduction-test-db-baseline.log`).

## 1. B1 — authorization cannot escape the absolute deadline (CE1/CE2)

`src/shared/http/safe-http.ts` (`runSafeSequence` + new `raceAuthorization`):

- The authorization WAIT is now raced against the SAME absolute sequence
  deadline that bounds the raw fetch (a real `setTimeout` budget computed
  from `deadline - Date.now()` at hop start). CE1 (grant that advances the
  fake clock past the deadline) and CE2 (never-settling authorizer) both
  end in `timeout` with ZERO raw requests and the observed attempt count
  unchanged.
- The remaining time is RECOMPUTED from the real clock AFTER the grant; a
  raw attempt never starts on the stale pre-authorization budget. A
  slow-but-timely grant leaves only its real remainder for headers/body
  (abort timer gets the recomputed value).
- A late grant NEVER resumes the network: after the deadline branch wins,
  the sequence has already returned; the settlement handlers only clear the
  race timer. Late rejections are absorbed the same way (handlers always
  attached — no unhandled rejection is possible).
- The in-flight authority (e.g. a D1 unit consume) may still COMMIT after
  the timeout answer. That conservative charge window is disclosed in code
  and docs; there is NO refund and NO claimed cancellation/rollback.
- The ONE timer introduced by the race is cleared on EVERY exit
  (settled / deadline / threw) via the single `finish` path.
- Deadline expiry at authorization returns the same `timeout` reason shape
  as any other deadline expiry — it is NOT provider quota exhaustion and
  NOT a 304.

## 2. B2 — quota denial preserves prior validators (CE3)

- `budgetDeniedOutput` (contract.ts) no longer hardcodes null validators:
  it now carries `etag` / `lastModified` (the PRIOR persisted values) and
  `retryAfterSeconds` explicitly.
- All five connectors pass their prior state validators on every denial
  exit (first, later, redirect-hop denials — the single helper covers all
  paths). RSS/GitHub additionally pass their strongest in-sequence
  Retry-After bound (see B3).
- The REAL commit path is coherent: `commitTerminalState` now PINS the
  loaded source row's `cursor`, `etag`, `last_modified` whenever
  `budgetDenied === true` — an authority denial can never null or partially
  advance persisted state, independent of connector-provided values.
- NOT disguised as 304: the output keeps `status: 'failed'`,
  `failureReason: 'budget_exhausted'`, no items, no cursor advance.
  Ordinary provider outcomes are untouched.

## 3. B3 — observed provider bounds survive a later denial (CE4/CE5/CE4b)

- RSS and GitHub collect the strongest Retry-After lower bound across
  rate-limited responses exactly as before (R05 machinery untouched); the
  denial output now CARRIES that bound instead of discarding it. Zero
  remains a valid bound (`0` is preserved as a number; only `null` means
  unknown).
- Handler scheduling for denied windows: a NEW first branch computes
  `next_poll_at = nowMs + max(INGESTION_BUDGET_RETRY_MS,
retryAfterSeconds × 1000)` — the schedule satisfies the budget-defer
  minimum AND every observed provider lower bound, never shortening
  either. CE4b's real-handler case (RSS `itch_discovery`, 7200 s bound
  then denial) now schedules at ≥ NOW+7 200 000 ms instead of the 600 000
  ms budget defer alone. The failure ladder stays inapplicable to denials;
  ordinary (non-denied) outcomes keep the EXACT prior branch order.
- No new partial-result policy and no further network after a denial.

## 4. B4 — observed attempts survive an authority throw (CE6)

- safe-http wraps ANY authorizer throw into the new typed
  `SafeFetchAuthorityError` carrying `requestCount` = raw attempts already
  issued by the failing sequence (CE6: hop0 302 → hop1 throw ⇒
  `requestCount: 1`). The error carries NO raw payload: no original
  message/cause, no URL, no headers, no body. Infrastructure
  classification is preserved end to end (never a `SafeFetchResult`,
  never quota/provider reclassification).
- New contract helper `fetchWithObservedAttempts(priorObserved, sequence)`:
  every connector's top-level sequences are wrapped; on a throw the
  re-surfaced error aggregates prior completed sequences' counts + the
  failing sequence's own count, EACH EXACTLY ONCE (RSS feeds, GitHub
  repos, Steam batch apps, YouTube playlists+details, Reddit token+
  listings).
- The handler's typed catch exposes the poll attempted total on the stable
  warning: `logger.warn('ingestion.poll.budget_authority_unavailable',
{ errorCode: 'job_handler_retryable_error', observedRequests: <number> })`
  — a SAFE OBSERVED metric, SEPARATE from durable charged units and never
  derived from them (`readIngestionBudget` is documented as a charged-unit
  readback, not an observed-request metric). The outcome stays
  `{ kind: 'retry', reasonCode: 'job_handler_retryable_error' }` with NO
  terminal state write, no cursor/items progress.

## 5. Documentation / scope corrections (non-blocking findings)

- `reconcileIngestionBudget` (legacy, retained): its doc now states the
  truth — the retained UPDATE is NOT cap-guarded (increments unconditionally
  when a row exists). Legacy BEHAVIOR unchanged, comment corrected.
- `readIngestionBudget` is documented as a charged-unit readback, NOT an
  exact observed-request metric; the two concepts are kept distinct
  everywhere (code, docs, handler warning).
- Call-chain diagram (`PIXEL_ROUND1_8_PER_HOP_BUDGET.md`): policy pause
  (D01) now precedes the atomic claim, matching the engine's real order.
- The grant outcome documentation now matches the real API
  (`{ kind, bucketDate }` — no usage counters).
- Round 1.8 status is corrected in the Round 1.8 design doc header: NOT
  ACCEPTED; corrected by 1.8.1. No fabricated acceptance/approval labels
  anywhere; coverage claims updated to the actual registered tests
  (§7 below).

## 6. Delivery-page scope deviation (disclosed, no further changes)

The prior session edited the sandbox delivery app (OUTSIDE `source/`, not
part of PIXEL). Exact paths, recovered from that workspace's git history:

- `<sandbox>/src/app/page.tsx` — rewritten into a static download page for
  the Round 1.8 ZIP (was the stock Z.ai scaffold placeholder).
- `<sandbox>/eslint.config.mjs` — one line changed: `ignores` extended with
  `round18/**`, `pixel/**`, `upload/**`, `download/**`, `public/*.zip`
  (scratch dirs were leaking into the app lint).
- `<sandbox>/public/pixel-phase04-v1.4.0-round1.8-review-candidate.zip` and
  `<sandbox>/download/pixel-phase04-v1.4.0-round1.8-review-candidate.zip` —
  added copies of the Round 1.8 artifact for user download (the user had
  explicitly asked to be sent the file).

Exact diffs are included at `review/delivery-page-disclosure.md`. These
files were NOT touched again in Round 1.8.1 and are NOT part of PIXEL
`source/`; unrelated user edits in that workspace were not reverted.

## 7. Test registration and coverage (actual, no double counting)

- The 8 evidence tests are registered PERMANENTLY, byte-identical
  (sha256 `b91696c4…13b998`), as
  `tests/integration/posidon-round18-counterexamples.test.ts`. All 8 are
  GREEN on the corrected source; no skip/weakening/assertion rewrite.
  Full-suite composition becomes 1072 + 8 = 1080 tests (85 + 1 files).
- NEW permanent suite `tests/integration/round181-boundary-corrections.test.ts`
  covers the ADDITIONAL required cases: real slow-authorizer waits (not
  only instant fake-clock jumps), first/later-hop authorization timeouts,
  no-raw-attempt + charge-disclosure semantics, header/body deadline after
  a slow-but-timely grant, late-grant non-resumption, non-null validator
  preservation through the REAL handler for first/later/redirect denials,
  multi-bound Retry-After carry-through (7200 s, multiple 429s,
  HTTP-date, invalid, missing, zero) for both families, real handler/D1
  scheduling with the quota raised before the next poll, and B4
  first/later TOP-LEVEL + redirect-hop throws with prior completed calls
  and a charged-but-not-attempted gap.
- Measured totals are reported ACTUALLY in the delivery logs; test:db
  (301/301) remains a SUBSET of the suite and is never added to the total.

## 8. Scope boundary honored

Only R10 boundary/propagation/observation changes + regression tests + docs
were made. R09 stays RED and untouched; the R10 original acceptance values
are unchanged and GREEN; D01/R04/R05/R06 suites and all accepted design
proofs remain green; schema stays 3; no migration executed; no dependency
or version change; no delivery-page or external-workspace edits.
