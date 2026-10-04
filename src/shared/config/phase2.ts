/**
 * Phase 2 configuration surface (Telegram secure ingress + admin foundation).
 *
 * Adds typed contracts for:
 * - TELEGRAM_INGRESS_ENABLED — NON-SECRET feature flag ('true' | 'false',
 *   default 'false'). The Telegram webhook route exists only while this flag
 *   is on; a disabled or misconfigured ingress behaves like an unknown route.
 * - Secrets BOT_TOKEN / WEBHOOK_SECRET / OWNER_TELEGRAM_ID (names are the
 *   contract; values never appear in source, docs, issues, or logs).
 * - TARGET_CHANNEL — non-secret public channel username (ADR-0009).
 *
 * Fail-closed rules (ADR-0008 phase-scoped readiness, extended to Phase 2):
 * - Format validation runs whenever a value is PRESENT, regardless of the
 *   flag; a present-but-invalid value is never silently ignored.
 * - While ingress is ENABLED, the secrets its Phase 2A features consume are
 *   REQUIRED: WEBHOOK_SECRET (webhook security) and OWNER_TELEGRAM_ID
 *   (authorization bootstrap). Readiness fails closed when either is absent
 *   or invalid. BOT_TOKEN is validated whenever present but stays OPTIONAL
 *   until Phase 2B enables live Telegram wiring — without it the ingress
 *   runs in documented OFFLINE mode (routed actions are skipped, never
 *   executed against the network).
 * - Validation issues carry FIELD NAMES and stable reason codes only —
 *   never values.
 * - Local development and offline tests use explicit fake fixtures that
 *   satisfy the documented formats (never realistic credentials).
 */
import { defineConfigSpec, type ConfigSpec } from './spec';
import { validateConfig, type ConfigIssue, type ConfigValidationResult } from './validate';

/**
 * Ingress feature flag values. Anything else is an invalid_enum issue and
 * fails configuration closed.
 */
export const TELEGRAM_INGRESS_FLAG_VALUES = ['true', 'false'] as const;

/**
 * WEBHOOK_SECRET minimum strength: at least 32 characters of Telegram's
 * documented header charset ([A-Za-z0-9_-]), at most 256 (the header value
 * limit). Shorter secrets are rejected before they can ever be deployed.
 */
export const WEBHOOK_SECRET_MIN_LENGTH = 32;
export const WEBHOOK_SECRET_MAX_LENGTH = 256;
export const WEBHOOK_SECRET_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${WEBHOOK_SECRET_MIN_LENGTH},${WEBHOOK_SECRET_MAX_LENGTH}}$`,
);

/**
 * BOT_TOKEN structural format "<numeric bot id>:<token body>".
 * Structural validation ONLY — the value is never printed, logged, or
 * included in any issue.
 */
export const BOT_TOKEN_PATTERN = /^[0-9]{6,16}:[A-Za-z0-9_-]{30,}$/;

/**
 * OWNER_TELEGRAM_ID: a positive Telegram numeric user ID represented safely.
 * Canonical decimal digits only (no signs, spaces, or leading zeros) and,
 * after parsing, at most Number.MAX_SAFE_INTEGER.
 */
export const OWNER_TELEGRAM_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

/**
 * TARGET_CHANNEL: safe public-channel username format — a leading '@',
 * 5–32 characters, starting with a letter and ending with a letter or digit.
 */
export const TARGET_CHANNEL_PATTERN = /^@[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;

export const PHASE_2_CONFIG_SPEC: ConfigSpec = defineConfigSpec([
  {
    name: 'TELEGRAM_INGRESS_ENABLED',
    type: 'enum',
    required: false,
    secret: false,
    allowed: [...TELEGRAM_INGRESS_FLAG_VALUES],
    default: 'false',
    description: 'Telegram webhook ingress feature flag (non-secret).',
    phase: 2,
  },
  {
    name: 'TARGET_CHANNEL',
    type: 'string',
    required: false,
    secret: false,
    pattern: TARGET_CHANNEL_PATTERN,
    description: 'Target public channel username (non-secret — ADR-0009).',
    phase: 2,
  },
  {
    name: 'BOT_TOKEN',
    type: 'string',
    required: false,
    secret: true,
    pattern: BOT_TOKEN_PATTERN,
    description: 'Telegram bot token; structurally validated, never echoed.',
    phase: 2,
  },
  {
    name: 'WEBHOOK_SECRET',
    type: 'string',
    required: false,
    secret: true,
    pattern: WEBHOOK_SECRET_PATTERN,
    description: 'Shared webhook secret; minimum strength 32 chars of [A-Za-z0-9_-].',
    phase: 2,
  },
  {
    name: 'OWNER_TELEGRAM_ID',
    type: 'string',
    required: false,
    secret: true,
    pattern: OWNER_TELEGRAM_ID_PATTERN,
    description: 'Owner Telegram numeric user ID (positive safe integer).',
    phase: 2,
  },
]);

/**
 * Names of the secrets that become REQUIRED once ingress is enabled:
 * WEBHOOK_SECRET (webhook security) and OWNER_TELEGRAM_ID (authorization
 * bootstrap). BOT_TOKEN is deliberately ABSENT — it is validated whenever
 * present, but stays optional so the ingress runs in documented OFFLINE
 * mode (routed actions skipped, no live calls) until Phase 2B wiring.
 */
export const INGRESS_REQUIRED_SECRETS = ['WEBHOOK_SECRET', 'OWNER_TELEGRAM_ID'] as const;

export interface TelegramPhase2Config {
  readonly ingressEnabled: boolean;
  /** Present only when structurally valid. Never log or echo. */
  readonly botToken?: string;
  /** Present only when it satisfies the minimum-strength pattern. Never log or echo. */
  readonly webhookSecret?: string;
  /** Parsed positive safe integer owner ID. */
  readonly ownerTelegramId?: number;
  readonly targetChannel?: string;
}

function withIssue(result: ConfigValidationResult, issue: ConfigIssue): ConfigValidationResult {
  return { ok: false as const, config: result.config, issues: [...result.issues, issue] };
}

function orUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Parse and validate the Phase 2 configuration subset.
 *
 * Like the Phase 1A parser (and unlike Phase 0), this never coerces: when
 * validation fails, `config` is `null` and callers must fail safely
 * (readiness -> not_ready; webhook route -> behaves like an unknown route /
 * rejects closed). Issues carry field names and reason codes only.
 */
export function parseTelegramPhase2Config(env: Readonly<Record<string, unknown>>): {
  readonly config: TelegramPhase2Config | null;
  readonly result: ConfigValidationResult;
} {
  let result = validateConfig(env, PHASE_2_CONFIG_SPEC);

  const flag = result.config['TELEGRAM_INGRESS_ENABLED'];
  const ingressEnabled = flag === 'true';

  if (ingressEnabled) {
    for (const name of INGRESS_REQUIRED_SECRETS) {
      const value = result.config[name];
      if (typeof value !== 'string' || value === '') {
        result = withIssue(result, {
          field: name,
          reason: 'missing_required',
          note: 'required Phase 2 secret is not set while Telegram ingress is enabled',
        });
      }
    }
  }

  const ownerId = result.config['OWNER_TELEGRAM_ID'];
  if (typeof ownerId === 'string' && ownerId !== '') {
    const parsed = Number.parseInt(ownerId, 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      // The pattern bounds the shape; this enforces the SAFE-integer bound.
      result = withIssue(result, {
        field: 'OWNER_TELEGRAM_ID',
        reason: 'invalid_value',
        note: 'value must be a positive Telegram user ID within the safe integer range',
      });
    }
  }

  if (!result.ok) {
    return { config: null, result };
  }

  return {
    config: {
      ingressEnabled,
      botToken: orUndefined(result.config['BOT_TOKEN']),
      webhookSecret: orUndefined(result.config['WEBHOOK_SECRET']),
      ownerTelegramId: orUndefined(result.config['OWNER_TELEGRAM_ID'])?.length
        ? Number.parseInt(result.config['OWNER_TELEGRAM_ID'] as string, 10)
        : undefined,
      targetChannel: orUndefined(result.config['TARGET_CHANNEL']),
    },
    result,
  };
}
