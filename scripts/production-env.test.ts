import { describe, expect, it } from 'vitest';
import { checkProductionEnv } from './production-env-lib';

const SECRET = 'a'.repeat(64);
const SIGNING = 'b'.repeat(64);

/** A complete on-prem production environment (fake values only). */
function good(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    APP_BASE_URL: 'https://app.example.org',
    SESSION_SECRET: SECRET,
    STORAGE_SIGNING_SECRET: SIGNING,
    DATABASE_URL: 'postgres://culture_atlas:not-the-dev-password@postgres:5432/culture_atlas',
    IDENTITY_MAIL_DRIVER: 'file',
    IDENTITY_MAIL_FILE_ALLOW_PRODUCTION: 'true',
    IDENTITY_MAIL_FILE_DIR: '/var/lib/culture-atlas/mail',
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: 'https://media.example.org',
    S3_BUCKET: 'culture-atlas-media',
    S3_ACCESS_KEY_ID: 'GK0000',
    S3_SECRET_ACCESS_KEY: 'fake',
    S3_FORCE_PATH_STYLE: 'true',
    TRUSTED_PROXY_HOPS: '1',
    CONCENTRATE_API_KEY: 'fake',
    CONCENTRATE_PROFILE_FILE: '/app/fixtures/concentrate/profiles.json',
    CONCENTRATE_QUALIFICATION_DIR: '/app/fixtures/concentrate',
    MODEL_DAILY_SPEND_LIMIT_USD: '5',
    MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD: '1',
    MODEL_MAX_UNKNOWN_SPEND_USD: '1',
    QLOO_API_KEY: 'fake',
    ELEVENLABS_API_KEY: 'fake',
    WIKIMEDIA_USER_AGENT: 'culture-atlas/1.0 (ops@example.org)',
    APPLE_TEAM_ID: 'ABCDE12345',
    ANDROID_ASSETLINKS_SHA256: 'AA'.repeat(32),
  };
}

const errorsFor = (overrides: Record<string, string | undefined>) =>
  checkProductionEnv({ ...good(), ...overrides }).errors.join('\n');

describe('production preflight (on-prem Compose)', () => {
  it('passes a complete environment with no warnings', () => {
    expect(checkProductionEnv(good())).toEqual({ errors: [], warnings: [] });
  });

  it('only guards production', () => {
    expect(errorsFor({ NODE_ENV: 'development' })).toMatch(/NODE_ENV must be "production"/);
  });

  it('requires the on-prem file mailbox from the spec and refuses cloud mail', () => {
    expect(errorsFor({ IDENTITY_MAIL_DRIVER: 'ses' })).toMatch(/IDENTITY_MAIL_DRIVER must be file .*ses is a cloud service/);
    expect(errorsFor({ IDENTITY_MAIL_DRIVER: '' })).toMatch(/IDENTITY_MAIL_DRIVER must be file/);
    expect(errorsFor({ IDENTITY_MAIL_DRIVER: 'none' })).toMatch(/IDENTITY_MAIL_DRIVER must be file/);
    expect(errorsFor({ IDENTITY_MAIL_FILE_ALLOW_PRODUCTION: '' })).toMatch(/IDENTITY_MAIL_FILE_ALLOW_PRODUCTION must be true/);
    expect(errorsFor({ IDENTITY_MAIL_FILE_DIR: '' })).toMatch(/IDENTITY_MAIL_FILE_DIR must be an absolute path/);
    expect(errorsFor({ IDENTITY_MAIL_FILE_DIR: '.data/dev-mail' })).toMatch(/IDENTITY_MAIL_FILE_DIR must be an absolute path/);
  });

  it('requires real session and storage signing secrets', () => {
    expect(errorsFor({ SESSION_SECRET: '' })).toMatch(/SESSION_SECRET is required/);
    expect(errorsFor({ SESSION_SECRET: 'dev-only-session-secret-change-me-xxxxxxxxxxxx' })).toMatch(/placeholder/);
    expect(errorsFor({ SESSION_SECRET: 'short' })).toMatch(/at least 32/);
    expect(errorsFor({ STORAGE_SIGNING_SECRET: '' })).toMatch(/STORAGE_SIGNING_SECRET is required/);
    expect(errorsFor({ STORAGE_SIGNING_SECRET: SECRET })).toMatch(/must differ from SESSION_SECRET/);
  });

  it('requires a public https APP_BASE_URL origin', () => {
    expect(errorsFor({ APP_BASE_URL: '' })).toMatch(/APP_BASE_URL is required/);
    expect(errorsFor({ APP_BASE_URL: 'http://app.example.org' })).toMatch(/must be an https URL/);
    expect(errorsFor({ APP_BASE_URL: 'https://localhost:3000' })).toMatch(/not a loopback/);
    expect(errorsFor({ APP_BASE_URL: 'https://app.example.org/atlas' })).toMatch(/origin only/);
  });

  it('requires private S3 storage on its own https host', () => {
    expect(errorsFor({ STORAGE_DRIVER: 'local' })).toMatch(/STORAGE_DRIVER must be s3/);
    expect(errorsFor({ S3_ENDPOINT: 'http://garage:3900' })).toMatch(/S3_ENDPOINT must be https/);
    expect(errorsFor({ S3_ENDPOINT: 'https://app.example.org' })).toMatch(/its own host/);
    expect(errorsFor({ S3_BUCKET: '' })).toMatch(/S3_BUCKET is required/);
    expect(checkProductionEnv({ ...good(), S3_FORCE_PATH_STYLE: '' }).warnings.join()).toMatch(/S3_FORCE_PATH_STYLE/);
  });

  it('refuses the development database password and replayed Qloo fixtures', () => {
    expect(errorsFor({ DATABASE_URL: 'postgres://culture_atlas:culture_atlas@postgres:5432/culture_atlas' })).toMatch(
      /development password/,
    );
    expect(errorsFor({ QLOO_REPLAY_FIXTURES: 'true' })).toMatch(/QLOO_REPLAY_FIXTURES/);
  });

  it('keeps missing provider keys as warnings (capabilities stay unavailable)', () => {
    const report = checkProductionEnv({ ...good(), QLOO_API_KEY: '', ELEVENLABS_API_KEY: '', CONCENTRATE_API_KEY: '' });
    expect(report.errors).toEqual([]);
    expect(report.warnings.join('\n')).toMatch(/QLOO_API_KEY/);
    expect(report.warnings.join('\n')).toMatch(/ELEVENLABS_API_KEY/);
    expect(report.warnings.join('\n')).toMatch(/CONCENTRATE_API_KEY/);
    expect(errorsFor({ MODEL_DAILY_SPEND_LIMIT_USD: '0' })).toMatch(/positive number/);
  });

  it('needs the credential key when live push is on', () => {
    expect(errorsFor({ PUSH_DRIVER: 'live' })).toMatch(/CREDENTIAL_ENCRYPTION_KEY is required/);
  });

  it('never echoes a value', () => {
    const report = checkProductionEnv({
      ...good(),
      SESSION_SECRET: 'short-secret-value',
      APP_BASE_URL: 'http://leaky.example.org',
      IDENTITY_MAIL_DRIVER: 'ses',
    });
    const text = [...report.errors, ...report.warnings].join('\n');
    expect(text).not.toContain('short-secret-value');
    expect(text).not.toContain('leaky.example.org');
    expect(text).not.toContain(SIGNING);
  });
});
