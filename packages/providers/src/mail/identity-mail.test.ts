import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IdentityMailDeliveryError,
  createFileIdentityMail,
  createIdentityMailFromEnv,
  createSesIdentityMail,
  renderIdentityMail,
} from './identity-mail';

const callback =
  'https://atlas.example.test/identity/callback#challenge_id=00000000-0000-4000-8000-000000000000&token=secret-proof&state=s&nonce=n';

describe('identity mail adapters', () => {
  let server: ReturnType<typeof createServer>;
  let endpoint: string;
  const received: { path: string; body: Record<string, unknown>; auth: string }[] = [];
  let failNext = false;
  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      if (failNext) {
        failNext = false;
        res.writeHead(400, {
          'content-type': 'application/json',
          'x-amzn-errortype': 'MessageRejected',
        });
        res.end(JSON.stringify({ message: 'Email address is not verified: person@example.test' }));
        return;
      }
      received.push({
        path: req.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        auth: String(req.headers.authorization ?? ''),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ MessageId: 'fixture-message-id' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const client = () =>
    new SESv2Client({
      region: 'us-east-1',
      endpoint,
      maxAttempts: 1,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'test-secret' },
    });

  it('sends a signed SES v2 SendEmail request with the callback only in the body', async () => {
    const mail = createSesIdentityMail({
      from: 'culture atlas <no-reply@atlas.example.test>',
      region: 'us-east-1',
      configurationSet: 'identity',
      client: client(),
    });
    await mail.send({ to: 'person@example.test', purpose: 'recover', callback });
    const request = received.at(-1)!;
    expect(request.path).toBe('/v2/email/outbound-emails');
    expect(request.auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ses\//,
    );
    expect(request.body).toMatchObject({
      FromEmailAddress: 'culture atlas <no-reply@atlas.example.test>',
      Destination: { ToAddresses: ['person@example.test'] },
      ConfigurationSetName: 'identity',
    });
    const content = request.body.Content as {
      Simple: { Subject: { Data: string }; Body: { Text: { Data: string } } };
    };
    expect(content.Simple.Subject.Data).toBe('Recover your culture atlas account');
    expect(content.Simple.Body.Text.Data).toContain(callback);
  });

  it('turns provider rejections into a generic error that never echoes the address', async () => {
    failNext = true;
    const mail = createSesIdentityMail({
      from: 'no-reply@atlas.example.test',
      region: 'us-east-1',
      client: client(),
    });
    const error = await mail
      .send({ to: 'person@example.test', purpose: 'sign_in', callback })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdentityMailDeliveryError);
    expect(String((error as Error).message)).not.toContain('person@example.test');
    expect(JSON.stringify(error)).not.toContain('secret-proof');
  });

  it('escapes the callback in HTML and refuses non-web schemes', () => {
    const rendered = renderIdentityMail({
      to: 'a@example.test',
      purpose: 'verify',
      callback: 'https://atlas.example.test/identity/callback#a="<b>"&c=1',
    });
    expect(rendered.html).not.toContain('"<b>"');
    expect(rendered.html).toContain('&quot;&lt;b&gt;&quot;');
    expect(() =>
      renderIdentityMail({
        to: 'a@example.test',
        purpose: 'verify',
        callback: 'javascript:alert(1)',
      }),
    ).toThrow(IdentityMailDeliveryError);
    expect(
      renderIdentityMail({
        to: 'a@example.test',
        purpose: 'sign_in',
        callback: 'cultureatlas://identity/callback#x=1',
      }).text,
    ).toContain('cultureatlas://identity/callback#x=1');
  });

  it('file mailbox writes private files locally and refuses production', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ca-mail-'));
    try {
      await createFileIdentityMail(dir, 'development').send({
        to: 'a@example.test',
        purpose: 'sign_in',
        callback,
      });
      const [file] = await readdir(dir);
      expect((await stat(join(dir, file!))).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(join(dir, file!), 'utf8'))).toMatchObject({
        callback,
        purpose: 'sign_in',
      });
      expect(() => createFileIdentityMail(dir, 'production')).toThrow(/local development/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('selects the adapter from environment and fails loudly on incomplete SES config', () => {
    expect(createIdentityMailFromEnv({})).toBeUndefined();
    expect(createIdentityMailFromEnv({ IDENTITY_MAIL_DRIVER: 'none' })).toBeUndefined();
    expect(() =>
      createIdentityMailFromEnv({ IDENTITY_MAIL_DRIVER: 'ses', AWS_REGION: 'us-east-1' }),
    ).toThrow(/IDENTITY_MAIL_FROM/);
    expect(
      createIdentityMailFromEnv({
        IDENTITY_MAIL_DRIVER: 'ses',
        AWS_REGION: 'us-east-1',
        IDENTITY_MAIL_FROM: 'a@b.test',
      }),
    ).toBeDefined();
    expect(() =>
      createIdentityMailFromEnv({ IDENTITY_MAIL_DRIVER: 'file', NODE_ENV: 'production' }),
    ).toThrow();
    expect(() => createIdentityMailFromEnv({ IDENTITY_MAIL_DRIVER: 'smtp' })).toThrow(
      /ses, file or none/,
    );
  });
});
