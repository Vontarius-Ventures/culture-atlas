import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

/**
 * Push wake-ups for enrolled phones (BACKEND-CONTRACTS "Remote command
 * state"): APNs/FCM carry ONLY an opaque reference. No media, command
 * payload, account data or authorization token is ever put in a push; the
 * phone wakes and long-polls GET /v2/device/commands with its own token.
 *
 * Device tokens are secrets of the installation: drivers never log them and
 * errors never include them.
 */
export interface PushTarget {
  provider: 'apns' | 'fcm';
  token: string;
  environment: 'production' | 'sandbox';
}
export type PushOutcome = 'sent' | 'invalid_token' | 'retry_later' | 'failed' | 'not_configured';
export interface PushDriver {
  readonly name: string;
  wake(target: PushTarget, reference: string): Promise<PushOutcome>;
}

const REFERENCE = /^[A-Za-z0-9_-]{16,64}$/;
function assertReference(reference: string): void {
  if (!REFERENCE.test(reference))
    throw new Error('Push references must be opaque base64url values.');
}

/** Local/default driver: sends nothing over the network. Keeps references only, for tests. */
export class NoopPushDriver implements PushDriver {
  readonly name = 'noop';
  readonly references: { provider: PushTarget['provider']; reference: string }[] = [];
  async wake(target: PushTarget, reference: string): Promise<PushOutcome> {
    assertReference(reference);
    this.references.push({ provider: target.provider, reference });
    return 'not_configured';
  }
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');
function jwt(header: object, claims: object, key: KeyObject, algorithm: 'ES256' | 'RS256'): string {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(input), {
    key,
    ...(algorithm === 'ES256' ? { dsaEncoding: 'ieee-p1363' as const } : {}),
  });
  return `${input}.${b64url(signature)}`;
}

export interface ApnsOptions {
  teamId: string;
  keyId: string;
  /** Contents of the .p8 signing key (PEM). */
  privateKey: string;
  /** App bundle id (apns-topic). */
  topic: string;
  /** Test seam: override the APNs origins (e.g. a local h2c server). */
  origins?: { production: string; sandbox: string };
  now?: () => Date;
  timeoutMs?: number;
}

/** APNs provider API over HTTP/2 with a token-based (ES256) provider JWT. */
export class ApnsPushDriver implements PushDriver {
  readonly name = 'apns';
  private readonly key: KeyObject;
  private cached?: { token: string; issuedAt: number };
  private sessions = new Map<string, ClientHttp2Session>();
  constructor(private readonly options: ApnsOptions) {
    this.key = createPrivateKey(options.privateKey);
  }
  private providerToken(): string {
    const now = (this.options.now ?? (() => new Date()))().getTime();
    // Apple accepts a token for up to an hour; refresh well before that.
    if (!this.cached || now - this.cached.issuedAt > 45 * 60_000) {
      this.cached = {
        issuedAt: now,
        token: jwt(
          { alg: 'ES256', kid: this.options.keyId },
          { iss: this.options.teamId, iat: Math.floor(now / 1000) },
          this.key,
          'ES256',
        ),
      };
    }
    return this.cached.token;
  }
  private session(origin: string): ClientHttp2Session {
    const existing = this.sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(origin);
    session.on('error', () => this.sessions.delete(origin));
    session.on('close', () => this.sessions.delete(origin));
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }
  async wake(target: PushTarget, reference: string): Promise<PushOutcome> {
    assertReference(reference);
    if (target.provider !== 'apns' || !/^[0-9a-fA-F]{64,200}$/.test(target.token))
      return 'invalid_token';
    const origins = this.options.origins ?? {
      production: 'https://api.push.apple.com',
      sandbox: 'https://api.sandbox.push.apple.com',
    };
    const body = JSON.stringify({ aps: { 'content-available': 1 }, ref: reference });
    return new Promise<PushOutcome>((resolve) => {
      let settled = false;
      const done = (outcome: PushOutcome) => {
        if (!settled) {
          settled = true;
          resolve(outcome);
        }
      };
      try {
        const request = this.session(origins[target.environment]).request({
          [constants.HTTP2_HEADER_METHOD]: 'POST',
          [constants.HTTP2_HEADER_PATH]: `/3/device/${target.token}`,
          authorization: `bearer ${this.providerToken()}`,
          'apns-topic': this.options.topic,
          'apns-push-type': 'background',
          'apns-priority': '5',
          'apns-expiration': '0',
          'content-type': 'application/json',
        });
        request.setTimeout(this.options.timeoutMs ?? 5000, () => {
          request.close();
          done('retry_later');
        });
        let status = 0;
        const chunks: Buffer[] = [];
        request.on('response', (headers) => {
          status = Number(headers[constants.HTTP2_HEADER_STATUS]);
        });
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          let reason = '';
          try {
            reason = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}').reason ?? '';
          } catch {
            /* Not JSON: treat by status only. */
          }
          if (status === 200) done('sent');
          else if (
            status === 410 ||
            ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(reason)
          )
            done('invalid_token');
          else if (status === 429 || status >= 500 || reason === 'ExpiredProviderToken') {
            if (reason === 'ExpiredProviderToken') this.cached = undefined;
            done('retry_later');
          } else done('failed');
        });
        request.on('error', () => done('retry_later'));
        request.end(body);
      } catch {
        done('retry_later');
      }
    });
  }
  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

export interface FcmOptions {
  projectId: string;
  /** Service account email and RSA private key (PEM) from the Firebase service account JSON. */
  clientEmail: string;
  privateKey: string;
  /** Test seams. */
  endpoint?: string;
  tokenUri?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/** Firebase Cloud Messaging HTTP v1 with a service-account OAuth token. Data-only messages. */
export class FcmPushDriver implements PushDriver {
  readonly name = 'fcm';
  private readonly key: KeyObject;
  private access?: { token: string; expiresAt: number };
  constructor(private readonly options: FcmOptions) {
    this.key = createPrivateKey(options.privateKey);
  }
  private now(): number {
    return (this.options.now ?? (() => new Date()))().getTime();
  }
  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - this.now() > 60_000) return this.access.token;
    const tokenUri = this.options.tokenUri ?? 'https://oauth2.googleapis.com/token';
    const iat = Math.floor(this.now() / 1000);
    const assertion = jwt(
      { alg: 'RS256', typ: 'JWT' },
      {
        iss: this.options.clientEmail,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: tokenUri,
        iat,
        exp: iat + 3600,
      },
      this.key,
      'RS256',
    );
    const response = await (this.options.fetch ?? fetch)(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
    });
    if (!response.ok) throw new Error('FCM authorization failed.');
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('FCM authorization failed.');
    this.access = {
      token: body.access_token,
      expiresAt: this.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }
  async wake(target: PushTarget, reference: string): Promise<PushOutcome> {
    assertReference(reference);
    if (target.provider !== 'fcm' || target.token.length < 20 || target.token.length > 4096)
      return 'invalid_token';
    try {
      const endpoint = this.options.endpoint ?? 'https://fcm.googleapis.com';
      const response = await (this.options.fetch ?? fetch)(
        `${endpoint}/v1/projects/${encodeURIComponent(this.options.projectId)}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await this.accessToken()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token: target.token,
              data: { ref: reference },
              android: { priority: 'high', ttl: '30s' },
            },
          }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
        },
      );
      if (response.ok) return 'sent';
      let code = '';
      try {
        const body = (await response.json()) as {
          error?: { status?: string; details?: { errorCode?: string }[] };
        };
        code = body.error?.details?.find((d) => d.errorCode)?.errorCode ?? body.error?.status ?? '';
      } catch {
        /* Status only. */
      }
      if (response.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT')
        return 'invalid_token';
      if (response.status === 401) this.access = undefined;
      if (response.status === 429 || response.status >= 500 || response.status === 401)
        return 'retry_later';
      return 'failed';
    } catch {
      return 'retry_later';
    }
  }
}

/** Routes each target to the driver for its provider; unconfigured providers are a no-op. */
export class CompositePushDriver implements PushDriver {
  readonly name = 'composite';
  constructor(private readonly drivers: Partial<Record<PushTarget['provider'], PushDriver>>) {}
  async wake(target: PushTarget, reference: string): Promise<PushOutcome> {
    assertReference(reference);
    const driver = this.drivers[target.provider];
    return driver ? driver.wake(target, reference) : 'not_configured';
  }
}

/**
 * PUSH_DRIVER=none (default) | live. With "live", APNs is configured by
 * PUSH_APNS_TEAM_ID/KEY_ID/PRIVATE_KEY/TOPIC and FCM by
 * PUSH_FCM_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY; either may be absent.
 */
export function createPushDriverFromEnv(env: Record<string, string | undefined>): PushDriver {
  const mode = env.PUSH_DRIVER?.trim() || 'none';
  if (mode === 'none') return new NoopPushDriver();
  if (mode !== 'live') throw new Error('PUSH_DRIVER must be none or live.');
  const pem = (value: string | undefined) => value?.replaceAll('\\n', '\n');
  const drivers: Partial<Record<PushTarget['provider'], PushDriver>> = {};
  if (
    env.PUSH_APNS_TEAM_ID &&
    env.PUSH_APNS_KEY_ID &&
    env.PUSH_APNS_PRIVATE_KEY &&
    env.PUSH_APNS_TOPIC
  )
    drivers.apns = new ApnsPushDriver({
      teamId: env.PUSH_APNS_TEAM_ID,
      keyId: env.PUSH_APNS_KEY_ID,
      privateKey: pem(env.PUSH_APNS_PRIVATE_KEY)!,
      topic: env.PUSH_APNS_TOPIC,
    });
  if (env.PUSH_FCM_PROJECT_ID && env.PUSH_FCM_CLIENT_EMAIL && env.PUSH_FCM_PRIVATE_KEY)
    drivers.fcm = new FcmPushDriver({
      projectId: env.PUSH_FCM_PROJECT_ID,
      clientEmail: env.PUSH_FCM_CLIENT_EMAIL,
      privateKey: pem(env.PUSH_FCM_PRIVATE_KEY)!,
    });
  return new CompositePushDriver(drivers);
}
