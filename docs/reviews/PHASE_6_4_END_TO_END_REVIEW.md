# Phase 6.4 self-review — the end-to-end path review and the surfaced fact-guard report

Round: 1.21.0 / schema 6 · ADR-0054 · baseline d72e5c6 (the post-6.3 tip) · 2026-11-11 (Asia/Tehran)

Scope honored: the roadmap's «۶.۴ مسیر سرتاسری» — source snapshot → Persian
draft → post with a FAKE provider; timeout, quota, late response and invalid
versions re-verified; the fact-guard report surfaced in the review view where
useful. Live-model paths remain Posidon-only (BLOCKED_LIVE).

## 1. The bullet → test matrix

| Roadmap bullet                               | Test (tests/integration/editorial-64-end-to-end.test.ts)                                   | Durable assertion                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| provider fake over the REAL chain            | all 10 tests                                                                               | the ONLY stub is `AiProviderPort` (ADR-0042 §6 seam); engine, handler, budget store, commit, ingress, review view and conversion are the shipped code over real workerd D1                                                                                                                                                                                                 |
| timeout (provider honors its own contract)   | «provider deadline_exceeded → typed recoverable retry…»                                    | job `retry_wait` attempts=1, ai_run failed/`deadline_exceeded`/null tokens, 0 drafts                                                                                                                                                                                                                                                                                       |
| timeout (wall deadline vs an in-flight call) | «wall deadline fires while a call is in flight…»                                           | deadline fired via the manual scheduler; the LATE resolution absorbed (0 drafts before the retry); the retry commits the ONLY draft and its traced content (`تیتر سرتاسری دوم`) proves the late value never landed; ai_runs = [failed deadline, succeeded 300/90]; budget 2 (conservative, no refund)                                                                      |
| quota                                        | «budget-first quota denial…»                                                               | bucket pre-exhausted (40/40) → 0 port calls, budget 40 unchanged, ai_run failed/`budget_denied`, `retry_wait`, 0 drafts                                                                                                                                                                                                                                                    |
| late response                                | covered inside the wall-deadline test (the late release happens AFTER the outcome decided) | no resurrection: drafts stay 0, job stays `retry_wait` until the legitimate retry                                                                                                                                                                                                                                                                                          |
| invalid versions (provider output)           | «invalid provider output (unknown evidence reference)…»                                    | cross-check rejects the unknown id → per-model ladder retry (2 calls) → `provider_unavailable` retry, budget 2, 0 drafts, no usage invented                                                                                                                                                                                                                                |
| invalid versions (untraced claims)           | «schema-valid draft with NO traced claim…»                                                 | R1.11.1 acceptance guard: TERMINAL dead_letter `editorial_no_traced_claim`, ai_run status `invalid`, 0 drafts                                                                                                                                                                                                                                                              |
| exhaustion                                   | «retry exhaustion…»                                                                        | 3 attempts → dead_letter `job_exhausted`, 3 honest failed runs, budget 3                                                                                                                                                                                                                                                                                                   |
| terminal refusal                             | «terminal provider safety refusal…»                                                        | dead_letter `editorial_ai_refusal` path (`editorial_ai_refused`), ai_run failed/`provider_safety_refusal`, budget 1                                                                                                                                                                                                                                                        |
| surfaced fact-guard (flag ON)                | «flag ON: the report rides the SAME commit…»                                               | stored `fact_guard_v1` on the SAME commit; `modelClaims[0].status === 'unverified'`; the REAL view renders `Fact guard (v1 lexical observations)`, `evaluated`, the requiring-review/unwitnessed counts, and both mandatory notes; `/post_from_draft` conversion succeeds with provenance `editorial_draft_id`/`editorial_draft_version` and «unverified status preserved» |
| flag OFF honesty                             | «flag OFF (default): … byte-identical …»                                                   | NO `factGuard` key in the stored document; the view shows the honest absent line; the UNVERIFIED note is independent of the flag                                                                                                                                                                                                                                           |
| stored lie                                   | «a stored LIE (corrupted fact-guard counts)…»                                              | the strict reader rejects the stored counts; the view renders the malformed state; the core document still renders; nothing crashes                                                                                                                                                                                                                                        |

RED → GREEN record: the 7 failure-path tests were GREEN on first run
against the untouched tree (that IS the re-verification result — recorded as
such, not staged). The 3 view tests were RED (the rendered view had no
fact-guard section) until the additive view/renderer/labels change; final
10/10 GREEN. Two harness-level corrections were made while reaching the
honest assertions (see §3).

## 2. What the re-verification actually proved (and what it cannot)

Proved end-to-end, over real D1, with the shipped code:

- The failure taxonomy of the draft service holds INSIDE the real engine
  loop — the engine's bounded retry/exhaustion and the handler's
  permanent/retry mapping compose exactly as pinned at the unit level.
- A late provider response can NEVER resurrect a decided outcome: the
  primitive absorbs the settlement and the durable state shows no draft
  between the deadline and the legitimate retry.
- The budget authority is genuinely FIRST: an exhausted bucket means
  zero port involvement, and charges for real calls stay recorded with
  no refunds and no invented usage.
- The stored fact-guard report is visible to the reviewing admin through
  the same bounded budget-first view discipline as the other reports,
  and its presence changes nothing downstream (the conversion is
  unaffected; flags never imply each other).

Cannot be proved locally (recorded honestly):

- Any REAL provider behavior (the artificial port is the only stub);
  live inference stays BLOCKED_LIVE (Posidon only).
- Real Telegram delivery, real Cloudflare state, real cost counters —
  untouched by construction.
- The 15 s wall deadline is exercised via the injectable scheduler, not
  real 15-second waits (the documented deterministic seam).
- Free readiness stays NOT_READY — nothing in this round changes it.

## 3. Honest in-round findings and their resolutions

1. **The ladder retries invalid output per allowlist model.** The first
   assertion expected ONE port call for an unknown-evidence-reference
   output; reality is TWO (the 2-model workers-ai ladder — invalid output
   is a per-model `invalid_output`, not a provider-skipping refusal).
   The test was corrected to the code's actual, intended behavior; the
   budget assertion (2 charges) follows.
2. **The acceptance guard's reason code is more specific than guessed.**
   The untraced-claims terminal reason is `editorial_no_traced_claim`
   (R1.11.1's distinct typed code), not the generic
   `editorial_input_invalid`. Test corrected to reality.
3. **The absent-state line is now expected on legacy documents.** The
   view renders the fact-guard absent line exactly like the other five
   reports' absent lines; the affected existing suites
   (admin-review detail/documents/language/originals/hostile,
   editorial-review-demo, fact-guard-persistence,
   admin-post-editorial-bridge) were re-run green — no test depended on
   the line's absence.

## 4. Limitations (deliberate, recorded)

- Fake provider only; the live model path is Posidon's exclusive lane.
- The conversion leg of the E2E is exercised to the durable provenance
  write + the honest reply; live publishing stays OFF everywhere.
- The view surfacing is additive; no historical document is rewritten,
  no reader contract of 6.3 changed (factGuardVersion 1 untouched).
- No Phase-6-completion claim: Gemini eligibility remains unverified,
  OD-009 stays OPEN, and every live surface requires Posidon.
