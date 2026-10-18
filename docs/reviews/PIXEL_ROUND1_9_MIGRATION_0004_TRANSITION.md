# PIXEL — Migration candidate 0004 (source-poll ownership): transition, preflight, rollback

**Status:** Round 1.9 LOCAL CANDIDATE documentation. The migration candidate
`migrations/0004_source_poll_ownership.sql` is PROPOSED material: it has been
applied ONLY to disposable workerd D1 test databases through the explicit
test-only plan `ROUND19_MIGRATION_PLAN` (tests/helpers/migrations.ts). The
applied runtime remains **app1.4.0 / schema 3** (migrations 0001–0003, which
are NEVER edited — append-only policy, AGENTS.md §6). NOTHING in this
document authorizes or performs a real migration; execution on any real
database is an OWNER decision with its own approval, and no Cloudflare or
wrangler command has been run by GLM.

---

## §1. The migration file (one immutable unit)

- File: `migrations/0004_source_poll_ownership.sql` (schema 3 → 4).
- Content (DDL verbatim from the independently reviewed Round 1.5 design
  fixture `tests/fixtures/proposed-0004-source-poll-ownership.sql`; only the
  header comment differs):
  1. `ALTER TABLE source_state ADD COLUMN poll_owner_job_id TEXT;`
  2. `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_outstanding_poll ON
jobs(aggregate_id) WHERE type='sources.fetch_poll' AND
aggregate_type='source' AND aggregate_id IS NOT NULL AND status IN
('pending','queued','claimed','retry_wait');`
  3. `schema_metadata` updates: `schema_version` → `4`,
     `migration_id` → `0004_source_poll_ownership`, `applied_at` → now.
- Discipline (C.1/C.2): ONE file, ONE capability, applied ONCE, WHOLE, as a
  single atomic batch (the test helper applies each migration as one
  `db.batch`; a failure rolls back completely — proven by the design lab
  P-M1 and re-proven for the whole-file semantics by R09-P14). Roll-forward
  only.
- Provenance of proof: design-lab proofs P-M1…P-M5 (duplicate preflight,
  whole/atomic application, post-migration exclusivity, idempotent re-run)
  plus the Round 1.9 production-path proofs R09-P14/P15 on the product
  candidate file.

## §2. C.3 duplicate preflight (MUST be run, and MUST be empty, first)

Read-only, bounded, no DDL required, runs on the CURRENT applied schema (3
or 4). Product implementation shipped this round:
`scanOutstandingPollDuplicates(executor, limit)` (src/adapters/db/
source-ingest-store.ts).

```sql
SELECT aggregate_type, aggregate_id, COUNT(*) AS n
  FROM jobs
 WHERE type = 'sources.fetch_poll'
   AND status IN ('pending', 'queued', 'claimed', 'retry_wait')
 GROUP BY aggregate_type, aggregate_id
HAVING n > 1
 LIMIT :limit;
```

- The scan MUST return ZERO rows before the index can be created: creating
  the proposed index while outstanding duplicates exist FAILS inside D1 and
  leaves the database untouched (measured fact, design lab P-M1/P-M2).
- Measured product-path evidence: R09-P15 (the scan is empty on a healthy
  database; a manual second outstanding poll job is rejected; other sources
  are isolated).

## §3. Recovery plan for a non-empty preflight (owner decision — NEVER automatic)

The Round 1.5/1.5.1 accepted remediation register is carried over VERBATIM
as the plan of record; this round ships NO automated remediation and NO
silent cancellation or deduplication:

1. **Drain-and-retry (preferred, zero risk):** wait for the outstanding
   duplicate jobs to reach terminal states under the accepted engine
   mechanics, then re-run the preflight. Terminal rows never resurrect
   (P-N9) and the partial index ignores them.
2. **Owner-approved dedup (only if drain is not viable):** the guarded
   `cancelled` transition on the NON-authoritative duplicates only (newest
   wins by `created_at` then `id`; EVERY cancellation individually logged
   with its job id; no deletion; no other status rewrites; `dlq_delivered_at`
   untouched; a cancelled row never appears in the DLQ reconciliation scan —
   design lab P-M3). The reference implementation stays in the reviewed
   design lab (`tests/design/round15-ownership.ts` →
   `cancelSupersededPollJob`, reason `job_cancelled_superseded`); it is
   deliberately NOT wired into the product this round.
3. Re-run the preflight. Only an EMPTY scan authorizes the next step.

## §4. Application runbook (owner-executed; NOT executed in this round)

1. Owner approval for the real migration (this document is not that
   approval).
2. Take/verify a D1 Time Travel restore bookmark immediately before the
   application (rollback anchor, §5).
3. Run the C.3 preflight (§2) — must be EMPTY.
4. Apply 0004 ONCE, WHOLE (`wrangler d1 migrations apply DB` executes the
   file as a single unit; the file itself is atomic). Never as halves.
5. Verify: `schema_metadata.schema_version = '4'`,
   `migration_id = '0004_source_poll_ownership'`, `applied_at` set; the
   column and the index exist (R09-P14 asserts exactly this on the disposable
   database).
6. Complete the bundle transition: set the operator-configured expected
   schema version (SCHEMA_VERSION env/wrangler vars) to `4` so
   `checkSchemaHealth`'s exact-equality contract matches the applied state.
   A schema-4 database with the bundle still configured as 3 is UNHEALTHY by
   design (mismatch reported; never silently accepted — R09-P16). Ownership
   features themselves feature-detect the APPLIED version at resolution time
   (3 → OFF, 4 → ON, unreadable → fail-safe OFF).
7. No rollback-after-success is expected (roll-forward policy); §5 covers
   the abort/rollback case.

## §5. Rollback / abort plan

- Rollback = **previous bundle + D1 point-in-time restore** to the
  pre-migration Time Travel bookmark taken in §4 step 2. There is NO
  down-migration SQL: the append-only policy forbids editing 0001–0003, and
  0004 is designed roll-forward-only (C.2).
- If the application FAILS midway (D1 executes it as one atomic unit — a
  failure leaves schema_metadata at 3 with no column and no index; design
  lab P-M1), the database is unchanged: fix the cause (usually a non-empty
  preflight) and re-apply.
- After a successful application, the product code of THIS bundle runs
  correctly at EITHER version (feature-detected); a point-in-time restore
  back to schema 3 simply returns the product to the accepted legacy
  behavior (the R09 defect honestly returns — it is a schema-4 capability).
- D1 Time Travel is the owner's operational capability; this round performed
  NO restore, NO export, and NO remote operation of any kind.

## §6. Feature availability per applied version (summary)

| Applied schema                     | Scheduler reservation                            | Claim-time acquisition                | Owned commit fence                     | Outstanding exclusivity | checkSchemaHealth                                             |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------- | -------------------------------------- | ----------------------- | ------------------------------------------------------------- |
| 3 (today, real DBs)                | legacy marker CAS (accepted; R09 defect visible) | n/a                                   | legacy hold-only fence                 | ✖                       | exact-equality vs configured (ships 3)                        |
| 4 (candidate; disposable test DBs) | atomic S1/S2/S3, current-time hold + owner       | A1 (self-heal + generation recycling) | P-fenced items + state, atomic release | ✔ partial unique index  | exact-equality vs configured (operator sets 4 in the runbook) |

Both behaviors live in the SAME bundle and are feature-detected per applied
version; no mixed-fleet health is claimed, and no version other than the
configured expectation is ever reported healthy.
