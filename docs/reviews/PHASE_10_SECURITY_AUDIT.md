# Phase 10 — the security/budget audit (the consolidated sweep + the exposure inventory)

- Version: 1.29.0 (schema 6 — ZERO DDL); baseline 08b9096 (Phase 9A)
- Scope: the roadmap bullet «Security test suite (webhook spoofing, replay,
  SSRF, injection)» + «Budget counters and soft-limit enforcement» — the
  honest inventory of what the tree ALREADY pins, the ONE gap found and
  closed, and the dependency-exposure analysis with NO blind `--force`.

## 1. The consolidated sweep (tests/integration/phase10-security-sweep.test.ts — 27 tests)

One suite that re-drives the REAL attack matrix and pins the
cross-cutting invariants; the per-feature suites stay authoritative for
their own paths (referenced, not re-implemented):

- **SSRF posture** (the 7.2 media boundary): IPv4/IPv6/bracketed-v6
  literals, localhost/.localhost/.local/.internal, the metadata-service
  lookalike, and — the GAP this round CLOSED — **single-label hosts**
  (a dot-less name can never be a public DNS name; it resolves through
  the resolver's own search domains). `isForbiddenHost` now fails closed
  on them (the shipped code contradicted its own docblock).
- **The injection boundary**: javascript:/data:/file:/vbscript: schemes
  are typed-invalid through the shared URL canonicalizer; credential
  (userinfo) URLs are refused; the canonicalizer lowercases the host and
  keeps the path byte-stable (no smuggling via normalization).
- **The request-id boundary**: a hostile `x-request-id` header can never
  carry the attacker value through — either the runtime refuses to
  construct it (control characters) or the resolver replaces it with a
  generated id; a well-formed id passes unchanged; the boundary is TOTAL.
- **The durable replay boundary (ADR-0025) over REAL D1**: the
  `telegram_updates` claim is the atomic replay answer (the UNIQUE PK
  rejects the second insert; a claimed id is never reprocessed).
- **The echo discipline**: the rejection reasons are a FIXED closed
  vocabulary — an attacker's payload text never travels back in a
  response or a rejection.

Referenced suites (already green, unchanged): the secret-header family +
body-size/content-type caps (telegram-webhook-security), the hostile
stored-draft renders (admin-review-hostile), the admin-post send
integrity (admin-post-security), the RBAC matrices, the 7.2 policy unit
family.

## 2. The budget side (the second bullet)

The budget machinery EXISTS and is pinned where the money actually is:
`ingestion-budget.test.ts` (the poll/batch/row budgets with the
continuation semantics), `ai-budget.test.ts` (the AI run/step budgets,
the wall deadline, the quota denial with ZERO provider calls),
`round18-r10-budget-authority.test.ts` (the budget AUTHORITY boundary),
`publication-82-scheduler.test.ts` (the attempt budget enforced AT the
claim boundary — the ADR-0037 lesson). The Free-plan ledger
(`free-plan/`, the design-lab) carries the documented NOT_READY verdict.
No new budget code was needed this round; the audit RECORDS the map so
the next reviewer does not re-derive it.

## 3. The dependency exposure inventory (npm audit at delivery)

`npm audit fix` (the NON-BREAKING subset only) was applied first: the
vite family advisories cleared (16 → 13). NO `audit fix --force` was run
(the AGENTS.md non-negotiable). The remaining 13 (7 moderate / 6 high):

- **zod < 4.6.6 (high, GHSA-mrhx-c7xc-m3w5 — DIRECT runtime dep)**: the
  memory-exhaustion-via-oversized-constrained-collections advisory. The
  real exposure is BOUNDED at the boundaries the advisory's trigger
  requires: every zod parse point consumes a size-capped payload (the
  64 KiB webhook body cap, the bounded readers, the fetch byte caps) and
  no schema validates an UNBOUNDED user-controlled collection. The fix
  is the zod@4 MAJOR migration (an API-semantics change across the job/
  ai/registry/connector schemas) — scheduled as a tracked maintenance
  item, NOT blind-forced mid-round. Residual risk: bounded-low.
- **sharp (high, via @cloudflare/vitest-pool-workers)**: test-infra
  ONLY (no runtime path exists — the Worker never imports sharp). The
  fix is a breaking pool-workers downgrade: rejected (it would trade a
  real CI capability for a dev-only advisory). Residual risk: dev-only.
- **undici (high, via miniflare/vitest dev chains)**: dev/test tooling;
  the Worker runs on workerd, not undici. Residual risk: dev-only.
- The remaining moderates: dev-chain packages of the same families.

Honest summary: ZERO runtime Worker exposure requires an immediate code
change; the tracked items are the zod v4 migration (runtime, bounded)
and the pool-workers/undici refreshes (dev-only).

## 4. Gates

The full `npm run check` + `npm run test:db` exits are recorded in the
round delivery message; the sweep (27 tests) and the hardened 7.2 policy
are registered in the full run.
