# ADR-0041: Workers-AI-first AI adapter foundation (free-only, fail-closed)

- **Status:** Implemented in owner round 1.10.6 (recovery round 1.10.6-R);
  runtime OFF by default. NOT a deployment, activation, or live-inference
  approval.
- **Phase:** 6 (adapter foundation only; story engine, fact guard, durable
  caller wiring, and channel publishing are explicitly NOT included)
- **Date:** 2026-10-28
- **Reviewed by:** Posidon (project architect; round 1.10.6 instruction).
  The instruction is the acceptance contract for this ADR.

## Context

Phase 6 needs AI providers behind the existing project boundaries
(ADR-0002 layout, ADR-0003 zero runtime dependencies, ADR-0022 typed D1
boundary, ADR-0038 budget authority patterns). The owner's round 1.10.6
instruction fixes the architecture: Cloudflare Workers AI (the `env.AI`
binding) is the PRIMARY path; the Gemini Developer API is a SECONDARY
path through the existing `GEMINI_API_KEY`; no third provider (Groq is
not part of the active policy); no paid plans, paid-only models, or
quota-evasion rotation; and everything fail-closed while OFF.

Prior state: `PixelBindings.AI` existed in the blueprint contract
(docs/blueprint/v1/), `AI_ENABLED`/AI flags did not exist, the future
secret catalog REQUIRED `GEMINI_API_KEY`/`GROQ_API_KEY` for Phase 6, and
the `budgets` table carried only ingestion-scope accounting.

## Decision

1. **Versioned policy over an explicit allowlist** (`src/domain/ai/policy.ts`,
   `ai-policy-v1`): exactly `@cf/meta/llama-3.1-8b-instruct-fp8` (primary),
   `@cf/qwen/qwen3-30b-a3b-fp8` (alternate), and
   `gemini-2.5-flash-lite` (fallback, `requiresEligibility`). The literal
   "auto" is never a model id; unknown catalog models are never trusted.
   The llama-3.3-70b-fast and gemini-3.1-flash-lite candidates stay OUT of
   this version. Validated bounds: ≤16 KiB public input, ≤768 output
   tokens, ≤15 s total wall deadline, ≤3 provider attempts.
2. **Eligibility is separate from availability**:
   `AI_PROVIDER_ELIGIBILITY_V1` marks Gemini `unverified_free_tier` —
   documentation availability, account access, billing tier, quota, and
   Persian quality are distinct concerns and a key/binding proves none of
   them. The Gemini fallback therefore stays OFF (typed
   `eligibility_unverified`, zero network) even when `AI_GEMINI_ENABLED`
   is true, until a later round verifies current official Free-tier docs.
   Workers AI is `binding_gated` — the binding itself is the access for
   that path.
3. **Config surface** (`src/shared/config/phase6.ts`, ADR-0003 validator):
   non-secret flags `AI_ENABLED` and `AI_GEMINI_ENABLED`, both default
   "false" and shipped "false" in every environment (wrangler root +
   preview vars, env examples). Owner amendment applied to the future
   secret catalog and `PixelSecrets`: `GEMINI_API_KEY` is conditional
   (optional), `GROQ_API_KEY` is not part of the active policy (optional
   name only). Frozen blueprint evidence is untouched.
4. **Wrangler reconciliation** (config-as-code, NOT a deploy): the preview
   environment declares `"ai": { "binding": "AI" }` mirroring the
   owner-approved dashboard binding (configuration version 0ef009b9…,
   100% Ready, added by the owner's authorized operator) so a future
   reviewed deploy preserves it. No deploy, resource creation, or model
   invocation is authorized or performed by the repository pass.
5. **Budget authority on the EXISTING `budgets` table** (no migration, no
   DDL): scope `ai`, `budget_key` = provider, `bucket_date` = Asia/Tehran
   day. `authorizeAiRequestAttempt` is an atomic guarded
   UPDATE + INSERT..SELECT batch executed BEFORE EVERY provider attempt;
   a successful durable authorization is the only way a call may start.
   Caps are app attempt units from the policy (NOT Neurons, NOT Google
   quota; provider reset boundaries remain the providers' own). No
   refunds; failed/timeout attempts stay charged. Store failures are a
   DISTINCT typed outcome (`budget_store_error`), never mistaken for
   quota. Ingestion accounting is untouched and never mingled.
6. **Domain purity and adapters** (blueprint §4 binding names):
   `src/domain/ai/` imports no SDK types. `src/adapters/ai/` holds the
   native boundaries — `WorkersAiAdapter` (env.AI.run; deadline race with
   the documented non-cancellable in-flight limitation; conservative
   code-only error classification) and `GeminiAdapter` (injected bounded
   transport; key ONLY in the `x-goog-api-key` header, never query
   strings or logs; strict HTTPS; `redirect: 'error'`; 1 MiB bounded
   body read; Retry-After parsing). Raw payloads, headers, URLs, and the
   key never cross the port boundary.
7. **Service semantics** (`src/application/ai/draft-service.ts`): gated
   OFF → typed `ai_disabled` with zero side effects; Zod-validated
   bounded request; ladder CF primary → CF alternate (only for suitable
   model-specific unavailable/retired/transient failures) → conditional
   Gemini; a shared provider-bucket quota denial skips ALL remaining
   same-provider models; provider content/safety refusals are TERMINAL
   typed refusals (no model/provider hopping to bypass safety); output is
   Zod-validated (`.strict()`, bounded) with evidence-id cross-checks;
   malformed/truncated/oversized/unknown-reference output is a rejected
   attempt, never a successful empty draft; exhausted free paths return
   typed deferred outcomes with stable reasons and known retry
   boundaries. Logging carries stable event names, provider/model ids,
   prompt version, outcome kinds, attempt counts, and clearly-labelled
   usage metadata only.
8. **Prompt contract** (`pixel-news-draft-v1`): immutable, versioned,
   Persian; news text is UNTRUSTED DATA (delimited markers), the model
   has no tools, cannot change trust/policy/schema, must not emit
   Telegram HTML, and must not publish. Referenced evidence ids alone do
   NOT prove a generated claim is true — the fact guard remains future
   work and is not claimed here.

## Consequences

- The full product suite grows 1150 → 1206 tests in 96 files (56 new AI
  tests; DB subset registers `ai-budget.test.ts` on REAL disposable
  workerd D1). All offline: provider transports are injected fakes.
- `AI_ENABLED=false` is the shipped state everywhere; enabling AI is a
  separate reviewed owner procedure. No live model call, no Cloudflare
  account change, no billing change, and no Telegram send is authorized
  by this ADR or the round that implemented it.
- Historical note: an earlier local candidate of this round (commit
  87f4db1, parent 220c6c5) was never pushed and its bytes became
  unavailable after an unexplained sandbox reset; it is recorded as a
  historical inaccessible candidate, NOT as a basis for any test count
  or claim. This ADR describes the RE-IMPLEMENTED candidate.

## References

- Round 1.10.6 owner instruction (Workers-AI-first adapters; §2–§6).
- ADR-0002 (layout), ADR-0003 (config), ADR-0022 (D1 boundary),
  ADR-0038 (budget patterns), docs/blueprint/v1/PIXEL_IMPLEMENTATION_SPEC_v1.md §4.
