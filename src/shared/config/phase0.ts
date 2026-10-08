/**
 * Phase 0 configuration surface.
 *
 * Phase 0 validates only the small subset needed by the health foundation
 * (per the Phase Packet). Every field is optional with a safe default, so a
 * bare deployment boots while still exercising the fail-safe validation path.
 *
 * The future secret catalog documents the full secret contract from the
 * blueprint with the phase that starts consuming each secret. Secrets are
 * NOT validated in Phase 0 — fail-closed readiness for a given secret is
 * enforced from the phase that actually uses it (ADR-0008, approved by
 * ADR-0014). TARGET_CHANNEL is intentionally ABSENT: it is non-secret
 * configuration per ADR-0009.
 */
import { defineConfigSpec, type ConfigSpec } from './spec';
import { validateConfig, type ConfigValidationResult } from './validate';
import { DEFAULT_LOG_LEVEL, isLogLevel, type LogLevel } from '../types/log-level';

/**
 * The approved Phase 2A application version (kept in sync with package.json
 * and wrangler.jsonc — see handoff/PHASE_02A_HANDOFF.md).
 */
export const DEFAULT_APP_VERSION = '1.3.1';

export const KNOWN_ENVIRONMENTS = ['development', 'preview', 'production'] as const;
export type Environment = (typeof KNOWN_ENVIRONMENTS)[number];

/** The configuration consumed by the Phase 0 foundation. */
export const PHASE_0_CONFIG_SPEC: ConfigSpec = defineConfigSpec([
  {
    name: 'ENVIRONMENT',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...KNOWN_ENVIRONMENTS],
    default: 'development',
    description: 'Deployment environment discriminator.',
    phase: 0,
  },
  {
    name: 'LOG_LEVEL',
    type: 'enum',
    required: false,
    secret: false,
    allowed: ['debug', 'info', 'warn', 'error'],
    default: DEFAULT_LOG_LEVEL,
    description: 'Minimum log level for the structured logger.',
    phase: 0,
  },
  {
    name: 'APP_VERSION',
    type: 'string',
    required: false,
    secret: false,
    default: DEFAULT_APP_VERSION,
    description: 'Build/version marker reported by /health and /version.',
    phase: 0,
  },
]);

export interface WorkerConfig {
  readonly ENVIRONMENT: Environment;
  readonly LOG_LEVEL: LogLevel;
  readonly APP_VERSION: string;
}

/**
 * Parse and validate the Phase 0 subset from a raw environment record.
 * On invalid input, falls back to safe defaults so the Worker can still serve
 * health endpoints and log the problem internally.
 */
export function parseWorkerConfig(env: Readonly<Record<string, unknown>>): {
  readonly config: WorkerConfig;
  readonly result: ConfigValidationResult;
} {
  const result = validateConfig(env, PHASE_0_CONFIG_SPEC);
  const c = result.config;

  const config: WorkerConfig = {
    ENVIRONMENT: isEnvironment(c['ENVIRONMENT']) ? c['ENVIRONMENT'] : 'development',
    LOG_LEVEL: isLogLevel(c['LOG_LEVEL']) ? c['LOG_LEVEL'] : DEFAULT_LOG_LEVEL,
    APP_VERSION: typeof c['APP_VERSION'] === 'string' ? c['APP_VERSION'] : DEFAULT_APP_VERSION,
  };

  return { config, result };
}

function isEnvironment(value: unknown): value is Environment {
  return typeof value === 'string' && (KNOWN_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Future secret catalog — names, owning phase, and purpose. This is the typed
 * mirror of blueprint §4 so readiness gating can be wired phase-by-phase.
 * Values never exist in source; see docs/SECURITY_MODEL.md.
 *
 * NOTE (ADR-0009): TARGET_CHANNEL is NOT in this catalog — the public channel
 * username is non-secret configuration and will be validated as plain config
 * in the phase that consumes it.
 */
export interface FutureSecretDescriptor {
  readonly name: string;
  readonly required: boolean;
  readonly phase: number;
  readonly description: string;
}

export const FUTURE_SECRET_CATALOG: readonly FutureSecretDescriptor[] = [
  {
    name: 'BOT_TOKEN',
    required: true,
    phase: 2,
    description: 'Telegram bot token for webhook auth and publishing.',
  },
  {
    name: 'WEBHOOK_SECRET',
    required: true,
    phase: 2,
    description: 'Shared secret validated on Telegram webhook calls.',
  },
  {
    name: 'OWNER_TELEGRAM_ID',
    required: true,
    phase: 2,
    description: 'Owner Telegram user ID for fail-closed admin bootstrapping.',
  },
  // TARGET_CHANNEL is intentionally absent: non-secret configuration
  // (publicly observable username) per ADR-0009 — never a secret.
  {
    name: 'YOUTUBE_API_KEY',
    required: true,
    phase: 4,
    description: 'YouTube Data API key for official channel watchlists.',
  },
  {
    name: 'REDDIT_CLIENT_ID',
    required: true,
    phase: 4,
    description: 'Reddit OAuth client ID for radar sources.',
  },
  {
    name: 'REDDIT_CLIENT_SECRET',
    required: true,
    phase: 4,
    description: 'Reddit OAuth client secret for radar sources.',
  },
  {
    name: 'IGDB_CLIENT_ID',
    required: true,
    phase: 4,
    description: 'IGDB/Twitch client ID for metadata lookups.',
  },
  {
    name: 'IGDB_CLIENT_SECRET',
    required: true,
    phase: 4,
    description: 'IGDB/Twitch client secret for metadata lookups.',
  },
  {
    name: 'GEMINI_API_KEY',
    required: true,
    phase: 6,
    description: 'Gemini API key for extraction and editorial tasks.',
  },
  {
    name: 'GROQ_API_KEY',
    required: true,
    phase: 6,
    description: 'Groq API key for fallback model routing.',
  },
  {
    name: 'GITHUB_TOKEN',
    required: false,
    phase: 4,
    description: 'Optional GitHub token for release watchlists.',
  },
  {
    name: 'BLUESKY_APP_PASSWORD',
    required: false,
    phase: 4,
    description: 'Optional Bluesky app password if authenticated access is needed.',
  },
];
