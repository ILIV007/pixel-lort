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
 * - Response semantics mirror the durable update lifecycle
 *   (ADR-0027/0030/0031, final correction v1.2.3):
 *     - duplicate-of-processed and TERMINAL permanent-failure outcomes answer
 *       the fast deterministic 200 {"ok":true} — HTTP 200 is emitted ONLY
 *       after a terminal state is durably persisted (a terminal transition
 *       that is rejected by the claim-generation fence or fails with a
 *       storage error answers safe 503 instead, never a false-success 200);
 *     - a RETRYABLE processing failure REJECTS with HTTP 503 semantics so
 *       Telegram redelivers and the failed row is reclaimed — a temporary
 *       failure can never be falsely acknowledged as success;
 *     - an IN-FLIGHT update (an active claim lease held by another delivery)
 *       ALSO answers safe retryable 503 semantics — never a false-success
 *       200 — so Telegram keeps redelivering until the lease resolves (the
 *       winner completes, or the lease expires and the abandoned claim
 *       becomes reclaimable; ADR-0030). Claim ownership is FENCED by the
 *       attempt_count generation: a stale Worker can never mutate or
 *       acknowledge a newer owner's claim (ADR-0030, v1.2.3).
 * - Responses are fast and deterministic; standard security headers and
 *   correlation-ID behavior are applied by the shared worker/response paths.
 */
import { AppError, type AppErrorCode } from '../../../shared/errors/app-error';
import { parseWorkerConfig } from '../../../shared/config/phase0';
import { parseTelegramPhase2Config } from '../../../shared/config/phase2';
import { parseAdminReviewConfig } from '../../../shared/config/phase9';
import { createAdminQueueDispositionService } from '../../../application/publishing/queue-disposition-service';
import { parseAdminPostConfig } from '../../../shared/config/phase10';
import { parseAiConfig } from '../../../shared/config/phase6';
import { createWorkersAiAdapter } from '../../../adapters/ai/workers-ai-adapter';
import { timingSafeEqualStrings } from '../../../shared/security/timing-safe';
import {
  BoundedReadError,
  decodeUtf8Strict,
  parseContentLengthHeader,
  readStreamBounded,
} from '../../../shared/http/bounded-reader';
import type { WorkerEnv } from '../../../shared/types/env';
import { createTelegramIngress } from '../../../application/telegram-ingress';
import { createEditorialReviewService } from '../../../application/editorial/draft-review-view';
import { createAdminQueueViewService } from '../../../application/publishing/queue-view-service';
import { createAdminStoryViewService } from '../../../application/publishing/story-view-service';
import { createAdminPostService } from '../../../application/admin-post/admin-post-service';
import { createAiInboundRewriter } from '../../../application/inbound/ai-rewriter';
import {
  createInboundPipelineService,
  type InboundTransport,
} from '../../../application/inbound/inbound-pipeline-service';
import { createAdminManageService } from '../../../application/admin-manage/admin-manage-service';
import { createAdminPanelService } from '../../../application/admin-panel/admin-panel-service';
import { createPostManagementService } from '../../../application/publishing/post-management-service';
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

  // R1.18 (ADR-0046): the read-only review gate is parsed fail-closed —
  // absent/false AND any invalid-present value both DISABLE the surface
  // (the invalid value is logged as a stable field/reason pair, never as a
  // value). Enabling it gates ONLY the new /drafts read commands.
  const review = parseAdminReviewConfig(env as Readonly<Record<string, unknown>>);
  if (!review.result.ok) {
    for (const issue of review.result.issues) {
      ctx.logger.warn('telegram.webhook.review_config_invalid', {
        field: issue.field,
        reason: issue.reason,
      });
    }
  }
  const reviewEnabled = review.config.reviewEnabled;
  // Phase 9A: the read-only queue gate is parsed by the SAME fail-closed
  // phase9 config (independent flag; default false).
  const queueEnabled = review.config.queueEnabled;
  // Phase 9B: the read-only story gate is parsed by the SAME fail-closed
  // phase9 config (independent flag; default false).
  const storyEnabled = review.config.storyEnabled;
  // Issue #8: the owner-only admin management gate is parsed by the SAME
  // fail-closed phase9 config (independent flag; default false).
  const adminManageEnabled = review.config.adminManageEnabled;
  // Slice 3: the admin panel gate is parsed by the SAME fail-closed
  // phase9 config (independent flag; default false).
  const panelEnabled = review.config.panelEnabled;
  // Phase 9C: the write-capable queue disposition gate is parsed by the
  // SAME fail-closed phase9 config (INDEPENDENT flag; default false — the
  // disposition is a STOP, never a resend).
  const queueWriteEnabled = review.config.queueWriteEnabled;

  // R1.20-R: the admin post pipeline gates are parsed fail-closed —
  // absent/false AND any invalid-present value both DISABLE (the invalid
  // value is logged as a stable field/reason pair, never as a value).
  // ADMIN_POST_ENABLED gates the capture/preview/approve/callback surface;
  // ADMIN_POST_LIVE_PUBLISH_ENABLED (independent, default false) gates ONLY
  // the actual channel send.
  const adminPostFlags = parseAdminPostConfig(env as Readonly<Record<string, unknown>>);
  if (!adminPostFlags.result.ok) {
    for (const issue of adminPostFlags.result.issues) {
      ctx.logger.warn('telegram.webhook.admin_post_config_invalid', {
        field: issue.field,
        reason: issue.reason,
      });
    }
  }
  const adminPostEnabled = adminPostFlags.config.adminPostEnabled;

  // R1.20-R1: the REAL combined Bot API client is built ONCE and wired BOTH
  // as the legacy action transport AND as the admin post pipeline's
  // direct-entity channel transport (the SAME client instance — no second
  // client, no bypass path). The LIVE flag still gates the send INSIDE the
  // service (a wired transport never implies a live send: while
  // ADMIN_POST_LIVE_PUBLISH_ENABLED is off, the publish action stops BEFORE
  // any publication row or Bot API call). Without BOT_TOKEN the offline
  // mode keeps its documented behavior (adminPost wired without transport:
  // a publish attempt reports honestly and the row stays under its lease).
  const botApi =
    phase2.config.botToken !== undefined
      ? createBotApiClient({ botToken: phase2.config.botToken, logger: ctx.logger })
      : undefined;

  // Slice 4: the inbound AI-admin pipeline is wired ONLY while the admin
  // post gate is ON (it shares the capture surface). The rewriter uses the
  // SAME Workers AI port + budget-authority shape as the editorial draft
  // service; the Gemini fallback stays UNWIRED in production (its
  // versioned eligibility is unverified, so the ladder skips it even if
  // its operator flag were on). The AI flags ship OFF on preview, so the
  // rewriter defers and the pipeline runs on the cleaned text.
  const aiFlags = parseAiConfig(env as Readonly<Record<string, unknown>>);
  const workersAiBindingPresent = env.AI !== undefined;
  const inboundRewriter = createAiInboundRewriter({
    executor,
    ports: workersAiBindingPresent ? { 'workers-ai': createWorkersAiAdapter(env.AI) } : {},
    clock: systemClock,
    logger: ctx.logger,
    config: {
      aiEnabled: aiFlags.config.AI_ENABLED,
      geminiEnabled: aiFlags.config.AI_GEMINI_ENABLED,
      workersAiBindingPresent,
      geminiApiKeyPresent: env.GEMINI_API_KEY !== undefined,
    },
  });
  // The transport adapter maps the SAME real Bot API client instance onto
  // the minimal inbound transport (no second client, no bypass path).
  // Classic sends/edits go through the HTML surface; rich sends/edits and
  // deletes go through their typed methods.
  const inboundTransport: InboundTransport | undefined =
    botApi === undefined
      ? undefined
      : {
          sendMessageRich: (input) => botApi.sendMessageRich(input),
          sendPhotoRich: (input) => botApi.sendPhotoRich(input),
          sendVideoRich: (input) => botApi.sendVideoRich(input),
          sendMessageClassic: (input) =>
            botApi.sendMessage({ chatId: input.chatId, text: input.html }),
          editMessageTextRich: (input) => botApi.editMessageTextRich(input),
          editMessageCaptionRich: (input) => botApi.editMessageCaptionRich(input),
          editMessageTextClassic: (input) =>
            botApi.editMessageText({
              chatId: input.chatId,
              messageId: input.messageId,
              text: input.html,
            }),
          deleteMessage: (input) => botApi.deleteMessage(input),
        };
  // Slice 6: the post-management service owns pins/housekeeping and the
  // in-place edit capture. Wired ONLY while the panel gate is ON AND a
  // target channel is configured (the panel is its only caller surface);
  // the service itself never sends a post and never enables any publish
  // or scheduler path. Without BOT_TOKEN the transport is undefined and
  // pin/delete/edit report honestly as unavailable (the ledger is never
  // written for a call that never happened).
  const postManagement =
    panelEnabled && phase2.config.targetChannel !== undefined
      ? createPostManagementService({
          executor,
          clock: systemClock,
          channelChatId: phase2.config.targetChannel,
          transport: botApi,
          logger: ctx.logger,
        })
      : undefined;

  const inboundPipeline = createInboundPipelineService({
    executor,
    clock: systemClock,
    logger: ctx.logger,
    config: {
      livePublishEnabled: adminPostFlags.config.livePublishEnabled,
      destination: phase2.config.targetChannel,
    },
    transport: inboundTransport,
    rewriter: inboundRewriter,
  });

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
      reviewEnabled,
      adminPostEnabled,
      // R1.22 Phase A: the editorial→post bridge gate (fail-closed, default
      // false) — gates ONLY the /post_from_draft conversion command.
      editorialToPostEnabled: adminPostFlags.config.editorialToPostEnabled,
      // Phase 9A: the read-only /queue gate (fail-closed, default false) —
      // gates ONLY that observation command.
      queueEnabled,
      // Phase 9C: the write-capable queue disposition gate (fail-closed,
      // default false) — gates ONLY the detail view, its cancel button and
      // its single-use callback; the disposition is a STOP, never a resend.
      queueWriteEnabled,
      // Phase 9B: the read-only /story gate (fail-closed, default false) —
      // gates ONLY that observation command.
      storyEnabled,
      // Issue #8: the owner-only /admins gate (fail-closed, default
      // false) — gates ONLY the admin management commands and their
      // single-use confirm/cancel callbacks.
      adminManageEnabled,
      // Slice 3: the /menu admin panel gate (fail-closed, default false)
      // — gates ONLY the main/mode/cap/event screens and their single-use
      // panel callbacks; settings only, never a send path.
      panelEnabled,
    }),
    // R1.18: the read-only review service is wired ONLY while the gate is
    // ON — the SAME production factory the offline demo shares.
    editorialReview: reviewEnabled ? createEditorialReviewService({ executor }) : undefined,
    // Phase 9A: the queue view service is wired ONLY while the gate is ON;
    // the send-gate note on the screen reads the parsed scheduler gate so
    // the observation NEVER pretends a live scheduler exists.
    adminQueueView: queueEnabled
      ? createAdminQueueViewService({
          executor,
          // NO scheduler send-gate config exists yet (the LIVE scheduler
          // wiring is BLOCKED_LIVE — ADR-0058): the screen reads the honest
          // constant false — decision-only observation, never a pretend
          // live scheduler.
          sendGateEnabled: false,
        })
      : undefined,
    // Phase 9B: the story view service is wired ONLY while its gate is ON;
    // the SAME honest send-gate note applies (the screen is observation-
    // only and never pretends a live scheduler exists).
    adminStoryView: storyEnabled
      ? createAdminStoryViewService({
          executor,
          sendGateEnabled: false,
        })
      : undefined,
    // Phase 9C: the write-capable queue disposition service is wired ONLY
    // while its gate is ON — the fenced cancel disposition (a STOP, never a
    // resend) with the deterministic audit event.
    adminQueueDisposition: queueWriteEnabled
      ? createAdminQueueDispositionService({ executor, clock: systemClock })
      : undefined,
    // R1.20-R: the admin post service is wired ONLY while its gate is ON;
    // R1.20-R1: the transport is the SAME real Bot API client instance built
    // above (direct-entity send), and the destination is the
    // operator-configured TARGET_CHANNEL (never user input). The
    // live-publish flag ships OFF and gates the send inside the service.
    adminPost: adminPostEnabled
      ? createAdminPostService({
          executor,
          clock: systemClock,
          logger: ctx.logger,
          config: {
            livePublishEnabled: adminPostFlags.config.livePublishEnabled,
            destination: phase2.config.targetChannel,
          },
          transport: botApi,
          // Slice 4: the inbound delegate — owner posts with no open
          // capture session flow through the inbound pipeline.
          inbound: inboundPipeline,
        })
      : undefined,
    // Slice 4: the inbound pipeline owns the `inbound.*` token callbacks
    // (approval previews). Wired only while the admin post gate is ON.
    inbound: adminPostEnabled ? inboundPipeline : undefined,
    // Issue #8: the admin management service is wired ONLY while its gate
    // is ON. The bootstrap owner id comes from the parsed Phase 2 config
    // (the protected identity); the service never reads it from chat.
    adminManage: adminManageEnabled
      ? createAdminManageService({
          executor,
          clock: systemClock,
          ownerTelegramId: phase2.config.ownerTelegramId,
        })
      : undefined,
    // Slice 3: the admin panel service is wired ONLY while its gate is
    // ON. Settings only — it never sends a post and never enables any
    // publish or scheduler path. The bootstrap owner id comes from the
    // parsed Phase 2 config (the protected identity).
    adminPanel: panelEnabled
      ? createAdminPanelService({
          executor,
          clock: systemClock,
          ownerTelegramId: phase2.config.ownerTelegramId,
          postManagement,
        })
      : undefined,
    // Slice 6: the in-place edit capture is consumed by the ingress
    // (a text message completes an open edit instead of starting a
    // new admin post). Wired ONLY while the panel gate is ON.
    postManagement,
    // Offline mode without BOT_TOKEN: noop actions complete; outbound
    // actions fail retryably (never silently skipped-and-acked).
    botApi,
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
