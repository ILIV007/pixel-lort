/**
 * POST /telegram/webhook — secure Telegram ingress edge (Phase 2A).
 *
 * Security posture (docs/SECURITY_MODEL.md trust boundaries):
 * - The route exists ONLY while TELEGRAM_INGRESS_ENABLED is 'true' AND the
 *   Phase 2 configuration is fully valid. A disabled or misconfigured
 *   ingress behaves exactly like an unknown route (uniform safe 404), so
 *   probing reveals neither route existence nor configuration state.
 * - Request lifecycle (fail-closed order):
 *     1. shared-secret header verified with a TIMING-SAFE comparison
 *        (Web Crypto HMAC strategy — see shared/security/timing-safe.ts);
 *     2. JSON content type enforced;
 *     3. conservative body-size cap enforced as TRUE BOUNDED STREAM READING
 *        (ADR-0028): an untrusted Content-Length is rejected early when
 *        oversized/malformed, and the body is then read from the byte
 *        stream with a strict cap — reading STOPS and the stream is
 *        CANCELLED once the cap is crossed; the complete body is never
 *        buffered before the limit is applied. Decoding is strict UTF-8.
 *     4. strict JSON parsing;
 *     5. bounded Update parsing (never throws, stable reason codes).
 * - Non-POST methods on this path never reach the handler: the allowlist
 *   router rejects them with the same uniform safe 404 as unknown routes.
 * - The request body, the secret header value, message text, usernames,
 *   phone numbers, and the Bot Token are NEVER logged. Logs carry stable
 *   event names and reason codes only.
 * - Response semantics mirror the durable update lifecycle (ADR-0027/0030/0031):
 *     - duplicate-of-processed and TERMINAL permanent-failure outcomes answer
 *       the fast deterministic 200 {"ok":true};
 *     - a RETRYABLE processing failure REJECTS with HTTP 503 semantics so
 *       Telegram redelivers and the failed row is reclaimed — a temporary
 *       failure can never be falsely acknowledged as success;
 *     - an IN-FLIGHT update (an active claim lease held by another delivery)
 *       ALSO answers safe retryable 503 semantics — never a false-success
 *       200 — so Telegram keeps redelivering until the lease resolves (the
 *       winner completes, or the lease expires and the abandoned claim
 *       becomes reclaimable; ADR-0030).
 * - Responses are fast and deterministic; standard security headers and
 *   correlation-ID behavior are applied by the shared worker/response paths.
 */
import { AppError, type AppErrorCode } from '../../../shared/errors/app-error';
import { parseWorkerConfig } from '../../../shared/config/phase0';
import { parseTelegramPhase2Config } from '../../../shared/config/phase2';
import { timingSafeEqualStrings } from '../../../shared/security/timing-safe';
import {
  BoundedReadError,
  decodeUtf8Strict,
  parseContentLengthHeader,
  readStreamBounded,
} from '../../../shared/http/bounded-reader';
import type { WorkerEnv } from '../../../shared/types/env';
import { createTelegramIngress } from '../../../application/telegram-ingress';
import { createAuthorizationService } from '../../../admin/authorization';
import { createCommandRouter } from '../../../admin/command-router';
import { createDbExecutor } from '../../../adapters/db/db-executor';
import { createBotApiClient } from '../../../adapters/telegram/bot-api-client';
import { createAdminRoleLookup } from '../../../adapters/telegram/admin-lookup';
import { parseTelegramUpdate } from '../../../adapters/telegram/update-parser';
import { systemClock } from '../../../shared/time/clock';
import type { Logger } from '../../../observability/logger';
import { jsonResponse } from '../responses';

/** Telegram delivers the shared secret in this header. */
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Conservative webhook body cap (64 KiB). Admin-panel updates (commands,
 * edited messages, callback queries) are far below this; the cap is a
 * DoS bound, not a Telegram-protocol boundary.
 */
export const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

export interface TelegramWebhookRouteContext {
  readonly logger: Logger;
}

/** Stable rejection reason codes — never values. */
export type TelegramWebhookRejectionReason =
  | 'secret_unavailable'
  | 'invalid_secret'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'malformed_json'
  | 'invalid_content_length'
  | 'invalid_update';

const REJECTION_ERROR_CODE: Readonly<
  Record<Exclude<TelegramWebhookRejectionReason, 'invalid_update'>, AppErrorCode>
> = {
  secret_unavailable: 'unauthorized',
  invalid_secret: 'unauthorized',
  unsupported_media_type: 'unsupported_media_type',
  payload_too_large: 'payload_too_large',
  malformed_json: 'bad_request',
  invalid_content_length: 'bad_request',
};

/**
 * Build a rejection AppError for a stable reason code.
 *
 * The helper is async on purpose: awaiting it introduces a microtask
 * boundary BEFORE the caller's `throw`, so every rejection leaves the
 * handler through the awaited code path (a synchronous throw from the top
 * of an async fetch handler is reported as an unhandled rejection by the
 * Workers test runtime).
 */
async function rejectionError(
  logger: Logger,
  reason: TelegramWebhookRejectionReason,
): Promise<AppError> {
  logger.warn('telegram.webhook.rejected', { reason });
  // 'invalid_update' also maps to bad_request; both share the safe 400 body.
  return new AppError(reason === 'invalid_update' ? 'bad_request' : REJECTION_ERROR_CODE[reason]);
}

async function uniformNotFoundRejection(): Promise<AppError> {
  return new AppError('not_found');
}

function isJsonContentType(header: string | null): boolean {
  if (header === null) {
    return false;
  }
  const mediaType = header.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json';
}

export async function handleTelegramWebhook(
  request: Request,
  env: WorkerEnv,
  ctx: TelegramWebhookRouteContext,
): Promise<Response> {
  const phase2 = parseTelegramPhase2Config(env as Readonly<Record<string, unknown>>);
  if (phase2.config === null || !phase2.config.ingressEnabled) {
    // Disabled or misconfigured ingress: uniform unknown-route behavior.
    throw await uniformNotFoundRejection();
  }

  const expectedSecret = phase2.config.webhookSecret;
  if (expectedSecret === undefined) {
    // Cannot verify ANY caller — fail closed without leaking why.
    throw await rejectionError(ctx.logger, 'secret_unavailable');
  }

  const providedSecret = request.headers.get(TELEGRAM_SECRET_HEADER);
  if (providedSecret === null || !(await timingSafeEqualStrings(providedSecret, expectedSecret))) {
    throw await rejectionError(ctx.logger, 'invalid_secret');
  }

  if (!isJsonContentType(request.headers.get('content-type'))) {
    throw await rejectionError(ctx.logger, 'unsupported_media_type');
  }

  // Early Content-Length check — UNTRUSTED and never the only gate: an
  // oversized or malformed declaration is rejected BEFORE any byte is read,
  // while the actual byte stream is still capped independently below.
  const contentLength = parseContentLengthHeader(
    request.headers.get('content-length'),
    TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
  );
  if (contentLength.kind === 'invalid') {
    throw await rejectionError(ctx.logger, 'invalid_content_length');
  }
  if (contentLength.kind === 'oversized') {
    throw await rejectionError(ctx.logger, 'payload_too_large');
  }

  // Read the body only after the caller is verified: TRUE bounded stream
  // reading (ADR-0028). The reader stops and CANCELS the stream as soon as
  // the cap is crossed — the complete body is never buffered first, and
  // Content-Length can never substitute for the byte-level cap.
  let rawBytes: Uint8Array;
  try {
    rawBytes = await readStreamBounded(request.body, TELEGRAM_WEBHOOK_MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BoundedReadError && error.reason === 'too_large') {
      throw await rejectionError(ctx.logger, 'payload_too_large');
    }
    throw await rejectionError(ctx.logger, 'malformed_json');
  }
  // Strict UTF-8: a corrupted body fails safely instead of parsing with
  // silently replaced characters.
  let rawBody: string;
  try {
    rawBody = decodeUtf8Strict(rawBytes);
  } catch {
    throw await rejectionError(ctx.logger, 'malformed_json');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw await rejectionError(ctx.logger, 'malformed_json');
  }

  const parseResult = parseTelegramUpdate(decoded);
  if (!parseResult.ok) {
    ctx.logger.warn('telegram.webhook.rejected', {
      reason: 'invalid_update',
      detail: parseResult.reason,
    });
    throw new AppError('bad_request');
  }

  ctx.logger.info('telegram.update.classified', { kind: parseResult.update.kind });

  // Durable idempotency requires D1 (no in-memory-only dedup, no KV):
  // without the binding the ingress fails closed as unavailable.
  if (env.DB === undefined) {
    ctx.logger.warn('telegram.webhook.unavailable', { reason: 'db_binding_missing' });
    throw new AppError('service_unavailable');
  }
  const executor = createDbExecutor(env.DB);

  const ingress = createTelegramIngress({
    executor,
    authorization: createAuthorizationService({
      ownerTelegramId: phase2.config.ownerTelegramId,
      lookup: createAdminRoleLookup(executor),
    }),
    commandRouter: createCommandRouter({
      applicationVersion: parseWorkerConfig(env as Readonly<Record<string, unknown>>).config
        .APP_VERSION,
      // expectedBotUsername is NOT wired in Phase 2A: no live getMe and no
      // username source exists yet, so every explicitly-targeted command is
      // ignored (fail closed). Wiring arrives with Phase 2B.
    }),
    // Offline mode without BOT_TOKEN: noop actions complete; outbound
    // actions fail retryably (never silently skipped-and-acked).
    botApi:
      phase2.config.botToken !== undefined
        ? createBotApiClient({ botToken: phase2.config.botToken, logger: ctx.logger })
        : undefined,
    clock: systemClock,
    logger: ctx.logger,
  });
  // Outcome semantics (ADR-0027/0030/0031): duplicates of PROCESSED updates
  // and TERMINAL permanent failures answer the deterministic 2xx; an
  // IN-FLIGHT update (active lease elsewhere) or a RETRYABLE failure
  // REJECTS with 503 semantics (the durable telegram_updates row is the
  // source of truth; Telegram redelivery either reclaims the failed row,
  // reclaims the stale lease, or observes the winner's completion).
  await ingress.processUpdate(parseResult.update);
  return jsonResponse(200, { ok: true });
}
