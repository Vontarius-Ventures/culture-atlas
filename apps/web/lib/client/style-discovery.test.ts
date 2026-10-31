import { describe, expect, it } from 'vitest';
import { CaptureResponse, VisualReferenceCardSchema } from '@culture-atlas/domain/schemas';
import {
  capturePayload,
  discoveryIntentsFixture,
  VISUAL_FIXTURE_CARD,
  COMMONS_FIXTURE_CARD,
} from '../../e2e/mock/discovery-intents';
import { parseDiscoveryIntents, StyledCaptureResponse, visualWorkPending } from './style';

describe('additive discovery intents', () => {
  it.each([
    'ready',
    'commons-by',
    'commons-sa',
    'pending',
    'running',
    'unavailable',
    'empty',
    'failed',
    'missing-profile',
  ] as const)(
    'keeps the synthetic %s fixture compatible with the shared additive contract',
    (mode) => {
      const raw = capturePayload(discoveryIntentsFixture(mode));
      expect(CaptureResponse.safeParse(raw).success).toBe(true);
      expect(StyledCaptureResponse.parse(raw).discovery_intents).not.toBeNull();
    },
  );
  it('parses separately without changing legacy fields or requiring new data from older APIs', () => {
    const old = capturePayload(undefined);
    delete (old as { discovery_intents?: unknown }).discovery_intents;
    const legacy = StyledCaptureResponse.parse(old);
    const current = StyledCaptureResponse.parse(capturePayload());
    expect(legacy.discovery_intents).toBeNull();
    expect(current.discovery_intents?.visual.cards).toHaveLength(1);
    expect(current.style).toEqual(legacy.style);
    expect(current.recommendations).toEqual(legacy.recommendations);
    expect(current.analysis).toEqual(legacy.analysis);
  });

  it.each([null, {}, { version: 'future' }, discoveryIntentsFixture('malformed')])(
    'fails closed for malformed additive structure without breaking the page: %j',
    (raw) => {
      expect(StyledCaptureResponse.parse(capturePayload(raw)).discovery_intents).toBeNull();
    },
  );

  it.each(['pending', 'running', 'unavailable', 'failed', 'empty'] as const)(
    'does not display attached cards in %s',
    (status) => {
      const raw = discoveryIntentsFixture();
      raw.visual.status = status;
      const parsed = parseDiscoveryIntents(raw)!;
      expect(parsed.visual.cards).toEqual([]);
      expect(visualWorkPending(parsed)).toBe(status === 'pending' || status === 'running');
    },
  );

  it.each([
    { image: null },
    { image: { ...VISUAL_FIXTURE_CARD.image, url: 'https://images.metmuseum.org/anything.jpg' } },
    { image: { ...VISUAL_FIXTURE_CARD.image, url: '//evil.example/image' } },
    { image: { ...VISUAL_FIXTURE_CARD.image, url: '/v1/captures/private/image' } },
    { image: { ...VISUAL_FIXTURE_CARD.image, url: `${VISUAL_FIXTURE_CARD.image.url}?secret=1` } },
    { source_url: 'javascript:alert(1)' },
    { source_url: 'https://www.metmuseum.org.evil.example/art/collection/search/1' },
    { source_url: 'https://user:password@www.metmuseum.org/art/collection/search/1' },
    { source_url: 'http://www.metmuseum.org/art/collection/search/1' },
    { comparison: 'verified' },
    { experimental: undefined },
  ])('rejects unsafe or incomplete candidate data, retaining other real cards: %j', (override) => {
    const raw = discoveryIntentsFixture();
    raw.visual.cards = [
      { ...VISUAL_FIXTURE_CARD, ...override },
      { ...VISUAL_FIXTURE_CARD, id: 'valid-second' },
    ] as typeof raw.visual.cards;
    const parsed = parseDiscoveryIntents(raw)!;
    expect(parsed.visual.cards.map((c) => c.id)).toEqual(['valid-second']);
  });

  it('preserves per-subject relation identity without legacy dedupe', () => {
    const raw = discoveryIntentsFixture();
    raw.visual.cards = [
      { ...VISUAL_FIXTURE_CARD },
      { ...VISUAL_FIXTURE_CARD, subject_id: 's2' },
    ] as typeof raw.visual.cards;
    expect(parseDiscoveryIntents(raw)?.visual.cards.map((c) => c.subject_id)).toEqual(['s1', 's2']);
  });

  it('bounds reason codes and rejects raw error strings', () => {
    const raw = discoveryIntentsFixture('failed');
    raw.visual.reason = '/private/profile.json: upstream token failed';
    expect(parseDiscoveryIntents(raw)).toBeNull();
  });

  it.each([
    ['CC0', 'https://creativecommons.org/publicdomain/zero/1.0/'],
    ['CC-BY-4.0', 'https://creativecommons.org/licenses/by/4.0/'],
    ['CC-BY-SA-4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'],
  ])('accepts exact %s credits for Commons and optional Met credit', (license, license_url) => {
    for (const base of [COMMONS_FIXTURE_CARD, VISUAL_FIXTURE_CARD]) {
      const card = {
        ...base,
        credit: { ...COMMONS_FIXTURE_CARD.credit, license, license_url },
      };
      expect(VisualReferenceCardSchema.safeParse(card).success).toBe(true);
      const fixture = discoveryIntentsFixture();
      const raw = { ...fixture, visual: { ...fixture.visual, cards: [card] } };
      expect(parseDiscoveryIntents(raw)?.visual.cards[0]?.credit).toEqual(card.credit);
    }
  });

  const invalidCredit = [
    null,
    {},
    { ...COMMONS_FIXTURE_CARD.credit, attribution: '   ' },
    { ...COMMONS_FIXTURE_CARD.credit, attribution: 'x'.repeat(601) },
    { ...COMMONS_FIXTURE_CARD.credit, changes: '' },
    { ...COMMONS_FIXTURE_CARD.credit, changes: 'x'.repeat(201) },
    { ...COMMONS_FIXTURE_CARD.credit, license: 'CC-BY-3.0' },
    { ...COMMONS_FIXTURE_CARD.credit, license: 'CC-BY-SA-4.0' },
    { ...COMMONS_FIXTURE_CARD.credit, license_url: 'javascript:alert(1)' },
    { ...COMMONS_FIXTURE_CARD.credit, license_url: 'https://evil.example/license' },
    { ...COMMONS_FIXTURE_CARD.credit, license_url: 'http://creativecommons.org/licenses/by/4.0/' },
    {
      ...COMMONS_FIXTURE_CARD.credit,
      license_url: 'https://creativecommons.org/licenses/by/4.0/?x=1',
    },
    {
      ...COMMONS_FIXTURE_CARD.credit,
      license_url: 'https://creativecommons.org/licenses/by/4.0/#x',
    },
    {
      ...COMMONS_FIXTURE_CARD.credit,
      license_url: 'https://creativecommons.org:443/licenses/by/4.0/',
    },
    { ...COMMONS_FIXTURE_CARD.credit, license_url: 'https://creativecommons.org/licenses/by/4.0' },
  ];
  it.each(invalidCredit)('rejects malformed supplied credit even on Met: %j', (credit) => {
    for (const base of [COMMONS_FIXTURE_CARD, VISUAL_FIXTURE_CARD]) {
      const card = { ...base, credit };
      expect(VisualReferenceCardSchema.safeParse(card).success).toBe(false);
      const fixture = discoveryIntentsFixture();
      const raw = { ...fixture, visual: { ...fixture.visual, cards: [card, VISUAL_FIXTURE_CARD] } };
      expect(CaptureResponse.safeParse(capturePayload(raw)).success).toBe(false);
      expect(
        StyledCaptureResponse.parse(capturePayload(raw)).discovery_intents?.visual.cards,
      ).toEqual([VISUAL_FIXTURE_CARD]);
    }
  });

  it.each([
    { credit: undefined },
    { catalog_id: 'commons:0' },
    { catalog_id: 'commons:02' },
    { catalog_id: 'commons:-2' },
    { catalog_id: 'other:2' },
    { catalog_id: 'commons:3' },
    { catalog_id: 'commons:2\n', source_url: 'https://commons.wikimedia.org/?curid=2\n' },
    { catalog_id: 'commons:2\r' },
    { source_url: 'https://www.metmuseum.org/art/collection/search/2' },
    { source_url: 'https://commons.wikimedia.org/?curid=3' },
    { source_url: 'https://commons.wikimedia.org/?curid=02' },
    { source_url: 'https://commons.wikimedia.org/?curid=%32' },
    { source_url: 'https://commons.wikimedia.org/?curid=2&curid=2' },
    { source_url: 'https://commons.wikimedia.org/?curid=2&extra=1' },
    { source_url: 'https://commons.wikimedia.org/?curid=2#fragment' },
    { source_url: 'https://commons.wikimedia.org/?curid=2#' },
    { source_url: 'https://commons.wikimedia.org:443/?curid=2' },
    { source_url: 'https://user@commons.wikimedia.org/?curid=2' },
    { source_url: 'https://commons.wikimedia.org.evil.example/?curid=2' },
    { source_url: 'https://commons.wikimedia.org/wiki/File:2' },
    { source_url: 'http://commons.wikimedia.org/?curid=2' },
    { source_url: '//commons.wikimedia.org/?curid=2' },
    { source_url: ' https://commons.wikimedia.org/?curid=2' },
    { source_url: 'https://commons.wikimedia.org/?curid=2\n' },
    { image: { ...COMMONS_FIXTURE_CARD.image, url: `${COMMONS_FIXTURE_CARD.image.url}\n` } },
    { image: { ...COMMONS_FIXTURE_CARD.image, url: `${COMMONS_FIXTURE_CARD.image.url}?x=1` } },
    {
      image: {
        ...COMMONS_FIXTURE_CARD.image,
        url: `/v1/visual-references/images/${'A'.repeat(64)}`,
      },
    },
    { image: { ...COMMONS_FIXTURE_CARD.image, url: 'https://upload.wikimedia.org/example.jpg' } },
  ])('requires exact Commons identity and credit; drops only that card: %j', (override) => {
    const fixture = discoveryIntentsFixture();
    const raw = {
      ...fixture,
      visual: {
        ...fixture.visual,
        cards: [{ ...COMMONS_FIXTURE_CARD, ...override }, VISUAL_FIXTURE_CARD],
      },
    };
    expect(CaptureResponse.safeParse(capturePayload(raw)).success).toBe(false);
    expect(parseDiscoveryIntents(raw)?.visual.cards).toEqual([VISUAL_FIXTURE_CARD]);
  });

  it.each([
    'https://www.metmuseum.org/art/collection/search/2',
    'https://www.metmuseum.org/art/collection/search/01',
    'https://commons.wikimedia.org/?curid=1',
    'https://metmuseum.org:443/art/collection/search/1',
    'https://metmuseum.org/art/collection/search/1?',
    'https://metmuseum.org/art/collection/search/1#',
  ])('binds Met source identity as well: %s', (source_url) => {
    const card = { ...VISUAL_FIXTURE_CARD, source_url };
    expect(VisualReferenceCardSchema.safeParse(card).success).toBe(false);
    const fixture = discoveryIntentsFixture();
    expect(
      parseDiscoveryIntents({ ...fixture, visual: { ...fixture.visual, cards: [card] } })?.visual
        .cards,
    ).toEqual([]);
  });

  it.each(['https://www.metmuseum.org', 'https://metmuseum.org'])(
    'retains old Met without credit at %s, with or without a trailing slash',
    (host) => {
      for (const suffix of ['', '/']) {
        const card = {
          ...VISUAL_FIXTURE_CARD,
          source_url: `${host}/art/collection/search/1${suffix}`,
        };
        expect(VisualReferenceCardSchema.safeParse(card).success).toBe(true);
      }
      expect(
        parseDiscoveryIntents(discoveryIntentsFixture())?.visual.cards[0]?.credit,
      ).toBeUndefined();
    },
  );
});
