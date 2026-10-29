# ADR-0042: Phase 5A — the first integrated local source→draft path

- **Status:** Implemented on the review branch (R1.11; under independent Posidon review — NOT deployment, activation, or live-inference approval)
- **Phase:** 5A (+ its bounded connection to the Phase 6 adapters)
- **Date:** 2026-10-29
- **App at delivery:** 1.6.0 candidate; **schema stays 3** (migrations 0001–0004 untouched)
- **Instruction:** Posidon R1.11 (`NEXT_GLM_R1.11_Phase5A_Source-to-Draft.md`)

## Context

Phase 6 shipped the free-only AI adapter foundation (ADR-0041) but no durable
caller: nothing connected a real `source_items` row to a stable draft. R1.11
orders the FIRST vertical local path — news → Story → source-report claim →
evidence → AI draft → ready draft — as a PRODUCT capability (a durable job
type on the EXISTING engine), not a new SQL lab. No deploy, no live
inference, no schema change.

## Decision

### 1. One job type, one gate (fail-closed, lossless pause)

`editorial.prepare_draft` joins `JOB_TYPES`/`PAYLOAD_SCHEMAS` with a strict,
reference-only payload (`sourceItemId` + `snapshotHash` — never news text,
never secrets). A NEW independent flag `EDITORIAL_ENABLED` (default `false`
in every shipped file: wrangler root + preview, `.env.example`,
`.dev.vars.example`) gates ONLY this type; it requires the jobs engine when
on (`editorial_requires_jobs`) and NEVER implies AI activation
(`AI_ENABLED` stays independent). The enablement registry (ADR-0040) maps
`editorial.prepare_draft → 'editorial_gate'`; gate off = the LOSSLESS
policy pause (pre-claim `paused_by_policy`, zero attempt burn, zero writes,
scan exclusion IN SQL) — never the unknown-type poison class. Handler
registration stays gate-conditional in `resolveJobsEngine`.

### 2. Deterministic, versioned identity (no random identity)

All identities derive from `(sourceItemId, snapshotHash, 'v1')` via the
existing `formatIdempotencyKey`/SHA-256 primitives: the durable job
idempotency key, `story_key`, story/claim/evidence/draft row ids
(`edst_/edcl_/edev_/eddr_` prefixes), and the AI `input_hash`. Replaying
the same input resolves the SAME rows; different snapshots never share a
story (identical titles never merge — semantic merging is explicitly OUT of
scope); no timestamp or randomness participates in identity. `ai_runs` ids
are per-generation (`edai_`), so each honest retry is a distinct row.

### 3. Snapshot identity checked against the STORED hash

The enqueue boundary reads the durable item and stamps its stored
`content_hash` into the payload. The handler re-reads the item and rejects
any mismatch with a TERMINAL `editorial_snapshot_mismatch` (unknown item →
`editorial_source_item_missing`; missing source row →
`editorial_source_missing`). An imaginary snapshot is never processed.

### 4. Conservative editorial semantics (fixed, code-defined)

- Story: ONE per item snapshot, `discovered`/`unknown`, `confidence=0`,
  `working_headline=NULL`; model output never raises trust.
- The ONLY durable claim is `claim_type='source_report'` ("source X reported
  this text"), `status='unverified'`, `confidence=0`, `object_text` built
  from the item's OWN title/excerpt (traceable, truncation marked in
  warnings).
- Evidence: `stance='mentions'`, `confidence=0`, linking that claim to the
  SAME source item. A link is not `supports`; never confirmation.
- Model-proposed claims live ONLY inside `drafts.document_json`/`facts_json`
  with `status='unverified'` + `origin='model'` — never as durable claims.
  Fact Guard remains future.
- Draft: `status='ready'`, `language='fa'`, `layout='news_v1'`, `version=1`,
  warnings `model_output_unverified` / `single_source_report` /
  `fact_guard_pending`. `ready` means "a draft is stored" — never
  validated/approved/published.
- `source_items.processing_status → 'processed'` ONLY inside the successful
  fenced commit (no fake success on error/deferred/uncertain persistence).

### 5. Fenced atomic commit on schema 3 (no migration)

ALL editorial writes run as ONE `executor.batch()` in
`src/adapters/db/editorial-store.ts` where EVERY statement — story insert,
source_report claim insert, mentions-evidence insert, `ai_runs` insert,
ready-draft insert, `source_items` update — carries the SAME ownership
predicate evaluated INSIDE SQL:

```
EXISTS (SELECT 1 FROM jobs
         WHERE id = ? AND status = 'claimed' AND attempts = ?
           AND lease_until IS NOT NULL AND lease_until > ?)
```

A stale generation (expired lease, or superseded attempts) matches zero
rows: zero inserts, zero status flips, no constraint errors raised or
swallowed. Deterministic ids + `NOT EXISTS` guards make the batch
idempotent; `drafts UNIQUE(story_id, version)`, `evidence
UNIQUE(claim_id, source_item_id, stance)` and `stories.story_key UNIQUE`
remain the schema-level backstops. A mid-commit D1 failure rolls the whole
batch back (no partial editorial state) and the engine's own retry
bookkeeping owns the recovery.

### 6. AI connection — the EXISTING service, honest at-least-once

The handler calls the EXISTING `createAiDraftService` (ADR-0041): real
`AI_ENABLED` gate, real 16 KiB input bound (handler byte-check +
service re-check → typed terminal `editorial_input_invalid`), real
per-attempt durable budget authorization, real allowlist ladder, real wall
deadline, real output validation. Tests inject an ARTIFICIAL provider port
implementing the same contract — no network, no orchestration mock. Outcome
mapping: draft → fenced commit; refusal → TERMINAL
`editorial_ai_refused` dead letter (no safety fallback); typed deferrals
(`ai_disabled`, `binding_missing`, `budget_denied`, `budget_store_error`,
`deadline_exceeded`, `provider_unavailable`, `provider_auth_failed`,
`eligibility_unverified`, `no_free_path`, `key_missing`, `config_invalid`)
→ recoverable retry on the engine's bounded attempt budget; no retry storm
for deterministic failures. `ai_runs` records REAL provider/model/
prompt_version/status/usage (usage only when reported; a run whose provider
never executed is NEVER fabricated). Crash windows are honest at-least-once:
provider-answered-but-not-committed → the next generation legitimately
re-calls the provider (each attempt durably charged BEFORE the call);
committed-but-terminal-write-lost → replay finds the stable result and
calls NO provider. Exactly-once external behavior is NOT claimed.

### 7. Production wiring stays OFF and Gemini stays unwired

`resolveJobsEngine` builds the editorial handler only when
`EDITORIAL_ENABLED=true`, wiring the real Workers-AI adapter only when the
native binding exists. The Gemini fallback remains UNWIRED in production
(its versioned eligibility is unverified per ADR-0041), so no live network
is reachable through this wiring while shipped flags are false. The Persian
output demonstrated in tests is an OFFLINE FIXTURE — no live-model Persian
quality is claimed. Free-plan live fetching stays NOT_READY; this local
path does not change that.

## Proof

- `tests/unit/editorial-contracts.test.ts` — payload strictness, identity
  determinism/versioning, conservatism mapping, config fail-closed, AI
  outcome mapping (30 tests).
- `tests/integration/editorial-source-to-draft.test.ts` — the ten required
  scenarios over REAL workerd D1 + REAL engine + REAL AI service
  (artificial port only): happy path, replay idempotency, concurrent
  duplicate delivery, mid-commit rollback + honest retry, stale
  generation/lease zero-effect, all gate/typed-failure behaviors,
  malformed/fake-id/refusal/deadline, no same-title merge, inert prompt
  injection, and both at-least-once crash windows (20 tests).
- `tests/integration/editorial-demo.test.ts` (`npm run demo:editorial`) —
  the offline demo runner printing the safe summary (ids, counts, draft
  status, artificial Persian headline/summary, provider attempts) and the
  LOCAL D1 proxy metric for one news path (22 statements / 16 execution API
  calls in the demo run — a LOCAL PROXY, not a Cloudflare billing figure).
- `npm run check` (lint, format, typecheck, full suite, selftests, secret
  scan, version consistency, dry-run build) green on the delivery HEAD;
  `test:db` subset extended with the two editorial D1 files (no double
  counting claimed).

## Honest limits (UNKNOWN/NOT_READY)

- Free-plan live fetching: NOT_READY (unchanged).
- Gemini fallback: unwired + eligibility unverified (unchanged).
- Multi-evidence drafts, semantic merge, alias graphs, AI adjudication,
  Fact Guard, renderer/Telegram HTML, publishing: future phases.
- Batch-10 scheduling of editorial jobs: NOT profiled this round (one job
  per invocation was the ordered scope).
- The local statement/API counts are a local proxy only.
