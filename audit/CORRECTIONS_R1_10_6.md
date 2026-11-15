# Round 1.10.6 (delivered as recovery round 1.10.6-R) — Workers-AI-first

# adapter foundation. Corrections/errata ledger for this round.

- **Round:** 1.10.6-R (re-implementation of the lost 1.10.6 candidate)
- **Date:** 2026-10-28
- **Base:** 220c6c5b22a1e772832eef75544b82b492eabb5a
  (review/r1.10.3-sql-design; PR #11; base branch
  phase/04-corrections-round191 @ f70205648922d0f8e60619e45e5d54e6e87b8f1b)

## E1 — Historical candidate loss (honesty record)

An earlier local candidate of round 1.10.6 existed as commit `87f4db1`
(parent `220c6c5`, built and locally verified in a previous session). It
was NEVER pushed, NEVER merged, and NEVER accepted; its bytes became
unavailable after a full sandbox environment reset. Consequences recorded
as standing facts:

- `87f4db1` is a HISTORICAL INACCESSIBLE CANDIDATE. It is NOT a basis for
  any test count, verification claim, or recovery claim in this round.
- The CAUSE of the sandbox reset is UNKNOWN. No definitive claim about
  platform behavior, host action, or process failure is made without
  independent evidence.
- This round is a RE-IMPLEMENTATION with a NEW commit SHA lineage. No
  byte of the lost candidate was available to this round; nothing here is
  presented as a recovery of it.

## E2 — Auth-path erratum (credential hygiene)

During this round's publication preparation, a GitHub device-flow poll
process died with the sandbox session (background processes do not
survive between tool calls in this environment). A later poll script
deleted its own short-lived device_code file on exit, which made one
still-valid authorization unclaimable. The owner then directed (explicit,
authorized) use of a fine-grained PAT supplied in chat for
ILIV007/pixel-lort work only. Hygiene facts:

- The token was used from a mode-600 file OUTSIDE the repository, never
  embedded in remote URLs, git config, commits, logs, ZIPs, or bundles.
- The token was transmitted in chat and is therefore treated as EXPOSED;
  the owner has been asked to REVOKE it after this round. No claim of
  complete removal from chat history is made.
- The official device-flow scripts under `/home/z/` (outside the repo)
  implement the owner's standing auth rules for future rounds.

## E3 — Product scope guard (nothing overclaimed)

Implemented in this round: versioned AI policy + prompt contract + Zod
output schema; fail-closed draft service with per-provider budget
authority on the existing `budgets` table; Workers AI binding adapter;
bounded Gemini HTTP adapter; Phase 6 config flags; preview AI-binding
declaration (config-as-code only). Explicitly NOT implemented / NOT
claimed: story engine, full editorial fact guard, channel publishing,
durable AI job types, any live inference, any Cloudflare account or
billing change, any Worker deployment. `AI_ENABLED` ships "false" in
every environment; the Gemini fallback additionally stays OFF behind the
unverified-eligibility gate.

## E4 — Test counts (fresh, this round only)

- Product suite: 96 files / 1206 tests, ALL PASSING (1150 prior + 56 new
  AI tests). Prior baselines are inherited UNCHANGED; the lost
  candidate's counts are NOT carried forward (E1).
- DB subset: `test:db` extended with `tests/integration/ai-budget.test.ts`
  (real disposable workerd D1).
- Full gate results for the delivered HEAD are recorded in the round
  delivery report (VERSION.json `evidence` block), not in this file.
