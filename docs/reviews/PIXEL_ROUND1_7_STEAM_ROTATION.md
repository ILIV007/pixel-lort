# Round 1.7 — R04: Steam bounded persistent cyclic rotation (product implementation)

Status: **R04 accepted after independent review by Posidon acting for Zeus**.
Not a release, migration authorization, deployment or activation approval.
See `ROUND1_7_INDEPENDENT_ACCEPTANCE.md` for measured review evidence and limits.
Round: 1.7. Baseline: `4b044f4940e0167af3e74e1f96764f971c501f77`
(branch `phase/04-corrections-round16`, the independently accepted Round 1.6 D01 source).
Scope honored: **R04 ONLY** — R09/R10 remain unresolved and visibly RED with their
original assertions unedited.

## 1. The R04 defect

The Steam connector fetched `apps.slice(0, appsPerBatch)` on every poll and returned
`cursor: null`. For any owner watchlist longer than `appsPerBatch`, the tail of the
watchlist was **permanently starved**: configured apps beyond the first batch were
never requested. `extended-review.test.ts` R04 asserted the tail is eventually
visited and stayed RED through Round 1.6.

## 2. Implemented behavior (bounded persistent cyclic rotation)

Each successful poll now visits an **ordered cyclic window** of the owner-provisioned
`apps` list:

- Window start = the **validated durable cursor** (`source_state.cursor`); a null
  cursor starts at index 0.
- Window size = exactly `min(appsPerBatch, apps.length)` configured entries per
  successful poll, wrapping at the end of the watchlist.
- On the existing successful complete-batch outcome, the proposed next cursor is
  `(start + selectedCount) mod currentLength`, persisted ONLY through the existing
  poll handler's atomic items/state commit (`commitPollResults`). A restarted
  connector/handler instance continues from the durable cursor — never an
  in-memory counter (proven on real workerd D1, §5).
- Empty successful responses still rotate: progress is defined by windows visited,
  not items seen. Existing normalization/malformed-item classification is unchanged.
- Duplicate configured entries are honored **as configured** — the owner list is
  never silently deduplicated or rewritten (tested: duplicates do not starve other
  configured IDs).
- `plannedRequestCount` and actual `requestCount` counting are unchanged and
  truthful: `min(watchlist, batch)` planned, one top-level SafeFetch invocation per configured entry. Observed counts
  also include redirect hops; the independent real-port redirect proof measures
  three raw requests for a two-entry window. R10 remains unresolved.
- On existing **failed / rate_limited** outcomes the connector preserves the
  input window's cursor (the normalized placement of THIS attempt), so the same
  selected window is retried. A non-null cursor is never reset to null by a Steam
  HTTP/transport/JSON/429 early return. Failed D1 batches cannot advance the
  durable cursor (atomic items+state batch, unchanged R02 semantics — proven on
  real workerd D1, §5). Failure classification, aggregate requestCount and
  Retry-After semantics are unchanged. No partial-result statuses or retention
  were introduced.

## 3. Cursor format and normalization policy

New small pure helper `src/connectors/steam-cursor.ts` (no network, no storage,
no clocks). The cursor is **bounded, versioned, opaque JSON** with exactly four
keys (strict schema; unknown keys rejected):

```json
{ "v": 1, "fp": "11ed3fef", "n": 3, "start": 2 }
```

- `v` — cursor contract version (1). Any other version resets.
- `fp` — 8-hex FNV-1a 32-bit fingerprint of the canonical JSON of the CURRENT
  validated ordered watchlist (order-sensitive, duplicates preserved).
- `n` — watchlist length at issue time (1..50).
- `start` — next window start index (0..49).

**Deterministic reset policy** (`normalizeSteamCursor` — total, never throws):

| Input condition                                                              | Outcome                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `null` / empty string                                                        | start 0 (fresh rotation — the normal initial state, not a "reset") |
| longer than `STEAM_CURSOR_MAX_CHARS` (512)                                   | reset to start 0 **without parsing**                               |
| invalid JSON / non-object / array / number                                   | reset to start 0                                                   |
| fails the strict schema (wrong `v`, unknown keys, wrong types, out-of-range) | reset to start 0                                                   |
| `n` ≠ current watchlist length (grow/shrink)                                 | reset to start 0                                                   |
| `fp` ≠ current fingerprint (reorder/any exact-list change)                   | reset to start 0                                                   |
| `start` out of range for the current list                                    | reset to start 0 (defense in depth)                                |

After any reset, rotation restarts deterministically from the head of the CURRENT
watchlist. Batch-size changes alone (same watchlist) keep the cursor valid — the
window size follows the CURRENT config.

**Safety invariant:** the cursor never carries an app ID, URL or host. Every
request derives from the CURRENT strictly validated watchlist and the PINNED
official endpoint. Even a forged or fingerprint-colliding cursor can at worst
select a different start index WITHIN the current watchlist — it can never
introduce a new app ID or endpoint (tested with an adversarial valid-shaped
cursor). FNV-1a 32-bit is sufficient here precisely because a collision is not a
security boundary; it only affects WHERE a window begins. There is no unbounded
cursor storage or parsing (serialized cursors are ~60 bytes; anything longer than
512 chars resets unparsed).

## 4. Fairness guarantee — stated honestly

With a **stable watchlist**, every configured position is covered within
`ceil(N/B)` **successful** polls (N = watchlist length, B = batch size) — the
windows traverse the list cyclically without gaps. Wraparound can revisit
positions within the coverage horizon (for example N3/B2 revisits position 0).

Disclosed limits (no silent skipping, no unconditional-progress claim):

- A **permanently failing selected window** delays rotation under the existing
  conservative retry policy: the failed window is retried with the same cursor
  until it succeeds, so later windows wait. This is intentional — it never
  silently skips data — but it means a dead window blocks rotation of the rest
  of the watchlist until it recovers.
- A watchlist change (grow/shrink/reorder) resets rotation to the head, which
  re-visits the first window before reaching the tail again.
- **R09's known concurrency/ownership gap is NOT fixed or hidden** by this
  sequential rotation: rotation assumes the existing single-owner poll window
  and offers no cross-worker fairness guarantee beyond it.

## 5. Production-path evidence

All in this round's permanent tests:

- `tests/unit/steam-rotation.test.ts` (18 tests, scripted SafeFetchExecutor fake —
  clearly labeled connector CONTRACT tests, not raw HTTP): the prompt's N3/B2
  windows (570,440 → 730,570), wraparound across several polls, N>B / N=B / N<B /
  B1, maximum supported lengths (50 apps × batch 25 in two full-coverage polls),
  empty watchlist (no network), empty successful responses (still rotate),
  duplicate entries (no starvation), the full invalid-cursor matrix (18 malformed
  / foreign / oversized cursors — every one deterministically resets to the head
  and never invents an app ID), watchlist grow/shrink/reorder resets, batch-size
  changes, fingerprint properties, plannedRequestCount truthfulness.
- `tests/integration/round17-r04-steam-rotation.test.ts` (9 tests, real local
  workerd D1):
  - **Persistence proof**: first successful poll through the REAL poll handler
    and the existing commit store persists the cursor; the same real handler/registry reload the DURABLE cursor and visit the tail
    ([730,570]) — full production path (scheduler → durable job → engine →
    handler → atomic commit). The harness does not reconstruct its handler
    between those polls. Separate manager evidence reconstructs fresh
    handler, registry, executor and HTTP fake around each invocation, including
    a rate-limit/restart cycle, using real D1 state only.
  - **Real batch failure**: a primary-key collision raises inside the atomic
    items+state batch (unrelated pre-existing row owning the generated id; the
    two targeted business-key conflict clauses do not absorb it) → whole batch
    aborts → durable cursor UNCHANGED, items rolled back → the REAL handler
    retries the SAME window successfully and only then advances the cursor.
  - **Failure-path matrix** (labeled SafeFetch fake): early transport failure,
    later HTTP 503, malformed JSON, unexpected content type, early and later
    429 — every path preserves the selected window's cursor (never null),
    truthful requestCount, parsed Retry-After; a subsequent successful retry
    revisits the same window and then rotates.
  - **TRUE transport-port test**: scripted RAW `typeof fetch` → REAL
    `createSafeFetch` → Steam connector across TWO cursor windows; asserts the
    pinned official host (`api.steampowered.com`) and endpoint path, bounded
    call count (4 raw calls for 2 windows × 2 apps), exact configured app IDs in
    cyclic order, official parameters, aggregate requestCount = 2 per window.

## 6. Explicitly NOT done (scope compliance)

- No R09 ownership/reservation implementation; no schema4 capability work; no
  applied migration (applied schema stays 3; proposed 0004 remains a lab-only
  disposable fixture); no R10 fix.
- No new table, column, dependency or version change. The rotation uses the
  existing `source_state.cursor` column only. The only package.json change is
  registering the new D1 suite in `test:db` (script only).
- No job-engine/policy/registry/owned-store/ingestion-budget/HTTP-boundary
  changes. No partial-result features, no observation history, no D02.
- No commits/pushes/merges/remote operations/deployment/activation/provisioning.

## 7. Test composition (measured, Round 1.7 candidate)

- Baseline (accepted Round 1.6 source, reproduced locally): full suite
  **1004 passed / 3 failed (1007)** — failures exactly R04/R09/R10;
  `test:db` **254/254**.
- With the R04 fix, the existing R04 assertion turns **GREEN UNCHANGED**.
- Added permanent tests: **18 unit + 9 integration = 27**.
- Full suite with the candidate: **1032 passed / 2 failed (1034)** — failures
  exactly R09/R10 (measured; exact exit codes in the delivery logs).
- `test:db` with the candidate: the prior 20-file subset (254/254) plus the new
  9-test file — **263/263** expected and measured exactly in the delivery logs
  (see `review/logs/`); the R04 assertion lives in `extended-review.test.ts`,
  which is part of the full suite, not the `test:db` subset.
