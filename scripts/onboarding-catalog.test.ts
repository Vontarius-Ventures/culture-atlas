import { ProviderError, type CallOptions, type QlooProvider, type QlooTag, type QlooTagsRequest } from '../packages/providers/src';
import { FakeQloo } from '../packages/providers/src/testing';
import { describe, expect, it } from 'vitest';
import {
  buildOnboardingCatalog,
  catalogProblems,
  chooseTag,
  type ChipSpec,
  type ImageSpec,
} from './onboarding-catalog-lib';

/**
 * Builder logic against a fake Qloo: exact-name matching, accepted tag types,
 * the request budget, at most 3 requests in flight and reuse of unchanged
 * entries. The committed catalog itself comes from the live run of
 * scripts/build-onboarding-catalog.ts.
 */
const tag = (id: string, name: string): QlooTag => ({ id, name, type: id.split(':').slice(0, 4).join(':') });
const now = () => new Date('2026-10-18T12:00:00.000Z');
const noSleep = async () => {};

const TAGS: Record<string, QlooTag[]> = {
  jazz: [tag('urn:tag:genre:media:jazz', 'Jazz'), tag('urn:tag:genre:music:jazz', 'Jazz'), tag('urn:tag:genre:music:jazz_fusion', 'Jazz Fusion')],
  soul: [tag('urn:tag:cuisine:qloo:soul', 'Soul')],
  'wabi sabi': [tag('urn:tag:decor:qloo:wabi_sabi', 'Wabi Sabi')],
  ramen: [tag('urn:tag:cuisine:qloo:ramen', 'Ramen')],
  izakaya: [tag('urn:tag:cuisine:qloo:izakaya', 'Izakaya')],
};

const chips: ChipSpec[] = [
  { id: 'chip-play-jazz', category: 'play', label: 'Jazz' },
  { id: 'chip-play-soul', category: 'play', label: 'Soul' },
  { id: 'chip-wear-wabi-sabi', category: 'wear', label: 'Wabi-sabi', query: 'wabi sabi' },
  { id: 'chip-eat-ramen', category: 'eat', label: 'Ramen' },
];
const images: ImageSpec[] = [
  {
    id: 'img-lanterns',
    category: 'eat',
    label: 'Lantern-lit alleys',
    image: { url: '/samples/feed/rainy-alley.jpg', width: 1000, height: 1250, alt: 'Alley' },
    tags: [{ query: 'izakaya' }, { chip: 'chip-eat-ramen' }, { chip: 'chip-play-soul' }],
  },
];

function fakeQloo(opts: { fail?: Set<string> } = {}) {
  let inFlight = 0;
  let maxInFlight = 0;
  const fake = new FakeQloo({
    tags: (q) => (opts.fail?.has(q) ? new ProviderError('qloo', 'rate_limited', '429', { status: 429 }) : TAGS[q.toLowerCase()] ?? []),
  }, { live: true });
  // Charges the budget before every attempt, like QlooHttpProvider, and tracks concurrency.
  const qloo: Pick<QlooProvider, 'lookupTags'> = {
    async lookupTags(req: QlooTagsRequest, options?: CallOptions) {
      if (options?.budget && !options.budget.take('qloo', 'request')) throw new ProviderError('qloo', 'budget_exhausted', 'budget');
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await fake.lookupTags(req);
      } finally {
        inFlight--;
      }
    },
  };
  return { qloo, calls: () => fake.calls.length, maxInFlight: () => maxInFlight };
}

describe('chooseTag', () => {
  it('needs an exact name and a type the category accepts, preferring earlier types', () => {
    expect(chooseTag(TAGS.jazz!, 'Jazz', 'play')?.id).toBe('urn:tag:genre:music:jazz');
    expect(chooseTag(TAGS.soul!, 'Soul', 'play')).toBeNull();
    expect(chooseTag(TAGS['wabi sabi']!, 'Wabi-sabi', 'wear')?.id).toBe('urn:tag:decor:qloo:wabi_sabi');
    expect(chooseTag(TAGS.jazz!, 'Jazz Fusion Revival', 'play')).toBeNull();
  });
});

describe('buildOnboardingCatalog', () => {
  it('resolves real ids, drops what Qloo lacks and keeps multi-tag images to resolved tags', async () => {
    const f = fakeQloo();
    const report = await buildOnboardingCatalog({ qloo: f.qloo, now, chips, images, sleep: noSleep });
    expect(report.dropped).toEqual([{ id: 'chip-play-soul', reason: 'no Qloo tag named "Soul"' }]);
    const img = report.catalog.items.find((i) => i.id === 'img-lanterns')!;
    expect(img.qloo.map((q) => q.id)).toEqual(['urn:tag:cuisine:qloo:izakaya', 'urn:tag:cuisine:qloo:ramen']);
    expect(report.catalog.catalog_version).toMatch(/^2026-10-18\.[0-9a-f]{10}$/);
    expect(report.requests).toBe(5);
    expect(f.maxInFlight()).toBeLessThanOrEqual(3);
    expect(catalogProblems(report.catalog)).toContain('expected 12-16 images, got 1');
  });

  it('never exceeds the request budget (retries included) and reuses unchanged entries', async () => {
    const f = fakeQloo();
    const capped = await buildOnboardingCatalog({ qloo: f.qloo, now, chips, images, budget: 2, sleep: noSleep });
    expect(capped.requests).toBe(2);
    expect(f.calls()).toBe(2);

    const first = await buildOnboardingCatalog({ qloo: fakeQloo().qloo, now, chips, images, sleep: noSleep });
    const g = fakeQloo();
    const again = await buildOnboardingCatalog({ qloo: g.qloo, now, chips, images, previous: first.catalog, sleep: noSleep });
    expect(g.calls()).toBe(1); // only the label that never resolved ("Soul") is looked up again
    expect(again.reused.sort()).toEqual(['chip-eat-ramen', 'chip-play-jazz', 'chip-wear-wabi-sabi']);
    expect(again.catalog.items).toEqual(first.catalog.items);
  });

  it('a throttled lookup leaves the label out instead of inventing it', async () => {
    const report = await buildOnboardingCatalog({ qloo: fakeQloo({ fail: new Set(['Jazz']) }).qloo, now, chips, images, sleep: noSleep });
    expect(report.catalog.items.some((i) => i.id === 'chip-play-jazz')).toBe(false);
    expect(report.dropped.map((d) => d.id)).toContain('chip-play-jazz');
  });
});
