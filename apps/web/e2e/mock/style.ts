/**
 * Style reading + rails fixtures for the Playwright mock (contract: E.2 of
 * prp/2026-10-23-style-analysis/design.md). Test-only illustrative data for
 * the sample outfit photo (a cream racing-style jacket on a wooden chair); it
 * is not a model reading and not a Qloo response. Every user-facing string
 * here stands in for what the server composes (`display`, `reason`), so the
 * UI is checked for rendering them verbatim.
 */
import type { DiscoveryCard } from '@culture-atlas/domain/schemas';
import type { SeedItem } from './data';

export type StyleMode = 'ready' | 'failed' | 'empty' | 'limit' | 'paused' | 'retract';

export const EXPERIMENTAL = {
  label: 'Experimental',
  note: 'Photo and video readings can miss details. Qloo explores entity-level taste and catalogue connections, not verified visual matches.',
} as const;

export const WHY_LINE = 'Suggested from an experimental reading of your photo.';

const img = (name: string) =>
  name.startsWith('/') ? `/samples${name}.jpg` : `/samples/feed/${name}.jpg`;

/** More-like-this cards for subject s1 (fashion brands in the same sporty, vintage style). */
export const MORE_LIKE_THIS_SEEDS: Array<SeedItem & { reason: string; attributes: string[] }> = [
  {
    key: 'mlt-1',
    title: 'Track-day nylon jackets',
    kind: 'brand',
    category: 'wear',
    image: img('/outfit'),
    reason: 'Because of the sportswear and nylon shell',
    attributes: ['Sportswear', 'nylon shell'],
  },
  {
    key: 'mlt-2',
    title: 'Heritage tracksuits',
    kind: 'brand',
    category: 'wear',
    image: img('softer-silhouette'),
    reason: 'Because of the sportswear and the cream and racing red palette',
    attributes: ['Sportswear'],
  },
  {
    key: 'mlt-3',
    title: 'Retro paddock wear',
    kind: 'brand',
    category: 'wear',
    image: img('linen-days'),
    reason: 'For the vintage motorsport look your photo resembles',
    attributes: ['Vintage motorsport'],
  },
  {
    key: 'mlt-4',
    title: 'Striped windbreakers',
    kind: 'brand',
    category: 'wear',
    image: img('sculptural-forms'),
    reason: 'Because of the contrast racing stripes and nylon shell',
    attributes: ['contrast racing stripes', 'nylon shell'],
  },
  {
    key: 'mlt-5',
    title: 'Clubhouse knitwear',
    kind: 'brand',
    category: 'wear',
    image: img('blossom-branch'),
    reason: 'Because of the sportswear and ribbed knit',
    attributes: ['Sportswear'],
  },
  {
    key: 'mlt-6',
    title: 'Pit-lane outerwear',
    kind: 'brand',
    category: 'wear',
    image: img('rainy-alley'),
    reason: 'Because of the sportswear and nylon shell',
    attributes: ['Sportswear', 'nylon shell'],
  },
];

/** `style_reading` for the sample outfit (E.2). Pass `retracted` to apply a stage-2 veto. */
export function styleReading(opts: { retracted?: boolean } = {}) {
  return {
    version: 'atlas_style_reading_v1',
    summary: 'A cream nylon jacket with racing stripes and a sporty, vintage look.',
    swatches: [
      { index: 0, hex: '#E9E1CF', share: 0.42 },
      { index: 1, hex: '#6B4A33', share: 0.21 },
      { index: 2, hex: '#B23A2E', share: 0.12 },
    ],
    subjects: [
      {
        id: 's1',
        category: 'fashion',
        label: 'Cream racing jacket',
        region: { x: 0.2, y: 0.12, w: 0.6, h: 0.55 },
        aesthetics: [
          {
            name: 'Sportswear',
            wording: 'asserted',
            display: 'Sportswear',
            strength: 'clear',
            region: { x: 0.22, y: 0.14, w: 0.56, h: 0.5 },
            features: ['nylon shell', 'contrast stripes'],
          },
          {
            name: 'Vintage motorsport',
            wording: 'resembles',
            display: 'Resembles vintage motorsport',
            strength: 'likely',
            region: { x: 0.25, y: 0.2, w: 0.3, h: 0.25 },
            features: ['racing stripes'],
            ...(opts.retracted ? { retracted: true } : {}),
          },
        ],
        era: {
          name: '1970s',
          display: 'Suggests the 1970s',
          wording: 'resembles',
          strength: null,
        },
        lineage: [
          {
            name: 'Endurance racing team wear',
            display: 'Resembles endurance racing team wear',
            wording: 'resembles',
            strength: null,
          },
        ],
        materials: [
          {
            name: 'nylon shell',
            texture: 'smooth, slightly glossy',
            wording: 'asserted',
            display: 'Nylon shell',
            strength: 'clear',
            region: { x: 0.3, y: 0.3, w: 0.2, h: 0.2 },
          },
          {
            name: 'ribbed knit',
            wording: 'resembles',
            display: 'Looks like ribbed knit cuffs',
            strength: 'possible',
            region: null,
          },
        ],
        construction: [
          {
            name: 'contrast racing stripes',
            kind: 'pattern',
            wording: 'asserted',
            display: 'Contrast racing stripes',
            strength: 'clear',
            region: { x: 0.3, y: 0.18, w: 0.12, h: 0.45 },
          },
        ],
        palette: [
          { swatch: 0, name: 'cream', hex: '#E9E1CF', display: 'Cream' },
          { swatch: 2, name: 'racing red', hex: '#B23A2E', display: 'Racing red' },
        ],
        mood: [
          { name: 'sporty', display: 'Feels sporty' },
          { name: 'nostalgic', display: 'Feels nostalgic' },
        ],
        details: [
          {
            text: 'Snap-button collar',
            display: 'Snap-button collar',
            wording: 'asserted',
            region: { x: 0.4, y: 0.12, w: 0.2, h: 0.08 },
          },
        ],
        brand: null,
        qloo_links: ['Fila', 'Ellesse'],
        rail: 'more_like_this:s1',
      },
      {
        id: 's2',
        category: 'interior',
        label: 'Wooden chair',
        region: { x: 0.15, y: 0.55, w: 0.7, h: 0.43 },
        aesthetics: [
          {
            name: 'Mid-century modern',
            wording: 'resembles',
            display: 'Resembles mid-century modern',
            strength: 'possible',
            region: { x: 0.15, y: 0.6, w: 0.7, h: 0.38 },
            features: ['tapered legs'],
          },
        ],
        era: null,
        lineage: [],
        materials: [
          {
            name: 'walnut',
            wording: 'resembles',
            display: 'Looks like walnut',
            strength: 'likely',
            region: null,
          },
        ],
        construction: [],
        palette: [{ swatch: 1, name: 'walnut brown', hex: '#6B4A33', display: 'Walnut brown' }],
        mood: [{ name: 'warm', display: 'Feels warm' }],
        details: [],
        brand: null,
        qloo_links: [],
        rail: 'more_like_this:s2',
      },
    ],
    retracted: opts.retracted ? ['subjects[0].aesthetics[1]'] : [],
  };
}

export function styleMatchFor(seed: { attributes: string[] }) {
  return {
    subject_id: 's1',
    attributes: seed.attributes,
    palette: [] as string[],
    via: null,
    experimental: true,
  };
}

export type RailCard = DiscoveryCard & { reason?: string | null; style_match?: unknown };
