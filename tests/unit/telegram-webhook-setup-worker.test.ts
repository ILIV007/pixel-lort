import { describe, expect, it } from 'vitest';
import { setupPreviewWebhook } from '../../scripts/telegram-webhook-setup.mjs';

const config = {
  botToken: '0000000000:FAKE-FAKE-FAKE-FAKE-FAKE-FAKE-000000',
  webhookSecret: 'FAKE_WEBHOOK_SECRET_FOR_OFFLINE_TESTS_ONLY_0000',
  ownerId: '555000111',
};
const url = 'https://pixel-preview.pixellort.workers.dev/telegram/webhook';

describe('operator setup — real Workers stream/runtime, mocked network', () => {
  it('completes using native Worker response streams', async () => {
    const results: unknown[] = [
      { id: 42, is_bot: true, username: 'pixel_test_bot' },
      { url: '', pending_update_count: 0 },
      true,
      {
        url,
        pending_update_count: 0,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
      },
    ];
    await expect(
      setupPreviewWebhook(
        config,
        async () => new Response(JSON.stringify({ ok: true, result: results.shift() })),
      ),
    ).resolves.toMatchObject({ status: 'verified' });
  });

  it('rejects provider status with a stable code', async () => {
    await expect(
      setupPreviewWebhook(
        config,
        async () => new Response('secret provider content', { status: 401 }),
      ),
    ).rejects.toMatchObject({ code: 'token_rejected' });
  });
});
