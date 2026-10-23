import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

/**
 * Identity mail delivery adapters. Structurally identical to the domain's
 * `IdentityMail` interface (providers cannot import the domain package).
 *
 * Rules for every adapter (IDENTITY-CONTRACT "Mail and rollout"):
 * - the callback URL carries a one-use proof in its fragment, so neither the
 *   message, the callback nor the recipient address is ever logged;
 * - delivery failures throw a generic error; the domain consumes the proof and
 *   still returns the same accepted response.
 */
export interface IdentityMailMessage {
  to: string;
  purpose: 'sign_in' | 'verify' | 'recover';
  callback: string;
}
export interface IdentityMailAdapter {
  send(message: IdentityMailMessage): Promise<void>;
}

export class IdentityMailDeliveryError extends Error {
  constructor() {
    // Deliberately carries no provider message: it may echo the address.
    super('Identity mail delivery failed.');
    this.name = 'IdentityMailDeliveryError';
  }
}

const SUBJECTS: Record<IdentityMailMessage['purpose'], string> = {
  sign_in: 'Your culture atlas sign-in link',
  verify: 'Verify your culture atlas email',
  recover: 'Recover your culture atlas account',
};
const INTROS: Record<IdentityMailMessage['purpose'], string> = {
  sign_in: 'Use this link to sign in to culture atlas.',
  verify: 'Use this link to verify the email address on your culture atlas account.',
  recover:
    'Use this link to recover your culture atlas account. Recovery signs out every other browser and phone.',
};

/** Plain text and minimal HTML bodies. The link expires in 15 minutes and works once. */
export function renderIdentityMail(message: IdentityMailMessage): {
  subject: string;
  text: string;
  html: string;
} {
  const url = new URL(message.callback);
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'cultureatlas:')
    throw new IdentityMailDeliveryError();
  const intro = INTROS[message.purpose];
  const ignore =
    'If you did not ask for this, ignore this email. The link expires in 15 minutes and works once, in the browser or app where you started.';
  const escaped = message.callback
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return {
    subject: SUBJECTS[message.purpose],
    text: `${intro}\n\n${message.callback}\n\n${ignore}\n`,
    html: `<p>${intro}</p><p><a href="${escaped}">Continue</a></p><p>${ignore}</p>`,
  };
}

export interface SesIdentityMailOptions {
  /** Verified SES identity, e.g. "culture atlas <no-reply@example.com>". */
  from: string;
  region: string;
  /** Optional SES configuration set (bounce/complaint tracking). */
  configurationSet?: string;
  /** Test seam: anything with SESv2Client's `send`. Production uses the default credential chain (EC2 instance role). */
  client?: Pick<SESv2Client, 'send'>;
}

/** Amazon SES v2 delivery. Credentials come from the instance role; none are configured here. */
export function createSesIdentityMail(options: SesIdentityMailOptions): IdentityMailAdapter {
  if (!options.from || !options.region)
    throw new Error('SES identity mail needs a sender and region.');
  const client = options.client ?? new SESv2Client({ region: options.region, maxAttempts: 2 });
  return {
    async send(message) {
      const body = renderIdentityMail(message);
      try {
        await client.send(
          new SendEmailCommand({
            FromEmailAddress: options.from,
            Destination: { ToAddresses: [message.to] },
            ConfigurationSetName: options.configurationSet,
            Content: {
              Simple: {
                Subject: { Data: body.subject, Charset: 'UTF-8' },
                Body: {
                  Text: { Data: body.text, Charset: 'UTF-8' },
                  Html: { Data: body.html, Charset: 'UTF-8' },
                },
              },
            },
          }),
        );
      } catch {
        throw new IdentityMailDeliveryError();
      }
    },
  };
}

/**
 * File mailbox: each message is written as a 0600 JSON file and nothing is
 * emailed. It is the spec's mail provider (prp/2026-10-22-interest-feed: "this
 * build uses a file mailbox; no email is sent"); the operator opens the link.
 * In production it runs only with the explicit on-prem opt-in
 * (IDENTITY_MAIL_FILE_ALLOW_PRODUCTION=true), so a stray development setting
 * still fails closed.
 */
export function createFileIdentityMail(
  directory: string,
  environment: string,
  options: { allowProduction?: boolean } = {},
): IdentityMailAdapter {
  if (environment === 'production' && !options.allowProduction)
    throw new Error(
      'The file identity mailbox needs IDENTITY_MAIL_FILE_ALLOW_PRODUCTION=true in production.',
    );
  const root = resolve(directory);
  return {
    async send(message) {
      const body = renderIdentityMail(message);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await writeFile(
        join(root, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`),
        JSON.stringify(
          {
            to: message.to,
            purpose: message.purpose,
            subject: body.subject,
            callback: message.callback,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    },
  };
}

export type IdentityMailDriver = 'ses' | 'file' | 'none';

/**
 * Selects the configured adapter. Returns undefined for "none" (or unset), in
 * which case the domain keeps its default: an in-memory outbox outside
 * production and a fail-closed 503 in production.
 */
export function createIdentityMailFromEnv(
  env: Record<string, string | undefined>,
): IdentityMailAdapter | undefined {
  const driver = (env.IDENTITY_MAIL_DRIVER?.trim() || 'none') as IdentityMailDriver;
  if (driver === 'none') return undefined;
  if (driver === 'ses') {
    const region = env.IDENTITY_MAIL_SES_REGION?.trim() || env.AWS_REGION?.trim() || '';
    const from = env.IDENTITY_MAIL_FROM?.trim() || '';
    if (!region || !from)
      throw new Error('IDENTITY_MAIL_DRIVER=ses needs IDENTITY_MAIL_FROM and a region.');
    return createSesIdentityMail({
      from,
      region,
      configurationSet: env.IDENTITY_MAIL_SES_CONFIGURATION_SET?.trim() || undefined,
    });
  }
  if (driver === 'file')
    return createFileIdentityMail(
      env.IDENTITY_MAIL_FILE_DIR?.trim() || '.data/dev-mail',
      env.NODE_ENV ?? 'development',
      { allowProduction: env.IDENTITY_MAIL_FILE_ALLOW_PRODUCTION?.trim() === 'true' },
    );
  throw new Error('IDENTITY_MAIL_DRIVER must be ses, file or none.');
}
