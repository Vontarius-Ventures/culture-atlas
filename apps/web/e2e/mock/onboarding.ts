/**
 * Mock of the amendment 2.2 onboarding and taste routes (/v1/onboarding/*,
 * /v1/taste/picks) for browser tests. Every response is validated against the
 * shared route contract by MockApi.handle. Test-only fixtures: catalog labels
 * follow the screen 14 mockup and search results are canned; nothing here is a
 * Qloo result. Images are the project's own sample illustrations.
 */
import type { Category } from '@culture-atlas/domain';
import type {
  OnboardingCatalogEntry,
  OnboardingPick,
  OnboardingState,
  TasteSeedStatus,
} from '@culture-atlas/domain/schemas';
import { FOOD_EXCLUSION_SUGGESTIONS } from '@culture-atlas/domain/schemas';
import { uid } from './data';

export interface OnboardingMockOptions {
  /** The session owes the questionnaire (new account, or the sign-in trigger). */
  required?: boolean;
  /** Live search answers "unavailable" (Qloo down or throttled). */
  search?: 'ok' | 'unavailable';
  /**
   * Seed job behaviour after completion: 'progressive' readies Wear on the
   * first poll and one more category per poll; 'unavailable' keeps retrying;
   * 'hold' stays pending.
   */
  seed?: 'progressive' | 'unavailable' | 'hold';
  /** Catalog ids picked before the page opens. */
  picks?: string[];
  /** Search picks (by result name) made before the page opens. */
  searchPicks?: string[];
  exclusions?: string[];
}

interface CatalogFixture {
  id: string;
  kind: 'image' | 'chip';
  category: Category;
  label: string;
  image?: string;
  item_kind: OnboardingPick['item_kind'];
}

const IMAGES: Array<[string, Category, string, string]> = [
  ['img-racing', 'wear', 'Vintage racing', '/samples/onboarding/racing.jpg'],
  ['img-linen', 'wear', 'Linen days', '/samples/onboarding/linen.jpg'],
  ['img-tailoring', 'wear', 'Soft tailoring', '/samples/onboarding/tailoring.jpg'],
  ['img-corners', 'wear', 'Quiet corners', '/samples/onboarding/corners.jpg'],
  ['img-forms', 'wear', 'Sculptural forms', '/samples/onboarding/forms.jpg'],
  ['img-listening', 'play', 'Sunday listening', '/samples/onboarding/listening.jpg'],
  ['img-cinema', 'watch', 'Late-night cinema', '/samples/onboarding/cinema.jpg'],
  ['img-night', 'watch', 'Night wanderings', '/samples/onboarding/night.jpg'],
  ['img-lanterns', 'eat', 'Lantern-lit alleys', '/samples/onboarding/lanterns.jpg'],
  ['img-tea', 'eat', 'Tea rituals', '/samples/onboarding/tea.jpg'],
  ['img-noodles', 'eat', 'Sesame noodles', '/samples/onboarding/noodles.jpg'],
  ['img-table', 'eat', 'Around the table', '/samples/onboarding/table.jpg'],
];

const CHIPS: Record<Category, string[]> = {
  wear: [
    'Japandi',
    'Mod revival',
    'Workwear',
    'Wabi-sabi',
    'Minimalist',
    'Vintage',
    'Streetwear',
    'Quiet luxury',
  ],
  play: ['Jazz', 'Bossa nova', 'Ambient', 'Indie folk', 'Soul', 'City pop', 'Classical', 'Lo-fi'],
  watch: [
    'Film noir',
    'Slow cinema',
    'French New Wave',
    'Coming of age',
    'Documentary',
    'Heist',
    'Romantic comedy',
    'Animation',
  ],
  eat: [
    'Sichuan cuisine',
    'Natural wine',
    'Dim sum',
    'Mezze',
    'Ramen',
    'Bakeries',
    'Neapolitan pizza',
    'Tapas',
  ],
};

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const CATALOG: CatalogFixture[] = [
  ...IMAGES.map(([id, category, label, image]) => ({
    id,
    kind: 'image' as const,
    category,
    label,
    image,
    item_kind: 'style' as const,
  })),
  ...(Object.keys(CHIPS) as Category[]).flatMap((category) =>
    CHIPS[category].map((label) => ({
      id: `chip-${category}-${slug(label)}`,
      kind: 'chip' as const,
      category,
      label,
      item_kind: (category === 'eat' ? 'food' : 'style') as OnboardingPick['item_kind'],
    })),
  ),
];

const SEARCH: Array<{
  name: string;
  type_label: string;
  category: Category | null;
  kind: OnboardingPick['item_kind'];
}> = [
  { name: 'Nina Simone', type_label: 'Artist', category: 'play', kind: 'artist' },
  { name: 'Nina Hagen', type_label: 'Artist', category: 'play', kind: 'artist' },
  { name: 'Nina Wu', type_label: 'Film', category: 'watch', kind: 'film' },
  { name: 'In the Mood for Love', type_label: 'Film', category: 'watch', kind: 'film' },
  { name: 'Bill Evans', type_label: 'Artist', category: 'play', kind: 'artist' },
];

const resultId = (name: string) => `sr_${Buffer.from(name).toString('base64url')}_signed`;
const nameFromResult = (id: string) => {
  const m = /^sr_(.+)_signed$/.exec(id);
  return m ? Buffer.from(m[1]!, 'base64url').toString() : null;
};

const now = () => new Date().toISOString();

export class OnboardingMock {
  required: boolean;
  picks: OnboardingPick[] = [];
  exclusions: string[];
  startedAt: string | null = null;
  completedAt: string | null = null;
  seedPolls = 0;
  seedJobId: string | null = null;
  readonly opts: OnboardingMockOptions;
  /** Requests the strip and seed screens made (FAST-04 assertions read the main log). */
  completeCalls = 0;

  constructor(opts: OnboardingMockOptions = {}) {
    this.opts = opts;
    this.required = Boolean(opts.required);
    this.exclusions = [...(opts.exclusions ?? [])];
    for (const id of opts.picks ?? []) this.addCatalogPick(id);
    for (const name of opts.searchPicks ?? []) this.addSearchPick(name);
  }

  addCatalogPick(id: string): OnboardingPick {
    const existing = this.picks.find((p) => p.catalog_item_id === id);
    if (existing) return existing;
    const c = CATALOG.find((x) => x.id === id);
    if (!c) throw new Error(`Unknown catalog id ${id}`);
    const tags = c.kind === 'image' ? 2 : 1;
    const pick: OnboardingPick = {
      id: uid(),
      source: 'catalog',
      catalog_item_id: c.id,
      label: c.label,
      category: c.category,
      item_kind: c.item_kind,
      saved_item_ids: Array.from({ length: tags }, () => uid()),
      discovery_item_ids: Array.from({ length: tags }, () => uid()),
      image: c.image ? { url: c.image, width: 800, height: 1000, alt: c.label } : null,
      created_at: now(),
    };
    this.picks.push(pick);
    this.startedAt ??= now();
    return pick;
  }

  addSearchPick(name: string): OnboardingPick {
    const existing = this.picks.find((p) => p.source === 'search' && p.label === name);
    if (existing) return existing;
    const r = SEARCH.find((x) => x.name === name)!;
    const pick: OnboardingPick = {
      id: uid(),
      source: 'search',
      catalog_item_id: null,
      label: r.name,
      category: r.category,
      item_kind: r.kind,
      saved_item_ids: [uid()],
      discovery_item_ids: [uid()],
      image: null,
      created_at: now(),
    };
    this.picks.push(pick);
    this.startedAt ??= now();
    return pick;
  }

  /** The save that triggered sign-up counts as one pick (source pending_save). */
  addPendingSavePick(
    label: string,
    category: Category | null,
    kind: OnboardingPick['item_kind'],
  ): OnboardingPick {
    const pick: OnboardingPick = {
      id: uid(),
      source: 'pending_save',
      catalog_item_id: null,
      label,
      category,
      item_kind: kind,
      saved_item_ids: [uid()],
      discovery_item_ids: [uid()],
      image: null,
      created_at: now(),
    };
    this.picks.push(pick);
    this.startedAt ??= now();
    return pick;
  }

  state(): OnboardingState {
    return {
      required: this.required,
      picks_count: this.picks.length,
      min_picks: 3,
      started_at: this.startedAt,
      completed_at: this.completedAt,
      catalog_version: 'mock-2026-10-18',
    };
  }

  entry(c: CatalogFixture): OnboardingCatalogEntry {
    const pick = this.picks.find((p) => p.catalog_item_id === c.id);
    return {
      id: c.id,
      kind: c.kind,
      category: c.category,
      label: c.label,
      image: c.image ? { url: c.image, width: 800, height: 1000, alt: c.label } : null,
      picked: Boolean(pick),
      pick_id: pick?.id ?? null,
    };
  }

  seed(): TasteSeedStatus {
    const cats: Category[] = ['wear', 'play', 'watch', 'eat'];
    if (!this.completedAt)
      return {
        job_id: null,
        state: 'not_started',
        categories: cats.map((category) => ({
          category,
          state: 'pending',
          card_count: 0,
          ready_at: null,
        })),
        first_ready_at: null,
        poll_after_ms: null,
      };
    const mode = this.opts.seed ?? 'progressive';
    if (mode === 'unavailable')
      return {
        job_id: this.seedJobId,
        state: 'retrying',
        categories: cats.map((category) => ({
          category,
          state: 'unavailable',
          card_count: 0,
          ready_at: null,
        })),
        first_ready_at: null,
        poll_after_ms: 2000,
      };
    const ready = mode === 'hold' ? 0 : Math.min(this.seedPolls, 4);
    const at = now();
    return {
      job_id: this.seedJobId,
      state: ready === 0 ? 'running' : ready < 4 ? 'partial' : 'complete',
      categories: cats.map((category, i) =>
        i < ready
          ? { category, state: 'ready', card_count: 6, ready_at: at }
          : { category, state: 'pending', card_count: 0, ready_at: null },
      ),
      first_ready_at: ready > 0 ? at : null,
      poll_after_ms: ready < 4 ? 500 : null,
    };
  }

  grouped() {
    const g = {
      wear: [] as OnboardingPick[],
      play: [] as OnboardingPick[],
      watch: [] as OnboardingPick[],
      eat: [] as OnboardingPick[],
      other: [] as OnboardingPick[],
    };
    for (const p of this.picks) (p.category ? g[p.category] : g.other).push(p);
    return g;
  }

  /** Returns undefined when the route is not an onboarding route. */
  dispatch(
    name: string,
    params: Record<string, string>,
    q: URLSearchParams,
    body: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ):
    | { json?: unknown; status?: number }
    | { error: string; status: number; message: string }
    | undefined {
    switch (name) {
      case 'getOnboardingCatalog': {
        const byCat = (cat: Category) =>
          CATALOG.filter((c) => c.kind === 'chip' && c.category === cat).map((c) => this.entry(c));
        return {
          json: {
            catalog_version: 'mock-2026-10-18',
            images: CATALOG.filter((c) => c.kind === 'image').map((c) => this.entry(c)),
            chips: {
              wear: byCat('wear'),
              play: byCat('play'),
              watch: byCat('watch'),
              eat: byCat('eat'),
            },
            exclusion_suggestions: [...FOOD_EXCLUSION_SUGGESTIONS],
            min_picks: 3,
          },
        };
      }
      case 'searchOnboarding': {
        if (this.opts.search === 'unavailable')
          return { json: { status: 'unavailable', results: [] } };
        const term = (q.get('q') ?? '').toLowerCase();
        const cat = q.get('category');
        const results = SEARCH.filter(
          (r) => r.name.toLowerCase().includes(term) && (!cat || r.category === cat),
        ).map((r) => ({
          result_id: resultId(r.name),
          name: r.name,
          type_label: r.type_label,
          category: r.category,
          // The mock's search names are unique, so the name stands for the Qloo id here.
          picked: this.picks.some((p) => p.source === 'search' && p.label === r.name),
          pick_id: this.picks.find((p) => p.source === 'search' && p.label === r.name)?.id ?? null,
        }));
        return { json: { status: 'ok', results } };
      }
      case 'createOnboardingPick':
      case 'createTastePick': {
        const before = this.picks.length;
        let pick: OnboardingPick;
        if (body.source === 'catalog') {
          if (!CATALOG.some((c) => c.id === body.catalog_item_id))
            return {
              error: 'not_found',
              status: 404,
              message: 'That idea is no longer available.',
            };
          pick = this.addCatalogPick(body.catalog_item_id);
        } else {
          const n = nameFromResult(body.result_id);
          if (!n || !SEARCH.some((r) => r.name === n))
            return {
              error: 'invalid_input',
              status: 400,
              message: 'That search result expired. Search again.',
            };
          pick = this.addSearchPick(n);
        }
        return {
          json: {
            pick,
            state: this.state(),
            taste_revision: this.picks.length,
            already_picked: this.picks.length === before,
          },
        };
      }
      case 'deleteOnboardingPick':
      case 'deleteTastePick': {
        const pick = this.picks.find((p) => p.id === params.id);
        if (!pick) return { error: 'not_found', status: 404, message: 'Not found.' };
        this.picks = this.picks.filter((p) => p.id !== params.id);
        return {
          json: {
            removed_pick_id: pick.id,
            state: this.state(),
            taste_revision: this.picks.length,
          },
        };
      }
      case 'putOnboardingExclusions':
        this.exclusions = [...body.food_exclusions];
        return { json: { food_exclusions: this.exclusions } };
      case 'completeOnboarding': {
        this.completeCalls += 1;
        if (this.picks.length < 3)
          return {
            error: 'conflict',
            status: 409,
            message: 'Pick at least 3 so your feed starts with you.',
          };
        this.completedAt ??= now();
        this.required = false;
        this.seedJobId ??= uid();
        return { json: { state: this.state(), seed: this.seed() } };
      }
      case 'getOnboardingState':
        return {
          json: {
            state: this.state(),
            picks: this.picks,
            food_exclusions: this.exclusions,
            seed: this.seed(),
          },
        };
      case 'getOnboardingSeed':
        this.seedPolls += 1;
        return { json: this.seed() };
      case 'listTastePicks':
        return {
          json: {
            picks: this.grouped(),
            picks_count: this.picks.length,
            food_exclusions: this.exclusions,
          },
        };
      default:
        return undefined;
    }
  }
}
