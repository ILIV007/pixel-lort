# ADR-0005 — Two-tier environment contract; commented binding placeholders

- **Status:** Accepted
- **Phase:** 0
- **Date:** Phase 0

## Context

Phase 0 must define typed contracts for future bindings (D1, KV, R2, Queue,
Workers AI) without creating resources or requiring real IDs, while keeping
the Worker honest about what actually exists at runtime.

## Decision

- `src/shared/types/env.ts` defines:
  - `WorkerEnv` — exactly what wrangler.jsonc provides today (vars only);
  - `PixelBindings`, `PixelConfig`, `PixelSecrets` — the full future contract
    with blueprint-authoritative binding names `DB`, `CACHE`, `JOBS`,
    `MEDIA`, `AI`;
  - `PixelEnv` — their composition (the eventual production environment).
- wrangler.jsonc declares **no bindings**; future declarations are documented
  as comments with the exact binding names and their owning phase.
- Rule: code never accesses a binding before its phase adds the wrangler
  declaration. Queue/secret contracts are type-only (`QueueEnvelope`,
  `PixelSecrets` names).

## Consequences

- `npm run build` (dry-run) and tests run without any Cloudflare account.
- Later phases extend `WorkerEnv` incrementally (e.g., add `DB` in phase 1),
  keeping type-claims aligned with reality.
