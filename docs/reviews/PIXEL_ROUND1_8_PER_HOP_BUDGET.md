# Round 1.8 — R10 per-hop ingestion budget authority (LOCAL product implementation)

Status: LOCAL review candidate on top of the independently reviewed Round 1.7
handoff (`f6337e54434126090be7f7a6fc1a7b28612941bd`, branch
`phase/04-corrections-round17`). NOT ACCEPTED in Round 1.8: Posidon's
independent review found four boundary failures (B1–B4), corrected locally in
Round 1.8.1 (see `PIXEL_ROUND1_8_1_BOUNDARY_CORRECTIONS.md`; the two factual
diagram/contract corrections flagged by the review are applied inline below).
Not a release, main merge, deployment, migration or activation. R09
(cross-worker source ownership) stays RED and is deliberately NOT implemented
here. Applied schema stays 3 (migrations 0001–0003); the proposed 0004
remains disposable lab material and is NOT executed.

## 1. The product failure being fixed (R10)

Round 1.7 and earlier charged the ingestion budget as `planned reservation
(before the sequence) + after-the-fact reconciliation of observed extras`.
That authority model cannot prevent a REDIRECT HOP or any LATER connector
request from exceeding the source/day cap: the cap was checked once, against
an ESTIMATE, before any network I/O. The accepted R10 characterization test
(`tests/integration/extended-review.test.ts`, "R10: redirects must not consume
requests beyond a one-request daily budget") proved the overage: with a
one-request daily budget, a 302→200 sequence issued TWO raw requests and
charged TWO units (planned 1 + reconciled extra 1) — the budget never
governed the second hop.

## 2. Exact ports / call chain (documented BEFORE editing, as required)

```
PRODUCTION INGESTION CALL CHAIN — Round 1.8 (R10 authority path)

Cloudflare Queue message
  → src/entrypoints/queue.ts                     (queue consumer entrypoint)
    → src/application/jobs/engine.ts             (JobsEngine.consumeMessage:
      policy gates (D01 pause PRE-claim, zero durable writes) → atomic claim
      → handler dispatch)
      → createSourcePollHandler().execute()      src/application/ingestion/poll-handler.ts
          ├─ load source + state (D1 via DbExecutor)
          ├─ payload/enablement/connector/preflight checks (no network)
          ├─ build the PER-EXECUTION source-bound ingestion transport:
          │    createIngestionSafeFetch({                 src/shared/http/safe-http.ts
          │      fetchFn: options.fetchFn,   // raw `typeof fetch` (production:
          │      │                           //  globalThis.fetch, engine-env.ts)
          │      authorizeUnit: () => authorizeIngestionUnit(   src/adapters/db/
          │        executor, { sourceId, nowMs: nowMs() })       ingestion-budget-store.ts
          │    })
          ├─ connector.fetch({ effects: { safeFetch: <that transport>, … } })
          │    src/connectors/{rss,steam-news,youtube-playlists,
          │                    reddit-oauth,github-releases}.ts
          │    EACH safeFetch call runs ONE guarded sequence (runSafeSequence):
          │      for hop = 0 … maxRedirects:
          │        1. guardFetchTarget — scheme/host/port/userinfo/allowlist/
          │           IP-literal checks (UNCHANGED security boundary; an
          │           invalid target is rejected BEFORE any unit is spent)
          │        2. POST body validation (bounded form, hop 0 only)
          │        3. shared-deadline check (expired → timeout, no unit)
          │        4. authorizeUnit() — ATOMIC guarded consume of EXACTLY ONE
          │           unit (R10, NEW):
          │             granted        → proceed to the raw fetch
          │             budget_denied → return { reason:'budget_denied' } —
          │                            ZERO raw requests, observed attempts
          │                            NOT incremented
          │             source_missing→ return { reason:'budget_source_missing' }
          │                            — ZERO raw requests
          │             (an authorizer THROW is infrastructure: it is NEVER
          │             converted into a provider-facing reason; it fails
          │             closed with no raw request and propagates to the
          │             handler's typed retry path)
          │        5. requestCount += 1; fetchFn(…) — the ONLY place a raw
          │           request is ever issued (thrown attempts consume the unit)
          │        6. 301/302/303/307/308 → validate Location, re-guard and
          │           RE-AUTHORIZE the next hop; 304 → terminal success;
          │           other 3xx → redirect_status_not_followable
          │    connector maps budget_denied / budget_source_missing to the
          │    typed output { budgetDenied: true, budgetDenialKind, … } and
          │    ABORTS the whole sequence (no further network)
          ├─ budgetDenied with kind 'source_missing'
          │    → job outcome { kind:'permanent', reasonCode:
          │      'ingestion_source_missing' } (same classification the old
          │      job-start path used; no terminal state write)
          ├─ budgetDenied with kind 'budget_exhausted'
          │    → commitTerminalState with the connector output: NO items,
          │      PRIOR cursor/validators preserved, failureReason
          │      'budget_exhausted' → existing INGESTION_BUDGET_RETRY_MS
          │      pacing branch (10 minutes), no ladder growth
          ├─ IngestionBudgetAuthorityError (D1 failure at authorization)
          │    → job outcome { kind:'retry', reasonCode:
          │      'job_handler_retryable_error' } — the distinct stable
          │      infrastructure path; NO terminal state write (durable cursor
          │      unchanged), already-charged units stay charged
          └─ otherwise → commitTerminalState (items + fenced state +
               requests_today readback) — unchanged
```

Non-ingestion/test transports keep the UNBOUNDED core factory
`createSafeFetch(fetchFn)` with an explicit doc header: it is deliberately
unlimited and MUST NOT be wired into the ingestion path. The production
wiring (`engine-env.ts`) no longer constructs `createSafeFetch` at all; it
hands the raw `fetchFn` to the poll handler, which unconditionally builds the
budgeted transport — there is no code path from the production ingestion
wiring to an unlimited transport.

## 3. Budget authority — the store contract

`authorizeIngestionUnit(executor, { sourceId, nowMs })` — the SINGLE
production charging owner (R10):

- Atomically consumes EXACTLY ONE unit via the proven two-statement D1 batch:
  1. guarded `UPDATE budgets … SET requests = requests + 1` with the cap
     predicate `requests + 1 <= (SELECT daily_request_budget FROM sources
WHERE id = ?)` checked INSIDE SQL against the CURRENT source budget;
  2. on a 0-change UPDATE, one guarded `INSERT…SELECT` (new Tehran-day row)
     with the same predicate and a `NOT EXISTS` guard — new-day
     initialization and the first charge are atomic and race-safe.
- The Asia/Tehran bucket is resolved from `nowMs` AT EACH AUTHORIZATION —
  never at job start — so a redirect straddling Tehran midnight charges each
  hop to its own day, and a budget change between hops is respected.
- Outcomes: `{ kind:'authorized', bucketDate }`,
  `{ kind:'denied', bucketDate }` (cap exhausted, quota 0 — a quota of 0
  denies ALL raw requests), `{ kind:'source_missing', bucketDate }`. (The
  authorization result carries kind + bucketDate ONLY — no usage counters;
  charged totals are read back separately via `readIngestionBudget`.)
- No pre-created chargeable credit, no clamping, no negative counts, no
  refunds (response errors/timeouts/cancellation never refund), no use of
  planned counts as consumption. Concurrent workers cannot exceed the cap
  (the cap predicate is re-evaluated by D1 per statement; proven by the
  existing race tests and new explicit races).
- Storage failures propagate as AppError — the handler converts them to the
  typed infrastructure retry path; they are NOT quota exhaustion.

`reserveIngestionBudget` and `reconcileIngestionBudget` are RETIRED from the
production ingestion path (the poll handler no longer calls them). They
remain ONLY as documented LEGACY helpers for the explicit legacy budget tests
(`tests/integration/ingestion-budget.test.ts`) — their docs now say exactly
that; no production code path reaches them.

`plannedRequestCount` stays on the connector contract as a bounded ESTIMATE
helper. No estimate grants authority; nothing consumes it in production.

## 4. Typed outcomes and deferral semantics

- `budget_denied` is a distinct transport reason and a distinct connector
  outcome (`budgetDenied: true`, `budgetDenialKind: 'budget_exhausted'`). It
  is NOT HTTP 429, NOT provider auth failure, NOT unknown-job poison, NOT
  database infrastructure failure, and it never feeds the failure ladder.
- A denied sequence defers the WHOLE window: the connector aborts on the
  first denial (no extra network afterwards), reports the cumulative
  OBSERVED raw attempts (`requestCount`) honestly, returns NO items, and
  proposes the PRIOR cursor AND PRIOR etag/last-modified validators
  (R10.1/B2 — never a null/partial replacement), plus the strongest
  provider Retry-After bound already observed in the SAME sequence
  (R10.1/B3 — RSS per-feed progress and GitHub per-repo etag progress are
  NOT written; Steam's rotation cursor stays on the same window — a denied
  window cannot rotate ahead; YouTube/Reddit keep their prior cursor). The
  handler pins the loaded source row's cursor/validators on the commit path
  and schedules the denied window at `max(INGESTION_BUDGET_RETRY_MS,
strongest observed provider bound)` — never earlier than either.
- After the budget becomes available (or the cap is raised) the SAME saved
  window is refetched and completes normally.
- Mid-sequence `source_missing` (the sources row vanished between the
  handler's existence check and a later hop) surfaces as
  `budgetDenialKind: 'source_missing'` → the handler returns the SAME
  permanent `ingestion_source_missing` job outcome the old job-start path
  used. No terminal state write.
- A D1 failure AT authorization fails CLOSED before any network and is
  classified as infrastructure: the typed `SafeFetchAuthorityError` (R10.1 —
  the transport wraps ANY authorizer throw, carrying the sequence's observed
  raw-attempt count and NO raw error payload) reaches the handler's typed
  catch, which returns a job `retry` outcome (`job_handler_retryable_error`)
  WITHOUT a terminal state write — the durable cursor is unchanged, durable
  charges stand, and the poll's safe OBSERVED attempt total (prior completed
  sequences + the failing one, aggregated exactly once) is exposed on the
  stable warning as a metric SEPARATE from charged units.

## 5. Disclosed under-utilization window (honest accounting)

Authorized units (durable, conservative) and observed raw attempts are
separate counters:

- If the process dies AFTER an authorization but BEFORE the raw fetch, that
  unit REMAINS charged. This is a narrow under-utilization window; the
  system never claims exactly-once provider usage.
- R10.1 (B1) adds a second, equally conservative window: an authorization
  still in flight when the sequence deadline expires may still COMMIT its
  D1 unit after the timeout answer — the charge stands, there is NO refund,
  and no cancellation/rollback of the storage transaction is claimed.
- A raw fetch that THROWS (network error) still consumes its unit.
- There is NO refund after response errors, timeouts, or cancellation.
- The R10 acceptance asserts this window directly: a direct store
  authorization with zero subsequent raw calls leaves the unit durably
  charged.

## 6. What is preserved (unchanged by this round)

- R04 Steam persistent cyclic rotation: window selection, cursor building,
  persistence semantics and all its accepted tests. A denied window returns
  the same retry cursor as any other failure — rotation cannot advance.
- D01 lossless policy pause: with the gate OFF the poll handler never runs —
  no authorization charge, no network, no claim/attempt burn.
- R05 strongest Retry-After lower bound and R06 honest requestCount
  aggregates: untouched.
- The safe-http security boundary: allowlist/scheme/IP/port/userinfo checks,
  manual redirect validation, credential-header stripping on origin change,
  exact 3xx handling, bounded bodies, shared deadline. Invalid targets are
  rejected before a unit is spent; the unit is spent only immediately before
  the raw fetch.
- All connectors' strict config contracts, header-only secrets, official
  endpoints, bounded body/timeout/redirect limits. No HTTP bypass anywhere.
- Jobs engine, pause/ownership scheduling, source registry, normalization,
  editorial/publication policy, partial-result provider-failure semantics,
  D02 observations, migration files, schema health, dependencies.

## 7. Fixture adaptations (setup ONLY — asserted explicitly)

Changing the poll-handler transport option from a pre-built
`SafeFetchExecutor` to the raw `fetchFn: typeof fetch` (mandatory budgeting
at the wiring point) required SETUP-ONLY adaptations:

- `tests/integration/extended-review.test.ts` (R10): the scripted raw fetch
  function is now passed directly (`fetchFn: <scripted raw>`) instead of
  first wrapping it with `createSafeFetch`. The raw script, the handler
  invocation and BOTH assertion lines are byte-identical.
- `tests/integration/source-poll-pipeline.test.ts`,
  `tests/integration/round16-d01-policy-pause.test.ts`,
  `tests/integration/round17-r04-steam-rotation.test.ts`: the harnesses now
  feed the handler the scripted RAW transport (`createRawFetchMock` — same
  queued-response shape, raw `typeof fetch`) instead of the SafeFetchExecutor
  fake. No assertion text, expected value, label, or test body changed; only
  the harness construction lines differ (token diff in the delivery report).
  The SafeFetchExecutor fake (`createFetchMock`) is untouched and remains the
  tool for connector CONTRACT coverage; handler-level suites are raw-port
  suites, and the new Round 1.8 suite labels the two families explicitly.
