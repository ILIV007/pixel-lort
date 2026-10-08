/**
 * One-time operator-only Telegram setup. This module is NOT imported by the
 * normal HTTP/cron handlers. An owner-authorized temporary scheduled wrapper
 * runs it using Cloudflare-bound secrets, then is removed. No public setup
 * endpoint and no token export. Node tests inject fetch; never live traffic.
 */
const PREVIEW_WEBHOOK = 'https://pixel-preview.pixellort.workers.dev/telegram/webhook';
const UPDATE_TYPES = ['message', 'edited_message', 'callback_query'];
const MAX_BYTES = 32 * 1024;

export class TelegramSetupError extends Error {
  constructor(code) {
    super('Telegram setup could not complete');
    this.name = 'TelegramSetupError';
    this.code = code;
  }
}

async function readBounded(response) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) {
    await response.body?.cancel();
    throw new TelegramSetupError('response_invalid');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new TelegramSetupError('response_invalid');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new TelegramSetupError('response_invalid');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    reader.releaseLock();
  }
}

/** Safe result contains normalized PUBLIC bot identity, never provider bodies. */
export async function setupPreviewWebhook({ botToken, webhookSecret, ownerId }, fetchImpl = fetch) {
  if (
    typeof botToken !== 'string' ||
    !/^[0-9]{6,16}:[A-Za-z0-9_-]{30,}$/.test(botToken) ||
    typeof webhookSecret !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret) ||
    typeof ownerId !== 'string' ||
    !/^[1-9][0-9]{0,15}$/.test(ownerId) ||
    !Number.isSafeInteger(Number(ownerId))
  ) {
    throw new TelegramSetupError('config_invalid');
  }

  async function call(method, payload = {}) {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new TelegramSetupError(
          response.status === 401 ? 'token_rejected' : 'api_unavailable',
        );
      }
      const body = await readBounded(response);
      if (body === null || typeof body !== 'object' || body.ok !== true) {
        throw new TelegramSetupError('api_rejected');
      }
      return body.result;
    } catch (error) {
      if (error instanceof TelegramSetupError) {
        error.method = method;
        throw error;
      }
      // Stable diagnostic names only; never transport messages/URLs/causes.
      const safe = new TelegramSetupError('transport_or_response_error');
      safe.method = method;
      safe.errorKind = ['TypeError', 'SyntaxError', 'TimeoutError', 'AbortError', 'Error'].includes(
        error?.name,
      )
        ? error.name
        : 'unknown';
      throw safe;
    }
  }

  const me = await call('getMe');
  if (
    me === null ||
    typeof me !== 'object' ||
    me.is_bot !== true ||
    !Number.isSafeInteger(me.id) ||
    me.id <= 0 ||
    typeof me.username !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(me.username)
  ) {
    throw new TelegramSetupError('identity_invalid');
  }

  function webhookInfo(value) {
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof value.url !== 'string' ||
      value.url.length > 2048 ||
      !Number.isSafeInteger(value.pending_update_count) ||
      value.pending_update_count < 0
    ) {
      throw new TelegramSetupError('webhook_info_invalid');
    }
    return value;
  }

  const before = webhookInfo(await call('getWebhookInfo'));
  if (before.url !== '' && before.url !== PREVIEW_WEBHOOK) {
    throw new TelegramSetupError('existing_webhook_conflict');
  }
  const set = await call('setWebhook', {
    url: PREVIEW_WEBHOOK,
    secret_token: webhookSecret,
    allowed_updates: UPDATE_TYPES,
    max_connections: 4,
    drop_pending_updates: false,
  });
  if (set !== true) throw new TelegramSetupError('webhook_set_rejected');
  const after = webhookInfo(await call('getWebhookInfo'));
  if (
    after.url !== PREVIEW_WEBHOOK ||
    !Array.isArray(after.allowed_updates) ||
    UPDATE_TYPES.some((type) => !after.allowed_updates.includes(type)) ||
    after.allowed_updates.length !== UPDATE_TYPES.length
  ) {
    throw new TelegramSetupError('webhook_verification_failed');
  }
  return {
    status: 'verified',
    botUsername: me.username,
    pendingUpdateCount: after.pending_update_count,
  };
}
