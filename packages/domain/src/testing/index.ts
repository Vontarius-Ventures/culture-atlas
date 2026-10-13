import { randomUUID } from 'node:crypto';
import { createProviderRegistry, type ProviderOverrides, type ProviderRegistry } from '@culture-atlas/providers';
import { inject } from 'vitest';
import { loadDomainConfig, type DomainConfig } from '../config';
import { createServiceContext, type ServiceContext } from '../context';
import { createDb, type PoolDb, type Queryable } from '../db/pool';
import { SCOPES, type LibraryAccess, type Scope } from '../enums';
import type { AccountPrincipal, AgentPrincipal, AnonymousPrincipal, Principal } from '../principal';
import { generateAgentCredential, hashToken, randomToken } from '../services/auth';

/**
 * Test helpers. DB tests share one isolated database per vitest run; never
 * TRUNCATE — create fresh owners per test (accounts/sessions are cheap) so
 * files can run in parallel.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    /** Isolated per-run database created by vitest.global-setup.ts. */
    databaseUrl: string;
  }
}

let db: PoolDb | undefined;

export function getTestDb(): PoolDb {
  db ??= createDb(inject('databaseUrl'), 5);
  return db;
}

export async function closeTestDb(): Promise<void> {
  await db?.end();
  db = undefined;
}

export function testConfig(overrides: Partial<Record<string, string>> = {}): DomainConfig {
  return loadDomainConfig({ NODE_ENV: 'test', ...overrides });
}

/** Provider registry with in-memory storage and no live providers unless overridden. */
export function testProviders(overrides: ProviderOverrides = {}): ProviderRegistry {
  return createProviderRegistry({ STORAGE_DRIVER: 'memory' }, overrides);
}

export function testContext(
  principal: Principal,
  options: { db?: Queryable & PoolDb; providers?: ProviderRegistry; config?: DomainConfig; now?: () => Date } = {},
): ServiceContext {
  return createServiceContext(principal, {
    db: options.db ?? getTestDb(),
    providers: options.providers ?? testProviders(),
    config: options.config ?? testConfig(),
    now: options.now,
    surface: 'test',
  });
}

export async function insertAccount(dbh: Queryable = getTestDb(), opts: { isDemoOwner?: boolean } = {}): Promise<AccountPrincipal> {
  const { rows } = await dbh.query<{ id: string }>(
    'INSERT INTO accounts (auth_subject, is_demo_owner) VALUES ($1, $2) RETURNING id',
    [`test:${randomUUID()}`, opts.isDemoOwner ?? false],
  );
  const accountId = rows[0]!.id;
  const s = await dbh.query<{ id: string }>(
    `INSERT INTO sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
    [accountId, hashToken(randomToken())],
  );
  return { kind: 'account', accountId, sessionId: s.rows[0]!.id, isDemoOwner: opts.isDemoOwner ?? false };
}

export async function insertAnonymousSession(dbh: Queryable = getTestDb()): Promise<AnonymousPrincipal> {
  const { rows } = await dbh.query<{ id: string; expires_at: Date }>(
    `INSERT INTO sessions (token_hash, expires_at) VALUES ($1, now() + interval '24 hours') RETURNING id, expires_at`,
    [hashToken(randomToken())],
  );
  return { kind: 'anonymous', sessionId: rows[0]!.id, expiresAt: rows[0]!.expires_at };
}

/** Inserts an agent connection row and returns its principal + bearer credential. */
export async function insertAgentConnection(
  account: { accountId: string },
  opts: { scopes?: Scope[]; libraryAccess?: LibraryAccess; collectionIds?: string[]; clientName?: string } = {},
  dbh: Queryable = getTestDb(),
): Promise<{ principal: AgentPrincipal; credential: string }> {
  const cred = generateAgentCredential();
  const scopes = opts.scopes ?? [...SCOPES];
  const libraryAccess = opts.libraryAccess ?? 'all';
  const { rows } = await dbh.query<{ id: string; expires_at: Date }>(
    `INSERT INTO agent_connections (owner_account_id, client_name, credential_hash, credential_prefix, scopes,
                                    library_access, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + interval '30 days') RETURNING id, expires_at`,
    [account.accountId, opts.clientName ?? 'test agent', cred.hash, cred.prefix, scopes, libraryAccess],
  );
  const id = rows[0]!.id;
  for (const cid of opts.collectionIds ?? []) {
    await dbh.query('INSERT INTO agent_connection_collections (agent_connection_id, collection_id) VALUES ($1, $2)', [id, cid]);
  }
  return {
    credential: cred.credential,
    principal: {
      kind: 'agent',
      accountId: account.accountId,
      connectionId: id,
      clientName: opts.clientName ?? 'test agent',
      purpose: 'agent',
      scopes,
      libraryAccess,
      allowedCollectionIds: opts.collectionIds ?? [],
      sensorConnectionId: null,
      expiresAt: rows[0]!.expires_at,
    },
  };
}
