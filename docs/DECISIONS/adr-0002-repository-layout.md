# ADR-0002 — Modular-monolith repository layout and blueprint mapping

- **Status:** Accepted
- **Phase:** 0
- **Date:** Phase 0

## Context

The Phase Packet fixes the source layout (`entrypoints/`, `domain/`,
`application/`, `adapters/`, `editorial/`, `admin/`, `observability/`,
`shared/`), while the blueprint §3 names boundaries (`domain/*`,
`application/*`, `infrastructure/*`, `connectors/*`, `interfaces/*`). Both
must coexist without confusion.

## Decision

- Adopt the Phase Packet layout as the physical structure.
- Map blueprint boundaries onto it (documented in `docs/ARCHITECTURE.md` §2):
  `interfaces/*` → `entrypoints/` + `admin/`; `infrastructure/*` and
  `connectors/*` → `adapters/`.
- Preserve the blueprint's boundary RULES verbatim: domain code imports no
  Cloudflare/Telegram/provider/HTTP types; adapters own all I/O.
- Planned directories contain only a short README describing scope and the
  phase that will fill them — no mock business logic.

## Consequences

- New contributors (and agents) can locate any future module by phase.
- No speculative scaffolding: empty planned directories carry intent only.
