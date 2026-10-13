/**
 * Seed data for the Playwright mock API. Test-only: these are illustrative
 * fixtures for exercising the interface, not provider results. Images are the
 * project's own sample illustrations in apps/web/public/samples.
 */
import type { DiscoveryCard } from '@culture-atlas/domain/schemas';

let counter = 0x100;
/** Deterministic RFC 4122 v4-shaped ids. */
export function uid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}
export function resetIds() {
  counter = 0x100;
}

type Kind = DiscoveryCard['kind'];
type Cat = DiscoveryCard['category'];

export interface SeedItem {
  key: string;
  title: string;
  kind: Kind;
  category: Cat;
  image: string | null;
  subtitle?: string | null;
  reason: string;
}

const img = (name: string | null) =>
  name ? (name.startsWith('/') ? `/samples${name}.jpg` : `/samples/feed/${name}.jpg`) : null;

export const FEED_SEED: SeedItem[] = [
  {
    key: 'vintage-racing',
    title: 'Vintage racing',
    kind: 'style',
    category: 'wear',
    image: img('/outfit'),
    reason: 'A few motorsport references stood out.',
  },
  {
    key: 'quiet-corners',
    title: 'Quiet corners',
    kind: 'reference',
    category: null,
    image: img('/room'),
    reason: 'Paper-screen light and low wooden furniture.',
  },
  {
    key: 'sunday-listening',
    title: 'Sunday listening',
    kind: 'artist',
    category: 'play',
    image: img('sunday-listening'),
    reason: 'Warm, unhurried jazz records.',
  },
  {
    key: 'around-the-table',
    title: 'Around the table',
    kind: 'food',
    category: 'eat',
    image: img('around-the-table'),
    reason: 'Shared plates and long lunches.',
  },
  {
    key: 'night-wanderings',
    title: 'Night wanderings',
    kind: 'film',
    category: 'watch',
    image: img('night-wanderings'),
    reason: 'Lamplit streets after rain.',
  },
  {
    key: 'sculptural-forms',
    title: 'Sculptural forms',
    kind: 'style',
    category: 'wear',
    image: img('sculptural-forms'),
    reason: 'Soft, rounded shapes in pale textures.',
  },
  {
    key: 'linen-days',
    title: 'Linen days',
    kind: 'style',
    category: 'wear',
    image: img('linen-days'),
    reason: 'Relaxed natural fabrics.',
  },
  {
    key: 'tea-rituals',
    title: 'Tea rituals',
    kind: 'food',
    category: 'eat',
    image: img('tea-rituals'),
    reason: 'Cast-iron pots and quiet afternoons.',
  },
  {
    key: 'late-night-cinema',
    title: 'Late-night cinema',
    kind: 'film',
    category: 'watch',
    image: img('late-night-cinema'),
    reason: 'Marquee lights and second features.',
  },
  {
    key: 'something-to-share',
    title: 'Something to share',
    kind: 'food',
    category: 'eat',
    image: img('something-to-share'),
    reason: 'Bright bowls for the middle of the table.',
  },
  {
    key: 'bill-evans',
    title: 'Bill Evans',
    kind: 'artist',
    category: 'play',
    image: null,
    subtitle: 'Jazz piano',
    reason: 'Gentle, lyrical piano trios.',
  },
  {
    key: 'a-softer-silhouette',
    title: 'A softer silhouette',
    kind: 'style',
    category: 'wear',
    image: img('softer-silhouette'),
    reason: 'Unstructured tailoring in light tones.',
  },
  {
    key: 'sesame-noodles',
    title: 'Sesame noodles',
    kind: 'food',
    category: 'eat',
    image: img('sesame-noodles'),
    reason: 'Nutty, cold noodles for warm evenings.',
  },
  {
    key: 'night-on-film',
    title: 'Night on film',
    kind: 'film',
    category: 'watch',
    image: img('rainy-alley'),
    reason: 'Lantern-lit alleys and slow romance.',
  },
  {
    key: 'spring-light',
    title: 'Spring light',
    kind: 'reference',
    category: null,
    image: img('blossom-branch'),
    reason: 'Blossom season as a mood.',
  },
  {
    key: 'nina-simone',
    title: 'Nina Simone',
    kind: 'artist',
    category: 'play',
    image: null,
    subtitle: 'Soul and jazz',
    reason: 'Commanding voice, intimate records.',
  },
  {
    key: 'cucumber-salad',
    title: 'Cucumber salad',
    kind: 'food',
    category: 'eat',
    image: img('cucumber-salad'),
    reason: 'Crisp, cool and quick.',
  },
];

/** Recommendations for a capture analysis: up to 3 per category, 12 total. */
export const CAPTURE_RECS: Record<'wear' | 'play' | 'watch' | 'eat', SeedItem[]> = {
  wear: [
    {
      key: 'rec-racing-jacket',
      title: 'Racing-stripe jackets',
      kind: 'style',
      category: 'wear',
      image: img('/outfit'),
      reason: 'Bold stripes in the spirit of 1970s endurance racing.',
    },
    {
      key: 'rec-softer',
      title: 'A softer silhouette',
      kind: 'style',
      category: 'wear',
      image: img('softer-silhouette'),
      reason: 'The same cream palette, relaxed.',
    },
    {
      key: 'rec-linen',
      title: 'Linen layers',
      kind: 'brand',
      category: 'wear',
      image: img('linen-days'),
      reason: 'Natural fabrics for warm days.',
    },
  ],
  play: [
    {
      key: 'rec-listening',
      title: 'Sunday listening',
      kind: 'artist',
      category: 'play',
      image: img('sunday-listening'),
      reason: 'Records that feel like a long drive.',
    },
    {
      key: 'rec-evans',
      title: 'Bill Evans',
      kind: 'artist',
      category: 'play',
      image: null,
      subtitle: 'Jazz piano',
      reason: 'Lyrical and unhurried.',
    },
    {
      key: 'rec-simone',
      title: 'Nina Simone',
      kind: 'artist',
      category: 'play',
      image: null,
      subtitle: 'Soul and jazz',
      reason: 'A voice with presence.',
    },
  ],
  watch: [
    {
      key: 'rec-night',
      title: 'Night on film',
      kind: 'film',
      category: 'watch',
      image: img('rainy-alley'),
      reason: 'Moody night photography.',
    },
    {
      key: 'rec-cinema',
      title: 'Late-night cinema',
      kind: 'film',
      category: 'watch',
      image: img('late-night-cinema'),
      reason: 'Second-feature classics.',
    },
    {
      key: 'rec-wander',
      title: 'Night wanderings',
      kind: 'film',
      category: 'watch',
      image: img('night-wanderings'),
      reason: 'City streets after rain.',
    },
  ],
  eat: [
    {
      key: 'rec-table',
      title: 'Around the table',
      kind: 'food',
      category: 'eat',
      image: img('around-the-table'),
      reason: 'Trackside lunches, shared.',
    },
    {
      key: 'rec-noodles',
      title: 'Sesame noodles',
      kind: 'food',
      category: 'eat',
      image: img('sesame-noodles'),
      reason: 'Simple and satisfying.',
    },
    {
      key: 'rec-tea',
      title: 'Tea rituals',
      kind: 'food',
      category: 'eat',
      image: img('tea-rituals'),
      reason: 'A slow pause.',
    },
  ],
};

export const SAMPLE_CAPTURES: Record<
  string,
  { title: string; interpretation: string; image: string; alt: string }
> = {
  outfit: {
    title: 'Vintage racing',
    interpretation: 'A few vintage racing references stood out.',
    image: '/samples/outfit.jpg',
    alt: 'A cream racing-style jacket on a chair',
  },
  room: {
    title: 'Quiet corners',
    interpretation:
      'Paper-screen light and low furniture suggest a calm, Japanese-influenced room.',
    image: '/samples/room.jpg',
    alt: 'A quiet room with a paned window',
  },
  cafe: {
    title: 'Café mornings',
    interpretation: 'A marble table and a cane chair read as a classic café setting.',
    image: '/samples/cafe.jpg',
    alt: 'A café table with coffee and a pastry',
  },
};
