import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

/**
 * Provider configuration from environment variables (all documented in .env.example).
 * Absent keys never throw: the matching capability reports 'unavailable/not_configured'.
 */
export const ProviderConfigSchema = z.object({
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_BASE_URL: optional,
  VLM_MODEL: z.string().default('claude-sonnet-5-5'),
  RESEARCH_MODEL: z.string().default('claude-sonnet-5-5'),
  COMPOSER_MODEL: optional,
  VLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  QLOO_API_KEY: optional,
  QLOO_API_URL: z.string().default('https://hackathon.api.qloo.com'),
  QLOO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Allow recorded fixtures as labeled "Example result" when Qloo is unavailable. */
  QLOO_REPLAY_FIXTURES: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  WIKIPEDIA_API_URL: z.string().default('https://en.wikipedia.org/api/rest_v1'),
  WIKIPEDIA_ACTION_API_URL: z.string().default('https://en.wikipedia.org/w/api.php'),
  /** Wikimedia requires a descriptive User-Agent with contact info. */
  WIKIMEDIA_USER_AGENT: z.string().default('culture-atlas/0.1 (development)'),

  STORAGE_DRIVER: z.enum(['local', 's3', 'memory']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.data/objects'),
  STORAGE_SIGNING_SECRET: optional,
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  S3_ENDPOINT: optional,
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: optional,
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  APP_BASE_URL: z.string().default('http://localhost:3000'),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export function loadProviderConfig(env: Record<string, string | undefined> = process.env): ProviderConfig {
  // Empty strings (e.g. `NAME=` copied from .env.example) count as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  return ProviderConfigSchema.parse(cleaned);
}
