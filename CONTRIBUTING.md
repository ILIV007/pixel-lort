# Contributing to Pixel

## Ground rules

1. The blueprint under `docs/blueprint/v1/` is authoritative. Phase boundaries
   in `docs/ROADMAP.md` are enforced: implement only the current phase.
2. Architectural changes require an ADR in `docs/DECISIONS/` or, for
   unresolved questions, an entry in `docs/OPEN_DECISIONS.md`.
3. Never commit real credentials or token-shaped values. Secrets live in
   Cloudflare secrets or a git-ignored `.dev.vars` file.

## Branching and commits

- Branch names follow `phase/NN-short-name` (e.g. `phase/00-foundation`).
- Never commit directly to `main`.
- Use focused conventional commits:
  - `feat: add x` / `fix: correct y`
  - `test: add phase zero quality gates`
  - `docs: add development and handoff documentation`
  - `chore: initialize worker foundation`
- Keep changes small and reviewable; do not mix unrelated work.

## Development workflow

```bash
npm ci           # after checkout or dependency changes
npm run format   # optional: auto-format
npm run check    # REQUIRED before every handoff/PR
```

`npm run check` runs lint, format check, typecheck, tests (inside the Workers
runtime), the secret scan, and an offline `wrangler deploy --dry-run` build.
There is no deployment workflow; deploys are explicit, manual, and out of
scope for Phase 0.

## Code expectations

- TypeScript strict mode; Workers-compatible runtime code only.
- No `console.*` outside `src/observability/logger.ts` (lint-enforced).
- Errors cross boundaries only via `src/shared/errors/` primitives.
- Tests are offline: fixtures and mocks, never live network calls.
- Respect the modular-monolith boundaries described in
  `docs/ARCHITECTURE.md` — in particular, domain code never imports
  platform/Cloudflare types.

## Documentation duties

When your change affects architecture, security, roadmap status, or open
decisions, update the corresponding document in the same change.
