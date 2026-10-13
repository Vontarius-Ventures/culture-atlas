import type { VlmAnalysis } from '@culture-atlas/providers';
import type { Category } from '../enums';
import { sampleBySlug, type SampleItem } from './samples';

/**
 * Reviewed example replays for the three "Try an example" photos
 * (apps/web/public/samples/{outfit,room,cafe}.jpg, project-original
 * illustrations). Used ONLY when an example capture is analyzed while the
 * VLM is unavailable (no ANTHROPIC_API_KEY): the compiler replays this
 * hand-reviewed reading instead of failing, and the capture is labeled
 * "Example result" in the UI.
 *
 * Honesty rules:
 *  - The reading describes what the illustration actually shows and phrases
 *    every cultural reading as a resemblance; it is not a model recording.
 *  - The picks are reviewed sample items (feed/samples.ts) stored with
 *    origin 'sample' — never 'qloo' — and each names the example reference it
 *    was chosen for as a creative rationale. Qloo categories still run (and
 *    report unavailable without a key), so the partial state stays visible.
 *  - The inspector shows the observe stage as a replay ("reviewed-example").
 */
export interface ExamplePick {
  sample: string;
  category: Category;
  /** Plain-language "Why this?" (creative choice, not a claimed connection). */
  reason: string;
  /** Candidate names from `analysis.candidates` this pick was chosen for. */
  references: string[];
}

export interface ExampleReplay {
  sampleId: 'outfit' | 'room' | 'cafe';
  reviewedAt: string;
  analysis: VlmAnalysis;
  picks: ExamplePick[];
}

export const EXAMPLE_REPLAY_MODEL = 'reviewed-example';

const EXAMPLES: readonly ExampleReplay[] = [
  {
    sampleId: 'outfit',
    reviewedAt: '2026-10-13',
    analysis: {
      title: 'Vintage racing references',
      interpretation: 'A cream jacket with red and navy stripes that resembles vintage motor-racing wear.',
      observations: [
        { id: 'o1', kind: 'garment', text: 'Cream zip-front jacket with two red and two navy vertical stripes', region_ids: ['r1'] },
        { id: 'o2', kind: 'object', text: 'Round target-style patch on the chest', region_ids: ['r2'] },
        { id: 'o3', kind: 'setting', text: 'Jacket hung over a wooden chair against a dark wall', region_ids: [] },
      ],
      visible_text: [],
      candidates: [
        {
          id: 'c1',
          name: 'Racing stripes',
          type: 'style',
          relation: 'resembles',
          rationale: 'Parallel contrasting stripes running the length of the jacket',
          certainty: 0.7,
          region_ids: ['r1'],
          suggested_categories: ['wear', 'watch'],
          tag_queries: ['racing stripes'],
        },
        {
          id: 'c2',
          name: 'Motorsport',
          type: 'tradition',
          relation: 'resembles',
          rationale: 'The cut and striping recall drivers’ jackets from 1960s and 1970s racing',
          certainty: 0.55,
          region_ids: ['r1'],
          suggested_categories: ['watch'],
          tag_queries: [],
        },
        {
          id: 'c3',
          name: 'Mod',
          type: 'style',
          relation: 'resembles',
          rationale: 'The target-style roundel patch is a familiar mod motif',
          certainty: 0.4,
          region_ids: ['r2'],
          suggested_categories: ['wear', 'play'],
          tag_queries: ['mod'],
        },
      ],
      regions: [
        { id: 'r1', label: 'Jacket', box: { x: 0.1, y: 0.22, w: 0.8, h: 0.6 } },
        { id: 'r2', label: 'Patch', box: { x: 0.37, y: 0.31, w: 0.09, h: 0.07 } },
      ],
      uncertainty: { overall: 'medium', notes: ['No logos or labels are visible; the reading is based on style alone.'] },
      competing_subjects: [],
      quality: { usable: true, issue: null },
    },
    picks: [
      { sample: 'film-le-mans', category: 'watch', reason: 'An endurance-racing film, for the racing feel of the jacket.', references: ['Motorsport', 'Racing stripes'] },
      { sample: 'film-grand-prix', category: 'watch', reason: 'A motor-racing drama from the era the jacket recalls.', references: ['Motorsport'] },
      { sample: 'style-mod', category: 'wear', reason: 'The roundel patch echoes mod style.', references: ['Mod'] },
      { sample: 'style-breton-shirt', category: 'wear', reason: 'Another classic stripe to wear with it.', references: ['Racing stripes'] },
    ],
  },
  {
    sampleId: 'room',
    reviewedAt: '2026-10-13',
    analysis: {
      title: 'A quiet, spare room',
      interpretation: 'A calm room with a paned window and a single branch in a vase, resembling minimal, nature-led interiors.',
      observations: [
        { id: 'o1', kind: 'setting', text: 'Paned window letting in soft afternoon light', region_ids: ['r1'] },
        { id: 'o2', kind: 'object', text: 'Low wooden table', region_ids: ['r2'] },
        { id: 'o3', kind: 'object', text: 'A single flowering branch in a vase', region_ids: ['r3'] },
      ],
      visible_text: [],
      candidates: [
        {
          id: 'c1',
          name: 'Minimalism',
          type: 'style',
          relation: 'resembles',
          rationale: 'Few objects, plain surfaces and open space',
          certainty: 0.6,
          region_ids: [],
          suggested_categories: ['wear', 'play', 'watch'],
          tag_queries: ['minimalist'],
        },
        {
          id: 'c2',
          name: 'Ikebana',
          type: 'tradition',
          relation: 'resembles',
          rationale: 'A single branch arranged on its own in a vase',
          certainty: 0.45,
          region_ids: ['r3'],
          suggested_categories: ['watch'],
          tag_queries: [],
        },
      ],
      regions: [
        { id: 'r1', label: 'Window', box: { x: 0.1, y: 0.08, w: 0.55, h: 0.5 } },
        { id: 'r2', label: 'Table', box: { x: 0.2, y: 0.66, w: 0.6, h: 0.2 } },
        { id: 'r3', label: 'Branch in a vase', box: { x: 0.55, y: 0.35, w: 0.25, h: 0.35 } },
      ],
      uncertainty: { overall: 'medium', notes: ['A mood, not a specific place or designer.'] },
      competing_subjects: [],
      quality: { usable: true, issue: null },
    },
    picks: [
      { sample: 'film-tokyo-story', category: 'watch', reason: 'Calm domestic rooms, in the spirit of your photo.', references: ['Minimalism'] },
      { sample: 'artist-ryuichi-sakamoto', category: 'play', reason: 'Spare piano music for a quiet room.', references: ['Minimalism'] },
      { sample: 'style-linen', category: 'wear', reason: 'Light, simple fabric with the same calm feel.', references: ['Minimalism'] },
    ],
  },
  {
    sampleId: 'cafe',
    reviewedAt: '2026-10-13',
    analysis: {
      title: 'A café afternoon',
      interpretation: 'A marble café table with coffee and a pastry, resembling a classic European café setting.',
      observations: [
        { id: 'o1', kind: 'object', text: 'Round marble table top', region_ids: ['r1'] },
        { id: 'o2', kind: 'food', text: 'A cup of coffee on a saucer', region_ids: ['r2'] },
        { id: 'o3', kind: 'food', text: 'A pastry on a small plate', region_ids: ['r3'] },
        { id: 'o4', kind: 'object', text: 'Cane-backed café chair', region_ids: [] },
      ],
      visible_text: [],
      candidates: [
        {
          id: 'c1',
          name: 'Café culture',
          type: 'tradition',
          relation: 'resembles',
          rationale: 'Marble table, cane chair and coffee service typical of European cafés',
          certainty: 0.6,
          region_ids: ['r1'],
          suggested_categories: ['eat', 'watch', 'play'],
          tag_queries: [],
        },
        {
          id: 'c2',
          name: 'Pastry',
          type: 'cuisine',
          relation: 'depicted',
          rationale: 'A pastry is shown on the plate; its exact kind is not clear',
          certainty: 0.7,
          region_ids: ['r3'],
          suggested_categories: ['eat'],
          tag_queries: [],
        },
      ],
      regions: [
        { id: 'r1', label: 'Table', box: { x: 0.12, y: 0.45, w: 0.76, h: 0.35 } },
        { id: 'r2', label: 'Coffee', box: { x: 0.3, y: 0.45, w: 0.2, h: 0.15 } },
        { id: 'r3', label: 'Pastry', box: { x: 0.55, y: 0.5, w: 0.2, h: 0.12 } },
      ],
      uncertainty: { overall: 'low', notes: [] },
      competing_subjects: [],
      quality: { usable: true, issue: null },
    },
    picks: [
      { sample: 'food-pastel-de-nata', category: 'eat', reason: 'A custard pastry to go with the coffee.', references: ['Pastry', 'Café culture'] },
      { sample: 'film-amelie', category: 'watch', reason: 'Set around a Montmartre café.', references: ['Café culture'] },
      { sample: 'artist-astrud-gilberto', category: 'play', reason: 'Easy bossa nova for a café afternoon.', references: ['Café culture'] },
    ],
  },
];

/** The reviewed replay for an example photo, or null. Returns a deep copy. */
export function exampleReplay(sampleId: string | null | undefined): ExampleReplay | null {
  const found = EXAMPLES.find((e) => e.sampleId === sampleId);
  return found ? structuredClone(found) : null;
}

/** Every pick resolves to a reviewed sample item (checked by tests). */
export function examplePickItems(example: ExampleReplay): { pick: ExamplePick; item: SampleItem }[] {
  return example.picks.flatMap((pick) => {
    const item = sampleBySlug(pick.sample);
    return item ? [{ pick, item }] : [];
  });
}

export const EXAMPLE_IDS = EXAMPLES.map((e) => e.sampleId);
