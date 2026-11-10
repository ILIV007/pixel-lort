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

## Record 2026-11 (V4 Phase 5.2 / Phase 5C-4 delivery — verbatim from the pre-1.19.0 VERSION.json)

```json
{
  "project": "PIXEL",
  "appVersion": "1.18.0",
  "schemaVersion": 6,
  "versionStatus": "REVIEW_CANDIDATE_NOT_ACTIVATED — 1.18.0 is the V4 Phase 5.2 local engineering round built on the 512386b snapshot (schema 6 unchanged, no migration): Phase 5C-4 adds the DETERMINISTIC candidate-MATCHING report to the existing editorial path — per-candidate score = canonical one-to-one encoding of the observed signal set (weights 1/4/8, subset-sum injective; equal scores imply identical observed sets; never a confidence/probability/threshold), report-level outcome separating identical_content_relation_observed (a LOCATOR for the verified 5C-3 reuse path only) from similar_signals_only_observed (never same-news evidence), and resolution labels honest about ambiguity (tie at the top score) and incomplete coverage (probe overflow or report truncation = unresolvable — no best-candidate claim). The report rides inside drafts.document_json of the SAME fenced commit with ZERO new SQL statements, ZERO provider calls, ZERO cost; the flag OFF (shipped everywhere) keeps the accepted path byte-identical. All editorial/AI/ingestion/live gates stay OFF; Free readiness unchanged NOT_READY.",
  "reviewRevision": "V4 Phase 5.2 / Phase 5C-4 (the deterministic candidate-MATCHING report: a transparent set-encoded score per candidate, the report-level identical-content-vs-similar-signals outcome, and the honest ambiguity/overflow resolution — a PURE zero-SQL/zero-cost derivation of the discovery + assessment already carried by the same draft, stored INSIDE document_json of the SAME fenced atomic commit behind the independent default-OFF gate EDITORIAL_MATCHING_ENABLED; typed reader cross-validated against BOTH siblings; unrelatednessConcluded fixed false; never a merge, never a threshold, never a publication effect; schema 6 untouched)",
  "sourceCommit": "512386be7916561e4faa18fa648ca0c16d6b585a",
  "sourceTree": "cde2c84102d0c9ea60b2385ae8882f31d2a27fe0",
  "sourceBranch": "review/r1.10.3-sql-design",
  "reviewPullRequest": "https://github.com/ILIV007/pixel-lort/pull/11",
  "artifactFilename": null,
  "deliveryHead": "NOT RECORDABLE IN-REPO — a commit cannot contain its own hash; the delivery HEAD/tree SHAs are reported in the round delivery message and preserved by Posidon's independent review/backup, and sourceCommit/sourceTree stay the SEPARATE baseline identity this round was built on",
  "purpose": "R1.19.1 — close the three ORIGINAL Posidon R1.19 counterexamples with the smallest safe corrections, exactly as tasked: (M1) src/adapters/telegram/update-parser.ts now applies a bounded shallow wire→canonical projection of the documented minimal text_mention User fields (id/is_bot/first_name plus allowed optional last_name/username/language_code) on the REAL incoming parser path — consistent with the existing storage reader/wire writer; unrelated optional Telegram flags (e.g. is_premium) are DROPPED by the documented ignore policy and never reject an ordinary real User payload; a non-object user is forwarded unchanged so the envelope fails it typed; wrong-typed/oversized required fields keep failing EXPLICITLY at the envelope boundary; no arbitrary nested raw User data is retained. (N1) src/domain/telegram/rich-text-envelope.ts canContain now implements the official be-part-of direction for the five formatting styles (styles may be part of any entity except pre/code); the containing direction, crossing rejection, code/pre isolation, quote non-nesting, same-type duplicate rejection and non-container atomic leaves are unchanged; one pre-existing test assertion that encoded the incorrect matrix (a bold inside a mention rejected) was corrected coherently, and the module/ADR matrix text no longer claims other entity types can never contain a style. (P1) parseMessageLike preserves a non-empty in-cap caption whose caption_entities is OMITTED as richCaption {ok:true,kind:'caption',text:<exact>,entities:[]}; explicit null/primitive caption_entities is NOT treated as absence (entities_malformed); empty-string caption stays no-caption; captions never become commands; whitespace/Markdown-literal captions are preserved byte-exactly. The ORIGINAL proof file is kept permanently byte-identical at tests/unit/posidon-r119-original-proof.test.ts.",
  "status": "REVIEW_CANDIDATE_NOT_ACTIVATED; RUNTIME_AI_OFF_EVERYWHERE; NO_LIVE_INFERENCE; NO_CLOUDFLARE_OPERATION_BY_GLM; NO_BILLING_CHANGE; SCHEMA_VERSION_6_UNTOUCHED_NO_MIGRATION; CORRECTION_ROUND_ONLY_NO_NEW_CAPABILITY; NO_NEW_COMMAND_NO_NEW_FLAG_NO_CHANNEL_WIRING; NO_INBOX_NO_CAPTURE_ROUTE_NO_APPROVAL_NO_OUTBOX; NO_LIVE_SEND_NO_LIVE_PREVIEW_NO_LIVE_EDIT; RAW_MARKDOWN_HTML_PARSING_DEFERRED; ADMIN_REVIEW_FLAG_SHIPS_FALSE_EVERYWHERE; R1191_ORIGINAL_M1_N1_P1_CLOSED_F1_RETAINED_GREEN; R1181_ORIGINAL_S1_V1_C1_CLOSED_AND_PRESERVED; R1172_ORIGINAL_A2_D2_CLOSED_AND_PRESERVED; OBSERVER_FIRST_AND_PENDING_READ_FIXES_PRESERVED; NO_ZIP_BUILT_BY_GLM_THIS_ROUND_ARTIFACT_FILENAME_NULL; STOP_AFTER_DELIVERY_AND_CI_OBSERVATION; V4_PHASE_5_2_LOCAL_SLICE_ONLY; NO_CLOUDFLARE_OPERATION; NO_LIVE_INFERENCE; NO_FLAG_ENABLED_ANYWHERE",
  "publication": {
    "pre-publicationSnapshot": true,
    "pushed": false,
    "previousRoundsFact": "R1.12 (1.7.0), R1.12.1 (1.7.1), R1.13 (1.8.0), R1.13.1 (1.8.1), R1.14 (1.9.0), R1.15 (1.10.0), R1.15.1 (1.10.1), R1.15.2 (1.10.2), R1.16 (1.11.0), R1.16.1 (1.11.1), R1.17 (1.12.0), R1.17.1 (1.12.1), R1.17.2 (1.12.2), the R1.17.2 corrected delivery (1.12.3), R1.18 (1.13.0), R1.18.1 (1.13.1) and R1.19 (1.14.0) WERE published on this branch; Draft PR #11 kept as draft every round; Cloudflare workers-and-pages suites historically stayed QUEUED with NO check-run materialized — recorded as UNKNOWN when no witness exists",
    "thisRound": "THIS VERSION.json is the explicit PRE-PUBLICATION snapshot of the R1.19.1 delivery commit: at commit time the three corrections are local-only on top of d175b539541f9414b666d447d39d92f39852c5ea, pending an ordinary fast-forward push on the SAME branch with PR #11 kept as Draft; post-push CI outcomes are unknown at commit time and are reported separately after observation; artifactFilename stays null and deliveryHead stays NOT RECORDABLE IN-REPO (a commit cannot contain its own hash).",
    "known": "baseline verified at round start (Start Guard): local HEAD d175b539541f9414b666d447d39d92f39852c5ea = tree b660c71508b8d74220100f34c4c25a5101fa4ac2 = remote tip = PR #11 head (open + Draft), ancestry 7af421c -> d175b53 linear; publish access verified via the owner-provided credential read-only API check (login ILIV007, repo push permission true; the credential was supplied by the owner in chat with an explicit full-access instruction, stored 0600 OUTSIDE the repo, never echoed/logged/committed, and must be rotated/revoked by the owner after the round; a single device-flow attempt BEFORE the credential was supplied expired unapproved and is reported, not repeated). The EXACT attached ORIGINAL proof ran FIRST on the untouched baseline and failed 3/4 exactly as Posidon observed (M1 user_invalid entityIndex 0; N1 nesting_violation; P1 richCaption null AND legacy text null) with F1 already green ({domainAccepted:false,fetchCalls:0}) — the log is preserved outside the repo; after the minimal fixes the SAME unchanged file passes 4/4.",
    "unknown": "post-push CI/Cloudflare check-run outcomes for the R1.19.1 delivery HEAD (to be observed separately after the push and reported separately)"
  },
  "evidence": {
    "cloudflareAccountOperations": 0,
    "githubRemoteWritesBeforePush": 0,
    "versionConsistency": "node scripts/check-versions.mjs: application version 1.14.1 and schema version 3 consistent across all active configuration files; VERSION.json itself validated (active metadata)",
    "sqlFootprint": "ZERO DDL/migration (schema stays 3); ZERO new SQL statements — the corrections touch the update parser and the pure domain envelope only; no DB suite was added, so the test:db subset is unchanged",
    "testFootprint": "PERMANENT ORIGINAL proof kept byte-identical: tests/unit/posidon-r119-original-proof.test.ts (RED 3 failed/1 passed on untouched d175b53 -> GREEN 4 passed/exit0 after the fixes, inputs and assertions unchanged throughout). Companion acceptance coverage (new tests, NOT fabricated baseline failures): tests/unit/update-parser-rich-text.test.ts (wire User projection incl. dropped real-User extras and the caption path; malformed/wrong-typed/oversized users fail user_invalid at the envelope; plain-caption preservation incl. explicit [] vs null/primitive malformed, whitespace/Markdown-literal exactness, empty-caption policy, edited_message parity), tests/unit/rich-text-envelope.test.ts (corrected-matrix companions: five styles inside a longer link, style outside a link, equal-range style/link, legal multi-level chains per the official rules, Persian/emoji UTF-16 link case, still-rejected non-style inner/code-pre/quote-in-quote/crossing/duplicates) — the one pre-existing assertion encoding the INCORRECT matrix (bold inside a mention) was corrected coherently, tests/unit/bot-api-client-rich-text.test.ts (end-to-end raw update -> parser -> envelope -> serialize -> read -> real client factory with captured fake fetch: wire User in the EXACT Bot API snake_case shape with no parse_mode and no camelCase/raw leakage; plain caption -> real editMessageCaption with exact caption and EMPTY caption_entities and no parse_mode). All previous suites keep their contracts unchanged and stay green.",
    "secretScan": "node scripts/scan-secrets.mjs run before the commit: fresh count for THIS round (reported in the delivery message); no credential entered any file, log, fixture, or URL; the owner-provided GitHub credential lives ONLY in a 0600 file OUTSIDE the repository and never in the repo; demo/client fixtures use clearly fictional tokens and displayable data",
    "providerPolicy": "free-only, fail-closed; unchanged caps/allowlist/eligibility — the corrections perform ZERO provider calls by construction (pure parser projection + domain validation; all test fetches are captured fakes; zero AI, zero charges, zero DB writes)",
    "costPaths": "LOCAL PROXY only: zero real network calls, zero AI/charge, zero DB writes — the round changes validation/projection logic and tests only (the transport companions use a captured fake fetch). LOCAL PROXY metrics only — never Cloudflare billing counters."
  },
  "thisRound": "THIS VERSION.json is the explicit pre-publication snapshot of the V4 Phase 5.2 (Phase 5C-4) delivery commit: at commit time the matching report slice is local-only on top of the remote tip 512386be7916561e4faa18fa648ca0c16d6b585a (PR #11 open draft), pending an ordinary fast-forward push on the SAME branch with PR #11 kept as Draft; post-push CI outcomes are unknown at commit time and are reported separately after observation; artifactFilename stays null and deliveryHead stays NOT RECORDABLE IN-REPO (a commit cannot contain its own hash)."
}
```
