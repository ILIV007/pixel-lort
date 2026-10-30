# Version history (frozen records — NOT active release metadata)

This file preserves the HISTORICAL version/record narratives that used to
live inline in `VERSION.json`. It exists so that `VERSION.json` can stay a
lean ACTIVE release-metadata document (checked by `scripts/check-versions.mjs`
against the active configuration), while nothing historical is deleted or
rewritten. Entries below are FROZEN evidence: they are never edited, never
"brought current", and never re-interpreted. The active metadata lives ONLY
in `VERSION.json` + `package.json` (validated for consistency by
`check:versions`).

---

## Record 2026-10 (R1.10.6.1 / delivery B01 — verbatim from the pre-1.7.0 VERSION.json)

```json
{
  "project": "PIXEL",
  "appVersion": "1.5.0",
  "versionStatus": "REVIEW_CANDIDATE_NOT_ACTIVATED — 1.5.0 is the next product candidate version (owner ruling: the AI adapter foundation is a new compatible capability relative to 1.4.0; minor bump). NOT ACTIVATED anywhere; the cloud-active version is NOT assumed changed without observation; no deploy and no live-variable change performed",
  "reviewRevision": "R1.10.6.1",
  "deliveryId": "B01",
  "artifactFilename": "Pixel-Lores_v1.5.0_R1.10.6.1_B01_AI-Deadline-Fixes_REVIEW_FULL-BACKUP.zip",
  "purpose": "VERSION CORRECTION + H1-E1 ERRATUM delivery (continuation of round 1.10.6.1; not a new architecture round). (1) Application version aligned 1.4.0 -> 1.5.0 across ALL active references per scripts/check-versions.mjs: package.json; package-lock.json ROOT metadata ONLY (the expect-type@1.4.0 / natural-compare@1.4.0 entries are third-party dependency versions, untouched; NO lockfile regeneration — two root fields edited in place, npm ci re-run green); wrangler.jsonc APP_VERSION (root + preview); src/shared/config/phase0.ts DEFAULT_APP_VERSION; .env.example; .dev.vars.example; tests/helpers/test-env.ts; plus the three active test assertions pinning the version (tests/unit/config.test.ts x2, tests/integration/version.test.ts x1). SCHEMA VERSION STAYS 3 — no migration. Historical reports and frozen evidence untouched. (2) H1-E1 erratum (audit/CORRECTIONS_R1_10_6_1.md): the H1 delivery report's '399/399 checksums' phrasing corrected — the H1 package has 399 REGULAR files (396 tracked + bundle + META + manifest); the manifest has 398 entries (does not cover itself); all 398 were independently verified by Posidon. The H1 package (SHA-256 e4cafd440f4f9dc722461d03f15838e7645899b05e2fd9aeb7c88510ec8a1b74) is NOT rebuilt, renamed, or replaced. The stale pre-H1 artifactFilename is fixed here. (3) Environment event recorded with observed facts only: the working clone was found EMPTY after a sandbox snapshot restore; the repo was rebuilt byte-exactly from the owner-verified H1 package (fresh extraction, manifest 398/398, inner bundle clone --branch review/r1.10.3-sql-design => HEAD 2f923fe5 + tree 9eb8fa2b, fsck clean, ALL 396 tracked files byte-identical); no committed work was lost. Standing versioning policy: compatible capability = minor; post-release product fix = patch; breaking = major with an architecture decision; repackaging or report-only fixes = delivery-ID increment (B01, B02, ...) not necessarily a software version; round numbers never replace software versions. This B01 package CONTAINS the H1 deadline-wait fix (expired-deadline path also attaches work settlement handlers; permanent tests X1-X3, red-first on the pre-fix tree) which is under Posidon review.",
  "status": "REVIEW_CANDIDATE_NOT_ACTIVATED; RUNTIME_AI_OFF_EVERYWHERE; NO_LIVE_INFERENCE; NO_CLOUDFLARE_OPERATION_BY_GLM; NO_BILLING_CHANGE; SCHEMA_VERSION_3_UNTOUCHED_NO_MIGRATION; FREE_INGESTION_AND_FULL_POLL_GATES_STILL_OPEN; STORY_ENGINE_NOT_CLAIMED; FACT_GUARD_FUTURE; DURABLE_CALLER_FUTURE; GEMINI_ELIGIBILITY_UNVERIFIED_AND_OFF; PUBLICATION_BLOCKER_NO_STORED_CREDENTIALS; STOP_FOR_POSIDON_REVIEW",
  "sourceCommit": "2f923fe5dedfd751f53e7b045ce8be3fc2ff7e2e",
  "sourceTree": "9eb8fa2b5d87712eecffd06c4a8faeec1000e179",
  "sourceBranch": "review/r1.10.3-sql-design",
  "sourceFiles": 396,
  "schemaVersion": 3,
  "deliveryHead": "the version-alignment commit on top of sourceCommit; a commit cannot contain its own hash — the full delivery HEAD and tree SHAs, the artifact SHA-256, and the fresh gate counts are recorded in recovery/META_R1_10_6_1_B01.txt inside the package and in the delivery report",
  "reviewParentCommit": "2f923fe5dedfd751f53e7b045ce8be3fc2ff7e2e",
  "reviewBranch": "review/r1.10.3-sql-design",
  "reviewPullRequest": "https://github.com/ILIV007/pixel-lort/pull/11",
  "publication": {
    "pushed": false,
    "blocker": "no stored GitHub credential in the sandbox (gh CLI absent, no env tokens, no credential helper); a device-flow code is issued ONLY when the owner signals real readiness; the old exposed token is NOT searched and NOT reused",
    "known": "remote tip verified 7ab64cd this delivery (anonymous fetch); 5 local commits pending ordinary fast-forward push (c4394b3, f15d295, 8ca2b9f, 2f923fe + this version commit); PR #11 open/draft, base f7020564",
    "unknown": "post-push CI/Cloudflare check-run outcomes (observed separately after the push and reported separately)"
  },
  "evidence": {
    "cloudflareAccountOperations": 0,
    "githubRemoteWritesBeforePush": 0,
    "recovery": "repo rebuilt from the owner-verified H1 package (SHA-256 e4cafd440f4f9dc722461d03f15838e7645899b05e2fd9aeb7c88510ec8a1b74): fresh extraction 399 regular files, manifest 398/398 verified; bundle clone --branch review/r1.10.3-sql-design => HEAD 2f923fe5 + tree 9eb8fa2b, fsck clean; ALL 396 tracked files byte-identical to the extraction",
    "versionConsistency": "node scripts/check-versions.mjs: application version 1.5.0 and schema version 3 consistent across all active configuration files; npm ci re-run after the in-place lockfile root edit: exit 0",
    "productSuite": "npm run check re-run on this delivery's tree: exit 0 — 97 files / 1222 tests ALL PASSING. Accounting: 1222 = 1206 (1.10.6-R) + 13 (R1.10.6.1 deadline tests) + 3 (H1 X-tests); THIS delivery (B01) adds 0 new tests — the count is re-MEASURED fresh on the 1.5.0 tree, not inherited (the version-alignment assertions in config.test.ts x2 + version.test.ts are updated in place, no count change)",
    "dbSubset": "npm run test:db re-run: 23 files / 310 tests, exit 0 (unchanged; the 9-test ai-budget subset is counted HERE only, never re-added to the product delta)",
    "separateSuites": "all re-measured fresh this delivery: trace v3 50/50 (3 files); design lab 30/30 (2 files) with cost-ledger BYTE-IDENTICAL (16 rows); probe-plan validator 21 checks / 0 failures; D1 terminal contract 4/4; frozen manager probes exit 1 = 1 failed / 3 passed (CE2 intentionally historical red, frozen evidence untouched)",
    "secretScan": "node scripts/scan-secrets.mjs on the staged set and on the final B01 package: 0 findings",
    "providerPolicy": "free-only, fail-closed; no paid plan/subscription/paid-model/quota-evasion path exists in code; Workers AI free Neurons are SHARED across its models and app attempt caps are NOT Neuron/token/billing meters (documented); Gemini Free-tier eligibility NOT verified — route stays OFF",
    "cloudUnchangedByGLM": "no dashboard/deploy/secret/binding/migration action taken by the coding agent; wrangler.jsonc touched ONLY in the two APP_VERSION var values (root + preview) — no flags/bindings/IDs/resource names"
  },
  "authorization": "LOCAL version alignment + H1-E1 erratum + SAME-branch ordinary publication per the owner's B01 instruction; frozen blueprint evidence untouched; applied migrations untouched (0001-0003, schema 3); no new numeric IDs or credentials in the repo; ZERO Cloudflare/account operations; ZERO live model invocations; ZERO Telegram sends",
  "cloudflareOperations": 0,
  "paidUpgrade": false,
  "deployment": false,
  "activation": false
}
```

### Separation note (R1.12)

At R1.12 this narrative was moved here verbatim. Reasons, per the round
instruction: (a) `VERSION.json` had drifted into an ACTIVE-vs-historical
contradiction (it still declared `appVersion: 1.5.0` while every active
reference was at 1.6.1); (b) active release metadata must be machine-checked
against the active configuration, which a historical narrative defeats;
(c) the recorded `artifactFilename` names a ZIP that was built by POSIDON's
process, not by the coding agent — active metadata must never fabricate an
artifact filename for a ZIP that was not built in the current round, so the
active field is `null` unless a package was actually produced.
