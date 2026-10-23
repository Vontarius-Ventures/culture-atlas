/**
 * Seed the design-fidelity fixture account (development databases only).
 *
 *   DATABASE_URL=... pnpm exec tsx scripts/seed-fidelity.ts [--out <file.json>]
 *
 * It creates two accounts that can sign in with FIXTURE_PASSWORD below, both
 * with the display name "Alex". The library account (fidelity@example.com)
 * mirrors the v1 mockups (design/cultural-atlas-v1/mockups/01..07); the
 * account-settings account (fidelity-account@example.com) mirrors the v2 agent
 * and sharing mockups (specs/capture-platform-v2/design/index.html 10..13).
 * They are separate so the collections index shows exactly the four covers of
 * mockup 07 while the sharing screens show "Quiet weekends":
 *
 *  - Discover: eight cards in mockup order (Vintage racing … Tea rituals);
 *  - Collections: Slow Sunday (6), After dark (4), Everyday favorites (8) and
 *    two unfiled saves (Saved for later); Quiet weekends (2) on the second account;
 *  - an item with a reference and three related cards (mockup 06);
 *  - a movie night planned from Slow Sunday (mockup 03);
 *  - an agent connection, "My research assistant", limited to Quiet weekends,
 *    which then really reads the preferences and that collection through the
 *    domain services, so the activity list is genuine.
 *
 * Honesty rules. Nothing here is presented as a provider result:
 *  - every seeded discovery item carries `display_metadata.example = true`, so
 *    the UI labels it "Example result" wherever it appears;
 *  - recommendations use origin 'sample' (never 'qloo'), no provider_queries
 *    rows are written, and plan picks are stored with origin 'sample';
 *  - images are the project-original illustrations in apps/web/public/samples
 *    (fixtures/images/LICENSES.md). Films and artists get no stand-in picture.
 * Titles and short descriptions are the mockups' illustrative fixtures.
 *
 * Re-running deletes the previous fixture accounts (by their emails) first.
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  agentPlatform,
  auth,
  collections,
  createServiceContext,
  getDb,
  loadRootEnv,
  preferences,
  type Principal,
} from '../packages/domain/src/index';
import { hashPassword } from '../packages/domain/src/services/passwords';

const root = new URL('..', import.meta.url).pathname;
loadRootEnv(root);

export const FIXTURE_EMAIL = 'fidelity@example.com';
export const FIXTURE_ACCOUNT_EMAIL = 'fidelity-account@example.com';
/** Local fixture password (not a secret: the account exists only in a development database). */
export const FIXTURE_PASSWORD = 'fidelity-fixture-password';

const img = (path: string, alt: string) => ({ url: path, alt, width: 1000, height: 1250, license: 'project-original' });

interface Fixture {
  key: string;
  kind: 'capture' | 'style' | 'brand' | 'artist' | 'track' | 'film' | 'food' | 'reference';
  category: 'wear' | 'play' | 'watch' | 'eat' | null;
  title: string;
  subtitle?: string;
  description?: string;
  year?: number;
  destination_url?: string;
  image?: ReturnType<typeof img>;
}

// Discover (mockups 01 and 04), in mockup order. Kinds and categories are
// chosen so the feed's category interleaving keeps exactly this order.
const FEED: Fixture[] = [
  { key: 'feed:vintage-racing', kind: 'style', category: 'wear', title: 'Vintage racing', description: 'A few motorsport references stood out.', image: img('/samples/outfit.jpg', 'A cream racing-style jacket with red and navy stripes on a wooden chair') },
  { key: 'feed:quiet-corners', kind: 'reference', category: null, title: 'Quiet corners', description: 'Soft light, low furniture and room to breathe.', image: img('/samples/room.jpg', 'A paned window with afternoon light over a low wooden table') },
  { key: 'feed:sunday-listening', kind: 'reference', category: 'play', title: 'Sunday listening', description: 'Records to spend a little time with.', image: img('/samples/feed/sunday-listening.jpg', 'A record player with records and a lamp') },
  { key: 'feed:around-the-table', kind: 'food', category: 'eat', title: 'Around the table', description: 'Dishes made for passing around.', image: img('/samples/feed/around-the-table.jpg', 'Shared dishes on a wooden table, seen from above') },
  { key: 'feed:night-wanderings', kind: 'reference', category: 'watch', title: 'Night wanderings', description: 'Lamplit streets after rain.', image: img('/samples/feed/night-wanderings.jpg', 'A lamplit street after rain') },
  { key: 'feed:sculptural-forms', kind: 'reference', category: null, title: 'Sculptural forms', description: 'Rounded, soft-edged furniture.', image: img('/samples/feed/sculptural-forms.jpg', 'A rounded cream chair beside a side table and a branch') },
  { key: 'feed:linen-days', kind: 'style', category: 'wear', title: 'Linen days', description: 'Light clothing for warm days.', image: img('/samples/feed/linen-days.jpg', 'A linen shirt on a hanger in leaf shadows') },
  { key: 'feed:tea-rituals', kind: 'food', category: 'eat', title: 'Tea rituals', description: 'A cast-iron pot and a slow cup.', image: img('/samples/feed/tea-rituals.jpg', 'A cast-iron teapot and cup beside a blossom branch') },
];

// "You might also like" on the Vintage racing item (mockup 06).
const RELATED: Fixture[] = [
  { key: 'related:night-on-film', kind: 'reference', category: 'watch', title: 'Night on film', description: 'Rain, neon and late streets.', image: img('/samples/feed/rainy-alley.jpg', 'A lantern-lit alley at night') },
  { key: 'related:softer-silhouette', kind: 'style', category: 'wear', title: 'A softer silhouette', description: 'Unstructured tailoring.', image: img('/samples/feed/softer-silhouette.jpg', 'An unstructured blazer on a cane chair') },
];

// Saved items (collections, mockups 02, 05 and 07).
const SAVED: Fixture[] = [
  { key: 'saved:quiet-corners', kind: 'capture', category: null, title: 'Quiet corners', image: img('/samples/room.jpg', 'Your photo: a paned window with afternoon light over a low wooden table') },
  { key: 'saved:sunday-listening', kind: 'track', category: 'play', title: 'Sunday listening', subtitle: 'Listening at home', image: img('/samples/feed/sunday-listening.jpg', 'A record player with records and a lamp') },
  { key: 'saved:late-night-cinema', kind: 'film', category: 'watch', title: 'Late-night cinema', subtitle: 'A night at the pictures', image: img('/samples/feed/late-night-cinema.jpg', 'Cinema marquee lights and two silhouettes') },
  { key: 'saved:something-to-share', kind: 'food', category: 'eat', title: 'Something to share', subtitle: 'Salad bowl', image: img('/samples/feed/something-to-share.jpg', 'A salad bowl seen from above') },
  { key: 'saved:vintage-racing', kind: 'style', category: 'wear', title: 'Vintage racing', subtitle: 'Style direction', image: img('/samples/outfit.jpg', 'A cream racing-style jacket with red and navy stripes on a wooden chair') },
  { key: 'saved:tea-for-two', kind: 'reference', category: null, title: 'Tea for two', subtitle: 'Tea at home', image: img('/samples/feed/tea-rituals.jpg', 'A cast-iron teapot and cup beside a blossom branch') },
  { key: 'saved:night-wanderings', kind: 'reference', category: 'watch', title: 'Night wanderings', subtitle: 'After dark', image: img('/samples/feed/night-wanderings.jpg', 'A lamplit street after rain') },
  { key: 'saved:lantern-alley', kind: 'reference', category: null, title: 'Lantern alley', subtitle: 'After dark', image: img('/samples/feed/rainy-alley.jpg', 'A lantern-lit alley at night') },
  { key: 'saved:linen-days', kind: 'style', category: 'wear', title: 'Linen days', subtitle: 'Style direction', image: img('/samples/feed/linen-days.jpg', 'A linen shirt on a hanger in leaf shadows') },
  { key: 'saved:sculptural-forms', kind: 'reference', category: null, title: 'Sculptural forms', subtitle: 'Design', image: img('/samples/feed/sculptural-forms.jpg', 'A rounded cream chair beside a side table and a branch') },
  { key: 'saved:blossom', kind: 'reference', category: null, title: 'First blossom', subtitle: 'Spring', image: img('/samples/feed/blossom-branch.jpg', 'A blossom branch against a soft background') },
  { key: 'saved:cafe-afternoon', kind: 'reference', category: null, title: 'A café afternoon', subtitle: 'Cafés', image: img('/samples/cafe.jpg', 'A marble café table with a cup and a pastry') },
  { key: 'saved:around-the-table', kind: 'food', category: 'eat', title: 'Around the table', subtitle: 'Shared dishes', image: img('/samples/feed/around-the-table.jpg', 'Shared dishes on a wooden table, seen from above') },
  { key: 'saved:sesame-noodles', kind: 'food', category: 'eat', title: 'Sesame noodles', subtitle: 'Cold noodle dish', image: img('/samples/feed/sesame-noodles.jpg', 'A bowl of noodles with chopsticks') },
  { key: 'saved:softer-silhouette', kind: 'style', category: 'wear', title: 'A softer silhouette', subtitle: 'Style direction', image: img('/samples/feed/softer-silhouette.jpg', 'An unstructured blazer on a cane chair') },
  { key: 'saved:cucumber-salad', kind: 'food', category: 'eat', title: 'Cucumber salad', subtitle: 'Smashed cucumber', image: img('/samples/feed/cucumber-salad.jpg', 'A cucumber salad bowl') },
];

// Quiet weekends (second account; shared in mockups 12 and 13): the mockup panels show text only.
const QUIET_WEEKENDS: Fixture[] = [
  { key: 'saved:neighborhood-gallery', kind: 'reference', category: null, title: 'A neighborhood gallery', description: 'Art, small exhibitions and an afternoon nearby.' },
  { key: 'saved:qw-sunday-listening', kind: 'reference', category: 'play', title: 'Sunday listening', description: 'Records to spend a little time with.' },
];

// Plan picks (mockup 03). Films and artists have no licensed image.
const PLAN_ITEMS: Fixture[] = [
  { key: 'plan:in-the-mood-for-love', kind: 'film', category: 'watch', title: 'In the Mood for Love', year: 2000, subtitle: '2000 · Wong Kar-wai', description: 'Wong Kar-wai’s film set in 1960s Hong Kong.', destination_url: 'https://en.wikipedia.org/wiki/In_the_Mood_for_Love' },
  { key: 'plan:bill-evans', kind: 'artist', category: 'play', title: 'Bill Evans', subtitle: 'Jazz pianist', destination_url: 'https://en.wikipedia.org/wiki/Bill_Evans' },
  { key: 'plan:nina-simone', kind: 'artist', category: 'play', title: 'Nina Simone', subtitle: 'Singer, songwriter and pianist', destination_url: 'https://en.wikipedia.org/wiki/Nina_Simone' },
  { key: 'plan:chet-baker', kind: 'artist', category: 'play', title: 'Chet Baker', subtitle: 'Jazz trumpeter and singer', destination_url: 'https://en.wikipedia.org/wiki/Chet_Baker' },
];

function displayOf(f: Fixture) {
  return {
    subtitle: f.subtitle ?? null,
    year: f.year ?? null,
    description: f.description ?? null,
    image: f.image ?? null,
    destination_url: f.destination_url ?? null,
    example: true,
  };
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed fixture data with NODE_ENV=production.');
  const outIdx = process.argv.indexOf('--out');
  const outFile = outIdx > 0 ? process.argv[outIdx + 1] : undefined;
  const db = getDb();

  // Replace earlier fixture accounts.
  await db.query(
    `DELETE FROM accounts WHERE id IN (SELECT account_id FROM account_credentials WHERE email = ANY($1::text[]))`,
    [[FIXTURE_EMAIL, FIXTURE_ACCOUNT_EMAIL]],
  );
  const makeAccount = async (email: string) => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO accounts (auth_subject, display_name) VALUES ($1, 'Alex') RETURNING id`,
      [`email:${email}`],
    );
    const id = rows[0]!.id;
    await db.query('INSERT INTO account_credentials (account_id, email, password_hash) VALUES ($1, $2, $3)', [
      id,
      email,
      await hashPassword(FIXTURE_PASSWORD),
    ]);
    // Amendment 2.2: both fixture people already went through the taste questionnaire, so
    // sign-in opens the app (the settings account has only two saves and would otherwise be
    // sent to /welcome/taste, ONB-06). The questionnaire itself is covered by the v22 runs.
    await db.query(
      `INSERT INTO onboarding_states (account_id, required, origin, started_at, completed_at, trigger_checked_at)
       VALUES ($1, false, 'sign_up', now(), now(), now())`,
      [id],
    );
    const principal: Principal = { kind: 'account', accountId: id, sessionId: null, isDemoOwner: false };
    return { id, ctx: createServiceContext(principal, { surface: 'web' }) };
  };
  const library = await makeAccount(FIXTURE_EMAIL);
  const settings = await makeAccount(FIXTURE_ACCOUNT_EMAIL);
  const accountId = library.id;
  const ctx = library.ctx;

  const ids = new Map<string, string>();
  const insertItem = async (f: Fixture, ownerId = accountId) => {
    let captureId: string | null = null;
    if (f.kind === 'capture') {
      // The owner's own photo. No analysis row: nothing model-made is invented.
      const file = readFileSync(`${root}apps/web/public${f.image!.url}`);
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (owner_account_id, source, image_sha256, width, height, captured_at, status)
         VALUES ($1, 'upload', $2, 1000, 1250, now(), 'ready') RETURNING id`,
        [ownerId, createHash('sha256').update(file).digest('hex')],
      );
      captureId = c.rows[0]!.id;
    }
    const r = await db.query<{ id: string }>(
      `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title, display_metadata, capture_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING id`,
      [ownerId, f.kind, f.category, captureId ? `capture:${captureId}` : `fixture:${f.key}`, f.title, JSON.stringify(displayOf(f)), captureId],
    );
    ids.set(f.key, r.rows[0]!.id);
    return r.rows[0]!.id;
  };
  for (const f of [...FEED, ...RELATED, ...SAVED, ...PLAN_ITEMS]) await insertItem(f);
  for (const f of QUIET_WEEKENDS) await insertItem(f, settings.id);
  const id = (key: string) => {
    const v = ids.get(key);
    if (!v) throw new Error(`missing fixture ${key}`);
    return v;
  };

  // A public reference for "Explore the references" (no claims, no research).
  const ref = await db.query<{ id: string }>(
    `INSERT INTO cultural_references (canonical_name, canonical_key, type, external_ids)
     VALUES ('Motorsport', 'fixture:reference:motorsport', 'tradition', '{"wikipedia": "https://en.wikipedia.org/wiki/Motorsport"}'::jsonb)
     ON CONFLICT (canonical_key) DO UPDATE SET canonical_name = EXCLUDED.canonical_name RETURNING id`,
  );
  await db.query('UPDATE discovery_items SET reference_id = $2 WHERE id = $1', [id('feed:vintage-racing'), ref.rows[0]!.id]);

  // Collections, through the real services.
  const make = async (name: string, description: string | null, keys: string[], owner = ctx) => {
    const col = await collections.createCollection(owner, { name, description });
    for (const k of keys) await collections.addCollectionItem(owner, { id: col.id, item_id: id(k), body: {} });
    return col.id;
  };
  const quietWeekends = await make('Quiet weekends', 'A few things for slower days.', ['saved:neighborhood-gallery', 'saved:qw-sunday-listening'], settings.ctx);
  const everyday = await make('Everyday favorites', 'Small things worth keeping close.', [
    'saved:tea-for-two', 'saved:linen-days', 'saved:sculptural-forms', 'saved:blossom',
    'saved:cafe-afternoon', 'saved:around-the-table', 'saved:something-to-share', 'saved:sesame-noodles',
  ]);
  const afterDark = await make('After dark', 'Late streets, small bars and records.', [
    'saved:night-wanderings', 'saved:lantern-alley', 'saved:late-night-cinema', 'saved:sunday-listening',
  ]);
  const slowSunday = await make('Slow Sunday', 'A little music, a little cinema, something good to eat.', [
    'saved:quiet-corners', 'saved:sunday-listening', 'saved:late-night-cinema',
    'saved:something-to-share', 'saved:vintage-racing', 'saved:tea-for-two',
  ]);
  // Two unfiled saves ("Saved for later").
  for (const k of ['saved:cucumber-salad', 'saved:softer-silhouette']) {
    await preferences.recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: id(k) });
  }
  // Collections index order: Slow Sunday, After dark, Everyday favorites (most recently updated first).
  const order = [slowSunday, afterDark, everyday];
  for (const [i, colId] of order.entries()) {
    await db.query(`UPDATE collections SET updated_at = now() - make_interval(mins => $2) WHERE id = $1`, [colId, i * 10]);
  }

  // Discover: each card is a related-discovery result of a saved item (origin
  // 'sample' → "Example result"). One completed discovery job per card keeps
  // the mockup order through rank fusion; newest first.
  const origin = id('saved:vintage-racing');
  for (const [i, f] of FEED.entries()) {
    const dj = await db.query<{ id: string }>(
      `INSERT INTO discovery_jobs (owner_account_id, origin_item_id, origin_collection_id, category, status, created_at)
       VALUES ($1, $2, $3, $4, 'complete', now() - make_interval(secs => $5)) RETURNING id`,
      [accountId, origin, slowSunday, f.category, 600 + i],
    );
    await db.query(
      `INSERT INTO recommendations (discovery_job_id, discovery_item_id, category, rank, title, display_reason, origin, created_at)
       VALUES ($1, $2, $3, 1, $4, $5, 'sample', now() - make_interval(secs => $6))`,
      [dj.rows[0]!.id, id(f.key), f.category, f.title, f.description ?? null, 600 + i],
    );
  }
  // Related to the Vintage racing card (mockup 06).
  const relJob = await db.query<{ id: string }>(
    `INSERT INTO discovery_jobs (owner_account_id, origin_item_id, status) VALUES ($1, $2, 'complete') RETURNING id`,
    [accountId, id('feed:vintage-racing')],
  );
  for (const [rank, key] of ['feed:sunday-listening', 'related:night-on-film', 'related:softer-silhouette'].entries()) {
    await db.query(
      `INSERT INTO recommendations (discovery_job_id, discovery_item_id, rank, title, origin)
       SELECT $1, id, $3, title, 'sample' FROM discovery_items WHERE id = $2`,
      [relJob.rows[0]!.id, id(key), rank + 1],
    );
  }

  // Movie night from Slow Sunday (mockup 03): stored the way the composer stores it,
  // every pick with origin 'sample' so each section shows "Example result".
  const inputs = ['saved:sunday-listening', 'saved:late-night-cinema', 'saved:tea-for-two'];
  const pick = (key: string, extra: Record<string, unknown>) => {
    const f = [...SAVED, ...PLAN_ITEMS].find((x) => x.key === key)!;
    return {
      item_id: id(key), kind: f.kind, title: f.title, year: f.year ?? null, detail: null, description: f.description ?? null,
      reason: null, is_fixed: false, key: `fixture:${key}`, contributing_input_ids: inputs.map(id), origin: 'sample', ...extra,
    };
  };
  const snapshotItems = inputs.map((k) => {
    const f = SAVED.find((x) => x.key === k)!;
    return { item_id: id(k), saved_item_id: null, kind: f.kind, category: f.category, title: f.title, canonical_key: `fixture:${k}`, external_ids: {}, subtitle: f.subtitle ?? null, year: null, detail: null, anchors: [], capture: null };
  });
  const plan = await db.query<{ id: string }>(
    `INSERT INTO plans (owner_account_id, source_collection_id, selected_item_ids, status, active_version, exploration)
     VALUES ($1, $2, $3::uuid[], 'complete', 1, 'balanced') RETURNING id`,
    [accountId, slowSunday, inputs.map(id)],
  );
  await db.query(
    `INSERT INTO plan_versions (plan_id, version, collection_revision, input_snapshot, title, summary, film, food, music, section_statuses)
     VALUES ($1, 1, 1, $2::jsonb, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, '{"film":"complete","food":"complete","music":"complete"}'::jsonb)`,
    [
      plan.rows[0]!.id,
      JSON.stringify({
        template: 'movie_night',
        collection: { id: slowSunday, name: 'Slow Sunday', description: null, revision: 1 },
        items: snapshotItems,
        constraints: { dietary_exclusions: [], instruction: null },
        exploration: 'balanced',
        fixed_film_item_id: null,
      }),
      'Your slow Sunday, planned.',
      'A film, a few dishes, and music to settle into.',
      JSON.stringify({ feature: pick('plan:in-the-mood-for-love', { reason: 'Slow, lamplit evenings to match your collection.' }), alternates: [] }),
      JSON.stringify({ dishes: [pick('saved:sesame-noodles', { description: 'Cold noodles in a sesame sauce.' }), pick('saved:cucumber-salad', { description: 'Smashed cucumber with chili.' })] }),
      JSON.stringify({ before: ['plan:bill-evans', 'plan:nina-simone', 'plan:chet-baker'].map((k) => pick(k, {})), after: [] }),
    ],
  );

  // Agent connection limited to Quiet weekends, then two genuine reads with its credential.
  const conn = await agentPlatform.createConnection(settings.ctx, {
    client_name: 'My research assistant',
    scopes: ['setup:read', 'preferences:read', 'collections:read'],
    library_access: 'selected_collections',
    collection_ids: [quietWeekends],
    expires_in_days: 24,
  });
  const agent = await auth.resolvePrincipal(db, { authorization: `Bearer ${conn.credential}` });
  if (!agent) throw new Error('agent credential did not resolve');
  const agentCtx = createServiceContext(agent, { surface: 'rest' });
  await agentPlatform.getPreferences(agentCtx);
  await collections.getCollection(agentCtx, { id: quietWeekends, query: {} });

  const result = {
    account_id: accountId,
    email: FIXTURE_EMAIL,
    settings_account_id: settings.id,
    settings_email: FIXTURE_ACCOUNT_EMAIL,
    password: FIXTURE_PASSWORD,
    collections: { slow_sunday: slowSunday, after_dark: afterDark, everyday_favorites: everyday, quiet_weekends: quietWeekends },
    items: { vintage_racing: id('feed:vintage-racing'), saved_vintage_racing: id('saved:vintage-racing'), sunday_listening: id('saved:sunday-listening'), late_night_cinema: id('saved:late-night-cinema') },
    plan_id: plan.rows[0]!.id,
    agent_connection_id: conn.connection.id,
  };
  if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, password: '(see FIXTURE_PASSWORD)' }, null, 2));
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
