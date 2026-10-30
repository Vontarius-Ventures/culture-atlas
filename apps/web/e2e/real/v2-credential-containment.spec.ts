import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * credential-evidence-containment (EXP-SCR-024), operational leg.
 *
 * The v2 journeys displayed a generated agent credential on the SecretOnce
 * screen while their screenshot helper did not mask the readonly textarea,
 * so committed evidence disclosed live test-journey agent credentials. The
 * user authorized exactly one containment action set: owner-scoped
 * revocation of the affected test-journey agent connections, including
 * matching older active connections. No unrelated connection, account or
 * history rewrite is in scope.
 *
 * This spec performs that revocation through the OWNER-AUTHORIZED route and
 * nothing else:
 *
 *  - the affected accounts and connection ids arrive as NONSECRET ownership
 *    metadata via V2_CONTAINMENT_ACCOUNTS (JSON array of
 *    { email, account_id, client_name, connection_ids }) — never a
 *    credential value;
 *  - for each account it signs in through the real email-link identity flow
 *    (file mailbox) — the owner's own front door, no backdoor query;
 *  - ownership is CONFIRMED three ways before any mutation: the signed-in
 *    session's account_id must equal the pre-identified account_id, the
 *    owner route must list every pre-identified connection id, and each
 *    listed connection's client_name must match the journey's agent name;
 *  - only then does the owner session DELETE the connection and verify the
 *    denial by the owner route's connection status ('revoked'). The agent
 *    token itself is never exercised, read or printed;
 *  - if any confirmation fails, NOTHING is revoked for that account and the
 *    refusal is reported verbatim — that is what requires the user, not an
 *    unrelated revocation.
 *
 * No worker, media worker or provider is needed; run it against the web
 * stack whose DATABASE_URL is the database holding the affected connections.
 * V2_MAIL_DIR must be the server's IDENTITY_MAIL_FILE_DIR.
 */

interface ContainmentAccount {
  email: string;
  account_id: string;
  client_name: string;
  connection_ids: string[];
}

const MAIL_DIR = process.env.V2_MAIL_DIR ?? '';
const RAW_ACCOUNTS = process.env.V2_CONTAINMENT_ACCOUNTS ?? '';
test.skip(!MAIL_DIR || !RAW_ACCOUNTS, 'V2_MAIL_DIR and V2_CONTAINMENT_ACCOUNTS are required');
const ACCOUNTS: ContainmentAccount[] = RAW_ACCOUNTS ? (JSON.parse(RAW_ACCOUNTS) as ContainmentAccount[]) : [];

test.use({ actionTimeout: 30_000 });

function mailTime(file: string): number {
  const iso = file.slice(0, 19).replace(/T(\d\d)-(\d\d)-(\d\d)$/, 'T$1:$2:$3');
  return new Date(`${iso}Z`).getTime();
}

/** Newest identity mail for this address since `after` (the file mailbox is local-dev only). */
async function mailFor(email: string, after: number): Promise<{ callback: string }> {
  let found: { callback: string } | undefined;
  await expect
    .poll(
      () => {
        const files = readdirSync(MAIL_DIR)
          .filter((f) => f.endsWith('.json') && mailTime(f) >= after - 2000)
          .sort()
          .reverse();
        for (const file of files) {
          const mail = JSON.parse(readFileSync(path.join(MAIL_DIR, file), 'utf8'));
          if (mail.to === email) {
            found = mail;
            return true;
          }
        }
        return false;
      },
      { timeout: 20_000 },
    )
    // A 429 email-start quota refusal also lands here: the server never sent mail.
    .toBe(true);
  return found!;
}

/** The browser session's own view (GET /v1/session) with its cookies. */
async function sessionOf(page: Page): Promise<{ principal: { kind: string; account_id: string | null } }> {
  return page.evaluate(async () => (await fetch('/v1/session', { cache: 'no-store' })).json());
}

async function ownerConnections(page: Page): Promise<
  Array<{ id: string; client_name: string; status: string }>
> {
  const res = await page.request.get('/v2/agent-connections');
  expect(res.status(), await res.text().catch(() => '')).toBe(200);
  const body = await res.json();
  return (body.connections ?? body.items) as Array<{ id: string; client_name: string; status: string }>;
}

/** Browser-session mutation headers, exactly as the web client sends them. */
async function mutationHeaders(page: Page): Promise<Record<string, string>> {
  const session = await (await page.request.get('/v1/session')).json();
  return {
    'x-csrf-token': session.csrf_token,
    'x-atlas-expected-account': session.principal.account_id,
    'idempotency-key': randomUUID(),
    'content-type': 'application/json',
  };
}

test('revoke the affected test-journey agent connections through the owner route', async ({ browser }, info) => {
  test.setTimeout(300_000);
  expect(ACCOUNTS.length, 'V2_CONTAINMENT_ACCOUNTS must list at least one account').toBeGreaterThan(0);

  const refusals: string[] = [];
  const revoked: string[] = [];

  for (const account of ACCOUNTS) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      // The owner's own front door: the real email-link sign-in flow.
      await page.goto('/identity');
      await page.getByLabel('Email').fill(account.email);
      const started = Date.now();
      await page.getByRole('button', { name: 'Email verification link' }).click();
      const mail = await mailFor(account.email, started);
      await page.goto(mail.callback);

      // Ownership confirmation 1: the signed-in principal is exactly the
      // pre-identified account owner.
      await expect
        .poll(() => sessionOf(page).then((s) => s.principal.account_id), {
          timeout: 30_000,
        })
        .toBe(account.account_id);

      // Ownership confirmation 2+3: the owner route lists every
      // pre-identified connection, and each carries the journey's agent name.
      const before = await ownerConnections(page);
      const listed = new Map(before.map((c) => [c.id, c]));
      const unconfirmed = account.connection_ids.filter((id) => !listed.has(id));
      const wrongIdentity = account.connection_ids.filter(
        (id) => listed.has(id) && listed.get(id)?.client_name !== account.client_name,
      );
      if (unconfirmed.length > 0 || wrongIdentity.length > 0) {
        refusals.push(
          `${account.email}: not revoked — connection ids not listed for this owner [${unconfirmed.join(', ')}]` +
            ` or with a different client name [${wrongIdentity.join(', ')}]`,
        );
        continue;
      }

      const headers = await mutationHeaders(page);
      for (const id of account.connection_ids) {
        const revoke = await page.request.delete(`/v2/agent-connections/${id}`, { headers });
        expect(revoke.status(), `revoking ${id}: ${await revoke.text().catch(() => '')}`).toBe(204);
      }

      // Denial verified by the owner route's connection status, never by
      // exercising the agent token.
      const after = await ownerConnections(page);
      for (const id of account.connection_ids) {
        const status = after.find((c) => c.id === id)?.status;
        expect(status, `connection ${id} must read back as revoked`).toBe('revoked');
        revoked.push(`${account.account_id}/${id}`);
        info.annotations.push({
          type: 'containment-revoked',
          description: `account ${account.account_id} connection ${id} (${account.client_name}) status revoked`,
        });
      }
    } finally {
      await context.close();
    }
  }

  expect(
    refusals,
    'every revocation must be owner-confirmed; refusals require the user, never a workaround',
  ).toEqual([]);
  expect(revoked.length).toBe(ACCOUNTS.reduce((n, a) => n + a.connection_ids.length, 0));
  expect(
    new Set(revoked).size,
    'each affected connection must be revoked exactly once',
  ).toBe(revoked.length);
});
