import type { Queryable } from '../db/pool';
import type { Category, ItemKind } from '../enums';
import type { DisplayMetadata } from '../services/display';

/**
 * Reviewed sample discovery items for the first-visit feed ("Find more of what
 * you love."). They are public (is_sample), shown to new users only, and every
 * card is labeled "Example result" (DiscoveryCard.is_example). They are NOT
 * provider results and never count as Qloo-derived.
 *
 * Content rules: short factual descriptions only (title, year, creator or a
 * neutral one-line description), each with a real public reference page as the
 * destination. No claims of relationships between samples: "related" samples
 * are simply other examples from different categories. Items whose subject a
 * project-original illustration actually shows carry that image
 * (apps/web/public/samples, licenses in fixtures/images/LICENSES.md); the rest
 * use the UI's text treatment. Never a stand-in picture of a performer or film.
 */
export interface SampleItem {
  slug: string;
  kind: ItemKind;
  category: Category | null;
  title: string;
  subtitle: string;
  year?: number;
  description: string;
  destination_url: string;
  /**
   * Optional project-original illustration under apps/web/public (license:
   * fixtures/images/LICENSES.md). Only set when the picture genuinely shows
   * the subject; artists and films never get a stand-in picture.
   */
  image?: { url: string; alt: string };
}

export const SAMPLE_ITEMS: readonly SampleItem[] = [
  // Illustrated samples first (image-led feed); the picture shows the subject itself.
  { slug: 'food-sesame-noodles', kind: 'food', category: 'eat', title: 'Sesame noodles', subtitle: 'Cold noodle dish', description: 'Noodles tossed in a sesame sauce, often served cold.', destination_url: 'https://en.wikipedia.org/wiki/Sesame_noodles', image: { url: '/samples/feed/sesame-noodles.jpg', alt: 'A bowl of noodles with chopsticks' } },
  { slug: 'style-linen', kind: 'style', category: 'wear', title: 'Summer linen', subtitle: 'Style direction', description: 'Light clothing woven from flax, made for warm days.', destination_url: 'https://en.wikipedia.org/wiki/Linen', image: { url: '/samples/feed/linen-days.jpg', alt: 'A linen shirt on a hanger in leaf shadows' } },
  { slug: 'reference-tetsubin', kind: 'reference', category: null, title: 'Tetsubin', subtitle: 'Japanese cast-iron kettle', description: 'Japanese cast-iron kettle used to heat water for tea.', destination_url: 'https://en.wikipedia.org/wiki/Tetsubin', image: { url: '/samples/feed/tea-rituals.jpg', alt: 'A cast-iron teapot and cup beside a blossom branch' } },
  { slug: 'reference-phonograph-record', kind: 'reference', category: null, title: 'The vinyl record', subtitle: 'Listening at home', description: 'The grooved disc that carried recorded music for most of the 20th century.', destination_url: 'https://en.wikipedia.org/wiki/Phonograph_record', image: { url: '/samples/feed/sunday-listening.jpg', alt: 'A record player with records and a lamp' } },
  { slug: 'film-in-the-mood-for-love', kind: 'film', category: 'watch', title: 'In the Mood for Love', subtitle: 'Wong Kar-wai', year: 2000, description: 'Wong Kar-wai’s film set in 1960s Hong Kong.', destination_url: 'https://en.wikipedia.org/wiki/In_the_Mood_for_Love' },
  { slug: 'artist-nina-simone', kind: 'artist', category: 'play', title: 'Nina Simone', subtitle: 'Singer, songwriter and pianist', description: 'American singer, songwriter and pianist.', destination_url: 'https://en.wikipedia.org/wiki/Nina_Simone' },
  { slug: 'style-breton-shirt', kind: 'style', category: 'wear', title: 'The Breton stripe', subtitle: 'Style direction', description: 'The striped knit shirt that began as a French naval uniform.', destination_url: 'https://en.wikipedia.org/wiki/Breton_shirt' },
  { slug: 'food-cacio-e-pepe', kind: 'food', category: 'eat', title: 'Cacio e pepe', subtitle: 'Roman pasta', description: 'Roman pasta with pecorino and black pepper.', destination_url: 'https://en.wikipedia.org/wiki/Cacio_e_pepe' },
  { slug: 'film-playtime', kind: 'film', category: 'watch', title: 'Playtime', subtitle: 'Jacques Tati', year: 1967, description: 'Jacques Tati’s comedy set in a modernist Paris.', destination_url: 'https://en.wikipedia.org/wiki/Playtime' },
  { slug: 'artist-fela-kuti', kind: 'artist', category: 'play', title: 'Fela Kuti', subtitle: 'Afrobeat pioneer', description: 'Nigerian musician and Afrobeat pioneer.', destination_url: 'https://en.wikipedia.org/wiki/Fela_Kuti' },
  { slug: 'brand-marimekko', kind: 'brand', category: 'wear', title: 'Marimekko', subtitle: 'Finnish design house', description: 'Finnish design house known for bold printed fabrics.', destination_url: 'https://en.wikipedia.org/wiki/Marimekko' },
  { slug: 'food-shakshouka', kind: 'food', category: 'eat', title: 'Shakshouka', subtitle: 'Eggs in spiced tomato', description: 'Eggs poached in a spiced tomato and pepper sauce.', destination_url: 'https://en.wikipedia.org/wiki/Shakshouka' },
  { slug: 'reference-bauhaus', kind: 'reference', category: null, title: 'Bauhaus', subtitle: 'Art school, 1919–1933', description: 'German art school whose approach shaped modern design.', destination_url: 'https://en.wikipedia.org/wiki/Bauhaus' },
  { slug: 'film-paris-texas', kind: 'film', category: 'watch', title: 'Paris, Texas', subtitle: 'Wim Wenders', year: 1984, description: 'Wim Wenders’s road film set in the American Southwest.', destination_url: 'https://en.wikipedia.org/wiki/Paris,_Texas_(film)' },
  { slug: 'artist-astrud-gilberto', kind: 'artist', category: 'play', title: 'Astrud Gilberto', subtitle: 'Bossa nova singer', description: 'Brazilian singer associated with bossa nova.', destination_url: 'https://en.wikipedia.org/wiki/Astrud_Gilberto' },
  { slug: 'style-mod', kind: 'style', category: 'wear', title: 'Mod tailoring', subtitle: 'Style direction', description: 'Slim, sharp tailoring associated with the 1960s mod subculture.', destination_url: 'https://en.wikipedia.org/wiki/Mod_(subculture)' },
  { slug: 'food-okonomiyaki', kind: 'food', category: 'eat', title: 'Okonomiyaki', subtitle: 'Japanese savory pancake', description: 'Japanese savory pancake cooked on a griddle.', destination_url: 'https://en.wikipedia.org/wiki/Okonomiyaki' },
  { slug: 'film-amelie', kind: 'film', category: 'watch', title: 'Amélie', subtitle: 'Jean-Pierre Jeunet', year: 2001, description: 'Jean-Pierre Jeunet’s comedy set in Montmartre.', destination_url: 'https://en.wikipedia.org/wiki/Am%C3%A9lie' },
  { slug: 'artist-air', kind: 'artist', category: 'play', title: 'Air', subtitle: 'French electronic duo', description: 'French electronic music duo from Versailles.', destination_url: 'https://en.wikipedia.org/wiki/Air_(French_band)' },
  { slug: 'style-workwear', kind: 'style', category: 'wear', title: 'Workwear', subtitle: 'Style direction', description: 'Durable clothing first made for manual work.', destination_url: 'https://en.wikipedia.org/wiki/Workwear' },
  { slug: 'food-pastel-de-nata', kind: 'food', category: 'eat', title: 'Pastel de nata', subtitle: 'Portuguese custard tart', description: 'Portuguese custard tart with a flaky pastry shell.', destination_url: 'https://en.wikipedia.org/wiki/Pastel_de_nata' },
  { slug: 'reference-memphis-group', kind: 'reference', category: null, title: 'Memphis Group', subtitle: 'Design collective, 1981–1987', description: 'Milan design collective known for bold color and pattern.', destination_url: 'https://en.wikipedia.org/wiki/Memphis_Group' },
  // Example-photo discoveries (fixtures/examples): reviewed picks used when an
  // example is replayed without live providers. Never presented as Qloo results.
  { slug: 'film-le-mans', kind: 'film', category: 'watch', title: 'Le Mans', subtitle: 'Lee H. Katzin', year: 1971, description: 'Steve McQueen stars in this film about the 24 Hours of Le Mans race.', destination_url: 'https://en.wikipedia.org/wiki/Le_Mans_(film)' },
  { slug: 'film-grand-prix', kind: 'film', category: 'watch', title: 'Grand Prix', subtitle: 'John Frankenheimer', year: 1966, description: 'John Frankenheimer’s film following Formula One drivers through a season.', destination_url: 'https://en.wikipedia.org/wiki/Grand_Prix_(1966_film)' },
  { slug: 'film-tokyo-story', kind: 'film', category: 'watch', title: 'Tokyo Story', subtitle: 'Yasujirō Ozu', year: 1953, description: 'Yasujirō Ozu’s quiet family drama, much of it set in calm domestic rooms.', destination_url: 'https://en.wikipedia.org/wiki/Tokyo_Story' },
  { slug: 'artist-ryuichi-sakamoto', kind: 'artist', category: 'play', title: 'Ryuichi Sakamoto', subtitle: 'Composer and pianist', description: 'Japanese composer, pianist and producer.', destination_url: 'https://en.wikipedia.org/wiki/Ryuichi_Sakamoto' },
];

export function sampleBySlug(slug: string): SampleItem | undefined {
  return SAMPLE_ITEMS.find((s) => s.slug === slug);
}

export const sampleKey = (slug: string) => `sample:${slug}`;

export function sampleDisplay(s: SampleItem): DisplayMetadata {
  return {
    subtitle: s.year ? `${s.year} · ${s.subtitle}` : s.subtitle,
    year: s.year ?? null,
    description: s.description,
    image: s.image ? { url: s.image.url, alt: s.image.alt, width: 1000, height: 1250, license: 'project-original' } : null,
    destination_url: s.destination_url,
  };
}

const ensured = new WeakMap<object, Promise<void>>();

/** Idempotently upsert the reviewed sample items (once per process per database handle). */
export function ensureSampleItems(db: Queryable, key: object = db): Promise<void> {
  let p = ensured.get(key);
  if (!p) {
    p = (async () => {
      for (const s of SAMPLE_ITEMS) {
        await db.query(
          `INSERT INTO discovery_items (is_sample, kind, category, canonical_key, title, display_metadata)
           VALUES (true, $1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (canonical_key) WHERE is_sample
           DO UPDATE SET kind = EXCLUDED.kind, category = EXCLUDED.category, title = EXCLUDED.title,
                         display_metadata = EXCLUDED.display_metadata, updated_at = now()`,
          [s.kind, s.category, sampleKey(s.slug), s.title, JSON.stringify(sampleDisplay(s))],
        );
      }
    })();
    p.catch(() => ensured.delete(key));
    ensured.set(key, p);
  }
  return p;
}

/** Sample item ids in curated order. */
export async function sampleItemIds(db: Queryable): Promise<{ id: string; canonical_key: string; category: Category | null; kind: ItemKind }[]> {
  await ensureSampleItems(db);
  const { rows } = await db.query<{ id: string; canonical_key: string; category: Category | null; kind: ItemKind }>(
    `SELECT id, canonical_key, category, kind FROM discovery_items WHERE is_sample AND canonical_key = ANY($1::text[])`,
    [SAMPLE_ITEMS.map((s) => sampleKey(s.slug))],
  );
  const byKey = new Map(rows.map((r) => [r.canonical_key, r]));
  return SAMPLE_ITEMS.flatMap((s) => {
    const r = byKey.get(sampleKey(s.slug));
    return r ? [r] : [];
  });
}
