# PIXEL R1.10.2 — independent review and scoped decisions

## Outcome

**PARTIAL ACCEPTANCE.** The major corrected trace/unit vocabulary, executable
package layout, recovery correction and stage-order correction are accepted
as progress. The Free-safe DESIGN is **CHANGES REQUIRED**. Do NOT implement
D1+D4 as a supposedly Free-safe product fix.
Product acceptance at f70205648922d0f8e60619e45e5d54e6e87b8f1b remains unchanged.
Current advertised ingestion profile remains NOT_READY_FOR_INGESTION_ON_FREE.
This does not establish that a narrower Free profile is impossible.

## Independent evidence, not copied totals

Reviewed ZIP SHA-256:
`bd7d3462ab8c3eaf2e5b51e1ac5b69db399748a6d916a0f1ecbdd83caf22c80b`
4,295,898 bytes. Manifest353/353; real bundle exact HEAD; source297/297
byte-identical; working clone tracked diff empty.

Exact unfiltered corrected tool command: **37/37, two files, exit0** independently
reproduced (logs/r1102-independent-traces.log). Full accepted product suite was
NOT rerun by manager this review, because source is unchanged and byte-verified;
the submitted full1142/DB301 logs remain GLM evidence, not a fresh manager claim.

Manager counterexample suite: **3 FAILED / 1 CONTROL PASSED, exit1**:

- CE1 actual failed batch incorrectly reported as completed statements.
- CE2 proposed Probe A drops the accepted source predicate.
- CE3 metadata-cap overflow can overwrite a retained unavailable record.
- CONTROL100 inserts +2 grouped reads =3 execution calls but102 SQL statements.
  The first/control/CE2 use real disposable workerd D1; CE3 is explicitly a fake
  binding unit test of instrumentation memory only. No cloud enforcement/CPU/fees.

## R112-01 — P1 BLOCKER: grouped reads do NOT remove retained insert statements

`free-plan/FREE_SAFE_EXECUTION_DESIGN.md` sections3,6,7,8.
The proposal keeps the atomic item batch UNCHANGED. It still submits one
INSERT per item plus its state UPDATE and budget statements. Therefore100
items already require >=101 statements BEFORE grouped reads and other work.

Actual minimal SQL control:100 bound INSERT statements in ONE batch, then two
source-scoped grouped SELECTs respecting100 bound parameters → **3 API calls,
102 attempted/completed statements**. No state/engine overhead is even counted.

Using T13's own retained component counts (batchStatements103; terminal108
including100 classification reads), replacing those100 reads by two grouped
reads gives a DERIVED12 API /113 statements, not15–16 statements. The exact
future implementation may differ; the lower bound alone disproves the claim.

Thus the asserted >=3x headroom under BOTH quota interpretations, and the
2-job32/32 estimate, are false. The design's dismissal of metadata-only
classification for retaining100+ write statements applies equally to its
PRIMARY design! Preserve both-unit acceptance until the official unit is
settled; don't change vocabulary to hide writes.

Accepted direction: grouped reads MAY be a worthwhile execution-call optimization,
not a complete Free-safe design. No product implementation authorized yet.
Next round needs an executable local SQL prototype with explicit insert/state/
budget/probe/dispatch/claim totals. Alternatives: parameter-bounded multi-row
INSERT..SELECT maintaining per-row ownership/targeted conflicts in ONE atomic
batch; lossless durable continuation if required; or explicit narrower initial
profile. Each must be proved, not merely named.

## R112-02 — P1: per-connector capacity and losslessness not proved

T18 uses3 Steam apps, T19 two playlists, T20 two repositories, T21 two
subreddits. These are representative multi-request tests, NOT supported-max
traces. Global cheap100-item-poll claims don't follow from them.
Actual runtime bounds: Steam batch up to25 apps × up to10 items; YouTube up
to25 playlists plus a details request; GitHub up to25 repositories; Reddit
up to10 subreddits plus token; RSS up to4 feeds with100 per feed. Redirects
can add hops and each hop incurs D1 authorization. A fixed 'base10' is not
a connector-independent worst case. Satisfying RSS100 doesn't certify all.

D3 also overstates continuation: RSS cursor stores per-feed validators (it is
not simply absent); GitHub per-repo etags are not general pagination; Reddit
saves `after` tokens but accepted listing request construction does not send
`after` as pagination. Whole-feed refetch cannot guarantee recovery of an item
which leaves a finite provider feed before retry. Preserve AT-LEAST-ONCE fetch
and the precise existing supported-window contract, not universal losslessness.

Manager direction: design a FIRST deterministic Free preview profile, e.g.
one supported single-feed RSS source, batch1, current100-item bound and
all hop limits fully accounted; keep other connectors implemented but OFF for
that profile, explicitly pending separate budget evidence. This is temporary
staging, NOT removal of product features. A multi-connector general design is
also acceptable if proved. Never silently lower feed caps/drop old items or
claim cadence controls queue occupancy. No config/profile applied this round.

## R112-03 — P2: failure and overflow counters still misreport

`audit-tools/trace/d1-instrument.ts:deriveCounts` sets
`statementsCompleted = terminalCompleted + batchStatements` even when a batch
fails. CE1: attempted2, batchFailed1, batchCompleted0, no results and transaction
rolled back; reported completed2. Maintain a separate successful-batch statement
counter, reset/snapshot it, and label unobservable execution/rollback internals
UNKNOWN rather than treating submitted statements as completed.

CE3: after4096 retained samples, captureMeta still edits the LAST retained
sample when a new available result arrives. If sample4096 had no metadata,
sample4097 is wrongly attributed to4096. Add an explicit truncation count/flag
and reliable all-result aggregates, never mutate an older sample or call a
truncated sum complete. Use the record just created, not the last array entry.
Both new failing controls must turn green after tooling correction.

## R112-04 — P2: grouped lookup must preserve source identity

Proposed Probe A removes `AND source_id=?` on the rationale that id is a PK.
PK uniqueness does NOT prove that an existing row belongs to the attempted
item's source. CE2's accepted query returns[], proposed query returns the
foreign-source row. This is a QUERY-EQUIVALENCE counterexample, not a claim
that normal fresh random IDs or the accepted product cause foreign writes.

Keep each attempted item's source/id pair. ProbeB/C must also preserve exact
per-item source (especially legacy commit inputs), not blindly assume every
item can use input.sourceId. Chunk binds including all source/identity binds
<=100, preserve classification order and all existing quirks. Existing PK
collision failure and whole-batch rollback may NOT be reinterpreted.

CE2 encodes the REJECTED literal SQL and will intentionally remain red if run
unchanged even after the document changes. Preserve original evidence;
add a DISTINCT corrected candidate-query test and parity matrix. Do NOT edit
the frozen test and claim the original4/4 now pass. Expected frozen-suite state
after fixing CE1/CE3 is1F/3P (CE2 remains the old-query counterexample).

## Operator nits to correct in-place (not another product redesign)

- Stage order7→8a→8b→8c is now non-circular. However 'automatic reversion to
  false' in checklist has no supplied timer/implementation. Call it an explicit
  timed operator shutdown/check, or identify a separately authorized mechanism;
  do not claim a guaranteed automatic stop that doesn't exist.
- Some worksheets still assert cloud rows>=local unconditionally/index
  amplification automatically undercounts. Keep raw local metadata and full
  coverage labels; cloud billable equality OR inequality is not measured.
- Label current small connector fixtures representative, not max-bound proofs.

## What is accepted now / what stays open

- Accepted progress: executable37-test package; prepare-vs-execution units;
  every-normal-batch-result capture; schema4 active measurements and honest
  NOT_READY verdict; existing recovery recognition; corrected stage topology;
  storage/date/reset-clock retractions. Preserve these; no broad rewrite.
- Open: R112-01/R112-02 design, R112-03 counter edge cases, R112-04 source
  parity, narrow operator wording. Next round is a measured DESIGN LAB, not a
  repeat of the full audit and not a product change.
- No commits/push/Cloudflare/real migration/deploy/activation/billing actions.
