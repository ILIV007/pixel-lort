import type { LogLevel } from './log-level';
import type { QueueEnvelope } from './queue';

/**
 * Typed environment contracts for the Pixel Worker.
 *
 * Three tiers exist on purpose:
 *
 * 1. `WorkerEnv` — what the entrypoints actually consume in Phase 0.
 *    Matches exactly what wrangler.jsonc provides today (vars only).
 *
 * 2. `PixelBindings` / `PixelConfig` / `PixelSecrets` — the full future
 *    binding and configuration contract, fixed by the blueprint
 *    (docs/blueprint/v1/PIXEL_IMPLEMENTATION_SPEC_v1.md §4). Binding names are
 *    authoritative: DB, CACHE, JOBS, MEDIA, AI.
 *
 * 3. `PixelEnv` — the composition of all tiers, representing the production
 *    environment once every phase has landed.
 *
 * Rule: code must never access a binding that is not declared in wrangler.jsonc
 * for the current phase (see ADR-0005 and docs/ROADMAP.md).
 */

/** Future Cloudflare resource bindings. NOT bound in Phase 0. */
export interface PixelBindings {
  /** D1 database — the source of truth for all durable state. */
  readonly DB: D1Database;
  /** KV namespace — cache/lock optimization only, never authoritative. */
  readonly CACHE: KVNamespace;
  /** Queues producer for the `pixel-jobs` queue (consumer configured separately). */
  readonly JOBS: Queue<QueueEnvelope>;
  /** R2 bucket — temporary, rights-cleared media artifacts only. */
  readonly MEDIA: R2Bucket;
  /** Workers AI binding. */
  readonly AI: Ai;
}

/**
 * Non-secret configuration values. Safe to expose in logs/health output
 * (never echoed wholesale — see docs/SECURITY_MODEL.md logging rules).
 */
export interface PixelConfig {
  /** Deployment environment discriminator. */
  readonly ENVIRONMENT: 'development' | 'preview' | 'production';
  /** Minimum log level emitted by the structured logger. */
  readonly LOG_LEVEL: LogLevel;
  /** Build/version marker reported by /health. */
  readonly APP_VERSION: string;
  /**
   * Commit identifier reported by GET /version (Phase 1A, ADR-0020).
   * Non-secret build metadata; the local placeholder is invalid in production.
   */
  readonly APP_COMMIT: string;
  /**
   * Expected D1 schema version, validated as a strict positive decimal
   * integer string (Phase 1A, ADR-0019/0020).
   */
  readonly SCHEMA_VERSION: string;
  /**
   * Target channel username (e.g. "@pixellort").
   * Classified as non-secret config because the channel username is publicly
   * observable; decided in ADR-0009 (closed OD-001) — stays OUTSIDE
   * PixelSecrets and the future secret catalog.
   */
  readonly TARGET_CHANNEL: string;
}

/**
 * Secret values. Names are contract; values exist only in Cloudflare secrets
 * (`wrangler secret put`) or a git-ignored `.dev.vars` file for local dev.
 * Never log, echo, commit, or embed these values anywhere.
 */
export interface PixelSecrets {
  readonly BOT_TOKEN: string;
  readonly WEBHOOK_SECRET: string;
  readonly OWNER_TELEGRAM_ID: string;
  readonly GEMINI_API_KEY: string;
  readonly GROQ_API_KEY: string;
  readonly YOUTUBE_API_KEY: string;
  readonly REDDIT_CLIENT_ID: string;
  readonly REDDIT_CLIENT_SECRET: string;
  readonly IGDB_CLIENT_ID: string;
  readonly IGDB_CLIENT_SECRET: string;
  /** Optional — only if authenticated GitHub access becomes necessary. */
  readonly GITHUB_TOKEN?: string;
  /** Optional — only if authenticated Bluesky access becomes necessary. */
  readonly BLUESKY_APP_PASSWORD?: string;
}

/** Full production environment once all phases have landed. */
export type PixelEnv = PixelBindings & PixelConfig & PixelSecrets;

/**
 * Phase 0/1A worker environment: the vars declared in wrangler.jsonc plus the
 * Phase 1A local D1 placeholder binding (ADR-0019; no Cloudflare resource
 * exists). All fields optional-with-validated-defaults so a bare runtime (and
 * tests without any configuration) still boot safely.
 */
export interface WorkerEnv {
  readonly APP_VERSION?: string;
  readonly ENVIRONMENT?: string;
  readonly LOG_LEVEL?: string;
  /**
   * Commit identifier (Phase 1A build metadata, ADR-0020). Optional with a
   * validated local default; invalid values fail readiness closed.
   */
  readonly APP_COMMIT?: string;
  /**
   * Expected D1 schema version as a strict positive decimal integer string
   * (Phase 1A, ADR-0019). Optional with a validated local default; invalid
   * values fail readiness closed — never silently coerced.
   */
  readonly SCHEMA_VERSION?: string;
  /**
   * D1 binding, declared in wrangler.jsonc starting Phase 1A as a LOCAL
   * placeholder (no resource created — ADR-0019). Optional: runtimes and
   * tests without D1 keep working in offline mode; when the binding IS
   * present, readiness additionally verifies schema health (ADR-0021).
   */
  readonly DB?: D1Database;
  // ---------------------------------------------------------------------------
  // Phase 2 configuration (Telegram secure ingress + admin foundation).
  // Names are contract; secret VALUES exist only via `wrangler secret put`
  // or a git-ignored `.dev.vars` file. They are validated by
  // src/shared/config/phase2.ts and never logged, echoed, or serialized.
  // ---------------------------------------------------------------------------
  /**
   * NON-SECRET ingress feature flag ('true' | 'false'; default 'false').
   * The webhook route fails closed to a uniform 404 unless this is 'true'
   * AND the full Phase 2 configuration is valid.
   */
  readonly TELEGRAM_INGRESS_ENABLED?: string;
  /** NON-SECRET target public channel username (e.g. "@pixellort") — ADR-0009. */
  readonly TARGET_CHANNEL?: string;
  /** SECRET — Telegram bot token. Never logged or echoed. */
  readonly BOT_TOKEN?: string;
  /** SECRET — webhook shared secret (min strength 32, [A-Za-z0-9_-]). Never logged. */
  readonly WEBHOOK_SECRET?: string;
  /** SECRET — owner Telegram numeric user ID (bootstrap identity). Never logged. */
  readonly OWNER_TELEGRAM_ID?: string;
}
