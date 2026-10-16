# Round 1.8.1 - independent corrective acceptance

Posidon accepts the LOCAL R10 implementation (Round 1.8 plus the Round 1.8.1
B1-B4 corrections) after independent code review and workerd D1 tests.
This supersedes the prior Round 1.8 CHANGES REQUIRED decision only for
these corrected boundaries. It is not a release, main merge, deployment,
activation, or authorization to execute a real database migration.

- Input ZIP SHA-256: `9220ccec6b8a83fb295e92ff667c5e1c8a0f0802a7452a07b616a8e529e28f87`.
- Parent accepted remote commit: `f6337e54434126090be7f7a6fc1a7b28612941bd`.
- Original Round 1.8 counterexamples independently reproduced: 7 failed /
  1 control passed; the same frozen evidence on this candidate: 8/8 passed.
- Candidate full suite, single command `npx vitest run --maxWorkers=1`:
  1094 passed / 1 failed of 1095, 87 files. The failure is precisely R09.
- Candidate DB subset: 301/301, 22 files. This is not added to the total.
- Shipped boundary suites: 23/23, included in the total above.
- Eleven additional independent manager probes, outside that composition,
  passed: all five connector families preserve saved cursor/validators on
  denial and aggregate prior calls plus redirect-hop authority errors once;
  late authority rejection never resumes the network.
- lint, format, typecheck, versions, Telegram setup, scanner self-tests,
  meaningful staged scan (286 files / zero findings), and both dry-run
  builds passed on the input source. No live provider network was used.
- All three packaged diffs independently reconstructed all 286 source files
  byte-identically: correction against the original Round 1.8 ZIP,
  incremental against f6337e54, cumulative against 48e0f28.

## Accepted boundaries

1. Authorization waits share the absolute HTTP sequence deadline; late
   grants cannot restart fetch. In-flight D1 authorization may still charge
   after timeout, conservatively and without refund.
2. Quota denial preserves the loaded cursor and validators, emits no items,
   and is not disguised as 304 or successful ingestion.
3. Previously observed provider Retry-After lower bounds survive a later
   denial and remain schedule lower bounds, including valid zero values.
4. Infrastructure exceptions carry safe observed-attempt counts through
   every connector and the handler warning, separately from charged units.

## Publication and remaining limits

This manager branch adds only this acceptance record to the candidate's
286 byte-identical files. Remote publication is pending; no push has been
performed. No GitHub CI result is claimed for this local commit.

R09 remains a genuine failing assertion. Full check/CI is NOT green and
this branch is NOT release-ready. Applied schema remains 3 (0001-0003).
The proposed 0004 fixture remains disposable-test material only. Product
ownership implementation and any real migration need separate approval.
No exactly-once external fetching or zero-defect product claim is made.
Historical candidate/status documents retain their original review-stage
labels and are superseded by this scoped acceptance, not silently rewritten.
