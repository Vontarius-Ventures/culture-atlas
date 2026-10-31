import { readFileSync } from 'node:fs';
import { resolveFromWorkspace } from '@culture-atlas/providers';
import { describe, expect, it } from 'vitest';
import type { Category } from '../enums';
import type { DiscoveryCard } from '../schemas/common';
import { RailDto, STYLE_COPY, StyleReadingDto } from '../schemas/style';
import type { StoredStyleReading, StoredSubject } from '../style/types';
import { buildRails, mediaStylePreview, styleReadingDto, subjectRailTitle } from './style-dto';

const subject = (category: StoredSubject['category'], label = 'Subject'): StoredSubject => ({
  id: 's1',
  category,
  label,
  region: { x: 0, y: 0, w: 1, h: 1 },
  aesthetics: [],
  era: null,
  lineage: [],
  materials: [],
  construction: [],
  palette: [],
  mood: [],
  details: [],
  brand: null,
  qloo_links: [],
  entity: null,
});
const stored = (s: StoredSubject): StoredStyleReading => ({
  schema: 'atlas_style_reading_v1',
  wording_version: 'legacy',
  guard_version: 'legacy',
  vocab_version: 'legacy',
  rev: 1,
  model: { role: 'vision_style', profile: null, model: 'fixture', experimental: true, ms: 1 },
  image: { width: 10, height: 10, frame_index: null },
  swatches: [],
  summary: 'A reading',
  subjects: [s],
  dropped: [],
  held: [],
  retracted: [],
});
const card = (kind: DiscoveryCard['kind'], category: Category | null = null): DiscoveryCard => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind,
  category,
  title: 'Entity',
  subtitle: null,
  image: null,
  is_example: false,
  saved: false,
  saved_item_id: null,
  recommendation_id: null,
  evidence_available: true,
  reason: 'A catalogue entity to explore.',
});
const rails = (s: StoredSubject | null, cards: DiscoveryCard[] = [], reason?: string) =>
  buildRails({
    stored: s ? stored(s) : null,
    sections: {
      style: 'ready',
      'more_like_this:s1': cards.length ? 'ready' : 'empty',
      ...(reason ? { 'more_like_this:s1:reason': reason } : {}),
    },
    moreLikeThis: new Map([['s1', cards]]),
    crossDomain: new Map(),
    experimental: true,
  });

describe('honest Qloo exploration presentation', () => {
  it('uses safe source nouns and summary only for the new feature-bound contract', () => {
    const s = subject('interior', 'Islamic ceramic bowl collection');
    s.observations = [{ id: 'o1', kind: 'form', text: 'Two round bowls with flared rims', certainty: 0.9, region: s.region }];
    const reading = { ...stored(s), summary: 'An Islamic ceramic bowl collection.' };
    const strict = styleReadingDto(reading, { showClaimRegions: false, safeSubjectLabels: true });
    expect(strict.subjects[0]!.label.toLowerCase()).toContain('bowl');
    expect(strict.subjects[0]!.label).not.toMatch(/Islamic/i);
    expect(strict.summary).not.toMatch(/Islamic/i);
    expect(mediaStylePreview(reading, 'ready', { safeSubjectLabels: true })!.summary).not.toMatch(/Islamic/i);
    expect(mediaStylePreview(reading, 'ready')!.summary).toBe(reading.summary);
    expect(styleReadingDto(reading, { showClaimRegions: false }).subjects[0]!.label).toBe(s.label);
  });

  it('marks completed but fully withheld Connections rails empty, not ready', () => {
    const result = buildRails({ stored: stored(subject('fashion', 'Shirt')), sections: { style: 'ready', 'more_like_this:s1': 'ready', wear: 'ready' },
      moreLikeThis: new Map(), crossDomain: new Map(), experimental: true, validatedConnections: true });
    expect(result.find(r => r.key === 'more_like_this:s1')).toMatchObject({ status: 'empty', cards: [] });
    expect(result.find(r => r.key === 'wear')).toMatchObject({ status: 'empty', cards: [] });
  });

  it('does not turn ongoing validated retrieval into a terminal empty outcome', () => {
    const result = buildRails({ stored: stored(subject('fashion', 'Shirt')), sections: { style: 'ready', 'more_like_this:s1': 'running', wear: 'running' },
      moreLikeThis: new Map(), crossDomain: new Map(), experimental: true, validatedConnections: true });
    expect(result.find(r => r.key === 'more_like_this:s1')!.status).toBe('running');
    expect(result.find(r => r.key === 'wear')!.status).toBe('running');
  });

  it.each([
    ['fashion', 'Jacket', 'brand', 'wear', 'Brands to explore'],
    ['interior', 'Chair', 'brand', 'wear', 'Home brands to explore'],
    ['food', 'Coffee', 'brand', 'wear', 'Food & drink brands to explore'],
    ['food', 'Dinner', 'food', 'eat', 'Food & places to explore'],
    ['media', 'Film poster', 'film', 'watch', 'Films to explore'],
    ['media', 'Record', 'artist', 'play', 'Music to explore'],
    ['media', 'Sculpture', 'film', 'watch', 'Films to explore'],
    ['other', 'Art object', 'reference', null, 'Qloo connections'],
  ] as const)(
    '%s / %s describes actual %s cards without claiming a visual match',
    (category, label, kind, cardCategory, title) => {
      const s = subject(category, label);
      const result = rails(s, [card(kind, cardCategory)])[0]!;
      expect(result).toMatchObject({
        key: 'more_like_this:s1',
        kind: 'more_like_this',
        title,
        subject_id: 's1',
      });
      expect(result.cards[0]!.reason).toBe('A catalogue entity to explore.');
      expect(RailDto.safeParse(result).success).toBe(true);
    },
  );

  it('uses neutral titles for mixed/unknown cards, absent subjects and empty routes', () => {
    expect(subjectRailTitle(subject('fashion'), [card('brand'), card('film')])).toBe(
      'Qloo connections',
    );
    expect(subjectRailTitle(subject('media'), [card('artist')])).toBe('Qloo connections');
    expect(subjectRailTitle(null, [card('reference')])).toBe('Qloo connections');
    expect(subjectRailTitle(subject('fashion'), [])).toBe('Qloo connections');
  });

  it('only an explicit no_city route requests location; unsupported scope is not catalogue absence', () => {
    expect(rails(subject('place'), [], 'no_city')[0]!.empty_message).toBe(STYLE_COPY.style.no_city);
    expect(rails(subject('media', 'Sculpture'), [], 'unsupported')[0]!.empty_message).toBe(
      STYLE_COPY.style.unsupported,
    );
    for (const reason of ['no_signal', 'interior_brands_off', 'unknown', undefined]) {
      expect(rails(subject('interior'), [], reason)[0]!.empty_message).toBe(
        STYLE_COPY.style.rail_empty,
      );
    }
  });

  it('preserves Wear/Play/Watch/Eat categories and legacy stored readings without backfill', () => {
    const s = subject('fashion');
    expect(
      StyleReadingDto.safeParse(styleReadingDto(stored(s), { showClaimRegions: false })).success,
    ).toBe(true);
    expect(
      rails(s)
        .slice(1)
        .map((r) => [r.key, r.kind, r.title]),
    ).toEqual([
      ['wear', 'cross_domain', 'Wear'],
      ['play', 'cross_domain', 'Play'],
      ['watch', 'cross_domain', 'Watch'],
      ['eat', 'cross_domain', 'Eat'],
    ]);
    expect(rails(null)[0]!.title).toBe('Qloo connections');
    expect(s).not.toHaveProperty('observations');
  });

  it('keeps the complete design/server copy identical', () => {
    const design = JSON.parse(readFileSync(resolveFromWorkspace('design/copy.json'), 'utf8'));
    expect(STYLE_COPY).toEqual(design);
  });
});
