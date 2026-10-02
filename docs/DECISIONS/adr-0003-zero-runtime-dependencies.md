# ADR-0003 — Zero runtime dependencies in Phase 0; hand-rolled config validation

- **Status:** Accepted
- **Phase:** 0
- **Date:** Phase 0

## Context

The blueprint mandates Zod for AI output parsing (§12), but Phase 0 must not
add AI SDKs and must keep runtime dependencies minimal. Configuration
validation is needed only for the health foundation subset.

## Decision

- **`dependencies` remains empty in Phase 0.** All shipped code is
  first-party TypeScript over Web-standard APIs.
- Configuration validation is a small hand-rolled module
  (`src/shared/config/`): typed field specs, string/enum types,
  required/optional with defaults, secret classification, fail-safe behavior,
  and value-free error issues.
- Zod will be introduced **with the phase that consumes it** (AI contracts,
  roadmap phase 6 — see OD-002 for the confirmation question), not before.

## Consequences

- No supply-chain or Workers-compatibility risk from runtime packages yet.
- The validator stays deliberately tiny (~100 lines) and fully unit-tested.
- Risk noted: hand-rolled validation must never grow into a framework; if
  needs exceed enums/strings/required/defaults, adopt Zod instead.
