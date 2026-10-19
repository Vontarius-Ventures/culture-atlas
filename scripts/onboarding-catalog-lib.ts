/**
 * Onboarding catalog builder (spec amendment 2.2, "What people pick from").
 *
 * Resolves every chip and image of the taste questionnaire to REAL Qloo tag
 * ids through GET /v2/tags and writes fixtures/onboarding/catalog.json with
 * the retrieval date. Nothing is invented: a label Qloo does not return with
 * a matching name is dropped (and reported), never filled in.
 *
 * Request discipline (the hackathon key throttles bursts): at most 3 requests
 * in flight, a pause between requests on each lane, and a hard request budget
 * (default 40, retries included). With `previous` set, items whose label and
 * query are unchanged keep their earlier ids and retrieval dates, so a refresh
 * only spends requests on what changed.
 *
 * Used by scripts/build-onboarding-catalog.ts; tested with a fake provider.
 */
import { createHash } from 'node:crypto';
import type { QlooProvider, QlooTag, RequestBudget } from '../packages/providers/src';
import type { Category } from '../packages/domain/src/enums';
import {
  ONBOARDING_IMAGE_TAGS_MAX,
  OnboardingCatalogFile,
  type OnboardingCatalogItem,
  type QlooRef,
} from '../packages/domain/src/schemas/onboarding';

export interface ChipSpec {
  id: string;
  category: Category;
  label: string;
  /** Qloo tag name to look up (defaults to the label). */
  query?: string;
}

export type ImageTagSpec = { chip: string } | { query: string; category?: Category };

export interface ImageSpec {
  id: string;
  category: Category;
  label: string;
  image: { url: string; width: number; height: number; alt: string; credit?: string; license?: string };
  tags: ImageTagSpec[];
}

/**
 * Tag-type preference per category: a matching name of an earlier type wins.
 * Matched on the tag id prefix ("urn:tag:genre:music:jazz").
 */
export const TAG_TYPE_PREFERENCE: Record<Category, readonly string[]> = {
  wear: ['urn:tag:style:qloo', 'urn:tag:decor:qloo', 'urn:tag:ambience:qloo'],
  play: ['urn:tag:genre:music', 'urn:tag:music:qloo', 'urn:tag:style:qloo'],
  watch: ['urn:tag:genre:media', 'urn:tag:subgenre:qloo', 'urn:tag:keyword:qloo', 'urn:tag:style:qloo'],
  eat: ['urn:tag:cuisine:qloo', 'urn:tag:specialty_dish:place', 'urn:tag:genre:place:restaurant', 'urn:tag:category:place'],
};

/** Mock photos (generated for this project, see fixtures/images/LICENSES.md), 800x1000, 4:5. */
const IMG = (file: string, alt: string) => ({
  url: `/samples/onboarding/${file}`,
  width: 800,
  height: 1000,
  alt,
  credit: 'culture atlas (generated mock photo)',
  license: 'project-owned mock',
});

/** Chips: Wear, Play, Watch, Eat, 6-10 each (amendment 2.2). Labels Qloo has no tag for are dropped at build time. */
export const CHIP_SPECS: readonly ChipSpec[] = [
  { id: 'chip-wear-japandi', category: 'wear', label: 'Japandi' },
  { id: 'chip-wear-wabi-sabi', category: 'wear', label: 'Wabi-sabi', query: 'wabi sabi' },
  { id: 'chip-wear-minimalist', category: 'wear', label: 'Minimalist' },
  { id: 'chip-wear-vintage', category: 'wear', label: 'Vintage' },
  { id: 'chip-wear-bohemian', category: 'wear', label: 'Bohemian' },
  { id: 'chip-wear-preppy', category: 'wear', label: 'Preppy' },
  { id: 'chip-wear-quiet-luxury', category: 'wear', label: 'Quiet luxury' },
  { id: 'chip-wear-art-deco', category: 'wear', label: 'Art deco' },

  { id: 'chip-play-jazz', category: 'play', label: 'Jazz' },
  { id: 'chip-play-bossa-nova', category: 'play', label: 'Bossa nova' },
  { id: 'chip-play-ambient', category: 'play', label: 'Ambient' },
  { id: 'chip-play-indie-folk', category: 'play', label: 'Indie folk' },
  { id: 'chip-play-classical', category: 'play', label: 'Classical' },
  { id: 'chip-play-city-pop', category: 'play', label: 'City pop' },
  { id: 'chip-play-mod-revival', category: 'play', label: 'Mod revival' },
  { id: 'chip-play-lo-fi', category: 'play', label: 'Lo-fi' },

  { id: 'chip-watch-film-noir', category: 'watch', label: 'Film noir' },
  { id: 'chip-watch-slow-cinema', category: 'watch', label: 'Slow cinema' },
  { id: 'chip-watch-french-new-wave', category: 'watch', label: 'French New Wave' },
  { id: 'chip-watch-coming-of-age', category: 'watch', label: 'Coming-of-age', query: 'coming of age' },
  { id: 'chip-watch-documentary', category: 'watch', label: 'Documentary' },
  { id: 'chip-watch-heist', category: 'watch', label: 'Heist' },
  { id: 'chip-watch-romantic-comedy', category: 'watch', label: 'Romantic comedy' },
  { id: 'chip-watch-animation', category: 'watch', label: 'Animation' },

  { id: 'chip-eat-sichuan-cuisine', category: 'eat', label: 'Sichuan cuisine', query: 'sichuan' },
  { id: 'chip-eat-natural-wine', category: 'eat', label: 'Natural wine' },
  { id: 'chip-eat-dim-sum', category: 'eat', label: 'Dim sum' },
  { id: 'chip-eat-mezze', category: 'eat', label: 'Mezze' },
  { id: 'chip-eat-ramen', category: 'eat', label: 'Ramen' },
  { id: 'chip-eat-bakeries', category: 'eat', label: 'Bakeries', query: 'bakery' },
  { id: 'chip-eat-neapolitan-pizza', category: 'eat', label: 'Neapolitan pizza' },
  { id: 'chip-eat-tapas', category: 'eat', label: 'Tapas' },
];

/**
 * Images: project-owned mock photos in apps/web/public/samples/onboarding
 * (see fixtures/images/LICENSES.md), each standing for 1-3 Qloo tags. Most reuse a
 * chip's tag so the whole catalog stays inside the request budget.
 */
export const IMAGE_SPECS: readonly ImageSpec[] = [
  { id: 'img-racing', category: 'wear', label: 'Vintage racing', image: IMG('racing.jpg', 'Cream racing jacket with red and navy stripes over a bentwood chair'),
    tags: [{ chip: 'chip-wear-vintage' }, { chip: 'chip-play-mod-revival' }] },
  { id: 'img-linen', category: 'wear', label: 'Linen days', image: IMG('linen.jpg', 'Oatmeal linen shirt on a wooden hanger with leaf shadows'),
    tags: [{ chip: 'chip-wear-minimalist' }, { query: 'scandinavian' }] },
  { id: 'img-tailoring', category: 'wear', label: 'Soft tailoring', image: IMG('tailoring.jpg', 'Camel blazer draped over a cane chair'),
    tags: [{ chip: 'chip-wear-quiet-luxury' }, { chip: 'chip-wear-preppy' }] },
  { id: 'img-corners', category: 'wear', label: 'Quiet corners', image: IMG('corners.jpg', 'Paned window with afternoon light, a low oak table and a branch in a vase'),
    tags: [{ chip: 'chip-wear-japandi' }, { chip: 'chip-wear-wabi-sabi' }] },
  { id: 'img-forms', category: 'wear', label: 'Sculptural forms', image: IMG('forms.jpg', 'Rounded cream boucle chair beside a teak side table'),
    tags: [{ query: 'mid century modern' }, { chip: 'chip-wear-minimalist' }] },
  { id: 'img-listening', category: 'play', label: 'Sunday listening', image: IMG('listening.jpg', 'Record player, a stack of records and a brass lamp'),
    tags: [{ chip: 'chip-play-jazz' }, { chip: 'chip-play-bossa-nova' }] },
  { id: 'img-cinema', category: 'watch', label: 'Late-night cinema', image: IMG('cinema.jpg', 'Cinema marquee lights and two silhouettes on a wet street'),
    tags: [{ chip: 'chip-watch-film-noir' }, { query: 'art house' }] },
  { id: 'img-night', category: 'watch', label: 'Night wanderings', image: IMG('night.jpg', 'Empty lamplit city street after rain'),
    tags: [{ query: 'neo noir' }, { chip: 'chip-play-ambient' }] },
  { id: 'img-lanterns', category: 'eat', label: 'Lantern-lit alleys', image: IMG('lanterns.jpg', 'Alley of small bars lit by red paper lanterns at night'),
    tags: [{ query: 'izakaya' }, { chip: 'chip-eat-ramen' }] },
  { id: 'img-tea', category: 'eat', label: 'Tea rituals', image: IMG('tea.jpg', 'Cast-iron teapot, a ceramic cup and a blossom branch'),
    tags: [{ query: 'tea house' }, { chip: 'chip-wear-wabi-sabi' }] },
  { id: 'img-noodles', category: 'eat', label: 'Sesame noodles', image: IMG('noodles.jpg', 'Bowl of sesame noodles with chili oil and chopsticks'),
    tags: [{ chip: 'chip-eat-sichuan-cuisine' }, { chip: 'chip-eat-ramen' }] },
  { id: 'img-table', category: 'eat', label: 'Around the table', image: IMG('table.jpg', 'Shared small plates on a wooden table, seen from above'),
    tags: [{ chip: 'chip-eat-mezze' }, { chip: 'chip-eat-tapas' }] },
];

export const DEFAULT_REQUEST_BUDGET = 40;
export const MAX_CONCURRENT = 3;

export function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Index of the tag's type in the category's preference list, or -1 when it is not an accepted type. */
export function tagTypeRank(tagId: string, category: Category): number {
  return TAG_TYPE_PREFERENCE[category].findIndex((p) => tagId.startsWith(`${p}:`));
}

/**
 * Choose the tag for a query: names must match exactly after normalization
 * ("Wabi-Sabi" = "wabi sabi") and the tag type must be one the category
 * accepts (a "Soul" cuisine tag is not a Play chip). Among those, preferred
 * types win, then Qloo's order. Returns null rather than a near miss.
 */
export function chooseTag(tags: readonly QlooTag[], query: string, category: Category): QlooTag | null {
  const want = normalizeName(query);
  const exact = tags.filter((t) => normalizeName(t.name) === want && tagTypeRank(t.id, category) >= 0);
  return [...exact].sort((a, b) => tagTypeRank(a.id, category) - tagTypeRank(b.id, category))[0] ?? null;
}

export function tagRef(tag: QlooTag): QlooRef {
  const type = tag.type && /^urn:[a-z0-9:_-]+$/i.test(tag.type) ? tag.type : tag.id.split(':').slice(0, 4).join(':');
  return { type: 'tag', id: tag.id, name: tag.name.slice(0, 120), subtype: type };
}

export interface BuildOptions {
  qloo: Pick<QlooProvider, 'lookupTags'>;
  now: () => Date;
  chips?: readonly ChipSpec[];
  images?: readonly ImageSpec[];
  previous?: OnboardingCatalogFile | null;
  budget?: number;
  concurrency?: number;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface BuildReport {
  catalog: OnboardingCatalogFile;
  requests: number;
  reused: string[];
  dropped: { id: string; reason: string }[];
}

interface Lookup {
  key: string;
  query: string;
  category: Category;
}

/** Run tasks with at most `limit` in flight, pausing between tasks on each lane. */
async function pool<T>(tasks: (() => Promise<T>)[], limit: number, pauseMs: number, sleep: (ms: number) => Promise<void>): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  const lane = async (laneIndex: number) => {
    if (laneIndex > 0) await sleep(Math.round((pauseMs * laneIndex) / limit));
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]!();
      if (next < tasks.length) await sleep(pauseMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, (_, i) => lane(i)));
  return out;
}

export function catalogVersion(items: readonly OnboardingCatalogItem[], now: Date): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(items.map((i) => [i.id, i.kind, i.category, i.label, i.image?.url ?? null, i.qloo.map((q) => q.id)])))
    .digest('hex')
    .slice(0, 10);
  return `${now.toISOString().slice(0, 10)}.${digest}`;
}

export async function buildOnboardingCatalog(options: BuildOptions): Promise<BuildReport> {
  const chips = options.chips ?? CHIP_SPECS;
  const images = options.images ?? IMAGE_SPECS;
  const limit = Math.min(options.concurrency ?? MAX_CONCURRENT, MAX_CONCURRENT);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});
  const maxRequests = options.budget ?? DEFAULT_REQUEST_BUDGET;
  let requests = 0;
  const budget: RequestBudget = { take: () => (requests < maxRequests ? (requests++, true) : false) };

  const previous = new Map((options.previous?.items ?? []).map((i) => [i.id, i]));
  const reused: string[] = [];
  const dropped: BuildReport['dropped'] = [];
  const resolved = new Map<string, { ref: QlooRef; retrieved_at: string }>();

  // 1. What needs a lookup (unchanged previous chips are reused as they were).
  const lookups = new Map<string, Lookup>();
  const chipKey = (c: ChipSpec) => `chip:${c.id}`;
  for (const chip of chips) {
    const prior = previous.get(chip.id);
    if (prior && prior.kind === 'chip' && prior.label === chip.label && prior.category === chip.category && prior.qloo[0]
      && tagTypeRank(prior.qloo[0].id, chip.category) >= 0) {
      resolved.set(chipKey(chip), { ref: prior.qloo[0], retrieved_at: prior.retrieved_at });
      reused.push(chip.id);
      continue;
    }
    lookups.set(chipKey(chip), { key: chipKey(chip), query: chip.query ?? chip.label, category: chip.category });
  }
  for (const img of images) {
    const prior = previous.get(img.id);
    const extraQueries = img.tags.filter((t): t is { query: string; category?: Category } => 'query' in t);
    const priorUsable = prior && prior.kind === 'image' && prior.label === img.label && prior.image?.url === img.image.url;
    for (const t of extraQueries) {
      const key = `query:${img.category}:${normalizeName(t.query)}`;
      if (resolved.has(key) || lookups.has(key)) continue;
      const priorRef = priorUsable
        ? prior.qloo.find((q) => normalizeName(q.name) === normalizeName(t.query) && tagTypeRank(q.id, t.category ?? img.category) >= 0)
        : undefined;
      if (priorRef && prior) {
        resolved.set(key, { ref: priorRef, retrieved_at: prior.retrieved_at });
        continue;
      }
      lookups.set(key, { key, query: t.query, category: t.category ?? img.category });
    }
  }

  // 2. Live lookups, <=3 concurrent, budgeted (retries included).
  const tasks = [...lookups.values()].map((l) => async () => {
    try {
      const res = await options.qloo.lookupTags({ query: l.query, take: 25 }, { budget, maxRetries: 1 });
      const tag = chooseTag(res.data, l.query, l.category);
      if (!tag) {
        log(`no exact Qloo tag for "${l.query}" (${l.category}); ${res.data.length} other results ignored`);
        return;
      }
      resolved.set(l.key, { ref: tagRef(tag), retrieved_at: res.retrieved_at });
      log(`"${l.query}" -> ${tag.id} (${tag.name})`);
    } catch (err) {
      log(`lookup "${l.query}" failed: ${(err as Error).message}`);
    }
  });
  await pool(tasks, limit, options.pauseMs ?? 500, sleep);

  // 3. Assemble items; drop anything without a real id.
  const items: OnboardingCatalogItem[] = [];
  for (const img of images) {
    const refs: QlooRef[] = [];
    let retrieved = '';
    for (const t of img.tags) {
      const key = 'chip' in t ? `chip:${t.chip}` : `query:${img.category}:${normalizeName(t.query)}`;
      const hit = resolved.get(key);
      if (!hit || refs.some((r) => r.id === hit.ref.id)) continue;
      refs.push(hit.ref);
      if (hit.retrieved_at > retrieved) retrieved = hit.retrieved_at;
    }
    if (!refs.length) {
      dropped.push({ id: img.id, reason: 'none of its tags resolved' });
      continue;
    }
    items.push({ id: img.id, kind: 'image', category: img.category, label: img.label,
      qloo: refs.slice(0, ONBOARDING_IMAGE_TAGS_MAX), image: img.image, retrieved_at: retrieved });
  }
  for (const chip of chips) {
    const hit = resolved.get(chipKey(chip));
    if (!hit) {
      dropped.push({ id: chip.id, reason: `no Qloo tag named "${chip.query ?? chip.label}"` });
      continue;
    }
    items.push({ id: chip.id, kind: 'chip', category: chip.category, label: chip.label, qloo: [hit.ref], retrieved_at: hit.retrieved_at });
  }

  const now = options.now();
  const retrievedAt = items.reduce((max, i) => (i.retrieved_at > max ? i.retrieved_at : max), '');
  const catalog = OnboardingCatalogFile.parse({
    kind: 'onboarding-catalog',
    catalog_version: catalogVersion(items, now),
    retrieved_at: retrievedAt || now.toISOString(),
    items,
  });
  return { catalog, requests, reused, dropped };
}

/** Shape rules beyond zod that the questionnaire relies on (12-16 images, 6-10 chips per category). */
export function catalogProblems(catalog: OnboardingCatalogFile): string[] {
  const problems: string[] = [];
  const images = catalog.items.filter((i) => i.kind === 'image');
  if (images.length < 12 || images.length > 16) problems.push(`expected 12-16 images, got ${images.length}`);
  for (const category of ['wear', 'play', 'watch', 'eat'] as const) {
    const n = catalog.items.filter((i) => i.kind === 'chip' && i.category === category).length;
    if (n < 6 || n > 10) problems.push(`expected 6-10 ${category} chips, got ${n}`);
  }
  return problems;
}
