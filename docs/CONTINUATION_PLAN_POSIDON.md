# Pixel Lores — continuation plan and operational handoff

Status snapshot: baseline `5fdb6ff7faac9024c1a0593701b652ade2b6eabc`, branch `review/r1.10.3-sql-design`, PR #11. Always re-read the actual remote and CI: this is not a live monitor. This plan is not an assertion that engineering, shadow or live rollout has completed.

## Fixed product constraints

- Build a comprehensive Persian-language gaming-news service, not a user-selected handful of games. Research and curate legitimate sources; prioritize by relevance and budget. Final objective is AUTO, without requiring human review of every news item.
- Free-only: never enable billing or paid fallback. Workers AI is primary, Gemini is conditional fallback only with verified Free eligibility and budget. Unknown eligibility means defer, never charge or guess.
- GLM works offline and can fast-forward push to the existing review branch, preserving the Draft PR. Posidon independently reviews and handles Cloudflare/live work. No force push, merge, Draft change, new cron, real Telegram sends or live migration by GLM.
- Treat source material as untrusted; avoid exposing secrets, private user data, or token values to logs, files, commits, backups or model providers. Rotate previously exposed credentials. No Device Flow.

## Decisions and boundaries

- **OD-009:** choose measurement-first, no automatic deletion (option C). A future raw-only retention design may be built and tested locally under a separate default-OFF flag, only if dedup, FK, provenance and snapshot verification are protected. No live deletion or entire-row purge without explicit later operational authorization.
- **OD-010:** unknown rights deny publishing; provenance or officiality is not a license. Build a fail-closed evidence model with asset identity, permitted destination and purpose, expiry, attribution and revocation, and audit. Existing upload service has its own network send, so scheduler-only enforcement is insufficient. Staging permission is not publication permission. Do not invent licenses or enable a write grant surface for unverified evidence. Rights authorization is not a blanket manual approval for every news post.
- Verify current source/API terms and free quotas before enabling; keep Reddit, IGDB and any service with unverified access/terms off. Do not use the GitHub write PAT as the bot's read token.

## Sequential engineering slices

1. **Media safety:** inventory every send path including `uploadAlbumMediaGroup`, design durable evidence and authorization, implement default-OFF/fail-closed enforcement before all external sends. Test unknown, forged, expired, revoked, wrong destination, attribution and replay/race paths with fake networks and real local D1. No valid rights claim may be created from officiality alone.
2. **Album and correction:** implement the album draft producer using existing contracts, bind exact per-ordinal evidence, preserve uncertainty and prevent implicit resend. Wire correction rendering and whole-story orchestration into the existing engine. Test duplicate updates, partial evidence, concurrent workers, supersede, late response and crash boundaries.
3. **End-to-end editorial and fact safety:** demonstrate source → story/evidence → draft → review → scheduling in the actual local pipeline with fake providers and Telegram. Connect the existing producer where missing. Establish measurable fail-closed AUTO gates for unsupported claims, uncertainty, schema errors and prompt injection; do not equate references alone with semantic proof. Keep legitimate automated publishing possible.
4. **Admin experience:** complete needed Phase 9 screens and write-capable queue dispositions using existing RBAC, opaque scoped single-use action tokens, bounded sessions, fencing and audit. Ambiguous outcomes require explicit safe disposition, never blind auto-resend.
5. **Security and free-budget proof:** investigate zod and remaining advisories with compatibility and regression tests, not blind forced upgrades. Check webhook/replay, SSRF including redirects/DNS, injection and budget gates. Build a full-poll-equivalent harness on the real local path; separately measure D1 API calls, statements and rows, retries, Workers CPU when observable, and provider quotas. Keep `NOT_READY_FOR_INGESTION_ON_FREE` until evidence justifies changing it; do not extrapolate production costs from mock tests.
6. **Shadow and private-channel preparation:** complete offline instrumentation, runbooks, setup and stop conditions. A 7–14 day live shadow and real private-channel checks are Posidon-controlled later; a completed tool is not a completed run.
7. **Production rollout:** after independent review, green exact-SHA CI, complete wiring, evidence of free operation, 7–14 day shadow and private-channel verification, apply the documented staged safe_auto→AUTO plan with rollback and stop conditions. No exactly-once claim for external Telegram calls.

## Checkpoint discipline

- At each start, inspect current remote, PR, local HEAD, dirty worktree, existing processes and state before modifying. Preserve and investigate in-flight changes. Use a single writer and no scheduled cron.
- For each slice: read relevant ADRs and existing tests; add discriminating tests before fixes; run targeted tests and debug; review the diff and race/failure cases; run `npm run check` and `npm run test:db`, recording true exit codes and counts. Do not weaken assertions merely to make a suite green.
- Record durable `PROJECT_STATUS.md` entries: actual phase, state, base/head, tests, blockers, backup, next action. Continue independent offline slices when one live/evidence-dependent lane is blocked; stop only on genuine unsafe ambiguity, failed gates or missing permission for the specific action.
- Commit coherent checkpoints; check remote unchanged and push only fast-forward. Observe CI for the exact SHA and report pending/failure honestly. Do not generate endless status-only commits to record CI.
- Create a secret-free self-contained ZIP containing git archive, full git bundle, checksums and restoration instructions; extract it fresh, verify checksums, clone bundle, run `git fsck`, and compare HEAD/tree. Deliver externally: an ephemeral sandbox path alone is not a durable backup.
- Keep local tests, remote CI, GitHub push, deployed version, database migration and live activation as separate observations. Never infer one from another. After context loss resume from the latest verified remote/checkpoint, not this static SHA.
