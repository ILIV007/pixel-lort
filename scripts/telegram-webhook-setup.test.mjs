import test from 'node:test';
import assert from 'node:assert/strict';
import { setupPreviewWebhook, TelegramSetupError } from './telegram-webhook-setup.mjs';

const config = {
  botToken: '0000000000:FAKE-FAKE-FAKE-FAKE-FAKE-FAKE-000000',
  webhookSecret: 'FAKE_WEBHOOK_SECRET_FOR_OFFLINE_TESTS_ONLY_0000',
  ownerId: '555000111',
};
const target = 'https://pixel-preview.pixellort.workers.dev/telegram/webhook';
const identity = { id: 42, is_bot: true, username: 'pixel_test_bot' };
const info = { url: '', pending_update_count: 0 };
const verified = {
  ...info,
  url: target,
  allowed_updates: ['message', 'edited_message', 'callback_query'],
};
const json = (result) => new Response(JSON.stringify({ ok: true, result }));
function fixtures(results) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ method: url.split('/').at(-1), init, payload: JSON.parse(init.body) });
    const result = results.shift();
    return result instanceof Response ? result : json(result);
  };
  return { calls, fetchImpl };
}

test('checks identity/status, registers shared secret, preserves pending updates and verifies', async () => {
  const { calls, fetchImpl } = fixtures([identity, info, true, verified]);
  assert.deepEqual(await setupPreviewWebhook(config, fetchImpl), {
    status: 'verified',
    botUsername: identity.username,
    pendingUpdateCount: 0,
  });
  assert.deepEqual(
    calls.map((c) => c.method),
    ['getMe', 'getWebhookInfo', 'setWebhook', 'getWebhookInfo'],
  );
  assert.equal(calls[2].payload.secret_token, config.webhookSecret);
  assert.equal(calls[2].payload.drop_pending_updates, false);
  assert.equal(calls[2].payload.max_connections, 4);
  assert.equal(calls[2].payload.url, target);
  assert.ok(calls.every((c) => c.init.redirect === 'manual' && c.init.signal));
});

test('refuses to replace a different existing webhook', async () => {
  const { calls, fetchImpl } = fixtures([identity, { ...info, url: 'https://example.com/old' }]);
  await assert.rejects(setupPreviewWebhook(config, fetchImpl), {
    code: 'existing_webhook_conflict',
  });
  assert.equal(calls.length, 2);
});

test('can safely rebind the same endpoint without dropping pending updates', async () => {
  const { calls, fetchImpl } = fixtures([identity, verified, true, verified]);
  await setupPreviewWebhook(config, fetchImpl);
  assert.equal(calls[2].payload.drop_pending_updates, false);
});

test('rejects invalid config before network', async () => {
  await assert.rejects(
    setupPreviewWebhook({ ...config, webhookSecret: 'short' }, () => {
      assert.fail('network must not run');
    }),
    { code: 'config_invalid' },
  );
});

test('invalid bot identity never registers webhook', async () => {
  const { calls, fetchImpl } = fixtures([{ ...identity, is_bot: false }]);
  await assert.rejects(setupPreviewWebhook(config, fetchImpl), { code: 'identity_invalid' });
  assert.equal(calls.length, 1);
});

test('token rejection is stable and never copies provider text', async () => {
  const { fetchImpl } = fixtures([
    new Response('provider payload containing secrets', { status: 401 }),
  ]);
  await assert.rejects(setupPreviewWebhook(config, fetchImpl), (e) => {
    assert.ok(e instanceof TelegramSetupError);
    assert.equal(e.code, 'token_rejected');
    assert.equal(e.cause, undefined);
    assert.ok(!e.message.includes('provider'));
    return true;
  });
});

test('transport errors cannot expose the tokenized request URL', async () => {
  await assert.rejects(
    setupPreviewWebhook(config, () => {
      throw new Error(config.botToken);
    }),
    (e) => {
      assert.equal(e.code, 'transport_or_response_error');
      assert.ok(!String(e).includes(config.botToken));
      assert.equal(e.cause, undefined);
      return true;
    },
  );
});

test('rejects oversized declared responses before parsing', async () => {
  const { fetchImpl } = fixtures([new Response('{}', { headers: { 'content-length': '40000' } })]);
  await assert.rejects(setupPreviewWebhook(config, fetchImpl), { code: 'response_invalid' });
});

test('rejects oversized streamed responses without a length header', async () => {
  const { fetchImpl } = fixtures([new Response('x'.repeat(40000))]);
  await assert.rejects(setupPreviewWebhook(config, fetchImpl), { code: 'response_invalid' });
});

test('requires explicit registration success', async () => {
  const { fetchImpl } = fixtures([identity, info, false]);
  await assert.rejects(setupPreviewWebhook(config, fetchImpl), { code: 'webhook_set_rejected' });
});

test('checks actual webhook URL and allowed update types after registration', async () => {
  const { fetchImpl } = fixtures([
    identity,
    info,
    true,
    { ...verified, allowed_updates: ['message'] },
  ]);
  await assert.rejects(setupPreviewWebhook(config, fetchImpl), {
    code: 'webhook_verification_failed',
  });
});

test('default fetch keeps the global receiver required by the Worker runtime', async () => {
  const original = globalThis.fetch;
  const { fetchImpl } = fixtures([identity, info, true, verified]);
  globalThis.fetch = function (...args) {
    assert.equal(this, globalThis);
    return fetchImpl(...args);
  };
  try {
    assert.equal((await setupPreviewWebhook(config)).status, 'verified');
  } finally {
    globalThis.fetch = original;
  }
});

test('network-body cleanup cannot mask a token rejection', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    body: {
      cancel: async () => {
        throw new TypeError('fake native cleanup failure');
      },
    },
  });
  await assert.rejects(setupPreviewWebhook(config, fetchImpl), { code: 'token_rejected' });
});

test('manual redirect mode rejects 3xx without following or copying Location', async () => {
  let calls = 0;
  await assert.rejects(
    setupPreviewWebhook(config, async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/untrusted' },
      });
    }),
    { code: 'redirect_rejected' },
  );
  assert.equal(calls, 1);
});
