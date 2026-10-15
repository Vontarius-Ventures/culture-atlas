import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

/**
 * Provider configuration from environment variables (all documented in .env.example).
 * Absent keys never throw: the matching capability reports 'unavailable/not_configured'.
 */
/** Default models per LLM provider (override with VLM_MODEL / RESEARCH_MODEL / COMPOSER_MODEL). */
export const DEFAULT_MODELS = {
  // Featherless serves vision on Gemma- and Mistral-class models; Gemma 3 27B handles both image and text.
  featherless: { vlm: 'google/gemma-3-27b-it', text: 'google/gemma-3-27b-it' },
  anthropic: { vlm: 'claude-sonnet-5-5', text: 'claude-sonnet-5-5' },
  // No route is qualified by default. Profiles must supply exact catalog IDs.
  concentrate: { vlm: '', text: '' },
} as const;

const BaseProviderConfigSchema = z.object({
  /** Which LLM service backs the VLM and text models. */
  LLM_PROVIDER: z.enum(['featherless', 'anthropic', 'concentrate']).default('featherless'),
  CONCENTRATE_API_KEY: optional,
  CONCENTRATE_BASE_URL: z
    .literal('https://api.concentrate.ai/v1')
    .default('https://api.concentrate.ai/v1'),
  CONCENTRATE_PROFILE_FILE: optional,
  CONCENTRATE_REQUIRE_ZDR: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  CONCENTRATE_ALLOW_CONTENT_LOGGING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  CONCENTRATE_GATEWAY_FALLBACKS_ENABLED: z.literal('false').default('false'),
  MODEL_DAILY_SPEND_LIMIT_USD: z.coerce.number().positive().optional(),
  MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD: z.coerce.number().positive().optional(),
  MODEL_MAX_UNKNOWN_SPEND_USD: z.coerce.number().positive().optional(),
  ACCOUNT_DAILY_MEDIA_ANALYSES: z.coerce.number().int().positive().default(50),
  FEATHERLESS_API_KEY: optional,
  FEATHERLESS_BASE_URL: z.string().default('https://api.featherless.ai/v1'),
  /**
   * How structured output is requested from Featherless (OpenAI-compatible):
   * json_schema (guided decoding against the zod schema), json_object, or
   * none (schema in the prompt only). Output is always re-validated with zod.
   */
  FEATHERLESS_JSON_MODE: z.enum(['json_schema', 'json_object', 'none']).default('json_object'),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_BASE_URL: optional,
  VLM_MODEL: optional,
  RESEARCH_MODEL: optional,
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
  /** Directory of sanitized recordings captured by scripts/probe-qloo.ts --record (replay only). */
  QLOO_REPLAY_DIR: optional,
  /** Effort for VLM / text calls (low|medium|high). Default medium: latency target is a first section within 10 s. */
  ANTHROPIC_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  /** Server-side refusal fallback on supported models (Claude API only; disable behind proxies that reject it). */
  ANTHROPIC_REFUSAL_FALLBACK: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  RESEARCH_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

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

export const ProviderConfigSchema = BaseProviderConfigSchema.transform((c) => ({
  ...c,
  VLM_MODEL: c.VLM_MODEL ?? DEFAULT_MODELS[c.LLM_PROVIDER].vlm,
  RESEARCH_MODEL: c.RESEARCH_MODEL ?? DEFAULT_MODELS[c.LLM_PROVIDER].text,
}));

export type ProviderConfig = z.output<typeof ProviderConfigSchema>;

export function loadProviderConfig(
  env: Record<string, string | undefined> = process.env,
): ProviderConfig {
  // Empty strings (e.g. `NAME=` copied from .env.example) count as unset.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  return ProviderConfigSchema.parse(cleaned);
}
