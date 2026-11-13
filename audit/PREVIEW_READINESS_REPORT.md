# PIXEL — LOCAL Preview-Readiness Audit Report — R1.10.2 corrected edition

**Round:** 1.10.2 (LOCAL audit-tool corrections + corrected operator reports

- Free-safe execution DESIGN ONLY — no product implementation; corrected
  edition of the R1.10.1 report, whose original is preserved inside the sealed
  input `input/R1.10.1_61a01947_ORIGINAL.zip`).
  **Accepted source:** commit `f70205648922d0f8e60619e45e5d54e6e87b8f1b`,
  branch `phase/04-corrections-round191` (app 1.4.0, expected schema 3, 297
  tracked files) — **unchanged and re-verified this round** (§1).
  **Authorization:** `NEXT_GLM_PROMPT_R1_10_2.md` (INSTRUCTIONS package
  `PIXEL_v1.4.0_R1.10.2_Free-Plan-Quota-Corrections_INSTRUCTIONS.zip`,
  manifest 316/316 + sealed input verified via `verify_package.py`).
  **Performed by:** GLM (local audit). **No commits, pushes, authentication,
  Cloudflare/wrangler remote operations, real migrations, deployments,
  activation, billing changes, or delivery-app edits were performed. No
  subagents were used.**

Corrections applied in this edition (per
`manager-review/R1101_INDEPENDENT_FINDINGS.md`): TR-01 (measurement units

- batch metadata), TR-02 (active/worst-supported path measured; profile
  NOT_READY), TR-03 (Stage-7.5/8 dependency cycle + accounting), TR-04
  (implemented recovery re-registered), TR-05 (trace command fixed; no
  nested duplicates), TR-06 (worksheet bounds/provenance). Full mapping with
  exact files and evidence: `audit/CORRECTIONS_R1_10_2.md`.

---

## 1. Baseline verification (input integrity — re-done this round)

| Check                                                                                                       | Result                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INSTRUCTIONS ZIP SHA-256 manifest (`SHA256SUMS.txt`)                                                        | **PASS — 316/316 files OK**                                                                                                                                                                                   |
| Sealed reviewed input                                                                                       | `input/R1.10.1_61a01947_ORIGINAL.zip`, SHA-256 `61a01947968db2902c41b8cd419f80badfbc4adce2397e068090e2416831ca40` (matches `reviewedInputSha256`) — preserved as HISTORY, never edited                        |
| Documents read in order                                                                                     | `README_START_HERE.md` → `VERSION.json` → `manager-review/R1101_INDEPENDENT_FINDINGS.md` → `manager-review/OUTCOME_FA.md` → `NEXT_GLM_PROMPT_R1_10_2.md` → `manager-evidence/README.md` + `MEASUREMENTS.json` |
| Git bundle clone (`verification/accepted-history.bundle`, branch `phase/04-corrections-round191`, explicit) | OK                                                                                                                                                                                                            |
| Clone HEAD                                                                                                  | **`f70205648922d0f8e60619e45e5d54e6e87b8f1b` (exact match)**                                                                                                                                                  |
| Ancestor commits reachable                                                                                  | `6e4851c` (R10), `f6337e5` (R04) present in `git log`                                                                                                                                                         |
| Tracked files in clone                                                                                      | **297**                                                                                                                                                                                                       |
| Byte-identity: shipped `source/` (297 files) vs `git archive HEAD`                                          | **Zero differences**                                                                                                                                                                                          |
| Working tree at end of round                                                                                | `git status` clean (0 changes)                                                                                                                                                                                |

## 2. Quality gates re-run THIS round (actual counts; commands GLM actually ran)

Environment: node v24.21.0 / npm 11.19.0 / wrangler 4.147.0; dependencies
installed with `npm ci --ignore-scripts` into the fresh clone. Exact logs in
`logs/`. **Count discipline (TR-01/manager rule): tool-suite counts are
NEVER added to product totals.**

| Gate (exact command)                                  | Result                                                             | Log                                |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| `npx vitest run --maxWorkers=1` (full accepted suite) | **1142/1142 passed, 91 files, exit 0**                             | `logs/01-full-suite.log`           |
| `npm run test:db` (DB subset)                         | **301/301 passed, exit 0** (subset — NOT added to the full total)  | `logs/02-db-subset.log`            |
| `npm run lint`                                        | exit 0 (audit-tools overlay staged OUTSIDE the clone during gates) | `logs/03-lint.log`                 |
| `npm run format:check`                                | exit 0                                                             | `logs/04-format-check.log`         |
| `npm run typecheck`                                   | exit 0                                                             | `logs/05-typecheck.log`            |
| `npm run check:versions`                              | exit 0                                                             | `logs/06-check-versions.log`       |
| `npm run test:telegram-setup`                         | exit 0                                                             | `logs/07-telegram-setup.log`       |
| `npm run test:secrets` (selftest)                     | exit 0                                                             | `logs/08-secrets-selftest.log`     |
| `npm run scan:secrets`                                | **297 files scanned, 0 findings**                                  | `logs/09-secret-scan.log`          |
| `npm run build` (DRY-RUN)                             | exit 0 — Total Upload 380.09 KiB / gzip 75.66 KiB                  | `logs/13-build-dryrun.log`         |
| `npm run build:preview` (DRY-RUN)                     | exit 0 — Total Upload 380.09 KiB / gzip 75.66 KiB                  | `logs/14-build-preview-dryrun.log` |

Both builds were DRY-RUN only; `dist/` was removed after the runs so the
working tree returned to exactly HEAD. No accepted source file or assertion
was changed.

## 3. Input reproduction (the manager's documented failures, re-proven)

| Reproduction                                                                                                | Result                                                                                                                                                        | Log                                        |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Supplied UNFILTERED recursive trace command on the SEALED INPUT (scratch overlay, exact documented command) | **exit 1** — 9 assertions pass; nested duplicate suite fails import (`Cannot find module '../../src/entrypoints/worker'`) — exactly as the manager documented | `logs/10-supplied-command-input-exit1.log` |
| Five manager controls UNMODIFIED (probes + manager config)                                                  | **5/5, exit 0** (real disposable workerd D1; REAL scheduled/queue entrypoints)                                                                                | `logs/11-manager-controls-input.log`       |
| Accepted tracked diff after overlay                                                                         | **0**                                                                                                                                                         | `logs/12-accepted-tracked-diff.log`        |

## 4. Corrected audit tooling (TR-01/TR-05 — outside the accepted source)

- `audit-tools/trace/d1-instrument.ts` v2: separated counters — prepares
  (construction only), terminal attempts/completed/failed BY METHOD
  (`run/all/first/raw`), batches (each = ONE execution-API call),
  batch statements, EVERY available result-metadata record, explicit
  UNAVAILABLE labeling, attempted/completed/failed separation; `raw()`
  counted; `exec()`/`withSession()` declared passthrough surfaces.
- `audit-tools/trace/instrument-controls.test.ts` (NEW): 9 unit controls
  (C-01…C-09) — unused prepare, multi-result batch, reused statement, bind
  identity, failures, non-instrumented probes, unavailable-metadata
  labeling, raw(), unsupported surfaces. **9/9 exit 0.**
- `audit-tools/trace/trace-suite.test.ts` v2: **28 traces** (T-01…T-28) —
  schema-3 surface (webhook normal/duplicate/unauthorized/owner-with-
  transport; cron idle/seed/due as SEPARATE windows; gate-OFF batch10) and
  ACTIVE schema-4 ingestion (single polls 0/2/100 new + duplicate-heavy +
  mixed; active batch10 via ONE real handleQueue; per-connector
  multi-request bounds incl. redirects; provider failure / budget denial /
  authority failure separately labeled; poison; bounded retries →
  dead-letter; cron DLQ reconciliation send; >24h stranded re-kick). Every
  trace: ONE entrypoint/window, expected AND applied schema logged, fixture
  writes + validation reads on the RAW binding outside the window.
- **No nested duplicate tool copies exist** (TR-05); the unfiltered
  documented command on the FINAL artifact from a fresh extraction is
  **37/37, exit 0** (`audit-tools/logs/trace-run-r1102.log`; fresh-extract
  re-proof `logs/20-final-fresh-extract-trace-run.log`).
- **Independent cross-validation:** the corrected instrument reproduces the
  manager's independent measurements EXACTLY — single 100-item poll
  T-13 = 110 execution-API-call attempts / 211 statements (manager C2-100);
  active batch10 T-16 = 1001 / 1812 (manager C3). Exact match.

## 5. Key measured results (corrected units — LOCAL PROXY numbers)

| Path                                                                                                      | xAPI (attempts) |        STMT | Verdict vs documented Free 50-query row                             |
| --------------------------------------------------------------------------------------------------------- | --------------: | ----------: | ------------------------------------------------------------------- |
| webhook normal / duplicate / unauthorized                                                                 |       2 / 2 / 3 |   2 / 2 / 3 | far below                                                           |
| cron idle; seed pass; due pass (separate windows)                                                         |      6 / 9 / 11 | 6 / 36 / 11 | below                                                               |
| gate-OFF batch10 (1 lookup/job)                                                                           |              10 |          10 | below                                                               |
| ACTIVE single poll 0 new (304 and empty-200)                                                              |              10 |          11 | below                                                               |
| ACTIVE single poll 2 new (redirect, 2 charged)                                                            |              13 |          17 | below                                                               |
| **ACTIVE single poll 100 new**                                                                            |         **110** |     **211** | **EXCEEDS under BOTH interpretations**                              |
| ACTIVE single poll 100 duplicates                                                                         |             210 |         311 | exceeds                                                             |
| ACTIVE single poll 50/50                                                                                  |             160 |         261 | exceeds                                                             |
| **ACTIVE batch10 via ONE handleQueue**                                                                    |        **1001** |    **1812** | **exceeds**                                                         |
| per-connector bounds (RSS 3 feeds+redirect / Steam 3 apps / YT 2 playlists / GH 2 repos / Reddit token+2) |           11–19 |       13–29 | raw requests 2–4 each                                               |
| provider failure / budget denial / authority failure                                                      |     10 / 11 / 8 | 11 / 12 / 9 | separately labeled; authority path = zero terminal writes, zero raw |
| cron DLQ reconciliation send                                                                              |               7 |           7 | 1 send + guarded confirmation                                       |
| cron stranded re-kick of 25h-aged queued row                                                              |               9 |           9 | SAME durable job id re-enqueued                                     |

**Operational status for the CURRENT ADVERTISED ingestion profile
(batch-10 / ≤100-item polls): `NOT_READY_FOR_INGESTION_ON_FREE`** —
a single supported 100-item poll alone exceeds the documented Free
50-query row under BOTH unit interpretations; lowering queue batch size
does not fix the single-job path. Cloud enforcement and CPU remain
LIVE-UNVERIFIED. This is a local-measurement + documented-limit conclusion
and does NOT assert that every Free profile is impossible.

## 6. Operator documents corrected (in place; history preserved)

Seven operator reports + free-plan documents corrected consistently:
`audit/PREVIEW_READINESS_CHECKLIST.md` (Stage 8a/8b/8c cycle fix —
TR-03), `audit/PREVIEW_SMOKE_TESTS.md` (counter semantics — TR-03),
`audit/CAPABILITY_MATRIX.md` (recovery re-registered — TR-04),
`audit/REMAINING_PRODUCT_WORK.md` (register fix — TR-04),
`audit/SCHEMA3_TO_4_TRANSITION_REVIEW.md` (consistency),
`audit/OPERATOR_SUMMARY_FA.md` (Persian summary),
`free-plan/FREE_PLAN_COMPATIBILITY.md` (§1 verdict + units + recovery),
`free-plan/FREE_PLAN_WORKSHEET.md` (rebuilt — TR-06),
`free-plan/FREE_PLAN_RESOURCE_LEDGER.json` (machine ledger),
`free-plan/FREE_PLAN_OFFICIAL_SOURCES.md` (provenance corrected — TR-06).
`audit/CORRECTIONS_R1_10_1.md` is preserved as HISTORY (inside the sealed
input); the new TR closure ledger is `audit/CORRECTIONS_R1_10_2.md`.
Preserved unchanged: R19-01 fail-closed, D01 pre-claim pause, R10 attempt-
vs-charged accounting, late authorization (unit-test property), source
rights, at-least-once caveats.

## 7. Free-safe execution DESIGN ONLY (new; `free-plan/FREE_SAFE_EXECUTION_DESIGN.md`)

Submitted FIRST, before any implementation, per the manager's instruction:

- **D1 (primary):** grouped classification probes (IN-lists, ≤ 100-bound
  chunking) replacing the per-item probe loop — same semantics, ~15–16
  xAPI/STMT per 100-item poll (≥ 3× headroom under BOTH interpretations);
  schema-3 AND schema-4 compatible; NO migration required; product code
  change in a FUTURE authorized round only.
- **D2 (rejected as primary):** classification from batch `changes`
  metadata — fails the statements interpretation and changes duplicate-
  reason semantics; listed for completeness.
- **D3:** continuation via existing atomic cursors (Steam/Reddit/GitHub);
  RSS/YouTube rely on full re-fetch + dedup — no silent-drop partial-feed
  cursors.
- **D4 (config, future round):** `max_batch_size: 10 → 2` for invocation-
  level fit; cadence staggering explicitly NOT a batch bound.
- Measurable acceptance criteria A1–A7 (per-invocation headroom under both
  interpretations, losslessness, fences untouched, idempotency, cloud
  observation); explicit non-goals (no item loss, no fence weakening, no
  fake knobs, no paid upgrade).

## 8. Remaining product work (summary — full list in `audit/REMAINING_PRODUCT_WORK.md`)

Unchanged except the TR-04 correction: application-level recovery
(expired-claim reclaim, stranded-queued re-kick, DLQ reconciliation send)
is IMPLEMENTED and locally measured (T-27/T-28) — the former "automatic
re-kick (future work)" register entry is replaced accordingly; remaining
owner-side items are real-Queue outage procedures, the full-DLQ-path cloud
evidence, and the Free-safe implementation round (after design acceptance).

## 9. Statuses kept distinct (audit-only round)

| Status                          | Value                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Local accepted commit           | `f70205648922d0f8e60619e45e5d54e6e87b8f1b` — verified byte-identical via bundle clone + `git archive` diff                                      |
| Remote publication              | Published BY THE MANAGER on `phase/04-corrections-round191`; CI run `39142636110` success (observed from handoff docs; GLM ran no CI/push/auth) |
| Local commits by GLM this round | **none**                                                                                                                                        |
| Deployment                      | **none** (dry-run builds only)                                                                                                                  |
| Real migration executed         | **none** (0004 only modeled on disposable workerd D1 in traces)                                                                                 |
| Cloudflare operations by GLM    | **0** (no account API/CLI calls; no fresh web fetch claimed — official citations use the manager's retrieved excerpts)                          |
| Activation                      | **none** (`SOURCE_INGESTION_ENABLED` false everywhere; shipped gate values untouched)                                                           |
| Delivery app edits              | **none**                                                                                                                                        |
| Paid upgrades / billing         | **none** — Free-plan-first constraint honored                                                                                                   |
| Subagents used                  | **none** (per prompt)                                                                                                                           |

## 10. Verdict

The accepted Round 1.9.1 baseline reproduces exactly (suite 1142/1142, DB
301/301, static gates green, scan 297/0, both dry-run builds green —
re-run THIS round). The manager's six findings (TR-01…TR-06) are corrected
consistently across tooling and documents
(`audit/CORRECTIONS_R1_10_2.md`), the corrected instrument independently
reproduces the manager's measurements exactly, the final artifact's
unfiltered trace command is green from a fresh extraction, and the
advertised ingestion profile is reported honestly as
**NOT_READY_FOR_INGESTION_ON_FREE** with a DESIGN-ONLY Free-safe path
submitted for review. No paid upgrade, no weakening of any fence, no cloud
operation. **STOP for Posidon review.**
