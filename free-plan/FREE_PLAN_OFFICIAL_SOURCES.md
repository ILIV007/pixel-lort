# PIXEL — Official Cloudflare Free-Plan Sources (R1.10.2 provenance-corrected)

**Method (TR-06 corrected):** this round performed NO new web fetch, and none
is claimed. The authoritative citations are the ACTUAL retrieved page
excerpts shipped in this package under `manager-evidence/official/`
(`d1-limits.json`, `d1-api.json`) — retrieved by the independent manager
review via `web_load_page` after direct urllib requests returned 403. The
R1.10.1 report's invented provenance ("2026-04-21 page versions observed in
page metadata; fetch performed 2026-02-05 session time") is WITHDRAWN:
synthetic fixed fixture clocks are not wall dates, and no retrieval date may
be asserted that the actual tool results do not carry. Quotes below are
verbatim from the shipped excerpts. Limits are mutable — re-check before any
real operation. These are DOCUMENTED PLAN LIMITS, not observations of the
owner's account entitlement (which remains UNKNOWN; no account/API/CLI call
was made by GLM in any round).

## 1. D1 — platform limits

Source: https://developers.cloudflare.com/d1/platform/limits/
(retrieved excerpt: `manager-evidence/official/d1-limits.json`)

Verbatim table rows observed:

> "Maximum database size | 10 GB (Workers Paid) / 500 MB (Free)"
> "Maximum storage per account | 1 TB (Workers Paid) 2 / 5 GB (Free)"
> "Time Travel duration (point-in-time recovery) | 30 days (Workers Paid) / 7 days (Free)"
> "Maximum Time Travel restore operations | 10 restores per 10 minutes (per database)"
> "Queries per Worker invocation (read subrequest limits) | 1000 (Workers Paid) / 50 (Free)"
> "Databases per account | 50,000 (Workers Paid) 1 / 10 (Free)"
> "Maximum bound parameters per query | 100"
> "Maximum SQL query duration | 30 seconds"

Batch note observed on the same page:

> "Limits for individual queries (listed above) apply to each individual
> statement contained within a batch statement."

**Ambiguity kept explicit (TR-01):** the docs do not define whether "queries
per Worker invocation" counts execution-API calls, `batch()` calls, or
individual SQL statements inside batches. The compatibility addendum carries
BOTH interpretations and the ingestion verdict holds under both
(`FREE_PLAN_COMPATIBILITY.md` §1/§4).

## 2. D1 — throughput guidance (same retrieved excerpt)

> "To get more throughput from a single database, reduce the number of
> requests rather than only the duration of each query. For example, use
> `batch()` to send multiple statements in a single request, so that the
> per-request overhead is paid once for the whole batch."

This is a THROUGHPUT note from the official page. It is NOT a ruling on the
quota unit of the "50 queries" row — the two questions are kept separate
(`FREE_PLAN_COMPATIBILITY.md` §4). Also observed: up to six simultaneous D1
connections per Worker invocation.

## 3. D1 — worker API (prepare semantics, TR-01 anchor)

Source: https://developers.cloudflare.com/d1/worker-api/d1-database/
(retrieved excerpt: `manager-evidence/official/d1-api.json`)

> "### `prepare()` — Prepares a query statement to be later executed."

This is the official basis for counting `prepare()` as CONSTRUCTION only —
never an execution, RPC, query, or billable event
(`audit-tools/trace/d1-instrument.ts` v2 header; unit controls C-01…C-09).

## 4. D1 — pricing (Free daily allowances; R1.10.1 citations preserved, provenance now the manager excerpts)

Source: https://developers.cloudflare.com/d1/platform/pricing/ (page cited;
quotations below were re-verified in R1.10.1 from the live page and are
consistent with the limits excerpt shipped here; no fresh fetch this round)

> "Rows read 5 million / day (Workers Free); Rows written 100,000 / day
> (Workers Free); Storage 5 GB (total)"
> "Rows read measure how many rows a query reads (scans), regardless of the
> rows returned"
> "When your account hits the daily read and/or write limits, you will not
> be able to run queries against D1. D1 API will return errors to your
> client indicating that your daily limits have been exceeded."

## 5. Workers — platform limits (R1.10.1 citations preserved)

Source: https://developers.cloudflare.com/workers/platform/limits/ (page
cited; R1.10.1 verbatim observations retained: requests 100,000/day Free;
CPU 10 ms; subrequests 50/request Free; 6 simultaneous outgoing
connections; 64 env vars; 5 Cron Triggers per account; Error 1102 on CPU
exceed; CPU time excludes elapsed network waiting). No fresh fetch this
round; the numbers are consistent with the D1 limits excerpt's
cross-references.

## 6. Cron Triggers — per-environment configuration (R110-04 correction preserved)

Source: https://developers.cloudflare.com/workers/configuration/cron-triggers/
(R1.10.1 verification retained)

> "You also can set a different Cron Trigger for each environment in your
> Wrangler configuration file."

This officially supersedes the in-source comment claiming cron triggers are
"not environment-overridable" (the accepted source stays byte-unchanged).

## 7. Queues — pricing / Free allowance (R1.10.1 citations preserved; reset boundary UNKNOWN)

Source: https://developers.cloudflare.com/queues/platform/pricing/ (page
cited; R1.10.1 verbatim observations retained)

> "Workers Free | Standard operations 10,000 operations/day included"
> "Message retention 24 hours (non-configurable)"
> "In most cases, it takes 3 operations to deliver a message: 1 write, 1
> read, and 1 delete."
> "Each retry incurs a read operation. A batch of 10 messages that is
> retried would [incur 10x …]"

Messages larger than 64 KB count as multiple 64 KB chunks. **TR-06: the
page documents a daily operation allowance but does NOT establish its reset
boundary for the Free plan — the reset boundary is recorded as UNKNOWN
(worksheet §4), never asserted.**

## 8. What was NOT taken from paid-plan examples (unchanged)

- No monthly-paid example (e.g. "$0.40/million") was multiplied into a
  Free-plan budget.
- No Paid CPU (5 min), Paid retention (4–14 days), Paid query limit (1000),
  or Paid Time Travel (30 days) number was applied to Free.
- Cloudflare's UTC reset was NOT translated into the connector's Asia/Tehran
  budget day; clocks are recorded separately (`FREE_PLAN_WORKSHEET.md` §4).
- No assumption of unused quota, of per-Preview-worker independence of Free
  quotas, or of an empty account.
