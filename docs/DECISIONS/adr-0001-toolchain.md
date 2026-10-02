# ADR-0001 — Toolchain: npm, Node 22, TypeScript strict, ESLint flat + Prettier

- **Status:** Accepted
- **Phase:** 0
- **Date:** Phase 0

## Context

Phase 0 requires a coherent repository foundation with lint, formatting,
typechecking, tests, and builds, runnable without Cloudflare credentials.
npm is the package manager unless the repository is already locked to another.

## Decision

- **npm** as package manager (lockfile committed; `npm ci` reproduces it).
- **Node 22** (pinned major version) for local tooling and CI; `engines.node >= 22`.
- **TypeScript 5 strict mode** plus `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, `isolatedModules`.
- **ESLint 9 flat config** with `typescript-eslint` recommended rules;
  `no-console` enforced everywhere except the logger and local maintenance
  scripts; `eslint-config-prettier` disables stylistic conflicts.
- **Prettier 3** for formatting (`format:check` in the gate).
- **Vitest** with the **Cloudflare-supported Workers pool**
  (`@cloudflare/vitest-pool-workers`): tests execute inside workerd using the
  real wrangler config, satisfying "test stack compatible with Cloudflare
  Workers" without credentials or network.

## Consequences

- Tests exercise Worker-runtime semantics (Request/Response, Web Crypto)
  instead of Node approximations.
- Tooling versions are pinned by `package-lock.json`; CI uses `npm ci`.
