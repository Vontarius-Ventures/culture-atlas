import { describe, expect, it } from 'vitest';
import type { QlooEntity } from '@culture-atlas/providers';
import {
  AFFINITY_REASON_MAX,
  affinityReason,
  entityProfile,
  familiesOf,
  genreFilterFor,
  productGate,
  productKind,
  rankCatalogue,
  readingTier,
  regionsOf,
  scoreMatch,
  styleTokens,
  subjectProfile,
  wordWeight,
} from './affinity';
import { matchClaims, rankAffinity } from './affinity-rail';
import { storedAesthetic, storedSubject } from './test-support';
import { styleVocabulary } from './vocabulary';

const G = (s: string) => `urn:tag:genre:brand:fashion:${s}`;
const tag = (id: string, name: string) => ({ id, name });
const ent = (id: string, name: string, tags: { id: string; name: string }[]): QlooEntity => ({ entity_id: id, name, types: ['urn:entity:brand'], properties: {}, tags });

/** Synthetic readings (shapes only, never model output and never an eval photo's answer). */
const tennis = storedSubject({
  label: 'Pleated tennis skirt',
  aesthetics: [storedAesthetic('Tennis whites', { wording: 'resembles', defining_features: ['pleated hem', 'contrast piping'] }), storedAesthetic('Classic', { wording: 'resembles' })],
});
const loafers = storedSubject({ label: 'Leather penny loafers', aesthetics: [storedAesthetic('Ivy League', { defining_features: ['moc toe', 'penny strap'] })] });
const dayDress = storedSubject({ label: 'Cotton floral day dress', aesthetics: [storedAesthetic('Romantic', { wording: 'resembles' })], materials: [{ ...storedAesthetic('Cotton'), texture: 'matte' }] });

describe('smatch-1 tokens, products and tiers', () => {
  it('folds spelling and compounds, drops style filler words', () => {
    expect(styleTokens('Colour-blocked T-shirts')).toEqual(['colorblock', 'tee']);
    expect(styleTokens('90s revival sneakers')).toEqual(['1990s', 'revival', 'sneaker']);
    expect(styleTokens('Smart-casual look, inspired design')).toEqual(['smartcasual']);
    expect(styleTokens('Tie-Dye Hoodie')).toEqual(['tiedye', 'hoodie']);
  });

  it('reads the product from the label head noun', () => {
    expect(productKind({ label: 'Tan crossbody bag', construction: [] })).toBe('bag');
    expect(productKind({ label: 'Black suit with silk tie', construction: [] })).toBe('tailoring');
    expect(productKind({ label: 'Dress with denim jacket', construction: [] })).toBe('dress');
    expect(productKind({ label: 'Suede chelsea boots', construction: [] })).toBe('footwear');
    expect(productKind({ label: 'Canvas work jacket', construction: [] })).toBe('apparel');
    expect(genreFilterFor('footwear')).toBe(G('footwear'));
    expect(genreFilterFor('apparel')).toBeNull();
  });

  it('gates other products by Qloo genre families', () => {
    const eyewear = familiesOf([G('accessories'), G('accessories:eyewear')]);
    const clothing = familiesOf([G('casual'), G('footwear')]);
    expect(productGate('apparel', eyewear)).toBe('not_apparel');
    expect(productGate('apparel', clothing)).toBeNull();
    expect(productGate('footwear', familiesOf([G('casual')]))).toBe('not_footwear');
    expect(productGate('bag', familiesOf([G('accessories:bags_and_leather')]))).toBeNull();
    // No genre information: a garment rail keeps it, a shoe rail needs Qloo to say it makes shoes.
    expect(productGate('apparel', familiesOf([]))).toBeNull();
    expect(productGate('footwear', familiesOf([]))).toBe('not_footwear');
  });

  it('a casual reading leaves couture, bridal and $$$$ houses out', () => {
    expect(readingTier('Cotton floral day dress ; Romantic')).toBe('casual');
    expect(readingTier('Sequined evening gown ; Glamour')).toBe('dressy');
    const q = subjectProfile(dayDress);
    const couture = entityProfile([tag(G('casual'), 'Casual'), tag(G('haute_couture'), 'Haute Couture'), tag('urn:tag:aesthetic_property:qloo:romantic', 'Romantic')]);
    const pricey = entityProfile([tag(G('casual'), 'Casual'), tag('urn:tag:price_level:qloo:_', '$$$$'), tag('urn:tag:aesthetic_property:qloo:romantic', 'Romantic')]);
    const everyday = entityProfile([tag(G('casual'), 'Casual'), tag('urn:tag:price_level:qloo:_', '$$'), tag('urn:tag:aesthetic_property:qloo:romantic', 'Romantic')]);
    expect(scoreMatch(q, couture).gate).toBe('tier');
    expect(scoreMatch(q, pricey).gate).toBe('tier');
    expect(scoreMatch(q, everyday).gate).toBeNull();
  });

  it('a market tie the reading does not mention ranks a brand down; a design reference does not', () => {
    expect(regionsOf('Brazilian Fashion')).toEqual(['brazilian']);
    expect(regionsOf('Middle Eastern Retail Scene')).toEqual(['middle_eastern']);
    const q = subjectProfile(tennis);
    const market = entityProfile([tag(G('casual'), 'Casual'), tag('urn:tag:cultural_relevance:qloo:tennis_culture', 'Tennis Culture'), tag('urn:tag:cultural_relevance:qloo:brazilian_fashion', 'Brazilian Fashion')]);
    const design = entityProfile([tag(G('casual'), 'Casual'), tag('urn:tag:cultural_relevance:qloo:tennis_culture', 'Tennis Culture'), tag('urn:tag:design_inspiration:qloo:french_riviera_style', 'French Riviera Style')]);
    expect(scoreMatch(q, market).regionFactor).toBeLessThan(1);
    expect(scoreMatch(q, design).regionFactor).toBe(1);
  });
});

describe('smatch-1 scoring', () => {
  it('a rare shared word outweighs common ones', () => {
    expect(wordWeight('tennis')).toBeGreaterThan(wordWeight('casual') * 5);
    const q = subjectProfile(tennis);
    const specific = entityProfile([tag(G('casual'), 'Casual'), tag('urn:tag:cultural_relevance:qloo:tennis_culture', 'Tennis Culture')]);
    const generic = entityProfile([tag(G('casual'), 'Casual'), tag('urn:tag:personal_style:qloo:classic', 'Classic'), tag('urn:tag:personal_style:qloo:casual', 'Casual'), tag('urn:tag:aesthetic_property:qloo:clean_lines', 'Clean Lines')]);
    expect(scoreMatch(q, specific).score).toBeGreaterThan(scoreMatch(q, generic).score * 2);
  });

  it('ranks the catalogue for a reading: every pick is a recorded brand of the same product family', () => {
    const v = styleVocabulary();
    const ids = new Set(v.brands.map((b) => b.id));
    const top = rankCatalogue(subjectProfile(loafers), { max: 10 });
    expect(top.length).toBeGreaterThan(3);
    for (const x of top) {
      expect(ids.has(x.id)).toBe(true);
      const b = v.brands.find((y) => y.id === x.id)!;
      expect(b.genre_ids!.some((g) => g.startsWith(G('footwear'))), b.name).toBe(true);
    }
  });

  it('reasons name the entity tag and the reading claim, within 90 characters', () => {
    const q = subjectProfile(tennis);
    const r = scoreMatch(q, entityProfile([tag(G('casual'), 'Casual'), tag('urn:tag:cultural_relevance:qloo:tennis_culture', 'Tennis Culture')]));
    const reason = affinityReason(r.hits)!;
    expect(reason).toBe('Known for tennis culture, like the tennis whites look your photo resembles');
    expect(reason.length).toBeLessThanOrEqual(AFFINITY_REASON_MAX);
    expect(matchClaims(r.hits).map((c) => c.name)).toEqual(['Tennis whites']);
    expect(affinityReason([], { entityName: 'Fixture Brand' })).toBe('Connected to Fixture Brand in your photo.');
    expect(affinityReason([])).toBeNull();
  });
});

describe('smatch-1 rail assembly', () => {
  it('gates other products, drops weak matches and duplicate names, ranks style first', () => {
    const q = subjectProfile(tennis);
    const tennisTag = tag('urn:tag:cultural_relevance:qloo:tennis_culture', 'Tennis Culture');
    const out = rankAffinity(q, [
      {
        list: [
          ent('A', 'Fixture Popular Eyewear', [tag(G('accessories:eyewear'), 'Eyewear'), tennisTag]),
          ent('B', 'Fixture Plain Casual', [tag(G('casual'), 'Casual'), tag('urn:tag:personal_style:qloo:casual', 'Casual')]),
          ent('C', 'Fixture Court Club', [tag(G('casual'), 'Casual'), tennisTag]),
          ent('D', 'Fixture Court Club', [tag(G('casual'), 'Casual'), tennisTag]),
        ],
        prior: true,
        fromEntity: false,
      },
    ]);
    expect(out.candidates.map((c) => c.entity.entity_id)).toEqual(['C']);
    expect(out.gated).toMatchObject({ not_apparel: 1, weak: 1 });
  });
});
