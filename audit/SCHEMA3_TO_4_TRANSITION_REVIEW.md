# PIXEL — Schema 3→4 Transition Review (real migration runner) — R1.10.2 corrected edition

Scope: review of the transition plan for the REAL migration runner, modeling
and rehearsal LOCALLY on disposable workerd D1 only. **No migration file was
changed; no real DB metadata was touched; no bundle default or enablement gate
was modified; no remote operation was performed.** Production readiness is NOT
claimed; uncertainties are reported explicitly. R110-03 corrections applied
(Time-Travel evidence boundary; `unresolved → stop/retry` model wording).
R1.10.2 consistency notes: every rehearsal/test states the EXPECTED and the
APPLIED schema separately; the downstream smoke ordering now follows the
cycle-free Stage 7 → 8a → 8b → 8c sequence (`audit/PREVIEW_READINESS_CHECKLIST.md`);
the R1.10.1 edition is preserved inside the sealed input
`input/R1.10.1_61a01947_ORIGINAL.zip`.

Authority documents reviewed:

- `docs/reviews/PIXEL_ROUND1_9_MIGRATION_0004_TRANSITION.md` (plan of record)
- `docs/reviews/PIXEL_ROUND1_9_R09_OWNERSHIP_IMPLEMENTATION.md` (+ 1.9.1 amendment)
- `docs/reviews/ROUND1_9_1_CORRECTIONS.md`
- Product code: `migrations/0004_source_poll_ownership.sql`,
  `src/adapters/db/schema-health.ts`, `src/adapters/db/source-ingest-store.ts`,
  `src/application/ingestion/{scheduler,poll-handler}.ts`,
  `src/adapters/db/job-store.ts`, `tests/helpers/migrations.ts`

---

## 1. Whole-migration semantics (VERIFIED locally on disposable workerd D1)

- `migrations/0004_source_poll_ownership.sql` is ONE immutable unit:
  1. `ALTER TABLE source_state ADD COLUMN poll_owner_job_id TEXT;`
  2. `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_outstanding_poll …`
     (partial: `type='sources.fetch_poll'`, `aggregate_type='source'`,
     `aggregate_id IS NOT NULL`, `status IN ('pending','queued','claimed','retry_wait')`)
  3. `schema_metadata` → `schema_version='4'`, `migration_id='0004_source_poll_ownership'`, `applied_at`.
- Application is WHOLE and atomic: the test helper applies each migration as a
  single `db.batch`; a mid-file failure leaves the DB untouched (design lab
  P-M1/P-M2; product-path R09-P14 re-proves whole-file semantics, metadata
  3→4, column+index presence, and no-op re-application). Rehearsal re-run this
  round: 56/56 (`logs/12-schema34-rehearsal.log`).
- Real runner note: `wrangler d1 migrations apply DB` executes the file as one
  unit **per Cloudflare's documented semantics — LIVE-UNVERIFIED on the real
  runner by this work** (no remote command was run). 0001–0003 are NEVER
  edited (append-only policy, AGENTS.md §6); roll-forward only — there is NO
  down-migration SQL.

## 2. Duplicate preflight MUST be empty (VERIFIED locally)

- Product implementation `scanOutstandingPollDuplicates(executor, limit)`
  (`src/adapters/db/source-ingest-store.ts`) is read-only, bounded, runs on
  schema 3 or 4: groups outstanding `sources.fetch_poll` jobs by
  `(aggregate_type, aggregate_id)` and returns rows with `n > 1`.
- Creating the partial unique index while outstanding duplicates exist FAILS
  inside D1 and leaves the database untouched — the preflight is therefore a
  hard gate, not a courtesy (measured locally: P-M1/P-M2; product-path
  R09-P15: empty on a healthy DB; a manual second outstanding job rejected;
  other sources isolated).
- Non-empty preflight recovery (owner decision, NEVER automatic):
  1. Drain-and-retry (preferred): wait for duplicates to reach terminal states
     (terminal rows never resurrect — P-N9).
  2. Owner-approved guarded `cancelled` on NON-authoritative duplicates only
     (newest wins; every cancellation individually logged with job id; no
     deletion; `dlq_delivered_at` untouched). Reference implementation
     `cancelSupersededPollJob` remains in the design lab
     (`tests/design/round15-ownership.ts`) and is deliberately NOT wired into
     the product.
- The REAL-DB preflight result is UNKNOWN until the owner runs it against the
  actual preview D1 (see §6).

## 3. Explicit expected-version readiness (VERIFIED locally)

- Health is exact-equality: `checkSchemaHealth(executor, expectedSchemaVersion)`
  never accepts an arbitrary applied version. A schema-4 DB with the bundle
  still configured `SCHEMA_VERSION="3"` is UNHEALTHY by design (R09-P16).
- Therefore the runbook order is: apply 0004 → verify metadata/column/index →
  set operator var `SCHEMA_VERSION="4"` → verify health. Never flip the var
  BEFORE the apply (a schema-3 DB with expectation 4 is also unhealthy).
- Ownership features feature-detect the APPLIED version at resolution time
  (3 → legacy path; 4 → owned path), so the same bundle runs correctly at
  either version.

## 4. Backup/bookmark and rollback consequences (LIVE-UNVERIFIED — R110-03 corrected)

**Evidence boundary (corrected this round):** the earlier "Time-Travel backup/
bookmark and rollback semantics: all verified" phrasing EXCEEDED the evidence.
Nothing in any round executed a real Cloudflare Time Travel bookmark, a real
point-in-time restore, or a real migration rollback drill. The verified items
are and remain ONLY the local, disposable-workerd facts in §1–§3 and §5.

- Backup anchor (PLANNED, owner capability, LIVE-UNVERIFIED): D1 Time Travel
  restore bookmark taken immediately before application. On the Free plan the
  Time Travel window is **7 days** (official docs,
  https://developers.cloudflare.com/d1/platform/limits/ — see
  `free-plan/FREE_PLAN_OFFICIAL_SOURCES.md`); the drill and any restore must
  occur within that window. Max restore rate: 10 restores / 10 min / DB.
- Rollback MODEL (documented, not executed): restore the DB to the pre-apply
  bookmark, keep/return to the previous bundle; the product then behaves as
  accepted legacy (the R09 second-window defect honestly returns — it is a
  schema-4 capability).
- **Restore consequences that MUST be planned before any real execution
  (documented here, verified nowhere):**
  1. A restore rewinds DATABASE state to the bookmark: any rows written AFTER
     the bookmark (items, jobs, telegram_updates bookkeeping, budgets) are
     rolled back as data, whatever their external consequences were.
  2. External side effects are NOT reverted: Telegram messages already sent
     stay sent; Queue messages already delivered/acked stay consumed; DLQ
     deliveries stay delivered. Cross-system reconciliation is a MANUAL
     operator procedure.
  3. Write quiescence/drain: before a real restore the operator must pause
     writes (gates OFF are lossless per ADR-0040), let in-flight queue
     deliveries drain or expire (Free retention 24 h), and decide the
     disposition of post-bookmark data. Doing this during live traffic is
     outside any plan reviewed here.
- Failed-midway application leaves `schema_metadata` at 3 with no column and
  no index (atomicity) → fix the cause (usually non-empty preflight) and
  re-apply. This local fact is verified; the real-runner equivalent is
  LIVE-UNVERIFIED.

## 5. Three-state runtime model (VERIFIED locally)

| State                       | Detection                                                 | Scheduling behavior                                                                          | Poll behavior                                                                                                                                     |
| --------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| known readable v3 legacy    | metadata row readable, version 3                          | legacy marker-CAS reservation                                                                | legacy hold-only fence (R09 defect honestly visible)                                                                                              |
| known readable v4 ownership | metadata readable, version 4                              | atomic S1/S2/S3 owned scheduling                                                             | A1 acquisition + ownership-fenced commit + partial-index exclusivity                                                                              |
| unresolved                  | metadata missing/corrupt/oversized/unsupported/read-throw | stops BEFORE probe/seed/due-scan (`cron.ingestion_capability_unresolved`); zero side effects | returns recoverable retry `ingestion_capability_unresolved` BEFORE preflight/budget/network/items/state; bounded retries → observable dead-letter |

**R110-03 wording correction:** the stale shorthand "unreadable → fail-safe
OFF" is superseded by the accepted model: **unresolved → STOP/RETRY** — the
pass stops BEFORE every effect and the poll returns a recoverable retry; the
retry path is bounded and ends in an observable dead-letter, never a silent
no-op and never an unfenced run. Local trace T-09
(`audit-tools/logs/trace-run.log`) re-demonstrates the full ladder this round:
3 deliveries → `retry_wait`(1) → `retry_wait`(2) → `dead_letter`(3), with the
durable `UPDATE jobs SET status='dead_letter' …` write observed.

Rehearsal evidence (existing suites, unmodified, disposable workerd D1):
`round19-r09-ownership` (R09-P1…P17), `round191-capability-failclosed` (16),
`round191-foreign-window-identity` (7), `migration-plan`,
`migration-plan-failures` — **56/56 passed** this round
(`logs/12-schema34-rehearsal.log`).

## 6. Uncertainties reported (honest boundaries)

1. **Real-DB preflight result is unknown** until the owner runs
   `scanOutstandingPollDuplicates` (or the read-only SQL) against the actual
   preview/production D1. A long-lived real DB could hold outstanding
   duplicates from past crash windows even though every local rehearsal DB was
   clean.
2. **Queue/DLQ drain state before migration is unknown** (real Queues have
   never been exercised by this tree). In-flight jobs at apply time are safe
   under the fence model, but the owner should confirm a quiet window.
3. **Time Travel bookmark/restore mechanics are owner-side and
   LIVE-UNVERIFIED**; GLM cannot verify the restore capability without remote
   operations (none performed). See §4 for the documented-but-unproven
   restore consequences and the Free 7-day window.
4. **`wrangler d1 migrations apply` version gating**: the local rehearsal used
   the test-only plan helper; behavioral equivalence of the real runner
   (single-unit application) is documented by Cloudflare semantics and the
   transition doc, not re-measured here.
5. **Free-plan capacity context** (analysis only, see `free-plan/`): a real
   apply + rehearsal-sized reads/writes are trivially small against D1 Free
   daily allowances on paper, but actual account entitlement and shared usage
   are UNKNOWN; conformance is UNPROVEN until measured.
6. Production readiness is NOT claimed. The migration remains a LOCAL product
   candidate applied ONLY to disposable workerd D1 databases.
