import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, insertAccount, insertAnonymousSession } from '../testing';

const db = getTestDb();
afterAll(closeTestDb);

const SPEC_TABLES = [
  'accounts', 'sessions', 'captures', 'analyses', 'cultural_references', 'capture_references', 'claims',
  'sources', 'provider_queries', 'recommendations', 'discovery_items', 'saved_items', 'collections',
  'collection_items', 'feed_snapshots', 'preference_events', 'plans', 'plan_versions', 'jobs',
  'agent_connections', 'sensor_connections', 'idempotency_keys', 'job_stages', 'uploads',
  'discovery_jobs', 'trace_events', 'sensor_imports', 'taste_profiles', 'item_exclusions',
  'agent_connection_collections', 'usage_counters',
];

async function item(owner: { accountId?: string; sessionId?: string }, key = randomUUID()) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, owner_session_id, kind, category, canonical_key, title)
     VALUES ($1, $2, 'film', 'watch', $3, 'A film') RETURNING id`,
    [owner.accountId ?? null, owner.sessionId ?? null, `qloo:${key}`],
  );
  return rows[0]!.id;
}

describe('001_init migration', () => {
  it('creates every data-model table', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of SPEC_TABLES) expect(names).toContain(t);
  });

  it('enforces unique saved_items(owner, discovery_item_id)', async () => {
    const a = await insertAccount(db);
    const id = await item({ accountId: a.accountId });
    await db.query('INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2)', [a.accountId, id]);
    await expect(
      db.query('INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2)', [a.accountId, id]),
    ).rejects.toThrow(/unique/i);
  });

  it('requires exactly one owner on session-or-account records', async () => {
    const a = await insertAccount(db);
    const s = await insertAnonymousSession(db);
    await expect(
      db.query(
        `INSERT INTO captures (owner_account_id, owner_session_id, source, image_sha256) VALUES ($1, $2, 'upload', 'x')`,
        [a.accountId, s.sessionId],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('enforces collection_items owner match and uniqueness', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const col = await db.query<{ id: string }>(`INSERT INTO collections (owner_account_id, name) VALUES ($1, 'Mine') RETURNING id`, [a.accountId]);
    const bItem = await item({ accountId: b.accountId });
    const bSaved = await db.query<{ id: string }>('INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2) RETURNING id', [b.accountId, bItem]);
    // Someone else's saved item cannot join my collection.
    await expect(
      db.query('INSERT INTO collection_items (collection_id, saved_item_id, owner_account_id, position) VALUES ($1, $2, $3, 0)', [col.rows[0]!.id, bSaved.rows[0]!.id, a.accountId]),
    ).rejects.toThrow(/foreign key/i);

    const aItem = await item({ accountId: a.accountId });
    const aSaved = await db.query<{ id: string }>('INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2) RETURNING id', [a.accountId, aItem]);
    await db.query('INSERT INTO collection_items (collection_id, saved_item_id, owner_account_id, position) VALUES ($1, $2, $3, 0)', [col.rows[0]!.id, aSaved.rows[0]!.id, a.accountId]);
    await expect(
      db.query('INSERT INTO collection_items (collection_id, saved_item_id, owner_account_id, position) VALUES ($1, $2, $3, 1)', [col.rows[0]!.id, aSaved.rows[0]!.id, a.accountId]),
    ).rejects.toThrow(/unique/i);
  });

  it('requires exactly one parent for provider_queries and recommendations', async () => {
    await expect(
      db.query(`INSERT INTO provider_queries (provider, operation) VALUES ('qloo', 'search')`),
    ).rejects.toThrow(/check/i);
  });

  it('allows public sample items without an owner but not owned samples', async () => {
    const key = `sample:${randomUUID()}`;
    await db.query(`INSERT INTO discovery_items (is_sample, kind, canonical_key, title) VALUES (true, 'brand', $1, 'Sample')`, [key]);
    const a = await insertAccount(db);
    await expect(
      db.query(`INSERT INTO discovery_items (is_sample, owner_account_id, kind, canonical_key, title) VALUES (true, $1, 'brand', $2, 'x')`, [a.accountId, randomUUID()]),
    ).rejects.toThrow(/check/i);
  });

  it('rejects factual claims without sources', async () => {
    const ref = await db.query<{ id: string }>(
      `INSERT INTO cultural_references (canonical_name, canonical_key, type) VALUES ('Bauhaus', $1, 'style') RETURNING id`,
      [`style:${randomUUID()}`],
    );
    await expect(
      db.query(`INSERT INTO claims (reference_id, text, claim_type) VALUES ($1, 'Founded in 1919', 'factual')`, [ref.rows[0]!.id]),
    ).rejects.toThrow(/check/i);
    await db.query(`INSERT INTO claims (reference_id, text, claim_type) VALUES ($1, 'Reads as Bauhaus-inspired', 'interpretive')`, [ref.rows[0]!.id]);
  });
});
