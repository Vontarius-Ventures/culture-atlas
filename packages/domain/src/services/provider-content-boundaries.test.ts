import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { upsertDiscoveryItem } from '../composer/store';
import { MIGRATIONS_DIR, runMigrations } from '../db/migrate';
import { accountCtx, insertItem } from '../test-support/library';
import { closeTestDb, createIsolatedDatabase, getTestDb, insertAccount } from '../testing';
import { loadCards } from './cards';
import { getItem } from './items';

/**
 * DISC-SCR-001 (VAL-EVID-005): the recorded Qloo rights policy — responses are
 * transient, displayed assets must be owned or independently cleared, and the
 * rights themselves are still undocumented — is enforced at the ACTUAL
 * discovery-item boundaries:
 *
 *  - the discovery-item store (fresh inserts AND existing-row upsert merges),
 *  - the card / item-detail readers that serve old rows,
 *  - and the strip migration for previously persisted restricted metadata.
 *
 * Qloo prose (properties.short_description / description) and Qloo-returned
 * image URLs must never persist or display; user-owned stored media, app-owned
 * sample assets and independently produced (model/user) prose stay usable.
 */
const db = getTestDb();
afterAll(closeTestDb);

const RESTRICTED_METADATA_MIGRATION = '330_provider_content_display_rights.sql';

describe('recorded provider rights policy (anchor)', () => {
  it('keeps Qloo transient-only and owned-or-cleared while its rights stay undocumented', async () => {
    // The static code boundaries below fail closed exactly while this recorded
    // policy says the retention/public-display rights are undocumented. If a
    // future change documents real rights here, the display boundary must be
    // revisited deliberately (with a migration and a review), never inferred
    // from HTTPS, a provider license field or operator assurance.
    const { rows } = await db.query<{ response_retention: string; public_display: string; rights_documented: boolean }>(
      `SELECT response_retention, public_display, rights_documented FROM provider_rights_policies WHERE provider = 'qloo'`,
    );
    expect(rows[0]).toMatchObject({
      response_retention: 'transient_only',
      public_display: 'owned_or_cleared_only',
      rights_documented: false,
    });
  });
});

describe('discovery-item store boundary', () => {
  it('drops Qloo prose and uncleared imagery from provider-backed upserts while cleared content persists', async () => {
    const account = await insertAccount();
    const owner = { kind: 'account' as const, accountId: account.accountId };

    // A live provider card shape: Qloo prose plus an https image URL.
    const restricted = await upsertDiscoveryItem(db, owner, {
      kind: 'film',
      category: 'watch',
      canonical_key: 'qloo:store-boundary-film',
      title: 'Boundary Film',
      display_metadata: {
        subtitle: '1957',
        year: 1957,
        description: 'Qloo prose that must stay transient.',
        image: { url: 'https://images.example/boundary.jpg', alt: 'Boundary', license: 'source', attribution: 'Qloo' },
        destination_url: 'https://boundary.example.com',
        example: false,
      },
      external_ids: { qloo: 'store-boundary-film' },
    });
    const stored = await db.query<{ display_metadata: Record<string, unknown> }>(
      'SELECT display_metadata FROM discovery_items WHERE id = $1',
      [restricted],
    );
    expect(stored.rows[0]!.display_metadata).toEqual({
      subtitle: '1957',
      year: 1957,
      destination_url: 'https://boundary.example.com',
      example: false,
    });

    // Independently produced (model) prose on a non-provider row persists.
    const model = await upsertDiscoveryItem(db, owner, {
      kind: 'food',
      category: 'eat',
      canonical_key: 'food:boundary-model-dish',
      title: 'Boundary Dish',
      display_metadata: { description: 'A model-composed idea.' },
      external_ids: {},
    });
    const modelMeta = await db.query<{ display_metadata: Record<string, unknown> }>(
      'SELECT display_metadata FROM discovery_items WHERE id = $1',
      [model],
    );
    expect(modelMeta.rows[0]!.display_metadata.description).toBe('A model-composed idea.');

    // Owned/cleared display images persist: user-owned stored media and app-served assets.
    const storedImage = await upsertDiscoveryItem(db, owner, {
      kind: 'film',
      category: 'watch',
      canonical_key: 'capture:boundary-stored',
      title: 'Boundary Stored',
      display_metadata: { image: { object_key: 'captures/test/boundary.jpg', alt: 'Your photo' } },
      external_ids: {},
    });
    const sampleImage = await upsertDiscoveryItem(db, owner, {
      kind: 'food',
      category: 'eat',
      canonical_key: 'food:boundary-sample-dish',
      title: 'Boundary Sample',
      display_metadata: { image: { url: '/samples/feed/sesame-noodles.jpg', alt: 'Noodles' } },
      external_ids: {},
    });
    const metas = await db.query<{ id: string; display_metadata: Record<string, unknown> }>(
      'SELECT id, display_metadata FROM discovery_items WHERE id = ANY($1::uuid[])',
      [[storedImage, sampleImage]],
    );
    const byId = new Map(metas.rows.map((r) => [r.id, r.display_metadata]));
    expect(byId.get(storedImage)!.image).toMatchObject({ object_key: 'captures/test/boundary.jpg' });
    expect(byId.get(sampleImage)!.image).toMatchObject({ url: '/samples/feed/sesame-noodles.jpg' });
  });

  it('cleans previously persisted restricted metadata when an existing row is upserted again', async () => {
    const account = await insertAccount();
    const owner = { kind: 'account' as const, accountId: account.accountId };

    // Legacy provider-backed row seeded directly, as a pre-boundary writer left it.
    const seeded = await db.query<{ id: string }>(
      `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title, display_metadata, external_ids)
       VALUES ($1, 'film', 'watch', 'qloo:legacy-merge-film', 'Legacy Merge Film', $2::jsonb, $3::jsonb) RETURNING id`,
      [
        owner.accountId,
        JSON.stringify({
          subtitle: '1957',
          description: 'Legacy Qloo prose.',
          image: { url: 'https://images.example/legacy.jpg', alt: 'Legacy' },
        }),
        JSON.stringify({ qloo: 'legacy-merge-film' }),
      ],
    );
    const legacyId = seeded.rows[0]!.id;
    await upsertDiscoveryItem(db, owner, {
      kind: 'film',
      category: 'watch',
      canonical_key: 'qloo:legacy-merge-film',
      title: 'Legacy Merge Film',
      display_metadata: { subtitle: '1957', destination_url: 'https://legacy.example.com' },
      external_ids: { qloo: 'legacy-merge-film' },
    });
    const merged = await db.query<{ display_metadata: Record<string, unknown> }>(
      'SELECT display_metadata FROM discovery_items WHERE id = $1',
      [legacyId],
    );
    expect(merged.rows[0]!.display_metadata.subtitle).toBe('1957');
    expect(merged.rows[0]!.display_metadata.description ?? null).toBeNull();
    expect(merged.rows[0]!.display_metadata.image ?? null).toBeNull();
    expect(merged.rows[0]!.display_metadata.destination_url).toBe('https://legacy.example.com');

    // Legacy non-provider row: its model prose survives the merge; the uncleared image does not.
    const seededModel = await db.query<{ id: string }>(
      `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title, display_metadata, external_ids)
       VALUES ($1, 'food', 'eat', 'food:legacy-model-dish', 'Legacy Model Dish', $2::jsonb, '{}'::jsonb) RETURNING id`,
      [
        owner.accountId,
        JSON.stringify({
          description: 'A model-composed idea.',
          image: { url: 'https://images.example/model.jpg', alt: 'Dish' },
        }),
      ],
    );
    await upsertDiscoveryItem(db, owner, {
      kind: 'food',
      category: 'eat',
      canonical_key: 'food:legacy-model-dish',
      title: 'Legacy Model Dish',
      display_metadata: { subtitle: 'Shared plate' },
      external_ids: {},
    });
    const mergedModel = await db.query<{ display_metadata: Record<string, unknown> }>(
      'SELECT display_metadata FROM discovery_items WHERE id = $1',
      [seededModel.rows[0]!.id],
    );
    expect(mergedModel.rows[0]!.display_metadata.description).toBe('A model-composed idea.');
    expect(mergedModel.rows[0]!.display_metadata.subtitle).toBe('Shared plate');
    expect(mergedModel.rows[0]!.display_metadata.image ?? null).toBeNull();
  });
});

describe('card and item-detail reads of previously persisted metadata', () => {
  it('serves only owned or independently cleared images and never provider-backed prose', async () => {
    const { ctx, principal } = await accountCtx();

    // Legacy provider-backed row seeded directly: Qloo prose + uncleared image URL.
    const legacy = await insertItem({ accountId: principal.accountId }, { kind: 'film', qloo: 'legacy-read-film', title: 'Legacy Read Film' });
    await db.query(`UPDATE discovery_items SET display_metadata = $2::jsonb WHERE id = $1`, [
      legacy,
      JSON.stringify({
        subtitle: '1957',
        description: 'Legacy Qloo prose.',
        image: { url: 'https://images.example/legacy.jpg', alt: 'Legacy' },
        destination_url: 'https://legacy.example.com',
      }),
    ]);

    // User-owned stored media, an app-owned sample asset and model prose stay usable.
    const stored = await insertItem({ accountId: principal.accountId }, { kind: 'film', title: 'Stored Photo Film' });
    await db.query(`UPDATE discovery_items SET display_metadata = $2::jsonb WHERE id = $1`, [
      stored,
      JSON.stringify({ image: { object_key: 'captures/test/read.jpg', width: 640, height: 480, alt: 'Your photo' } }),
    ]);
    const sampled = await insertItem({ accountId: principal.accountId }, { kind: 'food', category: 'eat', title: 'Sampled Dish' });
    await db.query(`UPDATE discovery_items SET display_metadata = $2::jsonb WHERE id = $1`, [
      sampled,
      JSON.stringify({ image: { url: '/samples/feed/sesame-noodles.jpg', alt: 'Noodles' } }),
    ]);
    const modeled = await insertItem({ accountId: principal.accountId }, { kind: 'food', category: 'eat', title: 'Modeled Dish' });
    await db.query(`UPDATE discovery_items SET display_metadata = $2::jsonb WHERE id = $1`, [
      modeled,
      JSON.stringify({ description: 'A model-composed idea.' }),
    ]);

    // The shared card reader (feed, items, collections, saved, plans) never
    // serves the uncleared provider URL; owned/cleared images still resolve.
    const cards = await loadCards(ctx, [legacy, stored, sampled, modeled]);
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(byId.get(legacy)!.image).toBeNull();
    expect(byId.get(stored)!.image).not.toBeNull();
    expect(byId.get(stored)!.image?.alt).toBe('Your photo');
    expect(byId.get(sampled)!.image).toMatchObject({ url: '/samples/feed/sesame-noodles.jpg' });

    // Item detail serves no provider-backed prose and no uncleared image, while
    // independently produced prose and verified destination links still read.
    const detail = await getItem(ctx, { id: legacy, query: {} });
    expect(detail.description).toBeNull();
    expect(detail.item.image).toBeNull();
    expect(detail.destination_url).toBe('https://legacy.example.com');
    const modelDetail = await getItem(ctx, { id: modeled, query: {} });
    expect(modelDetail.description).toBe('A model-composed idea.');
  });
});

describe(`migration ${RESTRICTED_METADATA_MIGRATION} (previously persisted metadata)`, () => {
  it('strips provider prose from provider-backed rows and uncleared images everywhere, keeping owned assets', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ca-migrations-'));
    try {
      for (const file of await readdir(MIGRATIONS_DIR)) {
        if (file.endsWith('.sql') && file !== RESTRICTED_METADATA_MIGRATION) {
          await copyFile(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
        }
      }
      const iso = await createIsolatedDatabase({ migrate: false, prefix: 'ca_prbnd' });
      try {
        // The database is at the pre-330 migration head, as the user's running
        // deployment is when this repair lands.
        await runMigrations(iso.url, { dir });
        const account = await insertAccount(iso.db);
        const ownerId = account.accountId;
        const seedRow = (
          canonicalKey: string,
          kind: string,
          category: string | null,
          externalIds: Record<string, unknown>,
          meta: Record<string, unknown>,
        ) =>
          iso.db.query(
            `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title, display_metadata, external_ids)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
            [ownerId, kind, category, canonicalKey, `Row ${canonicalKey}`, JSON.stringify(meta), JSON.stringify(externalIds)],
          );
        await seedRow('qloo:mig-a', 'film', 'watch', { qloo: 'mig-a' }, {
          description: 'Qloo prose.',
          image: { url: 'https://images.example/a.jpg' },
          subtitle: '1957',
          destination_url: 'https://a.example.com',
        });
        await seedRow('qloo:mig-b', 'style', 'wear', { qloo_tag: 'urn:tag:fixture:mig-b' }, { description: 'Qloo tag prose.' });
        await seedRow('food:mig-c', 'food', 'eat', {}, {
          description: 'A model-composed idea.',
          image: { url: 'https://images.example/c.jpg' },
        });
        await seedRow('test:mig-d', 'film', 'watch', {}, { image: { object_key: 'captures/test/d.jpg', alt: 'Your photo' } });
        await seedRow('food:mig-e', 'food', 'eat', {}, { image: { url: '/samples/feed/sesame-noodles.jpg' } });

        const applied = await runMigrations(iso.url);
        expect(applied.applied).toEqual([RESTRICTED_METADATA_MIGRATION]);

        const meta = async (canonicalKey: string) =>
          (
            await iso.db.query<{ display_metadata: Record<string, unknown> }>(
              'SELECT display_metadata FROM discovery_items WHERE owner_account_id = $1 AND canonical_key = $2',
              [ownerId, canonicalKey],
            )
          ).rows[0]!.display_metadata;
        // Provider prose and the uncleared image are gone; the verified link survives.
        expect(await meta('qloo:mig-a')).toEqual({ subtitle: '1957', destination_url: 'https://a.example.com' });
        expect(await meta('qloo:mig-b')).toEqual({});
        // Independently produced prose survives; its uncleared image does not.
        expect(await meta('food:mig-c')).toEqual({ description: 'A model-composed idea.' });
        // Owned stored media and app-served sample assets survive untouched.
        expect(await meta('test:mig-d')).toEqual({ image: { object_key: 'captures/test/d.jpg', alt: 'Your photo' } });
        expect(await meta('food:mig-e')).toEqual({ image: { url: '/samples/feed/sesame-noodles.jpg' } });

        // Reapplying is idempotent.
        const again = await runMigrations(iso.url);
        expect(again.applied).toEqual([]);
      } finally {
        await iso.drop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
