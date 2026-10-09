/**
 * Source registry runtime validation (Phase 4 — ADR-0038 §2; blueprint §27
 * "pixel_source_registry_v1.json validates against its application schema").
 *
 * The blueprint registry JSON is imported VERBATIM from
 * docs/blueprint/v1/ — the authoritative, byte-identical catalog. This
 * module builds the runtime validation AROUND it (never edits it) and
 * fails safe: any invalid record invalidates the WHOLE catalog
 * (`parseRegistry` returns a typed failure) so a partially valid catalog
 * can never run.
 *
 * Zod per ADR-0010. Strict object shapes: unknown connector-specific
 * fields are rejected so registry drift fails loudly instead of silently.
 */
import { z } from 'zod';
import blueprintRegistry from '../../../docs/blueprint/v1/pixel_source_registry_v1.json';
import { CATALOG_CONNECTORS } from './types';

/** Bounded bounds mirrors of registry globalPolicies (defense in depth). */
export const INGESTION_LIMITS = {
  httpTimeoutMs: 10_000,
  maxFeedBytes: 2 * 1024 * 1024,
  maxRedirects: 2,
  maxItemsPerFeed: 100,
  excerptMaxChars: 512,
  titleMaxChars: 512,
  authorMaxChars: 256,
  rawJsonMaxBytes: 8 * 1024,
} as const;

/** Connector-specific config schemas (ADR-0039 §1). */
const SteamNewsConfigSchema = z
  .object({
    appsPerBatch: z.number().int().min(1).max(25),
    maxItemsPerApp: z.number().int().min(1).max(10),
  })
  .strict();

const YoutubeConfigSchema = z
  .object({
    useSearchEndpoint: z.literal(false),
    downloadVideo: z.literal(false),
  })
  .strict();

const RedditConfigSchema = z
  .object({
    subreddits: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/))
      .min(1)
      .max(10),
    limit: z.number().int().min(1).max(50),
    stripDownloadLinks: z.boolean().optional(),
  })
  .strict();

const GithubConfigSchema = z
  .object({
    repositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).max(25),
    includePrereleases: z.boolean(),
  })
  .strict();

const BlueskyConfigSchema = z
  .object({
    accounts: z.array(z.string()),
    reposts: z.boolean(),
    replies: z.boolean(),
  })
  .strict();

const IgdbConfigSchema = z
  .object({
    commercialUseAllowed: z.boolean(),
    requestsPerSecond: z.number().int().min(1).max(10),
    onDemand: z.boolean(),
  })
  .strict();

const CONFIG_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  'steam-news': SteamNewsConfigSchema,
  'youtube-playlists': YoutubeConfigSchema,
  'reddit-oauth': RedditConfigSchema,
  'github-releases': GithubConfigSchema,
  'bluesky-public': BlueskyConfigSchema,
  igdb: IgdbConfigSchema,
};

/** Approved auto-publish thresholds (blueprint §11). */
const ThresholdSchema = z.number().int().min(0).max(100).nullable();

const RegistrySourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_]{3,64}$/),
    name: z.string().min(1).max(128),
    connector: z.enum(CATALOG_CONNECTORS as unknown as [string, ...string[]]),
    lane: z.enum(['official', 'editorial', 'radar', 'community', 'media', 'metadata']),
    endpoint: z.string().max(2048).optional(),
    detailsEndpoint: z.string().max(2048).optional(),
    endpointTemplate: z.string().max(2048).optional(),
    endpointTemplates: z.array(z.string().max(2048)).max(4).optional(),
    trustTier: z.number().int().min(0).max(100),
    intervalSeconds: z.number().int().min(60).max(86_400),
    dailyRequestBudget: z.number().int().min(1).max(10_000),
    approvalPolicy: z.enum(['auto', 'threshold', 'approval', 'signal_only', 'never_publish']),
    autoPublishThreshold: ThresholdSchema,
    content: z.array(z.string().max(64)).max(16),
    attribution: z.string().max(128).optional(),
    config: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    // Connector-specific config must match its schema exactly (fail safe).
    const schema = CONFIG_SCHEMAS[source.connector];
    if (schema !== undefined) {
      const parsed = schema.safeParse(source.config ?? {});
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid config for connector ${source.connector}`,
          path: ['config'],
        });
      }
    } else if (source.config !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'connector does not accept config',
        path: ['config'],
      });
    }
    // RSS needs at least one concrete endpoint source.
    if (source.connector === 'rss') {
      const hasEndpoint =
        typeof source.endpoint === 'string' ||
        (Array.isArray(source.endpointTemplates) && source.endpointTemplates.length > 0);
      if (!hasEndpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'rss source requires endpoint or endpointTemplates',
          path: ['endpoint'],
        });
      }
    }
    // signal_only must never carry an auto threshold (blueprint §11).
    if (source.approvalPolicy === 'signal_only' && source.autoPublishThreshold !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'signal_only sources cannot have an autoPublishThreshold',
        path: ['autoPublishThreshold'],
      });
    }
  });

export const RegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    brand: z
      .object({
        channelName: z.string().min(1),
        channelUsername: z.string().min(1),
        botPersona: z.string().min(1),
        footerHtml: z.string().min(1),
      })
      .strict(),
    globalPolicies: z
      .object({
        timezone: z.literal('Asia/Tehran'),
        defaultPublishingMode: z.string(),
        rssConditionalGet: z.boolean(),
        respectRetryAfter: z.boolean(),
        maxRedirects: z.number().int().min(0).max(2),
        httpTimeoutMs: z.number().int().min(1000).max(30_000),
        maxFeedBytes: z.number().int().min(1024),
        maxArticleBytes: z.number().int().min(1024),
        allowHttp: z.literal(false),
        storeRawDays: z.number().int().min(1),
        neverAutoPublishSignalOnly: z.literal(true),
        noPiracyDownloadLinks: z.boolean(),
        youtubeDownloadForbidden: z.literal(true),
      })
      .strict(),
    sources: z.array(RegistrySourceSchema).min(1).max(32),
  })
  .strict();

export type RegistrySource = z.infer<typeof RegistrySourceSchema>;
export type Registry = z.infer<typeof RegistrySchema>;

export type RegistryParseResult =
  | { readonly ok: true; readonly registry: Registry }
  | { readonly ok: false; readonly reason: 'registry_invalid' };

/**
 * Validate the embedded blueprint registry. Returns a typed failure (never
 * throws) so callers can fail closed with a stable code.
 */
export function parseEmbeddedRegistry(): RegistryParseResult {
  const parsed = RegistrySchema.safeParse(blueprintRegistry);
  if (!parsed.success) {
    return { ok: false, reason: 'registry_invalid' };
  }
  return { ok: true, registry: parsed.data };
}

/** Lane-derived scheduling priority (ADR-0038 §2; owner-managed column). */
export function laneDefaultPriority(lane: RegistrySource['lane']): number {
  switch (lane) {
    case 'official':
      return 80;
    case 'media':
      return 60;
    case 'editorial':
      return 60;
    case 'community':
      return 40;
    case 'radar':
      return 30;
    case 'metadata':
      return 20;
  }
}
