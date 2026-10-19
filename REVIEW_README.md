# R1.10.3.1 — Free-Safe SQL Design Corrections (UNREVIEWED DESIGN CANDIDATE)

> **Status: UNREVIEWED DESIGN CANDIDATE — corrections applied after the
> manager verdict CHANGES REQUIRED; awaiting independent review.**
> This branch extends the published R1.10.3 candidate
> (reviewed commit `c72db10c7c631dd62c7981391d628b9c09104235`, retained
> in history — no force push) with LOCAL design/tooling corrections ONLY
> (Round 1.10.3.1). The design is **NOT accepted** for product
> implementation; for the UNCHANGED supported RSS envelope the verdict is
> **NOT_READY against BOTH ≤40 targets** (exact blocker + durable
> continuation design: `free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §9).
> Nothing here is merged, deployed, or product-implemented.
> The 297 accepted product files are byte-identical to the accepted
> baseline commit `f70205648922d0f8e60619e45e5d54e6e87b8f1b`
> (branch `phase/04-corrections-round191`): this round ADDS/MODIFIES
> review-side files and modifies NO product file. `REVIEW_README.md` is
> publication metadata and is not part of the candidate itself.

## What changed in R1.10.3.1 (review-side only, on top of the 51 published files)

| Area                                                                                                                              | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `design-lab/candidate-sql.ts`                                                                                                     | **FIX 1** — per-chunk byte accounting: EVERY chunk built + validated independently against its ACTUAL SQL text + ACTUAL bind bytes (row binds + real P/B1 shared guard values) under BOTH the 100-bind row and the conservative 102,400-byte budget; per-chunk audits returned; explicit `OversizedRowPlanError` (`row_exceeds_statement_budget`) rejects a single oversized row at PLAN time (atomic, zero effects, no truncation/silent drop); per-statement re-audit before `prepare()`; atomicity, ownership predicate P, B1 binding, and both targeted conflict clauses byte-identical to R1.10.3 |
| `design-lab/fixtures.ts` (NEW)                                                                                                    | Deterministic percent-encoded 5000-char CJK-path fixtures — canonical URLs of EXACTLY 45,023 bytes, distinct per item (host chosen for the manager's counterexample arithmetic)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `design-lab/lab-suite.test.ts`                                                                                                    | L-08 reworked (EVERY chunk audited, not a prefix-derived largest); NEW **L-12** (manager's heterogeneous counterexample: 8 short + 92 CJK≈45 KB → 1×8 + 46×2 = 47 INSERTs, all chunks ≤ budget, feed < 2 MiB, all rows + full URLs land), **L-13** (oversized row → typed plan-time rejection, zero durable effects), **L-14** (the ACCEPTED normalizer produces canonical URLs of exactly 45,023 bytes — NO URL length cap — uniform CJK shape → exactly 50 chunks × 2 rows)                                                                                                                          |
| `design-lab/cost-ledger.test.ts`                                                                                                  | Ledger rows carry honest per-chunk plan summaries (`chunkRows` run-length, `maxStatementTotalBytes`); NEW **C-15** (owned, 100 × ≈45 KB CJK URLs: 15 xAPI / **66 STMT** — ≤40 STMT FAILS) and **C-16** (legacy: 14 xAPI / **65 STMT**) — the NOT_READY evidence                                                                                                                                                                                                                                                                                                                                        |
| `design-lab/cost-ledger.json`                                                                                                     | Regenerated: **16 rows** (byte-identical to a fresh extraction of the committed tree's run)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `design-lab/lab-log.ts`, `audit-tools/trace/trace-log.ts` (NEW)                                                                   | Single documented measurement-output channel per tree (workerd tests reach the host log ONLY via console; the ledger extractor PARSES those lines) — one visible eslint exception each, no blanket ignores                                                                                                                                                                                                                                                                                                                                                                                             |
| `audit-tools/trace/*.test.ts`                                                                                                     | Measurement output channeled through `traceLog`; prettier formatting — 50/50 unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `free-plan/FREE_SAFE_EXECUTION_DESIGN.md`                                                                                         | **FIX 2** — "18 xAPI / 34 STMT" RETRACTED as a universal bound → RELABELED a conditional measured scenario (fixture URL shapes at the ~2 KiB assumption); NOT_READY verdict for the unchanged envelope with the exact blocker; §9.3 platform-limit justification (documented SQL-TEXT row vs the internal combined policy; payload/CPU/quota risks); §9.4 durable continuation design (authorized preview-DB measurement gate, pre-committed policy rule, durable multi-window alternative); §9.1/§9.5 correction records                                                                              |
| `free-plan/FREE_PLAN_WORKSHEET.md`                                                                                                | §7 relabeled + C-15/C-16 rows added                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `audit/CORRECTIONS_R1_10_3_1.md` (NEW)                                                                                            | The corrections ledger (CR11031-01…04) with the full verification matrix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `closure/RESPONSE_LEDGER_R1_10_3_1.md` (NEW)                                                                                      | Verdict-item → evidence map for the CHANGES REQUIRED verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `manager-evidence/manager-probes/design-counterexamples.test.ts.frozen`                                                           | The frozen manager probe preserved BYTE-IDENTICAL as an opaque fixture (git rename; linters/formatters/tsc never see it); materialized TEMPORARILY for its standalone run by `manager-evidence/reproduce.sh` + the documented commands, removed after the run                                                                                                                                                                                                                                                                                                                                          |
| `manager-evidence/reproduce.sh`                                                                                                   | Materialize step for the opaque fixture (byte-frozen evidence otherwise untouched)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| All 28 prettier-flagged review files                                                                                              | Formatting only — an ordered word-stream comparison of every reformatted .md/.json against the reviewed HEAD is IDENTICAL (zero words added/removed/reordered)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `eslint.config.js`, all 297 product files, `.github/workflows/ci.yml`, `logs/`, `OBSERVATIONS.json`, `manager-evidence/README.md` | BYTE-IDENTICAL — untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Measured results (LOCAL workerd + disposable D1 proxies only — exact separate counts)

- Trace tooling (v3): **50/50 passed, exit 0** (28 traces + 16 instrument
  controls + 6 corrected-query controls)
- Design lab: **30/30 passed, exit 0** (14 parity/regression incl.
  L-12/L-13/L-14 + 16 cost-ledger scenarios); regenerated 16-row ledger
  byte-identical to `design-lab/cost-ledger.json`
- Product suite: **1142/1142** (91 files), exit 0; DB suite: **301/301**
  (22 files), exit 0
- Frozen manager probes (materialized `.frozen` fixture): **exit 1 =
  1 failed / 3 passed** — CE1/CE3/CONTROL green under the v3 instrument;
  **CE2 intentionally historical red** (never edited to green)
- Static gates: `eslint .` 0 errors; `prettier --check .` clean;
  `tsc --noEmit` clean; `check:versions` / secrets self-test /
  telegram-setup exit 0; `npm run build` dry-run 380.09 KiB
- **Full CI gate `npm run check`: exit 0 (GREEN)** — the PR's read-only
  CI now passes
- Secret scan: **353 tracked files / 0 findings**; an explicit
  credential-pattern grep (PAT/PKP/AWS shapes) over ALL tracked files
  hits ONLY the scanner's own self-test fixture
- FIRST-profile conditional measured scenario (URL shapes at the ~2 KiB
  assumption; RELABELED — NOT a universal bound): 17 xAPI / 33 STMT
  lab-measured + 1/1 envelope residual = 18 xAPI / 34 STMT
- **Unchanged-envelope re-measure (C-15/C-16): 50 INSERT statements
  ALONE → 15 xAPI / 66 STMT (owned), 14 xAPI / 65 STMT (legacy) → the
  ≤40 STMT target FAILS → NOT_READY** (correctness unchanged; every
  audited statement ≤ 102,400 bytes: C-15 max 91,728, C-16 max 90,989)
- All numbers are LOCAL proxy measurements: no cloud CPU/quota/billing
  evidence, no Cloudflare-side enforcement claim. Tool counts are NEVER
  added to the accepted suite's counts.

## CI note

`.github/workflows/ci.yml` is byte-identical (triggers on push for
`main` / `phase/**` only — this branch's push triggers nothing — and on
`pull_request` with `permissions: contents: read`; it runs `npm ci` +
`npm run check` and has no deploy/wrangler/Cloudflare steps). The
previous round's red lint step is FIXED: `npm run check` exits 0 on this
tree. No ignore lists, no disabled checks, no weakened assertions; the
frozen-evidence bytes and the expected 1F/3P outcome are preserved.

## Reproduction (from a fresh clone of THIS branch)

```bash
npm ci --ignore-scripts

# 1) Trace tooling — expect 50/50, exit 0
npx vitest run --config audit-tools/vitest.config.trace.mjs --maxWorkers=1

# 2) Frozen manager probes — expect exit 1, 1 failed / 3 passed (CE2 intentionally red)
cp -a manager-evidence/manager-probes ./audit-tools/
mv ./audit-tools/manager-probes/design-counterexamples.test.ts.frozen \
   ./audit-tools/manager-probes/design-counterexamples.test.ts
cp manager-evidence/vitest.config.manager.mjs ./audit-tools/
npx vitest run --config audit-tools/vitest.config.manager.mjs --maxWorkers=1
rm -rf audit-tools/manager-probes audit-tools/vitest.config.manager.mjs

# 3) Design lab — expect 30/30, exit 0; ledger regeneration identical
npx vitest run --config design-lab/vitest.config.lab.mjs --maxWorkers=1 \
  > /tmp/raw-lab-run.log 2>&1
node design-lab/extract-ledger.mjs /tmp/raw-lab-run.log /tmp/cost-ledger.json
diff /tmp/cost-ledger.json design-lab/cost-ledger.json && echo "LEDGER IDENTICAL"

# 4) Full CI gate (lint, format, typecheck, product tests, secret scan, build)
npm run check
```

Suggested reading order for review:
`audit/CORRECTIONS_R1_10_3_1.md` →
`free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §9 → `design-lab/README.md` →
`closure/RESPONSE_LEDGER_R1_10_3_1.md` →
`closure/RESPONSE_LEDGER_R1_10_3.md` (prior round).

## Provenance of external artifacts (preserved locally, referenced by SHA-256 — not embedded)

| Artifact                                                                                               | SHA-256                                                            |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Candidate ZIP `PIXEL_v1.4.0_R1.10.3_Free-Safe-SQL-Design-Proofs_REVIEW.zip` (6,486,096 bytes)          | `2f877fff2238791845700ce13bd45552df0dd882cbc5ffaafcaa6c344c6dd849` |
| Instructions ZIP `PIXEL_v1.4.0_R1.10.3_Free-Safe-SQL-Design-Proofs_INSTRUCTIONS.zip` (6,156,538 bytes) | `a579ab5a75625cec8240f4564542fb44c7df07ffc7694024ede106e60f6014c1` |
| Sealed reviewed input `R1.10.2_bd7d3462_ORIGINAL.zip`                                                  | `bd7d3462ab8c3eaf2e5b51e1ac5b69db399748a6d916a0f1ecbdd83caf22c80b` |
| `accepted-history.bundle` (accepted history through the baseline)                                      | `9b15adef72f0f78c9b0e53c0514bd407720cd83df0dae644b56966194f101582` |
| This round's lean backup `PIXEL_v1.4.0_R1.10.3_1_Design-Corrections_REVIEW.zip`                        | see the round's delivery message + `VERSION.json`                  |

The candidate ZIP's own `source/` tree (297 files) was verified
byte-identical to this baseline (`git archive HEAD` vs the delivery
`source/`), and this round re-verifies all 297 product paths against the
baseline commit. The full delivery package stays outside this repository
on purpose.

## Explicit non-claims

No product change. No deployment. No real migration (0004 remains a
test-only candidate plan; production schema stays 3). No Cloudflare
operation. No activation. No paid upgrade. Design-lab code is NOT wired
into the product and is not authorized for product use. The unchanged
RSS-envelope verdict is NOT_READY; the ≤40/≤40 result is a CONDITIONAL
measured scenario, never a universal bound. **STOP for Posidon review.**
