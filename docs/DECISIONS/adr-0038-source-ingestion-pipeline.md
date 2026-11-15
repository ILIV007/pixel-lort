# ADR-0038: Source ingestion pipeline — registry, scheduling, poll ownership, deduplication, budgets

- **Status:** Accepted
- **Phase:** 4 (source registry and initial connectors, blueprint §26 step 4)
- **Date:** 2026-10-09
- **Decided by:** Alexios

## Context

Phase 4 adds the source-ingestion pipeline on top of the ACCEPTED Phase 3
job engine (ADR-0036/0037). The engine stays untouched as the only scheduler
and queue consumer; this ADR covers what Phase 4 adds: the source registry
(`docs/blueprint/v1/pixel_source_registry_v1.json`, 14 definitions,
byte-identical), the runtime validation/seeding of `sources` +
`source_state`, five connector families (RSS/Atom, Steam News, YouTube
playlists, Reddit OAuth, GitHub releases), normalized `source_items`
persistence, and the request budget. Connector request contracts and safe
HTTP are decided separately in ADR-0039.

Existing schema columns are reused: `sources` (registry descriptor +
`config_json`), `source_state` (etag/cursor/next_poll_at/health/budget),
`source_items` (two UNIQUE constraints: `(source_id, external_id)` and
`(source_id, canonical_url)`), `budgets (scope, budget_key, bucket_date)`.
Schema version stays **3** — no migration 0004 is required: every Phase 4
query is served by existing indexes
(`idx_sources_due_config(enabled, priority)`,
`idx_source_state_due(next_poll_at, circuit_open_until)`,
`idx_source_items_hash/time/status`).

## Decision

### 1. Activation gate and registration

One non-secret flag `SOURCE_INGESTION_ENABLED` ('true' | 'false', default
'false') gates the ingestion subsystem ONLY: due-source scheduling in cron
and registration of the `sources.fetch_poll` handler. The Phase 3 engine
(`JOBS_ENABLED`) is unchanged. Ingestion enabled while the jobs engine is
disabled (or the engine misconfigured) is a fail-closed readiness error
(`ingestion_requires_jobs`) — ingestion can never run half-wired. With the
gate off, cron/queue behavior is byte-identical to Phase 3 v1.3.1. Per-source
runtime enablement (`sources.enabled`) remains a separate, explicit owner
control; seeding NEVER touches `enabled` on existing rows.

### 2. Registry validation and seeding

The blueprint registry JSON is imported verbatim from
`docs/blueprint/v1/` (single source of truth, never copied or edited) and
validated at runtime with Zod: registry version, brand, global policies
(timezone, conditional GET, redirect cap 2, timeout 10 s, feed cap 2 MiB,
allowHttp=false), and all 14 source definitions with per-connector config
schemas (Steam `appsPerBatch/maxItemsPerApp`, YouTube `useSearchEndpoint
(false)/downloadVideo (false)`, Reddit subreddits + `stripDownloadLinks`,
GitHub repositories + prerelease policy, RSS single endpoint or bounded
template list). Validation is fail-safe: any invalid record disables the
whole ingestion pass (stable readiness reason `ingestion_config_invalid`),
never a partial catalog.

Catalog status classes are explicit and separate:

- **implemented** — connector code exists (rss, steam-news,
  youtube-playlists, reddit-oauth, github-releases; rss covers all seven
  registry RSS entries generically).
- **configured** — implemented AND its runtime preconditions hold
  (endpoint present; credential-free: PlayStation Blog, Xbox Wire; or
  watchlist + credentials present).
- **enabled** — configured AND `sources.enabled = 1` (owner control; the
  delivered tree ships all sources disabled).
- **blocked** — implemented but unconfigured (empty/missing watchlist,
  missing credentials) with a STABLE health reason (`watchlist_empty`,
  `credentials_missing`), or catalog-only connectors (bluesky-public,
  igdb) with reason `connector_not_implemented`. Blocked sources are never
  fabricated with invented app IDs, playlist IDs or repositories; Bluesky
  and IGDB remain recognized catalog entries without runnable handlers.

Seeding is an idempotent typed-DB operation
(`seedSourcesFromRegistry`): INSERT new rows fully (enabled = 0,
`source_state` next_poll_at = 0); on conflict, refresh ONLY the
registry-descriptor fields (name, connector, lane, trust_tier,
interval_seconds, daily_request_budget, approval_policy, attribution,
config_json) and NEVER `enabled` or `priority` (owner-managed), and never
touch existing `source_state` rows. A repeated import can therefore never
silently re-enable a disabled source or overwrite owner runtime settings.

### 3. Poll scheduling — atomic reservation with a deterministic window key

Cron (gate on) performs ONE bounded, indexed due-source scan per pass:

```sql
SELECT ... FROM source_state st JOIN sources s ON s.id = st.source_id
WHERE s.enabled = 1 AND st.next_poll_at <= :now
  AND (st.circuit_open_until IS NULL OR st.circuit_open_until <= :now)
ORDER BY st.next_poll_at ASC, s.id ASC LIMIT 10;
```

The seek uses `idx_source_state_due(next_poll_at, circuit_open_until)` and
the join uses the `sources` primary key; the LIMIT is a cap on an already
bounded candidate set, not the bounding mechanism. Per due source, in order:

1. **Pre-flight (no network):** connector implemented? config complete?
   A blocked source is skipped WITHOUT a job: one guarded state write sets
   `last_error` to the stable reason and `next_poll_at = now + interval`
   (no hot loop, visible health, zero budget spend).
2. **Durable job FIRST** with the deterministic window key
   `sources.poll:<sha256(sourceId ‖ scheduledForMs)>` where
   `scheduledForMs` is the `next_poll_at` value the scan read. Overlapping
   crons read the same state and derive the SAME key — the idempotent
   create (UNIQUE idempotency_key) admits exactly one durable job; a new
   legitimate later poll advances `next_poll_at` and therefore derives a
   FRESH key (never reuses a terminal job's key).
3. **Atomic reservation** — a guarded advance of the scanned due marker:

   ```sql
   UPDATE source_state SET next_poll_at = :scheduledForMs + :holdMs,
          updated_at = :now
   WHERE source_id = :id AND next_poll_at = :scheduledForMs;
   ```

   `holdMs = 120 000` (just above the 2-minute claim lease). Reservation
   and job creation are BOTH idempotent in either order: a crash between
   them leaves either (a) a durable job whose claim fencing absorbs
   re-dispatch, or (b) a hold that expires after 2 minutes and returns the
   source to the due scan — a skipped poll is never a permanently lost
   fetch job. A reservation that changes 0 rows means another actor won;
   the durable job (if created) still runs and its guarded terminal write
   fences it out (point 5).

### 4. Handler contract — one attempt, one authority

`sources.fetch_poll` payload: `{sourceId, scheduledForMs}` (strict Zod,
bounded). The handler executes ONE bounded poll attempt:

- source missing/disabled → terminal, no retry (source state owns pacing);
- connector unavailable → permanent `ingestion_connector_unavailable`;
- config pre-flight re-check (defense in depth) → skip with stable reason;
- budget reservation (point 6) → exhausted ends the attempt with
  `budget_exhausted` and a retry at a bounded delay, no network;
- ONE safe fetch sequence (≤ 1 + maxRedirects requests, ADR-0039);
- normalize → atomic guarded commit (point 5).

**Retry ownership is split by failure class, never doubled.** Provider-side
conditions (timeout, 5xx, 429, malformed source, auth failure) are owned by
the SOURCE schedule: the handler writes the backoff / Retry-After /
circuit into `source_state` and returns SUCCESS — job meaning is "one poll
attempt durably recorded", not "feed fetched". Only infrastructure
uncertainty (D1 failures inside the engine boundary) stays on the Phase 3
job-retry path (ADR-0036 backoff, max attempts, DLQ). Therefore a pending
job retry can never race an independent fresh cron poll into a provider:
while a poll job lives, the source's `next_poll_at` is at least
`scheduledForMs + 120 s`, and the scan cannot re-reserve an earlier window.

Backoff policy (mirror of blueprint §7 semantics at the source layer):
`next = now + min(30 min, interval × 2^consecutive_failures)` with ±10 %
full jitter from the injected random; a 429 `Retry-After` is a TRUE lower
bound (`next = now + max(retryAfterMs, backoff)` — never earlier because a
generic cap said so); 401/403 sets `circuit_open_until = now + 30 min` +
stable `credentials_rejected` and does not increment the failure ladder
(the circuit, not the ladder, owns the pause).

### 5. Atomic commit, fencing and deduplication

The terminal state write and ALL item inserts of one poll run as ONE atomic
D1 batch. The state write is fenced on the reserved hold value carried in
the payload (deterministic: `scheduledForMs + holdMs`):

```sql
UPDATE source_state SET etag=:e, last_modified=:lm, cursor=:c,
  next_poll_at=:next, last_polled_at=:now, last_success_at=..., ...
WHERE source_id=:id AND next_poll_at = :scheduledForMs + :holdMs;
```

A stale worker (its hold already superseded by a newer reservation, a
reclaim, or a newer poll) changes 0 rows — visible in batch meta — and its
state fields are NOT written; the engine never overwrites a newer poll's
etag/cursor/schedule. Item inserts are unconditional-idempotent and safe
for stale workers: duplicates are absorbed by the two UNIQUE constraints
(assets, not state).

Item identity and deduplication policy:

- `external_id` = the provider's stable identifier when present (RSS guid /
  Atom id, Steam gid, YouTube videoId, Reddit fullname, GitHub release id);
  when absent, a deterministic synthesized id
  `<connector>:c:<sha256-16(content)>` so NULL-identifier feeds still get
  `(source_id, external_id)` uniqueness.
- Persistence per item inside the batch: `INSERT OR IGNORE` — the ONLY
  form that can never abort the batch on either UNIQUE constraint and
  cannot partially commit (the batch is atomic; a CHECK/NOT NULL violation
  still fails the whole batch and the poll reports failure with the cursor
  NOT advanced).
- Honest classification AFTER the commit (bounded reads): our row's PK
  present → `inserted`; else an existing row with our `(source_id,
external_id)` → `duplicate_external`; else an existing row with our
  `(source_id, canonical_url)` → `duplicate_url` (canonical identity wins;
  first-seen row retained — a changed item under the same canonical URL is
  an UPDATE of the same article, and story adjudication later compares
  content hashes; it is never silently re-inserted as a second row). These
  counts are reported, never guessed.
- NULL semantics: SQLite UNIQUE treats NULLs as distinct — items without a
  canonical URL (or with http-only links, which are rejected to NULL by
  policy, ADR-0039) deduplicate through `external_id` only; that is
  documented and bounded.
- Cursor/pagination: a paginated cursor advances ONLY past pages whose
  retained items are durably committed in the same atomic batch as the
  cursor write; a malformed page (parse failure) leaves the cursor
  untouched; individually malformed ITEMS inside a retained page are
  dropped with `malformed_count` (explicit conservative policy) so a
  permanently malformed entry cannot stall a feed forever.

A 304 (not modified) writes ONLY scheduling/health metadata
(`last_polled_at`, `next_poll_at`, reset failure ladder, request counters):
no items, no cursor churn, no downstream jobs.

Crash/replay windows: durable items already committed + a lost terminal
job write (engine-level) → the job retries, the poll re-executes, INSERT
OR IGNORE + fenced state make replay a no-op (no duplicate rows, no
corruption of newer state); retries stay bounded by ADR-0036 max attempts.

### 6. Request budget — atomic reservation before network

The `budgets` table is the SINGLE authority:
`scope='ingestion'`, `budget_key=<sourceId>`, `bucket_date=<YYYY-MM-DD in
Asia/Tehran>` (fixed UTC+03:30 offset; Iran has no DST since 2022 —
documented helper, unit-tested at day boundaries; date rollover is implicit
via a new primary key, so there is no reset write and no double-reset
race).

Reservation happens BEFORE the first network call, atomically:

```sql
UPDATE budgets SET requests = requests + :n, updated_at = :now
WHERE scope='ingestion' AND budget_key=:id AND bucket_date=:day
  AND requests + :n <= (SELECT daily_request_budget FROM sources WHERE id=:id);
-- if 0 rows: single INSERT ...SELECT guarded by the same cap
```

`n` = the connector's PLANNED request count (1 for RSS/Steam/GitHub;
YouTube 1–2; Reddit 2: token + feed). Redirect hops and any extra observed
requests are reserved by a second guarded increment after the fact (best
effort; a mid-flight exhaustion is recorded with a stable code and the
planned cap still holds for the NEXT poll). No connector-internal retries
exist, so observed extra requests are bounded by the redirect cap (≤ 2).

Budget exhaustion never touches the failure ladder: `budget_exhausted`
with a bounded retry delay (10 min), no network, no items.

## Consequences

- No migration 0004: all six mandated concerns are met with existing
  tables/indexes plus guarded writes. Query plans are verified in tests
  (`EXPLAIN QUERY PLAN` on the due scan).
- The reservation hold (120 s) creates a bounded overlap window after a
  mid-poll crash (at most one reclaim re-execution plus one fresh window
  job); double fetches are absorbed by dedup and fencing — documented,
  tested, and cheaper than any lease-renewal design.
- Handler "success after provider failure" is intentional and documented
  (point 4); the failure ladder and circuit carry the observable health.
- Job-level retries remain exclusively for infrastructure uncertainty
  (ADR-0036 semantics unchanged and retested).

## Amendment (Round 1.6 — ADR-0040, corrective note; original §1 wording preserved)

§1 above states "With the gate off, cron/queue behavior is byte-identical to
Phase 3 v1.3.1". That wording is superseded on exactly ONE point by the
accepted Round 1.5.1 pause design, implemented in Round 1.6 (ADR-0040): with
the gate off, a delivered `sources.fetch_poll` message is now acknowledged
`paused_by_policy` BEFORE the atomic claim (durable row, attempts, lease and
error/exhaustion information preserved exactly), and the paused type is
excluded from the dispatch and recovery scans IN SQL — instead of burning a
claim and dead-lettering the durable job as `job_type_unregistered` (the
shipped D01 defect). Scheduling stays skipped and the poll handler stays
unregistered while the gate is off; every other Phase 3 mechanic is
unchanged. See ADR-0040 for the full decision and its scope guards.
