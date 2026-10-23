import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DomainConfigSchema } from '../packages/domain/src/config';
import { ProviderConfigSchema } from '../packages/providers/src/config';
import { checkProductionEnv } from './production-env-lib';

/**
 * Static checks of the on-prem production Compose file (THE production path:
 * docs/deploy.md, docs/production-readiness.md). Docker is not needed: the file
 * is parsed and its wiring, safety and secret-handling invariants asserted.
 */
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(`${root}/${path}`, 'utf8');
const composeText = read('docker-compose.yml');

type Service = {
  image?: string;
  build?: { target?: string };
  profiles?: string[];
  ports?: string[];
  command?: string[];
  restart?: string;
  environment?: Record<string, string>;
  volumes?: string[];
  healthcheck?: { disable?: boolean; test?: unknown };
  depends_on?: Record<string, { condition: string }>;
  networks?: { default?: { aliases?: string[] } };
};
const compose = parse(composeText, { merge: true }) as {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};
const svc = (name: string) => compose.services[name]!;
const env = (name: string) => svc(name).environment ?? {};

const LONG_RUNNING = ['postgres', 'garage', 'caddy', 'web', 'worker', 'media-worker'];
const ONE_SHOT = ['preflight', 'storage-init', 'migrate', 'ops'];
const SECRETISH = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/;

const domainKeys = Object.keys(DomainConfigSchema.shape);
const providerKeys = Object.keys(
  (ProviderConfigSchema as unknown as { in: { shape: Record<string, unknown> } }).in.shape,
);
/** Read only by the web edge (client address). */
const WEB_ONLY = ['TRUSTED_PROXY_HOPS', 'CLIENT_IP_HEADER'];
/** Deliberately not wired: production forces s3 and never replays Qloo recordings. */
const NOT_IN_PRODUCTION = ['STORAGE_LOCAL_DIR', 'QLOO_REPLAY_DIR'];
const missingFrom = (service: string, keys: string[]) => keys.filter((k) => !(k in env(service)));

/** `${NAME}`, `${NAME:-default}` or `${NAME:?message}` -> NAME. */
const references = (text: string) => [...text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)(?::?[-?][^}]*)?\}/g)].map((m) => m[1]!);

/**
 * Resolves a compose value the way `docker compose` would with a filled .env:
 * fake values for every referenced name, so the preflight can judge the wiring.
 */
function resolveWith(value: string, dotenv: Record<string, string>): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::([-?])([^}]*))?\}/g, (_m, name: string, op?: string, rest?: string) =>
    dotenv[name] ?? (op === '-' ? (rest ?? '') : ''),
  );
}

describe('on-prem production Compose', () => {
  it('contains no secret values', () => {
    expect(composeText).not.toMatch(/\brc_[A-Za-z0-9]/);
    expect(composeText).not.toMatch(/\bsk-[A-Za-z0-9]/);
    expect(composeText).not.toMatch(/AKIA[A-Z0-9]{16}/);
    expect(composeText).not.toMatch(/\bGK[0-9a-f]{24}\b/);
    expect(composeText).not.toMatch(/^\s*env_file:/m);
    for (const [name, service] of Object.entries(compose.services))
      for (const [key, value] of Object.entries(service.environment ?? {})) {
        if (!SECRETISH.test(key)) continue;
        // Secrets are only ever references to the gitignored .env.
        expect(String(value), `${name}.${key}`).toMatch(new RegExp(`^\\$\\{${key}[:}]`));
      }
    expect(String(env('web').DATABASE_URL)).toMatch(/\$\{POSTGRES_PASSWORD:\?/);
  });

  it('runs postgres, garage, caddy, web, worker and media-worker with one-shot gates', () => {
    expect(Object.keys(compose.services)).toEqual(expect.arrayContaining([...LONG_RUNNING, ...ONE_SHOT]));
    expect(compose.volumes).toHaveProperty('pgdata');
    expect(compose.volumes).toHaveProperty('garage-meta');
    expect(compose.volumes).toHaveProperty('garage-data');
    expect(compose.volumes).toHaveProperty('caddy-data');
    expect(svc('postgres').volumes).toContain('pgdata:/var/lib/postgresql/data');
    expect(svc('postgres').image).toMatch(/^postgres:16\./);
    expect(svc('garage').image).toMatch(/^dxflrs\/garage:v\d+\.\d+\.\d+$/);
    expect(svc('caddy').image).toMatch(/^caddy:\d+\.\d+\.\d+$/);
  });

  it('gives every long-running service a healthcheck and a restart policy', () => {
    for (const name of LONG_RUNNING) {
      expect(svc(name).restart, name).toBe('unless-stopped');
      expect(svc(name).healthcheck?.disable, name).not.toBe(true);
      expect(svc(name).healthcheck?.test, name).toBeTruthy();
    }
    for (const name of ONE_SHOT) expect(svc(name).restart, name).toBe('no');
    expect(JSON.stringify(svc('web').healthcheck?.test)).toContain('/v1/health');
    expect(JSON.stringify(svc('media-worker').healthcheck?.test)).toContain('ffprobe -version');
    expect(JSON.stringify(svc('worker').healthcheck?.test)).toContain('select 1');
  });

  it('runs preflight, storage init and migrations before the app starts', () => {
    const completed = (service: string, dep: string) =>
      expect(svc(service).depends_on?.[dep]?.condition, `${service} -> ${dep}`).toBe('service_completed_successfully');
    completed('storage-init', 'preflight');
    completed('migrate', 'preflight');
    completed('migrate', 'storage-init');
    for (const app of ['web', 'worker', 'media-worker']) {
      completed(app, 'migrate');
      expect(svc(app).depends_on?.postgres?.condition).toBe('service_healthy');
      expect(svc(app).depends_on?.garage?.condition).toBe('service_healthy');
    }
    expect(svc('preflight').command).toEqual(['pnpm', '--silent', 'ops:preflight']);
    expect(svc('storage-init').command).toEqual(['pnpm', '--silent', 'ops:storage', 'init']);
    expect(svc('migrate').command).toEqual(['pnpm', 'db:migrate']);
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['ops:preflight']).toBe('tsx scripts/production-env.ts');
    expect(scripts['ops:storage']).toBe('tsx scripts/object-store.ts');
  });

  it('wires every domain and provider setting to web and worker', () => {
    const all = [...domainKeys, ...providerKeys].filter((k) => !NOT_IN_PRODUCTION.includes(k));
    expect(missingFrom('web', all)).toEqual([]);
    expect(missingFrom('preflight', all)).toEqual([]);
    expect(missingFrom('worker', all.filter((k) => !WEB_ONLY.includes(k)))).toEqual([]);
    for (const key of NOT_IN_PRODUCTION) expect(env('web')).not.toHaveProperty(key);
  });

  it('wires storage, database and media-worker settings to the media worker', () => {
    const media = env('media-worker');
    for (const key of [
      'DATABASE_URL',
      'SESSION_SECRET',
      'APP_BASE_URL',
      'STORAGE_DRIVER',
      'STORAGE_SIGNING_SECRET',
      'S3_ENDPOINT',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_FORCE_PATH_STYLE',
      'FFMPEG_PATH',
      'FFPROBE_PATH',
      'MEDIA_WORKER_CONCURRENCY',
      'MEDIA_WORKER_SCRATCH_DIR',
      'MEDIA_VIDEO_MAX_BYTES',
    ])
      expect(media, `media-worker is missing ${key}`).toHaveProperty(key);
    expect(
      missingFrom(
        'media-worker',
        domainKeys.filter((k) => !k.startsWith('ELEVENLABS_') && !WEB_ONLY.includes(k)),
      ),
    ).toEqual([]);
    for (const key of ['MEDIA_ANALYSIS_WORKER_ENABLED', 'MEDIA_ANALYSIS_PHOTO_CONCURRENCY', 'MEDIA_ANALYSIS_VIDEO_CONCURRENCY'])
      expect(env('worker')).toHaveProperty(key);
  });

  it('keeps provider keys and mail settings to the services that use them', () => {
    for (const key of ['IDENTITY_MAIL_DRIVER', 'IDENTITY_MAIL_FILE_DIR', 'APPLE_TEAM_ID', 'ANDROID_ASSETLINKS_SHA256']) {
      expect(env('web')).toHaveProperty(key);
      for (const other of ['worker', 'media-worker', 'migrate', 'storage-init', 'ops']) expect(env(other)).not.toHaveProperty(key);
    }
    for (const key of ['CONCENTRATE_API_KEY', 'QLOO_API_KEY', 'ELEVENLABS_API_KEY', 'FEATHERLESS_API_KEY', 'PUSH_APNS_PRIVATE_KEY'])
      for (const other of ['media-worker', 'migrate', 'storage-init', 'ops']) expect(env(other)).not.toHaveProperty(key);
  });

  it('pins the production choices: on-prem file mailbox, private S3 on Garage, Concentrate, no replay', () => {
    const web = env('web');
    // The spec's mail provider is the file mailbox, kept on this host: no cloud mail.
    expect(web.IDENTITY_MAIL_DRIVER).toBe('file');
    expect(web.IDENTITY_MAIL_FILE_ALLOW_PRODUCTION).toBe('true');
    expect(web.IDENTITY_MAIL_FILE_DIR).toBe('/var/lib/culture-atlas/mail');
    expect(svc('web').volumes).toContain('mailbox:/var/lib/culture-atlas/mail');
    expect(composeText).not.toMatch(/IDENTITY_MAIL_SES|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
    expect(web.NODE_ENV).toBe('production');
    expect(web.STORAGE_DRIVER).toBe('s3');
    expect(web.S3_FORCE_PATH_STYLE).toBe('true');
    expect(web.LLM_PROVIDER).toBe('${LLM_PROVIDER:-concentrate}');
    expect(web.CONCENTRATE_GATEWAY_FALLBACKS_ENABLED).toBe('false');
    expect(web.CONCENTRATE_REQUIRE_ZDR).toBe('true');
    expect(web.QLOO_REPLAY_FIXTURES).toBe('false');
    expect(web.QLOO_API_URL).toMatch(/hackathon\.api\.qloo\.com/);
    for (const key of ['APP_BASE_URL', 'SESSION_SECRET', 'STORAGE_SIGNING_SECRET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'])
      expect(web[key], key).toMatch(new RegExp(`^\\$\\{${key}:\\?`));
    for (const key of ['MODEL_DAILY_SPEND_LIMIT_USD', 'MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD', 'MODEL_MAX_UNKNOWN_SPEND_USD'])
      expect(web[key]).toMatch(new RegExp(`^\\$\\{${key}:-\\d`));
    // storage-init and ops talk to Garage directly; the apps use the public https host.
    expect(env('storage-init').S3_ENDPOINT).toBe('http://garage:3900');
    expect(env('ops').S3_ENDPOINT).toBe('http://garage:3900');
  });

  it('mounts the Concentrate profile and qualification files the settings point to', () => {
    const mount = '${CONCENTRATE_CONFIG_DIR:-./fixtures/concentrate}:/etc/culture-atlas/concentrate:ro';
    for (const app of ['web', 'worker', 'preflight']) expect(svc(app).volumes).toContain(mount);
    expect(env('web').CONCENTRATE_PROFILE_FILE).toBe('${CONCENTRATE_PROFILE_FILE:-/etc/culture-atlas/concentrate/profiles.json}');
    expect(env('web').CONCENTRATE_QUALIFICATION_DIR).toBe('${CONCENTRATE_QUALIFICATION_DIR:-/etc/culture-atlas/concentrate}');
    expect(existsSync(`${root}/fixtures/concentrate/profiles.json`)).toBe(true);
    expect(existsSync(`${root}/fixtures/concentrate/catalog-snapshot.json`)).toBe(true);
  });

  it('exposes only Caddy publicly; web and Garage stay on loopback', () => {
    expect(svc('web').ports).toEqual(['${WEB_BIND_ADDRESS:-127.0.0.1}:${PORT:-3000}:3000']);
    expect(svc('garage').ports).toEqual(['${GARAGE_BIND_ADDRESS:-127.0.0.1}:3900:3900']);
    expect(svc('caddy').ports).toEqual(expect.arrayContaining(['80:80', '443:443']));
    for (const name of ['postgres', 'worker', 'media-worker']) expect(svc(name).ports, name).toBeUndefined();
    expect(svc('caddy').profiles).toEqual(['edge']);
    expect(svc('caddy').networks?.default?.aliases).toEqual(['${APP_HOST:?REQUIRED in .env}', '${MEDIA_HOST:?REQUIRED in .env}']);
    expect(env('web').TRUSTED_PROXY_HOPS).toBe('${TRUSTED_PROXY_HOPS:-1}');
  });

  it('terminates TLS for the app and media hosts and serves the native association files from web', () => {
    const caddy = read('infra/onprem/Caddyfile');
    expect(caddy).toMatch(/\{\$APP_HOST\} \{[\s\S]*reverse_proxy web:3000/);
    expect(caddy).toMatch(/\{\$MEDIA_HOST\} \{[\s\S]*reverse_proxy garage:3900/);
    expect(caddy).toMatch(/Strict-Transport-Security/);
    expect(caddy).toMatch(/delete X-Amz-Signature/);
    expect(svc('caddy').volumes).toContain('./infra/onprem/Caddyfile:/etc/caddy/Caddyfile:ro');
    expect(existsSync(`${root}/apps/web/app/.well-known/apple-app-site-association/route.ts`)).toBe(true);
    expect(existsSync(`${root}/apps/web/app/.well-known/assetlinks.json/route.ts`)).toBe(true);
  });

  it('configures Garage without secrets and with the region the app signs for', () => {
    const garage = read('infra/onprem/garage.toml');
    expect(garage).not.toMatch(/rpc_secret\s*=|admin_token\s*=/);
    expect(garage).toMatch(/s3_region = "us-east-1"/);
    expect(env('web').S3_REGION).toBe('${S3_REGION:-us-east-1}');
    expect(env('garage')).toEqual({
      GARAGE_RPC_SECRET: expect.stringMatching(/^\$\{GARAGE_RPC_SECRET:\?/),
      GARAGE_ADMIN_TOKEN: expect.stringMatching(/^\$\{GARAGE_ADMIN_TOKEN:\?/),
    });
  });

  it('backs up PostgreSQL and objects with the ops image', () => {
    const ops = svc('ops');
    expect(ops.build?.target).toBe('ops');
    expect(ops.profiles).toEqual(['ops']);
    expect(ops.volumes).toContain('${BACKUP_DIR:-/var/backups/culture-atlas}:/backups');
    expect(env('ops').CAPTURE_BACKUP_DIR).toBe('/backups');
    const script = read('infra/onprem/atlas-backup.sh');
    expect(script).toMatch(/pnpm --silent ops:backup/);
    expect(script).toMatch(/pnpm --silent ops:storage mirror/);
    expect(read('Dockerfile')).toMatch(/postgresql-client-16/);
  });

  it('builds an image with ffmpeg and keeps .env out of the build context', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toMatch(/FROM base AS runtime[\s\S]*apt-get install -y --no-install-recommends ffmpeg/);
    expect(read('.dockerignore')).toMatch(/^\.env$/m);
  });

  it('documents every name Compose reads in .env.example', () => {
    const documented = new Set(
      [...read('.env.example').matchAll(/^#?\s?([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]!),
    );
    const missing = [...new Set(references(composeText))].filter((name) => !documented.has(name));
    expect(missing).toEqual([]);
  });

  it('passes the production preflight once .env holds the required names', () => {
    const dotenv: Record<string, string> = {
      APP_BASE_URL: 'https://app.example.org',
      APP_HOST: 'app.example.org',
      MEDIA_HOST: 'media.example.org',
      POSTGRES_PASSWORD: 'f'.repeat(48),
      SESSION_SECRET: 'a'.repeat(64),
      STORAGE_SIGNING_SECRET: 'b'.repeat(64),
      S3_ENDPOINT: 'https://media.example.org',
      S3_ACCESS_KEY_ID: 'GK-fake',
      S3_SECRET_ACCESS_KEY: 'fake',
    };
    const resolved = Object.fromEntries(
      Object.entries(env('preflight')).map(([k, v]) => [k, resolveWith(String(v), dotenv)]),
    );
    expect(checkProductionEnv(resolved).errors).toEqual([]);
    // ...and refuses a cloud mail service even when an operator sets it.
    expect(checkProductionEnv({ ...resolved, IDENTITY_MAIL_DRIVER: 'ses' }).errors.join()).toMatch(/must be file/);
  });

  it('keeps the paid Render blueprint unapplied and honest', () => {
    const render = read('render.yaml');
    expect(render).toMatch(/not free|no free plan/i);
    expect(render).toMatch(/LLM_PROVIDER/);
    expect(render).not.toMatch(/\brc_[A-Za-z0-9]/);
  });
});
