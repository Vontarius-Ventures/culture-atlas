/**
 * Production preflight for the on-prem Compose deployment (docs/deploy.md,
 * docs/production-readiness.md). Pure: it reads an environment map and returns
 * problems by NAME only. No value is ever echoed, so the report is safe to
 * print in container logs.
 *
 * Errors stop the stack (the Compose `preflight` service exits 1 and `migrate`,
 * `web`, `worker` and `media-worker` never start). Warnings are printed but do
 * not block: they mark capabilities that stay honestly `unavailable`.
 */

export interface PreflightReport {
  errors: string[];
  warnings: string[];
}

type Env = Record<string, string | undefined>;

const DEV_SESSION_PREFIX = 'dev-only';
const MIN_SECRET_LENGTH = 32;

function value(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function httpsUrl(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '0.0.0.0'
  );
}

function positiveNumber(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0;
}

/**
 * Checks the settings a production on-prem deployment cannot run safely
 * without. `NODE_ENV` other than `production` only yields a single error:
 * this command exists to guard production.
 */
export function checkProductionEnv(env: Env): PreflightReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const has = (name: string) => value(env, name) !== undefined;

  if (value(env, 'NODE_ENV') !== 'production') {
    errors.push('NODE_ENV must be "production" for the production preflight.');
    return { errors, warnings };
  }

  // --- Runtime ------------------------------------------------------------
  const base = value(env, 'APP_BASE_URL');
  const baseUrl = httpsUrl(base);
  if (!base) errors.push('APP_BASE_URL is required (the public https URL, e.g. https://app.cultureatlas.com).');
  else if (!baseUrl)
    errors.push('APP_BASE_URL must be an https URL: Secure cookies, identity links and universal links need TLS.');
  else if (isLoopbackHost(baseUrl.hostname))
    errors.push('APP_BASE_URL must be the public host, not a loopback address.');
  else if (baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash)
    errors.push('APP_BASE_URL must be an origin only (no path, query or fragment).');

  const session = value(env, 'SESSION_SECRET');
  if (!session) errors.push('SESSION_SECRET is required (openssl rand -hex 32).');
  else if (session.startsWith(DEV_SESSION_PREFIX))
    errors.push('SESSION_SECRET is the development placeholder; generate a real secret.');
  else if (session.length < MIN_SECRET_LENGTH)
    errors.push(`SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);

  const signing = value(env, 'STORAGE_SIGNING_SECRET');
  if (!signing)
    errors.push(
      'STORAGE_SIGNING_SECRET is required: without it each process signs media links with its own random key.',
    );
  else if (signing.length < MIN_SECRET_LENGTH)
    errors.push(`STORAGE_SIGNING_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  else if (signing === session) errors.push('STORAGE_SIGNING_SECRET must differ from SESSION_SECRET.');

  if (!has('DATABASE_URL')) errors.push('DATABASE_URL is required.');
  else if (/:\/\/culture_atlas:culture_atlas@/.test(value(env, 'DATABASE_URL')!))
    errors.push('DATABASE_URL uses the development password; set POSTGRES_PASSWORD.');

  // --- Identity email: Resend (owner decision; the on-prem host sends through Resend)
  const mail = value(env, 'IDENTITY_MAIL_DRIVER') ?? 'none';
  if (mail === 'file')
    errors.push(
      'IDENTITY_MAIL_DRIVER=file is a local development mailbox and is refused in production; use resend.',
    );
  else if (mail !== 'resend')
    errors.push(
      'IDENTITY_MAIL_DRIVER must be resend in production; otherwise email sign-in and recovery fail with 503.',
    );
  if (mail === 'resend') {
    if (!has('RESEND_API_KEY'))
      errors.push('RESEND_API_KEY is required with IDENTITY_MAIL_DRIVER=resend (a sending-only API key).');
    if (!has('IDENTITY_MAIL_FROM'))
      errors.push('IDENTITY_MAIL_FROM is required with IDENTITY_MAIL_DRIVER=resend (an address on a domain verified in Resend).');
  }

  // --- Object storage: private S3 API (on-prem Garage) ----------------------
  // createMultipartStorage refuses the filesystem driver in production, so v2
  // capture media needs an S3 endpoint even on-prem.
  const driver = value(env, 'STORAGE_DRIVER') ?? 'local';
  if (driver !== 's3')
    errors.push('STORAGE_DRIVER must be s3 in production (the on-prem Garage object store); local is refused for v2 media.');
  else {
    for (const name of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])
      if (!has(name)) errors.push(`${name} is required with STORAGE_DRIVER=s3.`);
    const endpoint = value(env, 'S3_ENDPOINT');
    const endpointUrl = httpsUrl(endpoint);
    if (!endpoint)
      errors.push('S3_ENDPOINT is required on-prem (the public https media host, e.g. https://media.cultureatlas.com).');
    else if (!endpointUrl)
      errors.push('S3_ENDPOINT must be https: phones and browsers upload parts and read media from presigned URLs.');
    else if (isLoopbackHost(endpointUrl.hostname))
      errors.push('S3_ENDPOINT must be a public host: presigned URLs are opened by phones and browsers.');
    else if (baseUrl && endpointUrl.host === baseUrl.host)
      errors.push('S3_ENDPOINT must be its own host (e.g. media.<domain>), not the app host.');
    if (value(env, 'S3_FORCE_PATH_STYLE') !== 'true')
      warnings.push('S3_FORCE_PATH_STYLE should be true for Garage (one TLS name for every bucket).');
  }

  // --- Proxy ----------------------------------------------------------------
  if (!has('TRUSTED_PROXY_HOPS'))
    warnings.push('TRUSTED_PROXY_HOPS is unset (default 1 = Caddy only); match it to your proxy chain.');

  // --- Model gateway and providers: missing keys leave capabilities unavailable
  const provider = value(env, 'LLM_PROVIDER') ?? 'concentrate';
  if (provider === 'concentrate') {
    if (!has('CONCENTRATE_API_KEY'))
      warnings.push('CONCENTRATE_API_KEY is unset: photo/video analysis stays unavailable.');
    if (!has('CONCENTRATE_PROFILE_FILE') && !has('CONCENTRATE_PROFILES_JSON'))
      warnings.push('CONCENTRATE_PROFILE_FILE / CONCENTRATE_PROFILES_JSON is unset: no model role is dispatchable.');
    if (!has('CONCENTRATE_QUALIFICATION_DIR'))
      warnings.push('CONCENTRATE_QUALIFICATION_DIR is unset: no role can prove qualification.');
    if (value(env, 'CONCENTRATE_GATEWAY_FALLBACKS_ENABLED') === 'true')
      errors.push('CONCENTRATE_GATEWAY_FALLBACKS_ENABLED must stay false.');
  }
  for (const name of ['MODEL_DAILY_SPEND_LIMIT_USD', 'MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD', 'MODEL_MAX_UNKNOWN_SPEND_USD']) {
    const raw = value(env, name);
    if (raw === undefined) warnings.push(`${name} is unset: model dispatch stays fail-closed.`);
    else if (!positiveNumber(raw)) errors.push(`${name} must be a positive number.`);
  }
  if (!has('QLOO_API_KEY')) warnings.push('QLOO_API_KEY is unset: every Qloo capability reports unavailable.');
  if (value(env, 'QLOO_REPLAY_FIXTURES') === 'true')
    errors.push('QLOO_REPLAY_FIXTURES must not be true in production (recorded results are examples, not live data).');
  if (!has('ELEVENLABS_API_KEY'))
    warnings.push('ELEVENLABS_API_KEY is unset: Music Mode transcription stays unavailable.');
  if (!has('WIKIMEDIA_USER_AGENT'))
    warnings.push('WIKIMEDIA_USER_AGENT is unset: Wikimedia asks for a descriptive agent with contact info.');

  // --- Native app links -----------------------------------------------------
  if (!has('APPLE_TEAM_ID'))
    warnings.push('APPLE_TEAM_ID is unset: apple-app-site-association uses the repository default team.');
  if (!has('ANDROID_ASSETLINKS_SHA256'))
    warnings.push('ANDROID_ASSETLINKS_SHA256 is unset: assetlinks.json lists no certificate, so Android App Links do not verify.');

  // --- Push -----------------------------------------------------------------
  if (value(env, 'PUSH_DRIVER') === 'live') {
    for (const name of [
      'PUSH_APNS_TEAM_ID',
      'PUSH_APNS_KEY_ID',
      'PUSH_APNS_PRIVATE_KEY',
      'PUSH_APNS_TOPIC',
      'PUSH_FCM_PROJECT_ID',
      'PUSH_FCM_CLIENT_EMAIL',
      'PUSH_FCM_PRIVATE_KEY',
    ])
      if (!has(name)) warnings.push(`${name} is unset with PUSH_DRIVER=live.`);
    if (!has('CREDENTIAL_ENCRYPTION_KEY'))
      errors.push('CREDENTIAL_ENCRYPTION_KEY is required with PUSH_DRIVER=live (device tokens are encrypted at rest).');
  }

  return { errors, warnings };
}
