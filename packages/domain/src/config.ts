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
  IP_DAILY_REQUESTS: int(2000),
  SENSOR_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
  SENSOR_POLL_INTERVAL_MS: int(10_000),
  SENSOR_MAX_ASSET_BYTES: int(LIMITS.uploadMaxBytes),
  /** Comma-separated account ids allowed to open the demo inspector for their own jobs. */
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
