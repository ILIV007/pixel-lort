# CORRECTIONS — R1.10.5 (LOCAL owner-directed channel-identity update ONLY)

**Scope:** continuation of Draft PR #11 (`review/r1.10.3-sql-design`). The
owner renamed the public **CHANNEL** (not the bot, not the repo, not any
Cloudflare resource) per `owner-handoff/R1.10.5/NEXT_GLM_PROMPT_R1_10_5_PIXEL_LORES.md`

- `owner-handoff/R1.10.5/OWNER_CHANNEL_IDENTITY_FA.md` (owner-supplied
  bytes, preserved in this round's delivery ZIP; instruction prompt files are
  not tracked in-repo, matching the `posidon-review/` convention). The owner
  explicitly **deferred and superseded the R1.10.4.4 publication/toggle
  sequence**: it was **NOT started** — zero Cloudflare/account operations of
  any kind (including reads), zero remote writes, no push, no PR update. This
  round is **LOCAL branding-only**: ordinary commits on top of the unpushed
  candidate, then STOP for review.

## CR1105-01 — starting tree provenance (honest restoration after sandbox reset)

- The sandbox reset again reverted local git metadata; the working clone was
  gone. The candidate was restored **exactly** from the checksummed git
  bundle `r11043-candidate-b140b62.bundle` (complete history): HEAD
  **`b140b624204afbd4d94d5bf30f7c69d4389b36df`**, parent
  `fc679f1f051f6d223356515160068980727f768b`, tree
  `e633e6c62c227722705367897a5c637d8da01e51`, branch
  `review/r1.10.3-sql-design`, 369 tracked files, clean status.
- **All 369 tracked files at b140b62 verified byte-identical to the
  Posidon-supplied R1.10.4.2 verified-tree ZIP** (`PIXEL_v1.4.0_R1.10.4.2_Verified-Tree_R1.10.4.4_Publication-Prompt_FULL-BACKUP.zip`,
  external SHA-256 `a6f99632f0f3a9ed597b0a7323222fff8104a957555ca640fde7d6bcf7889785`,
  internal SHA256SUMS 392/392 OK): 369 matched / 0 mismatched / 0 extra.
  The 25 ZIP-only extras are packet files outside the commit tree
  (evidence + the deferred R1.10.4.4 prompt), enumerated in the delivery log.
- The original local commit `3759d9b…` (R1.10.4.2 round) remains **LOST**
  and was NOT recovered; b140b62 is the previously disclosed ordinary
  replacement commit (parent fc679f1), NOT a claim of recovering 3759d9b.

## CR1105-02 — owner channel identity applied (exact strings)

- Channel display name: `pixel lores` (owner's exact spelling, lowercase).
- Public channel username: `@pixellores`.
- Canonical public URL: `https://t.me/pixellores`.
- Applied to every ACTIVE/CURRENT surface (17 files, +52/−21; all 17 are in
  the 297-product baseline `f70205648922d0f8e60619e45e5d54e6e87b8f1b` — the
  owner-authorized branding-only exception of prompt §7):
  1. `docs/blueprint/v1/pixel_source_registry_v1.json` — brand block ONLY:
     `channelName`, `channelUsername`, `footerHtml` (BOTH anchor href AND
     label). **Only these 3 lines changed**; `schemaVersion`,
     `globalPolicies`, `sources`, and `brand.botPersona` ("Pixel") verified
     structurally IDENTICAL. This file is imported VERBATIM by application
     code (`src/domain/source/source-registry.ts`) — it is live-consumed
     runtime identity, not "just a historical document".
  2. `src/connectors/rss.ts` / `github-releases.ts` / `reddit-oauth.ts`
     (token + listing paths — 4 header literals): User-Agent contact URL
     `+https://t.me/pixellort` → `+https://t.me/pixellores`. Agent name
     `PixelEditorialAgent`, version `/1.4`, and all request behavior
     unchanged (identity-only change, as authorized).
  3. `src/shared/types/env.ts` (2 doc examples): `e.g. "@pixellort"` →
     `"@pixellores"`.
  4. `.env.example` / `.dev.vars.example`: intended non-secret value made
     explicit as `# TARGET_CHANNEL=@pixellores` — still commented, so config
     optionality and the ADR-0009 validation contract are preserved; the
     value is documented, not forced.
  5. `wrangler.jsonc` — top-level `vars` AND `env.preview.vars`: explicit
     non-secret `"TARGET_CHANNEL": "@pixellores"` with a comment naming the
     owner identity and its unconsumed status. No flags, bindings, DB IDs,
     resource names, secrets, or numeric chat IDs touched. This is a
     config-FILE change only: **no live Cloudflare variable was written**.
  6. `README.md`, `package.json` (description), `docs/ARCHITECTURE.md`
     (publisher diagram): channel name/username updated; the workers.dev
     address in README §deploy untouched (technical identity, see CR1105-04).
  7. Blueprint live-consumed refs (narrow brand-field changes only):
     `docs/blueprint/v1/PIXEL_IMPLEMENTATION_SPEC_v1.md` (Channel/Username
     header, publisher diagram, §4 `TARGET_CHANNEL=@pixellores` example),
     `PIXEL_PERSONA_PROMPTS_v1.md` §1 (channel behind the persona — the
     persona itself unchanged), blueprint `README.md` intro. The
     blueprint tree is prettier-ignored and otherwise preserved verbatim;
     the changes carry an inline "R1.10.5 owner amendment" marker.
  8. `tests/unit/phase2-config.test.ts`: negative pattern fixture
     `'pixellort'` → `'pixellores'` (identity/setup expectation only —
     both lack the leading `@`, so the asserted outcome `false` is
     identical; no ingestion/budget/security/fence assertion weakened).
  9. `docs/DECISIONS/adr-0009-target-channel-non-secret.md` +
     `docs/OPEN_DECISIONS.md` (OD-001): the verbatim historical Blueprint
     quotes are preserved BYTE-IDENTICAL (prompt §6 forbids falsifying
     verbatim historical assertions); each doc gained a clearly dated
     **Owner amendment (Round 1.10.5, 2026-10-27)** block stating the
     current intended value `TARGET_CHANNEL=@pixellores` and that the
     ADR-0009 non-secret classification is unchanged.

## CR1105-03 — positive branding tests added (new, passing)

`tests/unit/channel-identity.test.ts` — 8 tests, all passing (included in
the product-suite total below):

1. `@pixellores` satisfies the EXISTING `TARGET_CHANNEL_PATTERN` (no new
   validation rule introduced; ADR-0009 contract respected);
2. bare `pixellores` still rejected (leading `@` required);
3. embedded registry parses OK (`parseEmbeddedRegistry().ok === true`);
4. brand carries the exact owner name/username with bot persona `Pixel`
   unchanged (channel ≠ bot distinction asserted);
5. footer href AND label BOTH name the new channel and agree with each
   other; old identity absent from the footer;
6. RSS connector sends `PixelEditorialAgent/1.4 (+https://t.me/pixellores)`
   on every request (behavioral, scripted SafeFetch fake — no live network);
7. GitHub-releases connector: same assertion on every call;
8. Reddit connector: same assertion on BOTH the OAuth token call and the
   authenticated listing call.

## CR1105-04 — explicit allowlist (deliberately preserved, with reasons)

9 remaining old-identity lines (post-round scan, case-insensitive
`pixellort` = 9; `PIXEL LORT` display = 0):

| Occurrences | Surface                                                                                                                                                                                                                                                                                                           | Reason preserved                                                                                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7           | `pixel-preview.pixellort.workers.dev` in `README.md` (health endpoint), `audit/CAPABILITY_MATRIX.md`, `audit/PREVIEW_READINESS_CHECKLIST.md`, `handoff/PHASE_01B_HANDOFF.md`, `scripts/telegram-webhook-setup.mjs`, `scripts/telegram-webhook-setup.test.mjs`, `tests/unit/telegram-webhook-setup-worker.test.ts` | Technical identifiers: a workers.dev address containing the old ACCOUNT SUBDOMAIN is NOT the channel URL. Renaming to an unprovisioned `pixellores.workers.dev` is forbidden by prompt §5; resource/domain renaming is not authorized. |
| 2           | `docs/DECISIONS/adr-0009-target-channel-non-secret.md:10`, `docs/OPEN_DECISIONS.md:23`                                                                                                                                                                                                                            | Verbatim historical quotations of what Blueprint §4 listed at decision time (2026-10-02). Preserving them is required by prompt §6; each doc now carries the dated owner amendment (CR1105-02 item 9).                                 |

Also preserved unchanged (never old channel identity, or frozen evidence):
bot/persona name `Pixel`/`پیکسل` wherever it names the bot (no bot username,
BotFather identity, token, owner ID, or numeric `-100…` channel ID invented);
repo slug `ILIV007/pixel-lort`; Worker names `pixel`/`pixel-preview`; D1
`pixel-db-preview`, queues `pixel-jobs-production`/`pixel-dlq-production`,
bucket placeholders, health service key `pixel`; type names (`PixelEnv`),
module/file/import paths; migration IDs; historical handoff artifact names
(`pixel-lort-phaseXX…zip` in `handoff/`); frozen evidence bytes in
`logs/03…`, `manager-evidence/`, `audit/CORRECTIONS_R1_10_4*`, prior
acceptance reports (zero rewrites). A global `pixel` replacement was NOT
performed; no official Persian transliteration of the channel name was
invented (owner's `pixel lores` used verbatim).

## CR1105-05 — exact diff accounting (branding vs everything else)

- Modified tracked files: **17** (+52/−21) — every one enumerated in
  CR1105-02, every one inside the 297-product baseline. **Branding-related:
  17/17. Unrelated modifications: 0.**
- New tracked files: `tests/unit/channel-identity.test.ts`,
  `audit/CORRECTIONS_R1_10_5.md` (this ledger), bound evidence logs
  `logs/61…67` (force-added past the `*.log` ignore, matching the R1.10.4.2
  convention), plus round metadata `VERSION.json` / `REVIEW_README.md`
  (metadata files, outside the 297-product baseline, per prior rounds).
- **All 280 non-branding product blobs verified byte-identical to
  `f70205648922d0f8e60619e45e5d54e6e87b8f1b`** by blob-hash comparison
  (297 baseline − 17 branding exceptions = 280 checked, 0 mismatches).
  No false "297 unchanged" claim is made: the accepted corrections of
  R1.10.4.2 and the owner-authorized branding exception are both preserved.
- All prior accepted corrections retained: R01–R10/D01 fences, ownership/
  generation/source fences, deadlines, strongest Retry-After, per-hop
  charging/counts, rotation, strict config parsing, AUTO policy, Free-plan
  limits — untouched (those files are inside the 280 verified identical, or
  the b140b62 delta already accepted for review).

## CR1105-06 — ERRATUM A: R1.10.4.3 publication-safety report implications retracted (owner-required correction)

The R1.10.4.3 report left unsupported implications that are hereby
**retracted as erratum** (the R1.10.4.3 file bytes are NOT rewritten —
prompt §6; this ledger is the current correction of record):

1. A historical FAILED Workers Builds check does **NOT** prove a future
   attempt is "known harmless / guaranteed no deployment".
2. A main-branch SUCCESS check alone does **NOT** establish that a
   production deployment definitely happened.
3. A failure conclusion alone does not establish whether a build got as far
   as executing code or attempting deployment — the failure stage remains
   UNKNOWN.
4. "No deployment in all prior rounds" cannot be asserted from any round's
   absence of pushes; historical deployment outcomes stay UNKNOWN, and this
   round's actions (zero Cloudflare operations, zero remote writes) are
   reported separately from those historical UNKNOWNs.

## CR1105-07 — ERRATUM B: frozen manager probes under instrument v3 — accepted expected state is 1 FAILED / 3 PASSED (owner-required correction)

- The accepted expected state of the frozen manager probes under instrument
  **v3** is **1 FAILED / 3 PASSED, exit 1**, with CE2 intentionally
  historical red — **NOT 3 FAILED / 1 PASSED**. The historical 3F/1P belongs
  to a different, earlier baseline. "No tests found" is not evidence of the
  expected state.
- Fresh run THIS round, per the prescribed procedure: the byte-preserved
  `manager-evidence/manager-probes/design-counterexamples.test.ts.frozen`
  was materialized byte-identically at
  `audit-tools/manager-probes/design-counterexamples.test.ts` (its
  `../trace/d1-instrument` import then resolves against the existing
  `audit-tools/trace/d1-instrument.ts`); a REVIEW-SIDE temporary vitest
  config (copy of the trace config, include narrowed to ONLY that file,
  `maxWorkers: 1`) ran it standalone; the materialized test and the
  temporary config were then **deleted before the ordinary gates** (working
  tree verified clean of both).
- **Actual result: exit 1 — Tests 1 failed | 3 passed (4)** — exactly the
  accepted expected state (CE2 red). Log: `logs/61-frozen-manager-probe-r1105.log`.
  No assertion or product config was modified; the lost historical input
  ZIPs were NOT required for these four tests (only the existing D1 test
  environment and `audit-tools/trace/d1-instrument`).

## CR1105-08 — verification gates (exact counts, all fresh this round, node v24.21.0)

| Gate                                                 | Command / config                                                                                                                                                        | Result                                                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Full CI gate                                         | `npm run check` (lint + format:check + typecheck + product suite + telegram-setup selftest + secret-scanner selftest + secret scan + versions + wrangler dry-run build) | **exit 0 (GREEN)** — dry-run printed `env.TARGET_CHANNEL ("@pixellores")`                  |
| Product suite                                        | `vitest run` (inside check)                                                                                                                                             | **1150/1150 passed, 92 files** (= 1142 prior + 8 new branding tests; derived, not clamped) |
| DB subset                                            | `npm run test:db`                                                                                                                                                       | **301/301 passed, 22 files**                                                               |
| Trace v3                                             | `vitest run --config audit-tools/vitest.config.trace.mjs`                                                                                                               | **50/50 passed, 3 files**                                                                  |
| Design lab                                           | `vitest run --config design-lab/vitest.config.lab.mjs`                                                                                                                  | **30/30 passed, 2 files**                                                                  |
| Lab ledger parity                                    | `node design-lab/extract-ledger.mjs` + `cmp`                                                                                                                            | **16 rows, BYTE-IDENTICAL**                                                                |
| Probe-plan validator                                 | `node audit-tools/probe-plan/validate-probe-plan.mjs`                                                                                                                   | **PASS — 21 checks / 0 failures** (structural simulation labeling preserved)               |
| D1 terminal contract                                 | `vitest run --config audit-tools/d1-contract/vitest.config.d1.mjs`                                                                                                      | **4/4 passed**                                                                             |
| Frozen manager probes (v3, temporary standalone run) | see CR1105-07                                                                                                                                                           | **exit 1 = 1 failed / 3 passed (4)** — accepted expected state                             |
| Secret scan                                          | `npm run scan:secrets` inside check: **369 tracked files, 0 findings**; re-run after staging: see delivery log for the final staged count                               | 0 findings                                                                                 |

Test fixtures changed this round: ONE, identity-only (CR1105-02 item 8).
No ingestion/budget/security/fence assertion was weakened anywhere.
`check-versions` confirms appVersion 1.4.0 / schemaVersion 3 unchanged
(no schema/app-version bump for the rename; candidate 0004 stays
disposable-only).

## CR1105-09 — configuration-state honesty (distinct statuses)

- **Configured-in-code:** `TARGET_CHANNEL=@pixellores` as an explicit
  non-secret example/default in `.env.example`, `.dev.vars.example`
  (both commented → optional) and `wrangler.jsonc` vars (dev + preview);
  registry brand block updated (live-consumed at parse time).
- **Configured-in-cloud:** NOTHING — zero Cloudflare operations this round
  (no reads, no writes; no Cloudflare credentials exist in this sandbox).
  The previously deployed preview (if any) is untouched by this round.
- **Deployed:** NOTHING — no build, no deploy, no migration, no activation,
  no webhook registration, no Telegram API call, no billing change. The
  renamed channel was NOT verified through Telegram (no live messages sent).
- Full-poll-equivalent harness: still **UNPROVEN / NOT IMPLEMENTED**; the
  branding work does NOT fix Free readiness, publishing functionality, or
  deployment. Ingestion-on-Free remains **NOT_READY** (unchanged envelope:
  ≤40 API calls PASS / ≤40 statements FAIL on the registered shapes).

## CR1105-10 — STOP

Publication (ordinary fast-forward push of this commit to
`review/r1.10.3-sql-design` + Draft PR #11 update) and the deferred bounded
R1.10.4.4 toggle sequence resume ONLY after the owner/Posidon review of this
branding round. No cloud toggle, publication step, or design round is
self-authorized by this round.
