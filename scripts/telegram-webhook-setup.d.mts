export class TelegramSetupError extends Error {
  readonly code: string;
  readonly method?: string;
  readonly errorKind?: string;
}
export function setupPreviewWebhook(
  config: { botToken: string; webhookSecret: string; ownerId: string },
  fetchImpl?: typeof fetch,
): Promise<{ status: 'verified'; botUsername: string; pendingUpdateCount: number }>;
