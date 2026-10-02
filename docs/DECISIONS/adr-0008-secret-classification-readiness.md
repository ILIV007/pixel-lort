# ADR-0008 — Secret classification and phase-scoped fail-closed readiness

- **Status:** Accepted (confirmed by ADR-0014; classification confirmed by ADR-0009)
- **Phase:** 0
- **Date:** Phase 0

## Context

Blueprint §4 lists required/optional secrets; §1.10 requires fail-closed
readiness. Phase 0 binds no secrets and must run without credentials, so
validating the entire blueprint secret set now would make every Phase-0
deployment permanently `not_ready`.

## Decision

- `PixelSecrets` (`src/shared/types/env.ts`) fixes secret NAMES as the typed
  contract; values exist only via `wrangler secret put` / dashboard or a
  git-ignored `.dev.vars`.
- `FUTURE_SECRET_CATALOG` (`src/shared/config/phase0.ts`) records each secret
  with its owning roadmap phase, mirroring blueprint §4.
- Readiness is **fail-closed per feature phase**: a secret gates readiness
  from the phase that consumes it. Phase 0 checks only the Phase-0 config
  subset (all defaulted, all non-secret). ~~Confirmation question recorded
  as OD-006.~~ **Confirmed by ADR-0014 (OD-006 closed).**
- `TARGET_CHANNEL` is classified as non-secret configuration (publicly
  observable username), deviating from the blueprint's secrets list layout;
  ~~recorded as OD-001 for owner confirmation.~~ **Confirmed by ADR-0009
  (OD-001 closed).**

## Consequences

- Phase-0 deployments are honestly `ready` for the subset they own.
- Adding a feature phase without adding its readiness gate would violate
  fail-closed behavior — enforced by review and AGENTS.md rules.
