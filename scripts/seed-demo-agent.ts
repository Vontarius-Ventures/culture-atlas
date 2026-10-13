/**
 * Seed a local demo for the independent agent (development only):
 * an account (demo owner) with a "Tokyo evenings" collection of a film, an
 * artist and a food idea, plus an agent connection limited to that collection.
 * Prints the one-time credential and the command to run the demo agent.
 *
 *   DATABASE_URL=... pnpm exec tsx scripts/seed-demo-agent.ts
 *
 * Items are marked as hand-entered demo inputs (no provider ids are invented).
 */
import { randomUUID } from 'node:crypto';
import { agentConnections, collections, createServiceContext, getDb, loadRootEnv } from '../packages/domain/src/index';

loadRootEnv(new URL('..', import.meta.url).pathname);

async function main() {
  const db = getDb();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO accounts (auth_subject, display_name, is_demo_owner) VALUES ($1, 'Demo owner', true) RETURNING id`,
    [`demo:${randomUUID()}`],
  );
  const accountId = rows[0]!.id;
  const ctx = createServiceContext({ kind: 'account', accountId, sessionId: null, isDemoOwner: true }, { surface: 'web' });

  const items: { kind: string; category: string; title: string }[] = [
    { kind: 'film', category: 'watch', title: 'Tampopo' },
    { kind: 'artist', category: 'play', title: 'Haruomi Hosono' },
    { kind: 'food', category: 'eat', title: 'Tonkotsu ramen' },
  ];
  const collection = await collections.createCollection(ctx, { name: 'Tokyo evenings' });
  for (const it of items) {
    const { rows: r } = await db.query<{ id: string }>(
      `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title, display_metadata)
       VALUES ($1, $2, $3, $4, $5, '{"subtitle": "Demo input"}'::jsonb) RETURNING id`,
      [accountId, it.kind, it.category, `demo:${it.kind}:${randomUUID()}`, it.title],
    );
    await collections.addCollectionItem(ctx, { id: collection.id, item_id: r[0]!.id, body: {} });
  }
  const conn = await agentConnections.createAgentConnection(ctx, {
    client_name: 'demo agent',
    scopes: ['collections:read', 'taste:read', 'plans:read', 'plans:write'],
    library_access: 'selected_collections',
    collection_ids: [collection.id],
    expires_in_days: 1,
  });
  console.log(JSON.stringify({ account_id: accountId, collection_id: collection.id, connection_id: conn.connection.id, mcp_url: conn.mcp_url }));
  console.log(`DEMO_AGENT_TOKEN=${conn.credential} pnpm demo-agent -- --url ${conn.mcp_url}`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
