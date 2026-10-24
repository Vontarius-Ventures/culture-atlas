import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

/**
 * Provider configuration from environment variables (all documented in .env.example).
 * Absent keys never throw: the matching capability reports 'unavailable/not_configured'.
 */
/**
 * Live Featherless catalog pin (2026-10-22 `GET /v1/models`, HTTP 200).
 * Explicit `LLM_PROVIDER=featherless` rollback only — never an automatic
 * fallback from Concentrate. The catalog listed `features.image_input: true`.
 */
export const PINNED_FEATHERLESS_ROLLBACK = {
  catalogFetchedAt: '2026-10-22T03:19:12.000Z',
  model: 'google/gemma-3-27b-it',
  imageInput: true,
} as const;

/** Default models per LLM provider (override with VLM_MODEL / RESEARCH_MODEL / COMPOSER_MODEL). */
export const DEFAULT_MODELS = {
  // Featherless serves vision on Gemma- and Mistral-class models; Gemma 3 27B handles both image and text.
  featherless: {
    vlm: PINNED_FEATHERLESS_ROLLBACK.model,
    text: PINNED_FEATHERLESS_ROLLBACK.model,
  },
  anthropic: { vlm: 'claude-sonnet-5-5', text: 'claude-sonnet-5-5' },
  // Empty on purpose: a catalog pin is not a dispatch default. After the
  // 2026-10-22 live catalog run the documented IDs are anthropic/claude-haiku-5-5
  // (PINNED_CONCENTRATE_ROUTES). Set VLM_MODEL / RESEARCH_MODEL as assertions
  // against a profile file; do not bake a marketing-page example here.
  concentrate: { vlm: '', text: '' },
} as const;

const BaseProviderConfigSchema = z.object({
  /**
   * Which LLM gateway backs the VLM and text models. Concentrate is the v2
   * default. featherless/anthropic remain explicit operational rollback
   * options only: nothing ever falls back to them automatically.
   */
  LLM_PROVIDER: z.enum(['featherless', 'anthropic', 'concentrate']).default('concentrate'),
  CONCENTRATE_API_KEY: optional,
  CONCENTRATE_BASE_URL: z
    .literal('https://api.concentrate.ai/v1')
    .default('https://api.concentrate.ai/v1'),
  CONCENTRATE_PROFILE_FILE: optional,
  /** Same array as CONCENTRATE_PROFILE_FILE, inline (for hosted secret/parameter stores). */
  CONCENTRATE_PROFILES_JSON: optional,
  /** Directory with catalog-snapshot.json and qualification artifacts (scripts/qualify-concentrate.ts). */
  CONCENTRATE_QUALIFICATION_DIR: optional,
  CONCENTRATE_REQUIRE_ZDR: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  CONCENTRATE_ALLOW_CONTENT_LOGGING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  CONCENTRATE_GATEWAY_FALLBACKS_ENABLED: z.literal('false').default('false'),
  /**
   * Operator demo override (never production): comma-separated model roles
   * (e.g. `vision_photo,vision_video_frame,vision_photo_enrich`) whose
   * catalog-compatible profile may dispatch although no passing qualification
   * artifact exists. Results are labelled "Experimental reading". Ignored when
   * NODE_ENV=production.
   */
  CONCENTRATE_DEMO_ALLOW_ROLES: optional,
  /**
   * Production experimental mode (style design §D.1): comma-separated model
   * roles allowed to dispatch UNQUALIFIED in any NODE_ENV (only when their
   * profile is catalog-compatible), always marked experimental so every
   * client labels the result. Separate from CONCENTRATE_DEMO_ALLOW_ROLES,
   * which stays refused in production.
   */
  ANALYSIS_EXPERIMENTAL_ROLES: optional,
  /**
   * Static kill switch for ANALYSIS_EXPERIMENTAL_ROLES ("false"/"0" turns every
   * experimental runner off). The runtime switch is the feature flag
   * experimental_analysis_enabled (feature_flag_kills), checked per job.
   */
  ANALYSIS_EXPERIMENTAL_ENABLED: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  /** Daily spend bucket (USD) for experimental roles, inside MODEL_DAILY_SPEND_LIMIT_USD. */
  ANALYSIS_EXPERIMENTAL_DAILY_SPEND_LIMIT_USD: z.coerce.number().positive().default(5),
  /** Experimental analyses (jobs using an experimental role) per account per UTC day. */
  ANALYSIS_EXPERIMENTAL_ACCOUNT_DAILY: z.coerce.number().int().positive().default(20),
  /**
   * Largest worst-case cost (USD) one style call may reserve (R-12). The
   * reservation is computed from catalog prices; a profile whose worst case
   * exceeds this cap gets no runner (readiness reason spend_cap).
   */
  STYLE_MAX_CALL_USD: z.coerce.number().positive().default(0.05),
  NODE_ENV: optional,
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
  /**
   * Elorian (OpenAI-compatible Chat Completions) as an explicit operator-chosen
   * fallback for the vision/text roles when the primary gateway cannot serve a
   * request (unavailable, timeout, incomplete, 429, 5xx). Off unless both
   * MODEL_FALLBACK=elorian and ELORIAN_API_KEY are set.
   */
  MODEL_FALLBACK: z.enum(['none', 'elorian']).default('none'),
  ELORIAN_API_KEY: optional,
  ELORIAN_BASE_URL: z.string().default('https://api.elorian.ai/v1'),
  ELORIAN_MODEL: z.string().default('elorian-1-agent'),
  // Elorian rejects response_format (structured_output_unsupported), so the schema goes in the prompt.
  ELORIAN_JSON_MODE: z.enum(['json_schema', 'json_object', 'none']).default('none'),
  ELORIAN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_BASE_URL: optional,
  VLM_MODEL: optional,
  RESEARCH_MODEL: optional,
  COMPOSER_MODEL: optional,
  VLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  QLOO_API_KEY: optional,
  QLOO_API_URL: z.string().default('https://hackathon.api.qloo.com'),
  QLOO_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Qloo requests in flight at once per process (shared by every caller; the hackathon key throttles bursts). */
  QLOO_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(3),
  /** Minimum gap between two Qloo dispatches in one process (style design R-11; a 429 hit at the 11th call in a second). */
  QLOO_MIN_SPACING_MS: z.coerce.number().int().min(0).max(5_000).default(120),
  /** Qloo requests per UTC day for the shared key across processes (R-11); past it, rails are an honest empty. */
  QLOO_DAILY_REQUEST_LIMIT: z.coerce.number().int().positive().default(1500),
  /** Cross-process token-bucket rate for the shared key, tokens per second (R-11). */
  QLOO_RATE_PER_SECOND: z.coerce.number().positive().max(10).default(8),
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
