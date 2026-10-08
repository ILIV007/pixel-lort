# Preview Telegram live wiring — operator runbook

This slice activates the accepted v1.2.3 application on Preview. Schema stays
at version 2; there is no migration 0003, no production deployment, and no
publishing functionality. Phase 2A historical offline handoffs remain intact.

## Boundaries

- Required Preview secrets: BOT_TOKEN, WEBHOOK_SECRET, OWNER_TELEGRAM_ID.
  Values never enter source, Git, D1 operation records, issues, or logs.
- Preview ingress is enabled in configuration; local defaults stay disabled.
- The owner identity is resolved from OWNER_TELEGRAM_ID. Adding or changing
  admins from inside the bot is NOT implemented by this activation slice.
- Current commands: /start, /help, /status, /version. Explicit /cmd@bot
  targeting remains fail-closed until verified bot-username wiring is added.
- TARGET_CHANNEL and publishing permissions are not needed for private-chat
  administration smoke tests and are not activated here.

## One-time registration without reading Cloudflare secrets

Cloudflare secrets are write-only. `scripts/telegram-webhook-setup.mjs` is an
operator-only helper, not imported by the normal Worker. An owner-authorized,
temporary scheduled wrapper can import it and consume the existing Secret
binding directly inside Cloudflare. Never add a public setup/debug endpoint.

1. Verify existing Preview schema, health, and Secret binding names.
2. Configure owner identity and a random 64-character webhook secret.
3. Create a unique operation journal in the existing `settings` table.
   Record only pending/running/verified/failed status, stable error codes,
   normalized public bot username, and pending-update count — never secrets,
   provider descriptions, webhook bodies, or user identities.
4. The temporary scheduled wrapper atomically claims the pending operation,
   checks getMe and getWebhookInfo, and refuses to overwrite any different
   existing webhook. It performs no automatic retries or message sends.
5. Register the fixed Preview URL with secret_token, bounded concurrency,
   allowed_updates=[message,edited_message,callback_query], and
   drop_pending_updates=false. Verify via getWebhookInfo.
6. Remove the temporary schedule and redeploy the canonical application.
   Verify no remaining schedule and no public operational endpoint.
7. Verify private /start, /help, /status, /version with the owner in Telegram;
   test unauthorized access with a separate account. Do not claim end-to-end
   command delivery succeeded until a real user has exercised it.

The source-controlled scheduled handler remains a no-op. This bootstrap is a
short-lived operator maintenance action, not the future production cron/job
workflow. Do not leave the wrapper or schedule deployed after registration.

## Owner-only admin management requirement

Follow-up implementation must allow the owner to add, list, assign approved
roles to, and deactivate admins from within a private bot conversation. Use
numeric Telegram IDs, server-side authorization on every operation, explicit
confirmation, transactional writes, and safe audit events. Protect the
bootstrap owner from removal/reassignment and prevent privilege escalation.
Test unauthorized calls, stale/replayed confirmations, disabled admins,
role changes, and duplicate Telegram deliveries before rollout.

## Quality gates

`npm run check` includes the existing 449-test Vitest suite and the offline
operator-bootstrap tests. `npm run test:db` independently verifies the 47
schema/migration tests. The bootstrap helper has bounded response reads,
timeouts, redirect rejection, stable errors, and no provider-body logging.
Development-toolchain audit findings remain tracked in GitHub issue #6;
this wiring is not production security clearance.
