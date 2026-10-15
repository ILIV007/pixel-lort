# Round 1.5.1 — independent design acceptance

Posidon accepted the B1 source-binding and B2 policy-aware recovery corrections after independent local workerd D1 verification. This is DESIGN/LAB acceptance, not a product release or authorization for migration/deployment.

- Input artifact SHA-256: `77ab12648084f5913f34caa6c1fe98055abf5ecffd611b45cf59d819569b2f7c`.
- All 260 accepted product files at `5a6b1b817d02c7d5bbeb5d4fcba7bc4356d4fa03` remain byte-identical. Ten design/lab files are additive. This manager branch additionally records the design and this acceptance note.
- Original independent evidence, unchanged: 4/4 passed (formerly 3 failed / 1 control passed).
- Full source suite: 981 passed / 4 failed (985). Design proofs/regressions: 61 passed, included in that total.
- DB subset: 232/232, not an additional 232 distinct tests.
- lint, format, typecheck, versions, Telegram setup, scanner self-tests, meaningful staged-file secret scan and both dry-run builds passed before publication.
- Product failures remain R04/R09/R10/D01. Main is not updated and this branch is not release-ready. CI failure from those four known assertions is expected, not waived or hidden.

## Acceptance clarifications overriding broad legacy design wording

1. Resume timing is state- and backlog-dependent: eligible pending/retry work is considered by bounded dispatch pages; reclaimed claims first become queued and may wait the configured stranded-queue grace before dispatch; genuinely exhausted claims follow ordinary exhaustion when ON. There is no unconditional promise that every paused job is sent on the first ON pass.
2. A COUNT aggregate returns one row, but does not bound the number of database rows scanned. The observability counts need query-plan/cost scrutiny at production scale. Active recovery pages remain LIMIT-bounded and exclude paused types.
3. Item source mismatch is rejected by the commit function before any batch statement. The extra SQL equality is defense in depth, not a database-wide trigger or a guarantee that bypassing the function rejects the entire batch.
4. Individual expired scheduling holds and execution leases do not by themselves revoke all authority. Accepted fences remain exact job identity/status/generation plus durable ownership. In-flight external requests cannot be recalled; exactly-once external fetch is not promised.
5. `inserted_unreserved` is an explicitly allowed orphan-job outcome, not all-or-nothing creation plus reservation. Its recovery cost remains disclosed.
6. The schema-4 fixture is proposed and authorized only inside disposable tests. Applied migrations stay 0001–0003, app1.4.0/schema3. Production ownership implementation and any migration require separate approval.

## Next narrowly authorized work

Round 1.6: LOCAL production implementation of D01 pause/enablement/recovery only, on schema3, with real engine/environment/cron/queue-port tests. R09 ownership, R04, R10, observation history, remote operations and deployment remain outside scope. GLM does not commit/push; Posidon independently reviews and publishes accepted work.
