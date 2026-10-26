import { describe, expect, it } from 'vitest';
import type { QlooEntity } from '@culture-atlas/providers';
import {
  AFFINITY_REASON_MAX,
  affinityReason,
  echoKey,
  echoNames,
  ECHO_PENALTY,
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
import { MOOD_CONTRADICTION_FACTOR } from './mood';
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
    expect(reason).toBe('Known for tennis culture, a shared detail with your photo');
    expect(reason.length).toBeLessThanOrEqual(AFFINITY_REASON_MAX);
    expect(matchClaims(r.hits)).toEqual([]); // A tennis tag does not prove tennis whites.
    expect(affinityReason([], { entityName: 'Fixture Brand' })).toBe('Connected to Fixture Brand in your photo.');
    expect(affinityReason([])).toBeNull();
  });
});

describe('bounded product and reason evidence', () => {
  it('rejects backpack-only and unproven bag forms but keeps a diversified crossbody maker', () => {
    const q = subjectProfile(storedSubject({ label: 'Tan leather crossbody bag' }));
    const bag = tag(G('accessories:bags_and_leather'), 'Bags and Leather');
    const piece = (name: string) => tag(`urn:tag:signature_piece:qloo:${name.toLowerCase().replaceAll(' ', '_')}`, name);
    const backpack = ent('backpack', 'Pack House', [bag, piece('Leather Backpacks')]);
    const generic = ent('generic', 'Generic Bag House', [bag]);
    const diversified = ent('diversified', 'Diversified House', [bag, piece('Backpacks'), piece('Leather Crossbody Bags')]);
    expect(scoreMatch(q, entityProfile(backpack.tags)).gate).toBe('incompatible_form');
    expect(scoreMatch(q, entityProfile(generic.tags)).gate).toBe('unsupported_form');
    expect(scoreMatch(q, entityProfile(diversified.tags)).gate).toBeNull();
    const out = rankAffinity(q, [{ list: [backpack, generic, diversified], prior: true, fromEntity: false }]);
    expect(out.candidates.map((c) => c.entity.entity_id)).toEqual(['diversified']);
  });

  it('does not fill a strict product rail with unsupported taste neighbours', () => {
    const q = subjectProfile(storedSubject({ label: 'Crossbody bag' }));
    const candidate = ent('weak', 'Unrelated House', [tag(G('accessories:bags_and_leather'), 'Bags and Leather'), tag('urn:tag:signature_piece:qloo:crossbody', 'Crossbody'), tag('urn:tag:personal_style:qloo:unrelated', 'Unrelated')]);
    // A positive form is necessary but does not waive the absolute evidence bar.
    const weak = { ...candidate, query: { explainability: [{ entity_id: 'seed', score: 0.9 }] } };
    const out = rankAffinity(q, [{ list: [weak], prior: true, fromEntity: false }], { signalNames: new Map([['seed', 'Seed House']]), v: { ...styleVocabulary(), brands: [] } });
    expect(out.candidates).toEqual([]);
  });

  it('equipment mislabeled fashion cannot score as clothing, while garments remain eligible', () => {
    const brand = entityProfile([tag(G('casual'), 'Casual'), tag('urn:tag:cultural_relevance:qloo:tennis', 'Tennis')]);
    const racket = subjectProfile(storedSubject({ label: 'Tennis racket', aesthetics: [storedAesthetic('Tennis')] }));
    expect(racket.kind).toBe('apparel'); // Backward-compatible provider family.
    expect(scoreMatch(racket, brand).gate).toBe('unsupported_product');
    expect(rankCatalogue(racket)).toEqual([]);
    for (const label of ['Tennis skirt', 'Wool coat', 'Cotton dress', 'Silk blouse', 'Linen trousers', 'Rain jacket', 'Tennis jersey']) {
      expect(scoreMatch(subjectProfile(storedSubject({ label })), brand).gate, label).toBeNull();
    }
  });

  it('does not equate contradictory cafe cultures or historical ceramic lineages', () => {
    const q = subjectProfile(storedSubject({ category: 'food', label: 'Italian cafe', lineage: [storedAesthetic('Italian cafe culture')] }));
    const mismatch = scoreMatch(q, entityProfile([tag('urn:tag:cultural_relevance:qloo:portuguese_cafe', 'Portuguese Cafe Culture')]), { fashion: false });
    expect(affinityReason(mismatch.hits)).toBeNull();
    expect(matchClaims(mismatch.hits)).toEqual([]);
    const ceramics = subjectProfile(storedSubject({ category: 'interior', label: 'Persian ceramic bowl', lineage: [storedAesthetic('Persian ceramics')] }));
    const broad = scoreMatch(ceramics, entityProfile([tag('urn:tag:keyword:qloo:ceramics', 'Ceramics')]), { fashion: false });
    expect(affinityReason(broad.hits)).toBe('Known for ceramics, a shared detail with your photo');
    expect(matchClaims(broad.hits)).toEqual([]);
    const exact = scoreMatch(q, entityProfile([tag('urn:tag:cultural_relevance:qloo:italian_cafe', 'Italian Cafe Culture')]), { fashion: false });
    expect(affinityReason(exact.hits)).toContain('Italian cafe culture');
    expect(matchClaims(exact.hits).map((c) => c.name)).toEqual(['Italian cafe culture']);
  });

  it('held and retracted claims, including era, do not classify or explain a profile', () => {
    const q = subjectProfile(storedSubject({
      label: 'Cotton jacket',
      aesthetics: [storedAesthetic('Italian couture', { held: true })],
      lineage: [storedAesthetic('Japanese heritage', { retracted: true })],
      era: { ...storedAesthetic('French luxury', { retracted: true }), cue: 'ornate trim' },
      materials: [{ ...storedAesthetic('Silk', { held: true }), texture: 'smooth' }],
      construction: [{ ...storedAesthetic('Crossbody', { retracted: true }), kind: 'sewn' }],
    }));
    expect(q.regions.size).toBe(0);
    expect(q.tier).toBe('casual');
    expect(q.form).toBeNull();
    for (const token of ['italian', 'japanese', 'french', 'silk', 'crossbody']) expect(q.tokens.has(token)).toBe(false);
    const hidden = scoreMatch(q, entityProfile([tag(G('casual'), 'Casual'), tag('urn:tag:cultural_relevance:qloo:japanese', 'Japanese Heritage')]));
    expect(affinityReason(hidden.hits)).toBeNull();
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

  it('mood-blind cards are strongly down-ranked: cheerful bedding for an abandoned motel room (eval r3, cause 2)', () => {
    const motel = storedSubject({
      category: 'interior',
      label: 'Abandoned paneled motel room',
      aesthetics: [storedAesthetic('Abandoned decay', { wording: 'resembles' }), storedAesthetic('Roadside motel', { wording: 'resembles' })],
      materials: [{ ...storedAesthetic('Cotton bedding'), texture: 'worn' }],
    });
    const q = subjectProfile(motel);
    expect([...q.mood]).toEqual(['melancholy']);
    // Two entities carrying the same non-mood evidence ("Roadside Motel"); only one also names a
    // mood ("Cozy Home") — the contradiction cuts its score by the fixed factor; silence never does.
    const roadside = 'urn:tag:decor:qloo:roadside_motel';
    const neutral = entityProfile([tag(roadside, 'Roadside Motel'), tag('urn:tag:lifestyle:qloo:family', 'Family Friendly')]);
    const cozy = entityProfile([tag(roadside, 'Roadside Motel'), tag('urn:tag:aesthetic_property:qloo:cozy_home', 'Cozy Home')]);
    expect([...neutral.mood]).toEqual([]);
    expect([...cozy.mood]).toEqual(['warm']);
    expect(scoreMatch(q, cozy).score).toBeCloseTo(scoreMatch(q, neutral).score * MOOD_CONTRADICTION_FACTOR, 5);
    expect(scoreMatch(q, neutral).score).toBeGreaterThan(0);
    // A reading without mood words is never mood-gated.
    const plain = subjectProfile(storedSubject({ category: 'interior', label: 'Roadside motel room' }));
    expect([...plain.mood]).toEqual([]);
    expect(scoreMatch(plain, cozy).score).toBeCloseTo(scoreMatch(plain, neutral).score, 5);
  });

  it('a warm drink reading is never contradicted by product words: the espresso rail keeps its real results', () => {
    // The live espresso run (r3run h16): the reading says "Feels warm, Feels cozy"; every coffee
    // brand carries product words ("Minimalist" design, "Dark Roast", "Cold Brew", "Rich") that
    // used to read as austere/melancholy moods, cutting all 17 real results to 35 % and gating
    // the rail empty. Product words are style evidence, never moods.
    const drink = storedSubject({
      category: 'food',
      label: 'Espresso in a ceramic cup',
      aesthetics: [storedAesthetic('Italian espresso', { wording: 'resembles' }), storedAesthetic('Classic cafe', { wording: 'resembles' })],
      mood: [
        { name: 'warm', certainty: 0.8, wording: 'resembles', display: 'Feels warm', strength: null, corroborated_by: [], held: false, basis: 'visible', region: null, qloo: null },
        { name: 'cozy', certainty: 0.7, wording: 'resembles', display: 'Feels cozy', strength: null, corroborated_by: [], held: false, basis: 'visible', region: null, qloo: null },
      ],
    });
    const q = subjectProfile(drink);
    expect([...q.mood]).toEqual(['warm']);
    // Two brands with the same espresso evidence and the same tag count; one carries the product
    // descriptors, the other neutral ones. Product words are style evidence, never moods: the
    // two score identically, where the old mood reading cut the first to 35 %.
    const shared = [tag('urn:tag:lifestyle:qloo:italian_espresso_culture', 'Italian Espresso Culture'), tag('urn:tag:genre:brand:dining', 'Dining')];
    const neutral = entityProfile([...shared, tag('urn:tag:material:qloo:arabica', 'Arabica'), tag('urn:tag:material:qloo:robusta', 'Robusta'), tag('urn:tag:product_service:qloo:slow_drip', 'Slow Drip'), tag('urn:tag:product_service:qloo:single_origin', 'Single Origin')]);
    const productWords = entityProfile([
      ...shared,
      tag('urn:tag:aesthetic_property:qloo:minimalist_design', 'Minimalist Design'),
      tag('urn:tag:material:qloo:dark_roast', 'Dark Roast'),
      tag('urn:tag:product_service:qloo:cold_brew', 'Cold Brew'),
      tag('urn:tag:aesthetic_property:qloo:rich_flavor', 'Rich Flavor'),
    ]);
    expect([...neutral.mood]).toEqual([]);
    expect([...productWords.mood]).toEqual([]);
    // Not the 0.35 mood cut the old reading gave these brands: within 10 % of its twin.
    expect(scoreMatch(q, productWords).score).toBeGreaterThan(scoreMatch(q, neutral).score * 0.9);
    expect(scoreMatch(q, productWords).score).toBeGreaterThan(0);
    // The gate still bites the real opposite mood: a cheerful brand for a gloomy reading.
    const gloomy = subjectProfile(storedSubject({ category: 'interior', label: 'Abandoned room', aesthetics: [storedAesthetic('Abandoned decay', { wording: 'resembles' })] }));
    const cheerful = entityProfile([tag('urn:tag:aesthetic_property:qloo:italian_espresso_culture', 'Italian Espresso Culture'), tag('urn:tag:aesthetic_property:qloo:cheerful', 'Cheerful')]);
    const glumless = entityProfile([tag('urn:tag:aesthetic_property:qloo:italian_espresso_culture', 'Italian Espresso Culture'), tag('urn:tag:aesthetic_property:qloo:unfussy', 'Unfussy')]);
    expect([...cheerful.mood]).toEqual(['warm']);
    expect([...glumless.mood]).toEqual([]);
    expect(scoreMatch(gloomy, cheerful).score).toBeCloseTo(scoreMatch(gloomy, glumless).score * MOOD_CONTRADICTION_FACTOR, 5);
  });

  it('an anchor-brand echo is down-ranked, not removed (eval r3, cause 4)', () => {
    const q = subjectProfile(tennis);
    const tennisTag = tag('urn:tag:cultural_relevance:qloo:tennis_culture', 'Tennis Culture');
    const out = rankAffinity(
      q,
      [{ list: [ent('W', 'Wilson', [tag(G('casual'), 'Casual'), tennisTag]), ent('K', 'Kappa', [tag(G('casual'), 'Casual'), tennisTag])], prior: true, fromEntity: false }],
      { echoNames: echoNames(['Wilson']) },
    );
    // The echo still matches the reading's style (it is kept), but ranks below the equal match.
    expect(out.candidates.map((c) => c.entity.name)).toEqual(['Kappa', 'Wilson']);
    expect(out.candidates[1]!.score).toBeLessThan(out.candidates[0]!.score);
    expect(out.gated.echo).toBe(1);
    // Echo names are brand names already surfaced, matched by folded name.
    expect(echoKey('Fila')).toBe(echoKey(' FILA. '));
    expect(ECHO_PENALTY).toBeLessThan(1);
    expect(out.candidates).toHaveLength(2);
  });
});
