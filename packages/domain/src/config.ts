import { z } from 'zod';
import { LIMITS } from './enums';

const int = (def: number) => z.coerce.number().int().positive().default(def);
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

/**
 * Domain/runtime configuration from environment variables. Every name here is
 * documented in .env.example. Provider configuration lives in
 * @culture-atlas/providers (providers/src/config.ts).
 */
export const DomainConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgres://culture_atlas:culture_atlas@localhost:5432/culture_atlas'),
  DATABASE_POOL_MAX: int(10),
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  /** HMAC secret for session tokens and CSRF. Required in production. */
  SESSION_SECRET: z.string().default('dev-only-session-secret-change-me'),
  /** 32-byte key (base64) for encrypting sensor viewer credentials at rest. */
  CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  COMPILER_VERSION: z.string().default('compiler-2026-10-13'),
  ANON_SESSION_TTL_HOURS: int(LIMITS.anonymousTtlHours),
  ACCOUNT_SESSION_TTL_DAYS: int(30),
  AGENT_TOKEN_DEFAULT_TTL_DAYS: int(30),
  UPLOAD_MAX_BYTES: int(LIMITS.uploadMaxBytes),
  UPLOAD_MAX_PIXELS: int(LIMITS.decodedMaxPixels),
  IMAGE_MAX_EDGE: int(LIMITS.derivativeMaxEdge),
  STORE_ORIGINALS: bool(false),
  WORKER_CONCURRENCY: int(5),
  WORKER_POLL_MS: int(500),
  JOB_LEASE_MS: int(30_000),
  JOB_HEARTBEAT_MS: int(10_000),
  JOB_MAX_ATTEMPTS: int(3),
  ANALYSIS_DEADLINE_MS: int(LIMITS.analysisDeadlineMs),
  JOB_MAX_QLOO_REQUESTS: int(LIMITS.qlooRequestsPerJob),
  JOB_MAX_RESEARCH_REFS: int(LIMITS.researchedReferencesMax),
  JOB_MAX_PROVIDER_RETRIES: int(LIMITS.providerRetriesPerStage),
  ANON_DAILY_ANALYSES: int(10),
  ANON_DAILY_PLANS: int(5),
  ACCOUNT_DAILY_ANALYSES: int(100),
  ACCOUNT_DAILY_PLANS: int(50),
  /** Live Qloo searches per account per day from the taste pickers (amendment 2.2; the hackathon key is shared). */
  ACCOUNT_DAILY_ONBOARDING_SEARCHES: int(200),
  /** Taste seed jobs per account per day (onboarding completion plus Settings -> Taste reseeds). */
  ACCOUNT_DAILY_TASTE_SEEDS: int(12),
  IP_DAILY_REQUESTS: int(2000),
  /**
   * Reverse proxies in front of the web app that append to X-Forwarded-For.
   * The client address is the entry that many hops from the right; entries
   * further left are client-supplied and never trusted.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
  /**
   * Optional header the edge platform sets to the verified client address
   * (e.g. cf-connecting-ip). Only set this when the platform overwrites any
   * client-supplied value; it then takes precedence over X-Forwarded-For.
   */
  CLIENT_IP_HEADER: z.string().optional(),
  SENSOR_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  SENSOR_POLL_INTERVAL_MS: int(10_000),
  SENSOR_MAX_ASSET_BYTES: int(LIMITS.uploadMaxBytes),
  /** Comma-separated account ids allowed to open the demo inspector for their own jobs. */
  /**
   * Feature flags evaluated inside services (feature-flags.ts
   * requireServiceFeature). Raw strings so the evaluation rules stay identical
   * to resolveFeatureFlags: "false"/"0" turns a default-on flag off, "true"/"1"
   * opts in to a default-off flag. FEATURE_KILL_SWITCHES is a comma-separated
   * list of killable flag names.
   */
  AGENT_API_ENABLED: z.string().optional(),
  COLLECTION_SHARING_ENABLED: z.string().optional(),
  AGENT_REMOTE_CAPTURE_ENABLED: z.string().optional(),
  /** Spec amendment 2.2 switches (default on): onboarding gate, taste seed job, "While we look". */
  ONBOARDING_REQUIRED: z.string().optional(),
  TASTE_SEED_ENABLED: z.string().optional(),
  WHILE_WE_LOOK_ENABLED: z.string().optional(),
  /**
   * Photo-role requalification: the independent verifier (vision_verify) runs
   * only when this is "true"/"1" (default off until the tune-split evaluation
   * enables it) and the role is qualified; the kill switch
   * analysis_verifier_enabled turns it off.
   */
  ANALYSIS_VERIFIER_ENABLED: z.string().optional(),
  FEATURE_KILL_SWITCHES: z.string().optional(),
  DEMO_INSPECTOR_ACCOUNT_IDS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
});

export type DomainConfig = z.infer<typeof DomainConfigSchema>;

let cached: DomainConfig | undefined;

/** Treat empty strings (e.g. `NAME=` copied from .env.example) as unset. */
export function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== '') out[k] = v;
  return out;
}

/**
 * Load the repo-root `.env` (gitignored) into process.env without overriding
 * variables that are already set. Called by next.config.ts, the worker and scripts.
 */
export function loadRootEnv(rootDir: string): void {
  try {
    process.loadEnvFile(`${rootDir}/.env`);
  } catch {
    // No .env file: rely on the real environment.
  }
}

export function loadDomainConfig(env: Record<string, string | undefined> = process.env): DomainConfig {
  const parsed = DomainConfigSchema.parse(cleanEnv(env));
  if (parsed.NODE_ENV === 'production' && parsed.SESSION_SECRET.startsWith('dev-only')) {
    throw new Error('SESSION_SECRET must be set in production');
  }
  return parsed;
}

export function getDomainConfig(): DomainConfig {
  cached ??= loadDomainConfig();
  return cached;
}

export function setDomainConfigForTesting(config: DomainConfig | undefined): void {
  cached = config;
}
