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
   * Target channel username (e.g. "@pixellort").
   * Classified as non-secret config because the channel username is publicly
   * observable; see ADR-0008 / OPEN_DECISIONS OD-001 for the recorded decision.
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
 * Phase 0 worker environment: exactly the vars declared in wrangler.jsonc.
 * All fields optional-with-validated-defaults so a bare runtime (and tests
 * without any configuration) still boot safely.
 */
export interface WorkerEnv {
  readonly APP_VERSION?: string;
  readonly ENVIRONMENT?: string;
  readonly LOG_LEVEL?: string;
}
