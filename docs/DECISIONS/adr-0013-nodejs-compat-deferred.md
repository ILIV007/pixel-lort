# ADR-0013 — nodejs_compat stays disabled for now

- **Status:** Accepted (closes OD-005)
- **Phase:** 0 (correction pass)
- **Date:** 2026-10-02
- **Decided by:** Alexios

## Context

Phase 0 uses only Web-standard APIs; no Node-only APIs. OD-005 asked whether
to enable the `nodejs_compat` compatibility flag preemptively.

## Decision

**Do not enable `nodejs_compat` now.** Only introduce it later when an
approved dependency has a demonstrated requirement, accompanied by an ADR.

## Consequences

- `wrangler.jsonc` has no `compatibility_flags` entry.
- Any phase that needs a Node-only dependency must first record the
  requirement in an ADR; the flag is enabled only then.
