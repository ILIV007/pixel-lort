# PIXEL — Round 1.5: ownership + pause design, finalized with executable proofs

**Status:** DESIGN ROUND DELIVERABLE — proposed material only. Nothing in this
document is implemented in the product, nothing is labeled approved, and no
migration is authorized for execution. App 1.4.0 / applied schema 3 /
migrations 0001–0003 (unchanged). The four supplied known failures
(R04/R09/R10/D01) remain RED and untouched.

**Baseline:** the accepted Round 1.4 handoff
(`pixel-phase04-v1.4.0-round1.4-reviewed-github-handoff.zip`, source commit
`5a6b1b817d02c7d5bbeb5d4fcba7bc4356d4fa03`, branch `phase/04-corrections-round14`).
All work this round is ADDITIVE: 3 design modules under `source/tests/design/`,
4 proof suites under `source/tests/integration/round15-design-*.test.ts`, 1
proposed DDL fixture under `source/tests/fixtures/`. Zero bytes of `src/`,
`migrations/`, or any accepted test changed.

**What closed this round (design + proofs):** R09 and D01 semantics, and the
open A.3/A.4 issues from the Round 1.2 letter. What did NOT close: the R09/D01
test failures themselves (they are product-implementation items for a later
authorized round); R04/R10 are NOT addressed here at all.

---

## §0. Why this design (the two standing defects, root-caused)

### R09 — the hold is anchored in 1970

`scheduler.ts` reserves the poll window with
`next_poll_at = scheduledForMs + SOURCE_POLL_HOLD_MS`, where `scheduledForMs`
is the SCANNED DUE MARKER. A newly seeded source has `next_poll_at = 0`, so the
"hold" lands at 120 000 ms — January 1 1970 — which is never `> now`. The hold
is therefore not a hold at all: overlapping crons re-scan the source
immediately, derive a NEW window key, and double-poll. The Round 1.5 letter
requires a **current-time hold anchored in durable winner-owned data**, without
reintroducing same-key/different-payload conflicts (§2 below).

### D01 — gate-off permanently poisons a pending poll

With `SOURCE_INGESTION_ENABLED=false`, `resolveJobsEngine` builds the engine
WITHOUT the `sources.fetch_poll` handler. A delivered poll message then runs
the accepted consumer path: claim (burning an attempt — `attempts+1`) →
`handler === undefined` → `dead_letter` with `job_type_unregistered`. A
TEMPORARY policy state permanently destroys a perfectly valid job. The letter
requires explicit disabled-by-policy handling BEFORE claim, distinct from
unknown types and misconfiguration, with cancellation never silently meaning
dead-letter (§5 below).

### A.3/A.4 (Round 1.2 letter) — creation↔reservation gaps

A.3: the then-proposed create+reserve batch reserved BEFORE discovering
whether the INSERT created a new job, and the INSERT was not conditioned on
reservation success — a post-batch read cannot retroactively make writes
conditional. A.4: `createJob` resolves ANY same-key row — including terminal
ones — as `existing`, so a terminal job's window could be silently re-driven.
Both are closed here by putting ALL conditioning INSIDE the SQL predicates of
one atomic batch (§2), not in post-batch logic.

---

## §1. The ownership model (proposed migration 0004 — schema 3 → 4)

Proposed DDL (verbatim, canonical executable copy:
`source/tests/fixtures/proposed-0004-source-poll-ownership.sql`):

```sql
ALTER TABLE source_state ADD COLUMN poll_owner_job_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_outstanding_poll
  ON jobs(aggregate_id)
 WHERE type = 'sources.fetch_poll'
   AND aggregate_type = 'source'
   AND aggregate_id IS NOT NULL
   AND status IN ('pending', 'queued', 'claimed', 'retry_wait');

UPDATE schema_metadata SET value = '4',  ... WHERE key = 'schema_version';
UPDATE schema_metadata SET value = '0004_source_poll_ownership', ... WHERE key = 'migration_id';
UPDATE schema_metadata SET value = strftime('%Y-%m-%dT%H:%M:%fZ','now'), ... WHERE key = 'applied_at';
```

Model:

- **`source_state.poll_owner_job_id`** — DURABLE WINNER-OWNED DATA. The ONE
  job that owns the poll window is named in the same row that carries the
  hold. `NULL` = unowned. Every owner-dependent mutation fences on this
  column (§2, §4). This is the "anchor" of instruction 2: the hold is
  current-time AND it is anchored to a durable row that names its winner.
- **`idx_jobs_source_outstanding_poll`** — at most ONE non-terminal poll job
  per source aggregate. This is a REQUIRED component of the ownership design
  (A.5): without it, a crash-after-commit re-drive can create a second
  outstanding window while the first job lingers non-terminal — the exact
  R09-family race. With it, the second window waits (bounded stall, proven
  P-R7) until the outstanding job resolves. The predicate deliberately
  excludes `failed` (RESERVED status — never written by the engine,
  non-executable, ownership-irrelevant) and terminal rows.
- **Why schema 3 cannot host the design:** schema 3 has no column able to
  carry a per-source job-owner binding. The candidate columns (`cursor`,
  `etag`, `last_modified`, `last_error`) are provider data or stable-reason
  strings; overloading them would corrupt accepted semantics. The hold value
  alone (schema-3 `next_poll_at`) is NOT sufficient: two now-based holds are
  indistinguishable, so a stale worker could commit over a newer window.
  This is exactly the "hold must be anchored in durable winner-owned data"
  requirement.
- **Migration discipline (C.1/C.2 carry-over, honored):** this is ONE
  immutable file serving ONE capability (ownership); it is never executed as
  halves. It is NOT added to the product `MIGRATIONS` list, NOT registered in
  the product test helper, and NOT applied anywhere outside the disposable
  lab. `checkSchemaHealth` is untouched; the readiness contract implication
  is in the capability matrix (§7).

---

## §2. Exact atomic SQL — instruction 1 and 2

All statements below are implemented verbatim in
`source/tests/design/round15-ownership.ts` and proven on real workerd D1
(proofs P-O1…P-O15, P-R1…P-R7). Clock units: epoch milliseconds, injected.

### §2.1 The scheduler batch — creation and reservation in ONE transaction

One contender = one `executor.batch` of three statements (D1 batches are
implicit transactions: all decisions land together or nothing lands):

```sql
-- S1: idempotent durable job insert (fresh UUID pk ⇒ only the
-- idempotency_key can conflict; a lost insert is a NO-OP, never an error).
INSERT INTO jobs
  (id, type, aggregate_type, aggregate_id, status, priority, run_after,
   attempts, max_attempts, lease_until, idempotency_key, payload_json,
   last_error, created_at, updated_at, dlq_delivered_at)
VALUES (?, 'sources.fetch_poll', 'source', ?, 'pending', ?, ?, 0, ?, NULL,
        ?, ?, NULL, ?, ?, NULL)
ON CONFLICT (idempotency_key) DO NOTHING;

-- S2: ownership-bound CURRENT-TIME reservation.
UPDATE source_state
   SET next_poll_at = :nowMs + 120000,   -- CURRENT-TIME hold (instruction 2)
       poll_owner_job_id = :myJobId,     -- the ACTUAL winner
       updated_at = :nowMs
 WHERE source_id = :sourceId
   AND next_poll_at = :scannedMarker     -- (a) the CAS — a losing CAS writes 0 rows
   AND EXISTS (                          -- (b) identity — the ACTUAL winner only
         SELECT 1 FROM jobs j
          WHERE j.id = :myJobId                    -- MY OWN freshly inserted row
            AND j.idempotency_key = :key
            AND j.type = 'sources.fetch_poll'
            AND j.aggregate_type = 'source'
            AND j.aggregate_id = :sourceId
            AND j.payload_json = :canonicalPayload
            AND j.status IN ('pending','queued','retry_wait','claimed')
       );

-- S3: A.4 terminal-window remediation (mutually exclusive with S2 by
-- construction: S2 requires MY fresh non-terminal row, S3 requires a
-- TERMINAL matching row).
UPDATE source_state
   SET next_poll_at = :nowMs + interval*1000,
       last_error = 'poll_window_terminal', last_error_at = :nowMs, updated_at = :nowMs
 WHERE source_id = :sourceId
   AND next_poll_at = :scannedMarker
   AND poll_owner_job_id IS NULL
   AND EXISTS (
         SELECT 1 FROM jobs j
          WHERE j.idempotency_key = :key
            AND j.type = 'sources.fetch_poll'
            AND j.aggregate_type = 'source'
            AND j.aggregate_id = :sourceId
            AND j.payload_json = :canonicalPayload
            AND j.status IN ('succeeded','dead_letter','cancelled','failed')
       );
```

**Why this closes A.3:** all conditioning is INSIDE the statements. S2 can
only move the marker for the contender whose OWN freshly inserted row exists
with the exact window identity — an idempotency-conflict loser, a foreign
payload, and a terminal existing job all fail the EXISTS and change 0 rows.
No post-batch read decides anything (reads only CLASSIFY outcomes for the
honest summary). Insert and reservation become visible in the same
transaction, so the dispatch-before-reservation window no longer exists.

**Why this closes A.4:** a terminal same-key row cannot pass S2's status
predicate — ownership is never (re-)acquired for it. Instead S3 treats the
window as consumed-without-execution: the stale marker advances DIRECTLY to a
fresh schedule (`now + interval`), counter
`poll_window_skipped_terminal`, no hold, no new job. `cancelled` is terminal:
an owner-cancelled window is never re-driven automatically. Non-terminal
existing jobs: S2 and S3 both change 0 rows — the outstanding job owns the
window and is left alone.

**The four refusal classes of instruction 1 — where each is enforced:**

| Class                     | Enforced by                                                                  | Proof                             |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------- |
| losing CAS (marker moved) | S2/S3 `next_poll_at = :scannedMarker`                                        | P-O3                              |
| idempotency conflict      | S1 absorbs (DO NOTHING); S2's `j.id = :myJobId` fails — the loser has no row | P-O2, P-O4                        |
| foreign payload           | S2/S3 `j.payload_json` + `j.type` + `j.aggregate_id` equality                | P-O4                              |
| terminal existing job     | S2 status predicate excludes; S3 remediates without ownership                | P-O5 (all four terminal statuses) |

**Key/payload contract (instruction 2, no same-key/different-payload
conflicts):** the key is `sources.poll:<sha256(sourceId ‖ scheduledForMs)>`
and the payload is `canonicalizeJson({sourceId, scheduledForMs})` — BOTH
derive only from `(sourceId, marker)`. The hold value NEVER enters the
payload or the key, so overlapping schedulers on the same window derive the
SAME key AND the SAME payload: the second create is an absorbed duplicate
(`existing`), never a conflict. The hold lives exclusively in durable
`source_state` data written by the winner (S2) or re-written at claim time
(A1 below).

**Batch-abort classification:** if S1 raises (the one designed cause: a
different-key outstanding poll job for this source trips the partial unique
index), the whole batch aborts INSIDE D1 — nothing landed — and the outcome
classifies as `outstanding_elsewhere` (proof P-O6, P-R7). Any other
constraint violation fails loud.

### §2.2 Claim-time acquisition (A1) — self-heal and generation recycling

Runs AFTER the engine's atomic claim, BEFORE any network activity:

```sql
UPDATE source_state
   SET next_poll_at = :nowMs + 120000,   -- CURRENT-TIME hold, again
       poll_owner_job_id = :jobId, updated_at = :nowMs
 WHERE source_id = :sourceId
   AND ( (poll_owner_job_id IS NULL AND next_poll_at = :scheduledForMs)  -- (i) fresh window
      OR (poll_owner_job_id = :jobId) )                                 -- (ii) my own window
   AND EXISTS ( SELECT 1 FROM jobs j
                 WHERE j.id = :jobId
                   AND j.type = 'sources.fetch_poll'
                   AND j.aggregate_type = 'source'
                   AND j.aggregate_id = :sourceId
                   AND j.status = 'claimed'
                   AND j.attempts = :generation );
```

- Branch (i) self-heals a scheduler that crashed between the batch and the
  queue send (proof P-O7, P-R2).
- Branch (ii) lets a NEWER generation of the SAME job re-acquire after lease
  recycling — the durable owner column names this job (proof P-O8, P-R5).
- The EXISTS binds job identity, claimed status, and the EXACT generation: a
  stale generation, a foreign job, or a superseded window can never acquire
  (proof P-O9). A cancelled job (status no longer `claimed`) cannot acquire —
  cancellation is honored mid-flight, pre-network.

### §2.3 The ownership-fenced commit — instruction 3, every mutation bound

Items AND terminal state are ONE atomic batch. EVERY statement carries the
same ownership predicate P — including the item inserts, in the
`INSERT..SELECT … WHERE P ON CONFLICT … DO NOTHING` shape the Round 1.2
letter flagged as "not yet exercised on real workerd D1". **The lab has now
exercised and proven exactly that shape** (P-O10/P-O11: P false ⇒ 0 rows, no
error; P true + duplicate ⇒ absorbed by the targeted clause; P true + fresh +
violation ⇒ the whole batch aborts — this third case is inherited from the
accepted R02 evidence and re-confirmed by the batch semantics).

```sql
-- Every item insert carries P (A.1 clause shape):
INSERT INTO source_items (…12 columns…)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new'
 WHERE EXISTS (SELECT 1 FROM source_state st
                WHERE st.source_id = :sourceId
                  AND st.next_poll_at = :observedHold
                  AND st.poll_owner_job_id = :jobId)
   AND EXISTS (SELECT 1 FROM jobs j
                WHERE j.id = :jobId
                  AND j.type = 'sources.fetch_poll'
                  AND j.aggregate_type = 'source'
                  AND j.aggregate_id = :sourceId
                  AND j.status = 'claimed'
                  AND j.attempts = :generation)
   ON CONFLICT (source_id, external_id) DO NOTHING
   ON CONFLICT (source_id, canonical_url) DO NOTHING;

-- The terminal state write (LAST statement of the batch) carries the same P
-- and, on success, RELEASES ownership atomically:
UPDATE source_state
   SET cursor=…, etag=…, last_modified=…, next_poll_at = :freshSchedule,
       last_polled_at=…, last_changed_at=COALESCE(…), last_success_at=COALESCE(…),
       last_error_at=…, last_error=…, consecutive_failures=…,
       circuit_open_until=…, requests_today=…, budget_date=…,
       poll_owner_job_id = NULL, updated_at = :nowMs
 WHERE source_id = :sourceId
   AND next_poll_at = :observedHold
   AND poll_owner_job_id = :jobId
   AND EXISTS (SELECT 1 FROM jobs j
                WHERE j.id = :jobId AND j.type='sources.fetch_poll'
                  AND j.aggregate_type='source' AND j.aggregate_id=:sourceId
                  AND j.status='claimed' AND j.attempts=:generation);
```

Binding table (instruction 3 — every mutation, every dimension):

| Mutation                             | job ID                                                               | type/aggregate/source    | generation/status                      | ownership                    |
| ------------------------------------ | -------------------------------------------------------------------- | ------------------------ | -------------------------------------- | ---------------------------- |
| scheduler reservation (S2)           | ✔ own row                                                            | ✔ type+aggregate+payload | ✔ non-terminal status                  | ✔ writes owner               |
| terminal-window skip (S3)            | ✔ matching row                                                       | ✔ type+aggregate+payload | ✔ terminal status                      | ✔ owner IS NULL              |
| claim-time acquisition (A1)          | ✔                                                                    | ✔ type+aggregate         | ✔ claimed + exact generation           | ✔ reads/writes owner         |
| budget reservation                   | – (per-source daily aggregate)                                       | ✔ sourceId               | ✔ ordered AFTER ownership verification | ✔ owner verified pre-network |
| item inserts                         | ✔ via P                                                              | ✔ via P                  | ✔ via P                                | ✔ via P                      |
| terminal state write                 | ✔ via P                                                              | ✔ via P                  | ✔ via P                                | ✔ via P                      |
| job completion / retry / dead-letter | accepted engine fences (`status='claimed' AND attempts=:generation`) | unchanged                | unchanged                              | unchanged                    |

The pre-network handler sequence binds everything BEFORE any network call:
payload → source row → A1 acquisition → ownership re-read → preflight →
budget reserve → fetch. A non-owner never reaches preflight, the budget, or
the network (proof P-R6: zero fetches, zero budget rows).

---

## §3. Lease/hold-expiry semantics (instruction 3, stated explicitly)

There are TWO distinct leases. Confusing them is the R09 family's root.

1. **The scheduling hold** (`source_state.next_poll_at`, current-time + 120 s,
   written by S2/A1 together with the owner column) prevents OTHER schedulers
   from creating a second window while unexpired — the due scan can only pick
   the source when the marker is past.
   **Expiry alone revokes NOTHING**: ownership lives in
   `poll_owner_job_id`; an expired hold with the owner intact and no
   competitor leaves the owner fully authorized (its commit wins — proof
   P-O13). Only a COMPETING RESERVATION — possible only after expiry —
   revokes, and it does so by atomically OVERWRITING owner + hold (after
   which every old-owner mutation fails its fence: proofs P-O14, P-O11).
2. **The execution lease** (`jobs.lease_until`, 2 min, accepted Phase 3
   mechanics, unchanged) bounds a claimed execution. Expiry → reclaim →
   `queued` (attempts NOT incremented — they count execution generations,
   not recoveries) → re-dispatch → a NEW generation. Stale generations can
   never mutate the job row (accepted `attempts = generation` fences) and —
   new in this design — can never re-poll or re-commit the window unless the
   durable owner column still names their job (branch ii, §2.2).

---

## §4. Recovery register (instruction 4 — proven, with honesty about limits)

| Window / fault                                                      | Design behavior                                                                                                                                                                                                                                                                                                | Proof               |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| queue outage (producer throws / binding missing)                    | rows stay `pending`/`retry_wait` (never marked queued, fail closed); ownership + hold untouched; the next successful pass delivers                                                                                                                                                                             | P-R1                |
| crash after scheduling batch, before queue send (W1′)               | job + owner + hold consistent in one transaction; due/stranded scans recover; the poll executes under the recorded owner                                                                                                                                                                                       | P-R2                |
| concurrent schedulers on one window                                 | exactly ONE owner, ONE job; the loser receives an honest classification (`outstanding_job_owns_window`); interleave order does not matter                                                                                                                                                                      | P-R3, P-O2          |
| crash after state commit, before job completion                     | commit already advanced marker + released owner; the recovered generation's acquisition REFUSES (marker ≠ payload marker, owner NULL) → skips BEFORE the network → completes honestly. NO second fetch, NO second commit                                                                                       | P-R4                |
| crash between fetch and commit                                      | nothing persisted; lease expiry → reclaim → new generation re-acquires branch (ii) → **the fetch happens AGAIN** → one commit. **At-least-once fetching is DISCLOSED, never claimed to be zero** — the design guarantees at-most-one-COMMITTED-outcome per ownership epoch, NOT exactly-once external fetching | P-R5                |
| stale worker (superseded window / foreign owner / stale generation) | commits NOTHING — items carry predicate P, so a losing fence rolls back with the batch                                                                                                                                                                                                                         | P-O11, P-O12, P-O14 |
| second window while one is outstanding                              | BLOCKED by the partial unique index (batch aborts inside D1, nothing lands); bounded stall until the outstanding job resolves; then normal flow                                                                                                                                                                | P-O6, P-R7          |

**Honest limits of the proofs (what they do NOT prove):** workerd tests are
single-isolate; TRUE multi-isolate concurrency is not schedulable in this
lab. What is proven instead: the CAS/EXISTS predicates decide ownership
inside single atomic D1 transactions, whose serialization is D1's own
contract (additionally evidenced by the accepted R08/round13 batch-rollback
proofs). Multi-isolate behavior follows from the same per-transaction
predicates, but is not directly observed here.

---

## §5. Pause — explicit disabled-by-policy design (instruction 5)

Implemented and proven in `source/tests/design/round15-pause.ts`,
`source/tests/design/round15-lab-pipeline.ts`, proofs P-P1…P-P13. **The pause
design is DDL-INDEPENDENT — it requires NO schema change and the proofs run
on the CURRENT schema 3.**

1. **Explicit enablement registry** (code-defined, reviewed):
   `JOB_ENABLEMENT_POLICY: { 'sources.fetch_poll' → gate: 'ingestion_gate' }`.
   A type is disabled-by-policy ONLY if listed there AND its gate is off.
   `PAYLOAD_SCHEMAS` membership alone confers nothing (§B.1 of the Round 1.2
   letter, honored).
2. **Dispatch-side pause (fairness):** while a gate is off, the due scan and
   the stranded-`queued` scan EXCLUDE the paused types IN SQL
   (`AND type NOT IN (…)`; same ordering/bounds as the accepted scans).
   Paused rows consume ZERO scan slots — a page full of paused rows can never
   starve other types (proof P-P6: 30 paused + 5 other due rows, batch 25 ⇒
   all 5 others dispatched in the first pass; `policyPaused = 30` counted,
   zero writes to the paused rows).
3. **Consumer-side pause (pre-claim):** a delivered message for a paused type
   is acknowledged `paused_by_policy` BEFORE the atomic claim — no attempt
   burn, no poison, no DLQ, no status write (proof P-P1, D01 semantics: the
   row stays `pending` with `attempts = 0`; proof P-P3: three OFF cycles are
   bit-identical — the pause performs NO durable write at all).
4. **Attempt economics / exhaustion:** pauses happen pre-claim, so
   `attempts` never moves while off; a row at `attempts = max−1` can NEVER be
   dead-lettered by pauses and executes its final attempt normally when the
   gate returns (proof P-P4).
5. **Expired claims during OFF (REWRITTEN in Round 1.5.1 — see §10/B2):**
   the policy-aware recovery pass RESOLVES THE PAUSE POLICY BEFORE selecting
   or mutating any expired-claim candidate: paused-type expired claims are
   neither requeued nor dead-lettered while the gate is off (dormant — the
   row and its exhausted-state information stay exactly as they are), and
   they never consume active recovery scan slots (proofs P-N1, P-N2, P-N5,
   P-N7, P-N10; the ORIGINAL P-P5 assertion — reclaim-during-OFF — is
   superseded by the independent review's counterexamples CE2/CE3 and
   documented, not silently weakened).
6. **Bounded resumption:** gate ON ⇒ the very next dispatch pass sends the
   paused rows (≤ 1 cron interval; proofs P-P2, P-P7).
7. **The three classes stay DISTINCT (P-P8, P-P9, P-P10):**
   - unknown type (no schema, no handler) → poison `dead_letter` /
     `job_type_unregistered` — shipped behavior UNCHANGED;
   - schema-known + missing handler + NOT paused → misconfiguration, a
     wiring bug — pre-claim poison `dead_letter` /
     **`handler_misconfigured`** (proposed new `JOB_ERROR_CODES` entry,
     visible, alerting; never a silent pause);
   - policy-mapped + gate off → pause, ALWAYS taking precedence over the
     misconfiguration probe (a paused type with a missing handler is
     expected gate-off operation).
8. **Cancellation is NOT dead-lettering (P-P11):** the guarded `cancelled`
   transition (C.3 remediation primitive) is terminal; consumers ack
   `cancelled`; the DLQ reconciliation scan selects ONLY
   `status='dead_letter'` and never sees a cancelled row;
   `dlq_delivered_at` is untouched. A cancelled window is never re-driven
   (terminal in S3). Proposed code for the remediation reason:
   `job_cancelled_superseded`.
9. **No product code changed:** the shipped D01 failure remains RED. The
   design's product wiring (later authorized round) is three small
   insertion points: `engine.ts` consume (§5.3 decision pre-claim) +
   dispatch (§5.2 filtered scans + counters), `scheduler.ts` (§2.1 batch),
   `poll-handler.ts` (§2.2 acquisition + §2.3 commit), plus an optional
   `typePolicy` port on `JobsEnginePorts` wired from `ingestionEnabled` in
   `engine-env.ts`. Proposed `JOB_ERROR_CODES` additions:
   `handler_misconfigured`, `job_cancelled_superseded`.

---

## §6. Duplicate preflight / remediation plan (instruction 6 / C.3)

Proven on real workerd D1 at schema 3 (proofs P-M1…P-M5):

1. **Preflight (read-only, bounded, no DDL needed):**
   `SELECT aggregate_type, aggregate_id, COUNT(*) AS n FROM jobs WHERE
type='sources.fetch_poll' AND status IN ('pending','queued','claimed',
'retry_wait') GROUP BY aggregate_type, aggregate_id HAVING n > 1 LIMIT
:limit;` — detects duplicates BEFORE any migration step (P-M2).
2. **The C.3 fact, measured:** creating the proposed index while duplicates
   exist FAILS inside D1, and the failed CREATE leaves the database
   untouched (schema_metadata still 3, no column, no index — P-M1). Scan and
   migration remain SEPARATE steps.
3. **Remediation is an explicit owner decision** — never automatic, never
   destructive: (a) drain-and-retry (wait for outstanding jobs to reach
   terminal states; re-run the scan), or (b) owner-approved dedup — the
   guarded `cancelled` transition on the NON-authoritative duplicates only
   (newest wins by `created_at` then `id`; every cancellation individually
   logged with its job id; no deletion; no other status rewrites). Proven:
   after cancelling the older duplicate the scan is empty, the survivor is
   untouched, the cancelled row never appears in the DLQ scan, and the
   proposed migration then applies WHOLE and ATOMICALLY (P-M3).
4. **Post-migration exclusivity:** the index rejects a second outstanding
   poll job per source and ignores terminal rows and other sources (P-M4);
   the lab plan is idempotent over a migrated database (P-M5).

---

## §7. Schema capability matrix (C.1-consistent)

The readiness contract stays EXACT-EQUALITY per deployed bundle (C.1
correction — never retracted): an application bundle declares the schema
version(s) it accepts; additive DDL does not keep a mixed fleet healthy.
`checkSchemaHealth` is UNTOUCHED this round; the contract below is the
PROPOSED target state for the authorized implementation round.

| Capability                                            | Schema 3 (applied today)                                                             | Schema 4 (PROPOSED 0004)                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Durable jobs lifecycle, claim fencing, attempt budget | ✔ accepted                                                                           | ✔ unchanged                                                                                                                                                                                                                                |
| Per-window idempotency keys (deterministic)           | ✔ accepted                                                                           | ✔ unchanged                                                                                                                                                                                                                                |
| Current-time hold (next_poll_at = now + 120 s)        | writeable, but UNANCHORED — no durable owner ⇒ stale-worker-unsafe as the sole fence | ✔ anchored with `poll_owner_job_id`                                                                                                                                                                                                        |
| Durable per-source poll ownership                     | ✖ (no column; overloading provider columns rejected)                                 | ✔                                                                                                                                                                                                                                          |
| Single-outstanding-poll exclusivity                   | ✖ (duplicate outstanding windows possible — the R09 family)                          | ✔ (partial unique index; C.3 preflight required)                                                                                                                                                                                           |
| Ownership-fenced commit (items + state, one batch)    | ✖ (hold-only fence)                                                                  | ✔                                                                                                                                                                                                                                          |
| Atomic create+reserve with in-SQL winner binding      | ✖ (A.3 gap)                                                                          | ✔                                                                                                                                                                                                                                          |
| Policy pause (gate off)                               | ✔ design-supported (DDL-independent; proven P-P1…P-P13)                              | ✔ same                                                                                                                                                                                                                                     |
| `checkSchemaHealth`                                   | exact equality, expects 3                                                            | proposed: accepted-versions contract per bundle — `{3}` for current bundles, `{4}` for ownership bundles, `{3,4}` only during the C.1 transition window (feature-detect via schema_metadata at resolution; ownership features OFF under 3) |
| Rollback                                              | n/a                                                                                  | roll-forward only; rollback = previous bundle + D1 point-in-time restore to the pre-migration Time Travel bookmark (mandatory runbook step BEFORE applying 0004; execution UNAUTHORIZED)                                                   |
| Observation history / revision tables                 | out of scope                                                                         | out of scope (C.4/C.5 stay with their own separately reviewed batch; NOT mixed into this round)                                                                                                                                            |

---

## §8. Proof register — exactly what each proof does and does not prove

All proofs run on REAL workerd D1 via `@cloudflare/vitest-pool-workers`;
network responses are simulated stubs (no live providers). Files:
`tests/integration/round15-design-ownership.test.ts` (18),
`…-pause.test.ts` (13), `…-recovery.test.ts` (7),
`…-migration-preflight.test.ts` (5). **43 new proofs, all GREEN.**

| Proof             | Does prove                                                                                                                                | Does NOT prove                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| P-O1              | current-time hold > now, bound to the winner's job id (R09 semantics)                                                                     | product scheduler behavior (unchanged)         |
| P-O2/P-R3         | overlapping schedulers: exactly one owner/job; honest loser classification                                                                | multi-isolate timing (single-isolate lab)      |
| P-O3              | losing CAS never acquires/overwrites                                                                                                      | —                                              |
| P-O4              | foreign payload / same-key foreign writer never acquires; window left alone                                                               | operator remediation UX                        |
| P-O5 (×4)         | terminal existing jobs (succeeded/dead_letter/cancelled/failed) consume the window without ownership; A.4 remediation advances the marker | —                                              |
| P-O6/P-R7         | partial index blocks a second outstanding window inside D1 (batch abort, nothing lands); bounded stall then normal flow                   | stall duration under real cron cadence         |
| P-O7/P-R2         | claim-time self-heal of a scheduler crash before reservation/send (A.3/W1′)                                                               | —                                              |
| P-O8              | generation recycling re-acquires the job's OWN window                                                                                     | —                                              |
| P-O9              | acquisition refuses foreign owner / stale generation / superseded window; the index blocks even manual duplicate creation                 | —                                              |
| P-O10             | owned commit lands items + fresh schedule + releases ownership atomically                                                                 | connector pacing exactness (stub)              |
| P-O11/P-O12/P-O14 | stale worker / wrong generation / wrong status / overwritten owner commit NOTHING (items carry P; whole-batch rollback)                   | —                                              |
| P-O13             | hold expiry alone never revokes ownership                                                                                                 | —                                              |
| P-O15             | the durable anchor is readable exactly as the handler reads it                                                                            | —                                              |
| P-P1              | D01 semantics: gate-off delivery acks `paused_by_policy` pre-claim; row pending, attempts 0, never poisoned                               | shipped D01 test (still RED by design)         |
| P-P2/P-P7         | gate-on resumption on the very next pass; bounded dispatch across passes                                                                  | real cron interval timing                      |
| P-P3              | OFF cycles are bit-identical (no durable write)                                                                                           | —                                              |
| P-P4              | near-exhausted rows are never dead-lettered by pauses                                                                                     | —                                              |
| P-P5              | expired claims during OFF reclaim harmlessly and resume                                                                                   | —                                              |
| P-P6              | dispatch fairness: 30 paused rows cannot starve other types (SQL exclusion, zero slots)                                                   | —                                              |
| P-P8/P-P9/P-P10   | the three failure classes stay distinct; policy precedence before the misconfiguration probe                                              | —                                              |
| P-P11             | cancellation is terminal, DLQ-invisible, honoured by consumers; guarded transition refuses terminal rows                                  | admin-facing cancel API (not designed here)    |
| P-P12             | a paused poll reaches neither network nor budget                                                                                          | —                                              |
| P-P13             | dispatch counters are honest observability                                                                                                | —                                              |
| P-R1              | queue-outage recovery (fail closed, next pass delivers)                                                                                   | real Queues semantics (simulated producer)     |
| P-R4              | crash-after-commit/before-completion: NO second fetch, honest completion                                                                  | exactly-once fetching in general               |
| P-R5              | crash-between-fetch-and-commit: the re-drive fetches AGAIN (at-least-once, disclosed) and commits once                                    | exactly-once fetching (explicitly NOT claimed) |
| P-R6              | a non-owner never reaches preflight/budget/network                                                                                        | —                                              |
| P-M1              | the C.3 fact: index creation fails with outstanding duplicates; failure is atomic                                                         | —                                              |
| P-M2              | the preflight scan detects duplicates at schema 3                                                                                         | —                                              |
| P-M3              | guarded-cancel remediation clears the scan; the migration then applies whole/atomically; metadata 3→4                                     | authorization to execute anywhere else         |
| P-M4/P-M5         | post-migration exclusivity; lab-plan idempotence                                                                                          | —                                              |

---

## §9. Out of scope (untouched, by instruction)

R04 (Steam batching), R10 (pre-network budget authority), publishing
features, observation tables / revision history (C.4/C.5), readiness-contract
code changes, rotation, delivery-page work. No commits, no pushes, no merge,
no migration execution, no deployment, no activation, no resource changes.
The product `MIGRATIONS` list, `checkSchemaHealth`, and every accepted test
are byte-identical to the Round 1.4 handoff baseline.

---

## §10. ROUND 1.5.1 — design/lab corrections (B1 + B2, counterexamples CE1/CE2/CE3)

**Status:** corrections to THIS design document and the executable lab ONLY.
Round 1.5 was NOT approved for product implementation or migration; nothing
here is implemented in the product, nothing is labeled approved, and no
migration is authorized for execution. All 260 accepted product files remain
byte-identical to commit `5a6b1b817d02c7d5bbeb5d4fcba7bc4356d4fa03`. The four
supplied known failures (R04/R09/R10/D01) remain RED and unedited — this
round does NOT claim they are fixed.

**Input:** the independent review package
`pixel-phase04-v1.4.0-round1.5-posidon-review.zip`
(SHA-256 `3020ada9b03ef2739ea54b825d6cce79d79b260be695e6b5ba09d3cfa9953f35`),
reviewing input artifact `26bab6957ce47bfdcd37dec765dc8b32349f080312cf976032002207dbb08bbd`
(the Round 1.5 candidate). The supplied counterexample file was reproduced
UNCHANGED first on the unchanged Round 1.5 lab: **3 failed desired-contract
assertions / 1 passing control, exit 1** (LOG_00), matching the review
exactly.

### §10.1 B1 — authoritative source binding (CE1 corrected)

**The gap (review finding B1):** the ownership predicate checked
`input.sourceId` and the job's aggregate source, but the inserted item's
`source_id` came from the independent `item.sourceId` — a legitimate claimed
owner of source A could insert an item attributed to source B and advance
source A's cursor (CE1 observed `foreignItems=1, rejected=false`).

**The enforced boundary (two layers, both in the lab):**

1. **PRIMARY — function-level whole-operation rejection.**
   `commitOwnedPollResults` validates EVERY item's attribution BEFORE any
   statement is built or executed. Any `item.sourceId !== input.sourceId` —
   a lone foreign item or ONE foreign item inside an otherwise valid batch —
   raises `OwnedCommitRejectionError('item_source_mismatch')`:
   - NO item is inserted (not even the valid ones — no partial acceptance,
     no silent re-attribution);
   - the cursor/state is NOT advanced and ownership is NOT released (zero
     statements have run, so the no-op is exact);
   - the rejection burns nothing — no attempt, no hold change, no owner
     change — so a corrected commit for the SAME window succeeds afterwards
     (proven P-O16).
     The validation is a pure function of the in-memory arguments, so it is
     race-free by construction; the durable-state races remain fenced by the
     per-statement predicates P (unchanged).
2. **DEFENSE IN DEPTH — statement-level binding guard.** Each item INSERT
   carries an additional `AND ? = ?` binding `item.sourceId` to
   `input.sourceId` inside the SQL, so a foreign-attributed row can never be
   persisted even by a caller that bypasses the validation (0 rows, no
   error, no silent rewrite). All ownership predicates (job id, type,
   aggregate, claimed status, exact generation, durable hold, owner) and
   both accepted targeted conflict clauses are byte-identical to Round 1.5.

**What is NOT claimed:** a DATABASE-level trigger enforcing the binding for
arbitrary writers is NOT part of the proposed migration and NOT claimed; the
enforced boundary is the commit function plus its statements. The normal
product connector constructs matching IDs (the review says so explicitly) —
this correction closes the boundary-consistency gap, not an observed
exploit.

**Proofs:** P-O16 (lone foreign item → typed rejection, exact no-op, window
survives, repaired commit succeeds), P-O17 (mixed valid+foreign batch →
whole rejection, valid item NOT silently kept, foreign source untouched),
P-O18 (valid commit attributes every row to the authoritative source only —
classification/read-path binding), CE1-R (in-suite regression of the exact
counterexample contract). All on real workerd D1, proposed schema 4
(disposable lab DB).

### §10.2 B2 — policy-aware recovery (CE2 + CE3 corrected)

**The gap (review finding B2):** the recovery pass
(`reclaimExpiredClaims`) selected expired claimed rows with NO type filter
and then mutated each one — so during a gate-OFF cycle (a) a paused type's
expired FINAL claim was dead-lettered `job_exhausted` (CE2: the policy did
not precede exhaustion handling in the recovery path) and (b) paused expired
claims consumed the bounded recovery page ahead of enabled work (CE3:
head-of-line delay, 25 paused rows starved one enabled heartbeat).

**The design recovery (`reclaimExpiredClaimsPolicyAware`, lab module
`round15-pause.ts`):**

1. **Policy FIRST:** one bounded aggregate COUNT of expired claimed
   paused-type rows (`pausedExpiredObserved`) — observability only, never
   mutated, never part of the active page. The policy is thereby resolved
   BEFORE any recovery candidate is selected.
2. **Active page excludes paused types IN SQL:** `AND type NOT IN (…)` with
   the same ordering/bounds as the accepted scan (`lease_until ASC, id ASC`,
   LIMIT). A paused row can NEVER consume an active recovery scan slot —
   enabled expired work is reached in the FIRST page (P-N5: 25 paused rows
   ordered before the enabled heartbeat, reclaimBatch 25 ⇒ the heartbeat is
   recovered in pass one; P-N7: page fairness holds across passes — 30
   eligible rows drain in two pages while all 25 paused rows stay
   untouched).
3. **Guarded mutations byte-identical in shape to the accepted ones**
   (ADR-0037): budget spent → `dead_letter`/`job_exhausted`; budget intact →
   `queued`; every UPDATE re-checks `status='claimed' AND lease_until IS NOT
NULL AND lease_until <= now` plus the attempts guard. Recovery NEVER
   writes `attempts`; terminal rows are unreachable (status guard) — nothing
   is reset, rewound or resurrected.
4. **OFF economics:** paused expired claims stay CLAIMED with an expired
   lease (dormant) — attempts and `last_error` preserved exactly, zero
   durable writes per pass (P-N1: final claim attempts=3=max survives any
   number of OFF passes untouched; P-N2: near-final attempts=2 likewise;
   P-N10: three OFF cycles byte-untouched with exhausted-state information
   intact).
5. **ON economics (genuine attempt economics, exactly once):** budget-intact
   rows requeue and resume to completion with attempts intact (P-N4: 2→3 via
   the ONE genuine final execution); genuinely exhausted rows dead-letter AT
   the recovery boundary EXACTLY ONCE with `job_exhausted` (P-N3, P-N10),
   visible to the DLQ reconciliation scan, and no further pass transitions
   them again.
6. **Unknown/misconfigured rows are NOT deferred by the pause:** the
   registry cannot pause what it does not map, and misconfiguration is
   visible by definition — both classes flow through the ordinary recovery
   transitions and the ordinary dispatch poison classes (`job_type_
unregistered` / `handler_misconfigured`), with the stranded-queue grace
   timing documented rather than an unqualified next-pass claim (P-N6).
7. **No-pause equivalence:** with an empty exclusion list the design
   recovery transitions an identical dataset byte-identically to the
   accepted `reclaimExpiredClaims` (P-N8).
8. **No new enum status:** pausing introduces NO new job status; dormancy is
   `claimed` with an expired lease, exactly the pre-existing state space.

**Superseded proof, documented not silent:** the ORIGINAL Round 1.5 P-P5
asserted `reclaimedLeases = 1` and `status = 'queued'` during OFF for a
paused type — exactly the behavior CE2/CE3 supersede. P-P5 now asserts the
corrected contract for the SAME scenario (identity retained; the OFF-side
assertions are STRICTER: zero recovery mutations, a byte-untouched row, and
the ON-side recovery + resumption). The superseded assertions are quoted
verbatim in the test file's supersession note. No other original proof was
edited; all 43 original proof identities are retained (P-O1…P-O15,
P-P1…P-P13, P-R1…P-R7, P-M1…P-M5).

### §10.3 Proof register — Round 1.5.1 additions (does / does-not-prove)

| Proof                       | Proves                                                                                                                              | Does NOT prove                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| P-O16                       | lone foreign item → typed whole-op rejection; exact no-op; window survives; repaired commit succeeds                                | a DB-level trigger for arbitrary writers |
| P-O17                       | mixed valid+foreign batch → whole rejection; no partial acceptance                                                                  | —                                        |
| P-O18                       | valid commit attributes every row to the authoritative source; classification binding                                               | —                                        |
| P-O19                       | policy-aware recovery + owned commit compose on proposed schema 4 (OFF dormancy preserves the ownership anchor; ON resumes)         | product behavior (src/ unchanged)        |
| P-N1                        | CE2 corrected: expired FINAL paused claim not dead-lettered during OFF; zero writes across passes                                   | —                                        |
| P-N2                        | expired NEAR-FINAL paused claim dormant during OFF, attempts intact                                                                 | —                                        |
| P-N3                        | ON recovery of the FINAL claim dead-letters EXACTLY ONCE at the boundary; DLQ-visible; later passes inert                           | —                                        |
| P-N4                        | ON recovery of the NEAR-FINAL claim requeues (attempts intact) and resumes to the ONE final execution                               | —                                        |
| P-N5                        | CE3 corrected: 25 paused expired rows cannot delay the enabled heartbeat (first-page recovery); grace timing documented             | unbounded-scan guarantees                |
| P-N6                        | unknown/misconfigured expired claims recovered (never deferred by the pause), then poisoned with the DISTINCT codes after the grace | —                                        |
| P-N7                        | recovery page fairness across passes (25+25+5 drain; paused rows consume zero slots)                                                | —                                        |
| P-N8                        | empty-exclusion equivalence with the accepted recovery (byte-equal transitions)                                                     | —                                        |
| P-N9                        | already-terminal rows never resurrected (OFF or ON)                                                                                 | —                                        |
| P-N10                       | repeated OFF cycles preserve exhausted state; ON applies genuine economics exactly once                                             | —                                        |
| CE1-R/CE2-R/CE3-R/CONTROL-R | the supplied counterexample contracts as in-suite regressions (the ORIGINAL file stays byte-identical at review/evidence/)          | —                                        |

**Honest scoping retained from Round 1.5 (unchanged):** `inserted_
unreserved` remains explicitly allowed and tested — the batch is atomic, but
a stale source-marker CAS can still leave a durable pending job without a
reservation; this is NOT equivalent to all-or-nothing job+reservation, and
the recovery/liveness cost is stated, not hidden. Hold/lease-expiry
semantics remain proposals. External in-flight fetches cannot be recalled
and fetch-before-commit crash recovery can fetch twice — the explicit
at-least-once disclosure stands. A schema-4 fixture running in a disposable
D1 test does NOT authorize remote migration or establish rollout/rollback
safety. R04/R10, D02 revision history, C.4/C.5 and partial-result
preservation remain out of scope, unresolved.

### §10.4 Measured totals (Round 1.5.1, all retained as exact logs)

- Supplied counterexamples on the UNCHANGED Round 1.5 lab: **3 failed / 1
  passed, exit 1** (LOG_00) — matches the independent review.
- The SAME original file on the corrected lab: **4/4 passed, exit 0**
  (LOG_01) — the corrections answer all three counterexamples; the control
  still passes.
- Full suite: **981 passed / 4 failed (985)**, exit 1 — failures exactly
  R04/R09/R10/D01 (named, visible, unedited). Includes the 43 original
  proof identities (P-P5 corrected as documented), 14 new proofs
  (P-O16…P-O19, P-N1…P-N10) and the 4 in-suite counterexample regressions
  (CE1-R/CE2-R/CE3-R/CONTROL-R).
- `test:db`: **232/232** (script composition unchanged — a subset, not an
  additional 232 distinct tests).
- lint, format:check, typecheck, check:versions, test:telegram-setup,
  test:secrets, scan:secrets (270 staged files, 0 findings), build,
  build:preview: all exit 0.
