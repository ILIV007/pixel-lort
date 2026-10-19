# R1.10.3 — Free-Safe SQL Design Proofs (UNREVIEWED DESIGN CANDIDATE)

> **Status: UNREVIEWED DESIGN CANDIDATE — awaiting independent review.**
> This branch is a PUBLICATION-ONLY handoff of the existing Round 1.10.3
> candidate (`PIXEL_v1.4.0_R1.10.3_Free-Safe-SQL-Design-Proofs_REVIEW.zip`).
> Nothing here is accepted, merged, deployed, or product-implemented.
> The 297 accepted product files are byte-identical to the accepted baseline
> commit `f70205648922d0f8e60619e45e5d54e6e87b8f1b`
> (branch `phase/04-corrections-round191`): this commit ADDS review-only
> files and modifies NO product file. `REVIEW_README.md` is publication
> metadata and is not part of the candidate itself.

## What this branch adds (51 files)

| Path | Contents |
|---|---|
| `audit/` | Corrected review/audit documents: CORRECTIONS_R1_10_1/2/3, PREVIEW_READINESS_REPORT + CHECKLIST, CAPABILITY_MATRIX, PREVIEW_SMOKE_TESTS, SCHEMA3_TO_4_TRANSITION_REVIEW, REMAINING_PRODUCT_WORK, Persian operator summary |
| `audit-tools/` | R1.10.3 local trace suite v3 — D1 instrument (`d1-instrument.ts`), 28 traces, 16 instrument controls (C-01…C-16), 6 corrected-query controls (Q-01…Q-06). NOT accepted source. |
| `design-lab/` | SQL feasibility DESIGN LAB — candidate parameter-bounded multi-row INSERT..SELECT builders (`candidate-sql.ts`), 11 parity/fence tests on real workerd D1, 14-scenario executable cost ledger, extractor, `cost-ledger.json`. NOT product code. |
| `manager-evidence/` | The manager's frozen counterexample probes + `reproduce.sh` (independent reproduction against the sealed R1.10.2 input) + `OBSERVATIONS.json` |
| `manager-review/` | The manager's independent review of R1.10.2 |
| `free-plan/` | FREE_PLAN_COMPATIBILITY / WORKSHEET / OFFICIAL_SOURCES / RESOURCE_LEDGER.json + FREE_SAFE_EXECUTION_DESIGN (DESIGN ONLY) |
| `closure/` | RESPONSE_LEDGER_R1_10_3.md (R112-01…04 + nits → evidence) |
| `logs/` | Sanitized execution logs bound to the reported numbers (manifest/verify, manager reproductions, trace run, frozen probes, design lab, ledger extraction, accepted-source diff) |
| `VERSION.json` | Review metadata (app version 1.4.0 / review revision R1.10.3 / status) |

Excluded on purpose (referenced by SHA-256 below instead): the full `source/`
copy (it IS the baseline tree of this branch), the sealed historical input
ZIP, the `accepted-history.bundle`, and the package-layout
`verify_package.py`.

## Measured results (LOCAL workerd + disposable D1 proxies only)

- Trace tooling (v3): **50/50 passed, exit 0** (28 traces + 16 instrument
  controls + 6 corrected-query controls) — `logs/30-trace-run-r1103.log`
- Design lab: **25/25 passed, exit 0** (11 parity/fence + 14 cost-ledger
  scenarios); regenerated 14-row ledger **byte-identical** to packaged
  `design-lab/cost-ledger.json` — `logs/32-design-lab-run.log`,
  `logs/33-ledger-extract.log`
- Frozen manager probes on the v3 tooling: **exit 1, 1 failed / 3 passed** —
  `logs/31-manager-probes-on-v3.log`
  - CE1 and CE3 turn GREEN under the v3 instrument (the R112-03 fixes);
    CONTROL stays green (3 API / 102 STMT).
  - **CE2 stays RED INTENTIONALLY** ("CE2 proposed ProbeA without source
    must preserve accepted source-scoped lookup"): it embeds the REJECTED
    source-less literal SQL as historical proof of the cross-source
    identity defect. Never edit the frozen probe to force 4/4 — the
    corrected candidate queries are proven separately (Q-02…Q-06).
- FIRST-profile worst case: 17 xAPI / 33 STMT lab-measured; 18/34 derived
  ceiling (queue-envelope residual) vs the ≤40/≤40 target —
  `free-plan/FREE_SAFE_EXECUTION_DESIGN.md` §4.
- All numbers are LOCAL proxy measurements: no cloud CPU/quota/billing
  evidence, no Cloudflare-side enforcement claim. Tool counts are NEVER
  added to the accepted suite's counts.

Publication-day re-verification on this exact tree: product suite
1142/1142 (91 files, exit 0); `tsc --noEmit` exit 0; secret scan
347 files / 0 findings; `check:versions` / secrets self-test /
telegram-setup all exit 0; `npm ci` exit 0.

## CI note (read-only quality gate only)

`.github/workflows/ci.yml` triggers on push for `main` / `phase/**` only
(this branch's push triggers nothing) and on `pull_request` with
`permissions: contents: read`; it runs `npm ci` + `npm run check` and has
no deploy/wrangler/Cloudflare steps. Expected PR CI result: **red at the
lint step** — 45 eslint errors (44× `no-console` in labeled test/CLI
output, 1× unused-var) and 28 prettier-format findings, ALL confined to
the added review-side files. The candidate is published byte-identical and
was deliberately NOT re-formatted; no workflow was modified.

## Reproduction (from a fresh clone of THIS branch)

```bash
npm ci --ignore-scripts

# 1) Trace tooling — expect 50/50, exit 0
npx vitest run --config audit-tools/vitest.config.trace.mjs --maxWorkers=1

# 2) Frozen manager probes — expect exit 1, 1 failed / 3 passed (CE2 intentionally red)
cp -a manager-evidence/manager-probes ./audit-tools/
cp manager-evidence/vitest.config.manager.mjs ./audit-tools/
npx vitest run --config audit-tools/vitest.config.manager.mjs --maxWorkers=1
rm -rf audit-tools/manager-probes audit-tools/vitest.config.manager.mjs

# 3) Design lab — expect 25/25, exit 0; ledger regeneration identical
npx vitest run --config design-lab/vitest.config.lab.mjs --maxWorkers=1 \
  > /tmp/raw-lab-run.log 2>&1
node design-lab/extract-ledger.mjs /tmp/raw-lab-run.log /tmp/cost-ledger.json
diff /tmp/cost-ledger.json design-lab/cost-ledger.json && echo "LEDGER IDENTICAL"
```

The `logs/` directory holds the bound execution logs for the reported
numbers. Suggested reading order for review: `audit/CORRECTIONS_R1_10_3.md`
→ `free-plan/FREE_SAFE_EXECUTION_DESIGN.md` → `design-lab/README.md` →
`audit-tools/README.md` → `closure/RESPONSE_LEDGER_R1_10_3.md`.

## Provenance of external artifacts (preserved locally, referenced by SHA-256 — not embedded)

| Artifact | SHA-256 |
|---|---|
| Candidate ZIP `PIXEL_v1.4.0_R1.10.3_Free-Safe-SQL-Design-Proofs_REVIEW.zip` (6,486,096 bytes) | `2f877fff2238791845700ce13bd45552df0dd882cbc5ffaafcaa6c344c6dd849` |
| Instructions ZIP `PIXEL_v1.4.0_R1.10.3_Free-Safe-SQL-Design-Proofs_INSTRUCTIONS.zip` (6,156,538 bytes) | `a579ab5a75625cec8240f4564542fb44c7df07ffc7694024ede106e60f6014c1` |
| Sealed reviewed input `R1.10.2_bd7d3462_ORIGINAL.zip` | `bd7d3462ab8c3eaf2e5b51e1ac5b69db399748a6d916a0f1ecbdd83caf22c80b` |
| `accepted-history.bundle` (accepted history through the baseline) | `9b15adef72f0f78c9b0e53c0514bd407720cd83df0dae644b56966194f101582` |

The candidate ZIP's own `source/` tree (297 files) was verified
byte-identical to this baseline (`git archive HEAD` vs the delivery
`source/`). The full delivery package stays outside this repository on
purpose.

## Explicit non-claims

No product change. No deployment. No real migration (0004 remains a
test-only candidate plan; production schema stays 3). No Cloudflare
operation. No activation. No paid upgrade. Design-lab code is NOT wired
into the product and is not authorized for product use.
