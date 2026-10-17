import { createServer as createH2Server, type Http2Server } from 'node:http2';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApnsPushDriver,
  CompositePushDriver,
  FcmPushDriver,
  NoopPushDriver,
  createPushDriverFromEnv,
} from './push';

const reference = randomBytes(16).toString('base64url');
const apnsToken = 'a'.repeat(64);
const fcmToken = 'fcm-registration-token-'.padEnd(40, 'x');

function decodeJwt(token: string) {
  const [h, c, s] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(c!, 'base64url').toString()),
    input: `${h}.${c}`,
    signature: Buffer.from(s!, 'base64url'),
  };
}

describe('APNs driver (HTTP/2)', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  let server: Http2Server;
  let origin: string;
  const seen: { headers: Record<string, unknown>; body: string }[] = [];
  let reply: { status: number; reason?: string } = { status: 200 };
  beforeAll(async () => {
    server = createH2Server();
    server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        seen.push({ headers: { ...headers }, body: Buffer.concat(chunks).toString() });
        stream.respond({ ':status': reply.status, 'content-type': 'application/json' });
        stream.end(reply.reason ? JSON.stringify({ reason: reply.reason }) : '');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const driver = () =>
    new ApnsPushDriver({
      teamId: 'TEAM123456',
      keyId: 'KEY1234567',
      privateKey: ec.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      topic: 'com.example.cultureatlas',
      origins: { production: origin, sandbox: origin },
    });

  it('sends a background push carrying only the opaque reference, with a valid ES256 provider token', async () => {
    reply = { status: 200 };
    const apns = driver();
    expect(
      await apns.wake({ provider: 'apns', token: apnsToken, environment: 'production' }, reference),
    ).toBe('sent');
    apns.close();
    const request = seen.at(-1)!;
    expect(request.headers[':path']).toBe(`/3/device/${apnsToken}`);
    expect(request.headers['apns-push-type']).toBe('background');
    expect(request.headers['apns-topic']).toBe('com.example.cultureatlas');
    expect(JSON.parse(request.body)).toEqual({ aps: { 'content-available': 1 }, ref: reference });
    const token = decodeJwt(String(request.headers.authorization).replace(/^bearer /, ''));
    expect(token.header).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(token.claims.iss).toBe('TEAM123456');
    expect(
      verify(
        'sha256',
        Buffer.from(token.input),
        { key: ec.publicKey, dsaEncoding: 'ieee-p1363' },
        token.signature,
      ),
    ).toBe(true);
  });

  it('maps unregistered tokens, throttling and malformed input', async () => {
    const apns = driver();
    reply = { status: 410, reason: 'Unregistered' };
    expect(
      await apns.wake({ provider: 'apns', token: apnsToken, environment: 'sandbox' }, reference),
    ).toBe('invalid_token');
    reply = { status: 429, reason: 'TooManyRequests' };
    expect(
      await apns.wake({ provider: 'apns', token: apnsToken, environment: 'sandbox' }, reference),
    ).toBe('retry_later');
    reply = { status: 400, reason: 'BadDeviceToken' };
    expect(
      await apns.wake({ provider: 'apns', token: apnsToken, environment: 'sandbox' }, reference),
    ).toBe('invalid_token');
    expect(
      await apns.wake({ provider: 'apns', token: 'not-hex', environment: 'sandbox' }, reference),
    ).toBe('invalid_token');
    await expect(
      apns.wake(
        { provider: 'apns', token: apnsToken, environment: 'sandbox' },
        'media: secret payload',
      ),
    ).rejects.toThrow(/opaque/);
    apns.close();
  });
});

describe('FCM driver (HTTP v1)', () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let server: Server;
  let origin: string;
  const sends: { auth: string; body: Record<string, unknown> }[] = [];
  let assertion = '';
  let sendStatus = 200;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString();
      if (req.url === '/token') {
        assertion = new URLSearchParams(text).get('assertion') ?? '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ya29.fixture', expires_in: 3600 }));
        return;
      }
      sends.push({ auth: String(req.headers.authorization), body: JSON.parse(text) });
      res.writeHead(sendStatus, { 'content-type': 'application/json' });
      res.end(
        sendStatus === 200
          ? JSON.stringify({ name: 'projects/p/messages/1' })
          : JSON.stringify({
              error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
            }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('exchanges a signed service-account assertion and sends a data-only message', async () => {
    const fcm = new FcmPushDriver({
      projectId: 'atlas-test',
      clientEmail: 'push@atlas-test.iam.gserviceaccount.com',
      privateKey: rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      endpoint: origin,
      tokenUri: `${origin}/token`,
    });
    expect(
      await fcm.wake({ provider: 'fcm', token: fcmToken, environment: 'production' }, reference),
    ).toBe('sent');
    const jwt = decodeJwt(assertion);
    expect(jwt.claims).toMatchObject({
      iss: 'push@atlas-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: `${origin}/token`,
    });
    expect(verify('sha256', Buffer.from(jwt.input), rsa.publicKey, jwt.signature)).toBe(true);
    expect(sends.at(-1)).toEqual({
      auth: 'Bearer ya29.fixture',
      body: {
        message: {
          token: fcmToken,
          data: { ref: reference },
          android: { priority: 'high', ttl: '30s' },
        },
      },
    });
    sendStatus = 404;
    expect(
      await fcm.wake({ provider: 'fcm', token: fcmToken, environment: 'production' }, reference),
    ).toBe('invalid_token');
  });
});

describe('driver selection', () => {
  it('defaults to the no-op driver and routes by provider', async () => {
    const noop = createPushDriverFromEnv({});
    expect(noop).toBeInstanceOf(NoopPushDriver);
    expect(
      await noop.wake({ provider: 'apns', token: apnsToken, environment: 'sandbox' }, reference),
    ).toBe('not_configured');
    expect((noop as NoopPushDriver).references).toEqual([{ provider: 'apns', reference }]);
    const live = createPushDriverFromEnv({ PUSH_DRIVER: 'live' });
    expect(live).toBeInstanceOf(CompositePushDriver);
    expect(
      await live.wake({ provider: 'fcm', token: fcmToken, environment: 'production' }, reference),
    ).toBe('not_configured');
    expect(() => createPushDriverFromEnv({ PUSH_DRIVER: 'apns' })).toThrow();
  });
});
