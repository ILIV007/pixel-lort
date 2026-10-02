// Ambient declarations for the Cloudflare Vitest test environment (Phase 1A).
//
// `@cloudflare/vitest-pool-workers` 0.22 removed the `providedEnv` export and
// its generated-env typing; bindings are consumed through the (JSDoc-
// deprecated but functional) `env` export of `cloudflare:test`, whose type is
// the project-extendable `Cloudflare.Env` interface. This file merges the
// bindings declared in wrangler.jsonc into that interface.
//
// NOTE: the DB binding is a LOCAL placeholder (ADR-0019) — no Cloudflare
// resource exists. If the project later adopts `wrangler types`-generated
// Env types, this augmentation should be revisited.

declare namespace Cloudflare {
  interface Env {
    /** D1 database binding (local placeholder — ADR-0019). */
    DB: D1Database;
    APP_VERSION: string;
    ENVIRONMENT: string;
    LOG_LEVEL: string;
  }
}

declare module '*.sql?raw' {
  const content: string;
  export default content;
}
