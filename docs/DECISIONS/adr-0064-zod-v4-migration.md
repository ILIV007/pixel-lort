# ADR-0064: the zod v4 migration (the Phase 10 tracked dependency carry)

- Status: Accepted
- Date: 2026-11-14
- Round: V4 v1.40.0 (schema 6 — ZERO DDL, no migration)
- Plan: docs/CONTINUATION_PLAN_POSIDON.md slice 5 ("Security and free-budget
  proof") — "investigate zod and remaining advisories with compatibility and
  regression tests, not blind forced upgrades"
- Advisory: GHSA-mrhx-c7xc-m3w5 — "Zod can exhaust memory while validating
  oversized constrained collections", severity high, fixed in zod 4.6.6.

## Context

Phase 10 (v1.29.0) recorded the dependency exposure inventory: the ONE
direct runtime advisory was zod < 4.6.6. The real exposure was bounded —
every zod parse point consumes a size-capped payload (the 64 KiB webhook
body cap, the bounded readers, the fetch byte caps) and no schema validates
an unbounded user-controlled collection — so the fix was TRACKED as a
deliberate maintenance round, not blind-forced mid-round. This round is
that tracked round.

The zod usage surface (the only runtime dependency in the Worker bundle,
per ADR-0010): the queue envelope (ADR-0036 §5/ADR-0037), the durable job
payload schemas (ADR-0036 §7), the AI provider-output schemas (ADR-0041,
event-relation), the source-registry schema (ADR-0038 §2) and the
connector runtime-config schemas (ADR-0039 §1).

## Decision

1. **The dependency pin moves to the fixed v4**: `zod@^4.6.7`
   (the advisory fix is 4.6.6; the house pin is >= 4.6.7).

2. **RED-first, adapted to a dependency migration.** A version bump has no
   behavior to unit-test in isolation, so the discriminating RED is
   delivered by TWO gates written FIRST on the pre-migration tree:

   - `tests/unit/zod-v4-contract.test.ts` (19 tests): TWO MIGRATION
     MARKERS recorded RED on 3.25.76 — the installed-version gate
     (major 4, >= 4.6.7, via the bundled `zod/package.json` read inside
     workerd) and the v4 canonical issue-message shape
     (`Invalid input: expected string...` where v3 said `Required`) —
     plus 17 PRESERVATION PINS locking the parse contracts of every
     migrated surface so the migration can never silently change a typed
     refusal: the envelope (canonical object, defensive JSON-string form,
     the strict smuggled-field refusal, the bounds refusals, the
     `unsupported_version` outcome, the `.issues` code+path contract), the
     payloads (the `PAYLOAD_SCHEMAS` map identity, the strict
     accept/refuse family), the AI output classifier (the stable codes,
     the oversized field refusal) and the registry (the strict catalog
     boundary, the connector-config schema acceptance, the non-object
     config refusal, the custom-issue code `custom` at the
     `sources.0.config` and `sources.0.autoPublishThreshold` paths).
   - `scripts/check-versions.mjs` gained the zod dependency gate: BOTH the
     declared range (package.json) and the installed version
     (node_modules) must be >= 4.6.7. Recorded exit 1 with 2 zod findings
     BEFORE the install; exit 0 after.

   RED evidence (real, recorded): on the pre-migration tree the contract
   suite was 2 failed / 17 passed and the version gate exit 1.

3. **The migration is the minimal API-form change** (three sites, all in
   the pure schema modules):

   - `z.record(z.unknown())` → `z.record(z.string(), z.unknown())` (v4
     requires the key schema — compile-pinned by `tsc --noEmit`);
   - `z.ZodIssueCode.custom` → the string literal `'custom'` (x4 — the v4
     issue code IS the string; behavior identical, v3's constant already
     evaluated to the same string);
   - `z.ZodTypeAny` → `z.ZodType` (x2 — the v4 replacement; the
     unparametrized `ZodType` accepts any schema under v4's
     variance-annotated generics).

   `z.ZodIssueCode` and `z.ZodTypeAny` still exist in v4 as deprecated
   compat aliases (the typecheck proved they compile), but the source now
   uses the v4-native forms so the next major cannot break us silently.

4. **The behavior-preservation proof**: post-migration the contract suite
   is 19/19 GREEN (both markers flipped GREEN — the observed v4 message
   matched the pinned shape) and the FULL unit suite is
   205 files / 2807 tests GREEN UNMODIFIED (zero behavioral fallout across
   every connector/registry/job/AI schema). No existing test was weakened
   or edited for the migration.

## The honest dependency inventory after the migration

- The DIRECT runtime zod (the deployed Worker surface) is the fixed
  4.6.7 — the advisory is closed at the runtime layer.
- The nested dev-chain zod 4.4.3 inside `@cloudflare/vitest-pool-workers`
  remains: even the latest pool-workers (0.23.0) depends on `zod@4.4.3`,
  so the dev-chain advisory cannot be cleared without upstream action.
  It is TEST-RUNNER-ONLY (no Worker-runtime path — the Worker bundle
  never imports the pool-workers tree) and stays a tracked honest carry
  together with the other dev-chain advisories (sharp/undici/minimatch).
  NO `audit fix --force` (the AGENTS.md non-negotiable).

## Consequences

- The runtime advisory closes with zero behavior change; the parse
  contracts are now pinned against ANY future dependency drift by the
  contract suite.
- The version gate makes a silent downgrade or a stale install impossible
  to miss (`npm run check` fails loudly).
- The remaining npm audit findings are dev-chain-only and unchanged in
  status; the OD-010 rights-evidence model remains the owner decision.
- Schema stays 6; no DDL; no flag changes; every activation lane stays
  BLOCKED_LIVE (Posidon only).
