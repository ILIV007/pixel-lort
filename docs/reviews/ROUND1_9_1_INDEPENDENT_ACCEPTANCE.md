# Round 1.9.1 - independent LOCAL R09 acceptance

Posidon accepts the LOCAL R09 product implementation from Round 1.9,
including the Round 1.9.1 R19-01/R19-02/R19-03 corrections, after independent
review. This supersedes the Round 1.9 CHANGES REQUIRED verdict for these
corrected boundaries. It is not a release, deployment, main merge,
ingestion activation or authorization to execute a real database migration.

## Input and independently reproduced evidence

- Input ZIP: `pixel-phase04-v1.4.0-round1.9.1-review-candidate.zip`.
- Input SHA-256:
  `ee799c1206eff932f23efa71ce6e1fd67255662957b4074024def3d34ccd4acf`.
- Input manifest: 348/348 valid; source: 296 files.
- Accepted parent: `6e4851caea27a32940eada992b00775ec2106d11`.
- Full suite: 1142/1142 passed, 91 files, exit 0, single command
  `npx vitest run --maxWorkers=1`.
- Frozen independent counterexamples: 7/7 passed unchanged; SHA-256
  `f84d28b8dfb5544abcba62e4e6e38dc30483282e6c47d2240c91abff119e6664`.
- DB subset: 301/301, 22 files, exit 0; not added to the full total.
- lint, format, types, versions, Telegram setup, secret selftests, meaningful
  staged secret scan (296 files / zero findings) and both DRY-RUN builds
  passed on the candidate. This acceptance document is the only manager
  addition, bringing the accepted tree to 297 files.

## Accepted boundaries

1. Owned scheduling uses a current-time hold plus a durable owner; the
   partial unique outstanding-poll index prevents a second live window.
   Every item/state mutation carries source identity, owner, hold and exact
   job generation fences. Mixed-source commits reject before statements.
2. Schema capability has three distinct states: known readable v3 legacy,
   known readable v4 ownership, unresolved. Unresolved stops scheduling
   before source/job/seed effects and returns a recoverable handler retry
   before ingestion budget/network/items/source-state effects. Engine
   claim/retry accounting remains distinct. Health equality is not relaxed.
3. Post-conflict classification validates complete durable identity before
   terminal/nonterminal classification; foreign aggregate rows never become
   reported window owners. No automatic cancellation or ownership transfer.
4. The original seven independent probes are byte-identical. R09-P16 alone
   was explicitly authorized to replace its unsafe unknown-to-legacy
   expectation; the superseded behavior is preserved as historical reference.
5. D01 policy pause, R10 per-hop authority and previous accepted tests stay
   green. External fetching remains at-least-once across a crash between
   fetch and commit; exactly-once network execution is not claimed.

## Authoritative diff verification

The reviewer cloned the actual public Git repository. The incremental diff
applied to an actual Git archive of `6e4851caea27a32940eada992b00775ec2106d11`
and the cumulative diff applied to an actual Git archive of
`48e0f28ce5bcd3d4d641560c3e9fb382292539ee` each reconstructed all 296 candidate
files byte-identically, including the previously missing acceptance document.
The correction diff also reconstructed the same tree through the previously
independently verified Round 1.9 incremental patch on the actual parent.
This closes the archive-level verification left open by GLM; no circular
reverse-derived baseline is asserted to be authoritative.

## Operational constraints

- Defaults remain app 1.4.0 / expected schema 3; readable schema 3 retains
  legacy compatibility. R09 ownership requires schema 4 and is NOT active
  merely because this source is accepted or committed.
- Migration 0004 is accepted as a LOCAL product candidate tested ONLY in
  disposable workerd D1 databases. Default test migrations remain 0001-0003.
- Any real migration requires separate owner authorization, an empty
  duplicate preflight, a backup/bookmark, version-aware readiness and a
  rollback plan. No real migration, Cloudflare operation or activation was
  performed as part of this acceptance.
- No live Telegram bot end-to-end behavior was verified here. A green
  foundation suite does not mean the complete editorial bot is finished.
- Publication, if separately completed, is only a correction branch; no
  merge to main or release is implied by this document.
