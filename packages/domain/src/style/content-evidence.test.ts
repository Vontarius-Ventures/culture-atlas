import { describe, expect, it } from 'vitest';
import { documentaryEvidence, documentaryTopic } from './content-evidence';
import { admitDiscovery, discoveryReason, proofIsActive } from './discovery-evidence';
import { storedAesthetic, storedSubject } from './test-support';
import { planConnectionTopics } from './connection-topics';

const movie = 'urn:entity:movie';
const documentary = { id: 'urn:tag:genre:media:documentary', name: 'Documentary' };
const sculpture = { id: 'urn:tag:keyword:qloo:sculpture', name: 'Sculpture' };
const coffee = { id: 'urn:tag:keyword:qloo:coffee', name: 'Coffee' };
const subject = storedSubject({ category: 'media', label: 'Terracotta head vessel sculpture' });
const entity = (description: string, tags = [sculpture, documentary]) => ({
  entity_id: 'documentary-fixture', name: 'Fixture Film', types: [movie], tags, properties: { description },
});

describe('candidate-owned documentary content evidence', () => {
  it.each(['Terracotta head figurine', 'Marble figure sculpture', 'Carved stone bust'])('supports an unclassified explicit art form: %s', (label) => {
    const art = storedSubject({ category: 'other', label });
    expect(documentaryTopic(art)).toMatchObject({ name: 'sculpture', claim: { slot: 'label', name: label } });
    expect(admitDiscovery([art], entity('The documentary profiles a sculptor.'), movie, { requireContent: true })?.relation).toBe('about_subject');
    expect(admitDiscovery([art], entity('A sculpture appears in the background.'), movie, { requireContent: true })).toBeNull();
    expect(admitDiscovery([art], { ...entity('The film profiles a sculptor.'), types: ['urn:entity:brand'] }, 'urn:entity:brand')).toBeNull();
  });

  it.each(['Clay object', 'Sculptural lamp', 'Ceramic mug', 'Human head', 'Stone wall'])('does not turn an unclassified object into sculpture: %s', (label) => {
    expect(documentaryTopic(storedSubject({ category: 'other', label, aesthetics: [storedAesthetic('Sculpture')] }))).toBeNull();
  });

  it.each(['Sunroom dining nook', 'Galley kitchen'])('recognizes compound room nouns: %s', (label) => {
    expect(documentaryTopic(storedSubject({ category: 'interior', label }))).toMatchObject({ name: 'architecture', claim: { slot: 'label', name: label } });
  });

  it('keeps an exact returned excerpt and does not pretend it is a visual or tag match', () => {
    const description = 'The documentary profiles British sculptor Andy Goldsworthy and his ephemeral works made from natural materials.';
    const proof = admitDiscovery([subject], entity(description), movie, { queryId: 'query-fixture', requireContent: true })!;
    expect(proof).toMatchObject({
      relation: 'about_subject', sourceQueryId: 'query-fixture',
      claim: { slot: 'label', name: 'Sculptural object' },
      contentEvidence: { field: 'description', excerpt: description, topic: 'sculpture', documentaryTag: { id: documentary.id } },
    });
    expect(proofIsActive(proof, [subject])).toBe(true);
    expect(discoveryReason(proof, movie)).toContain('sculptural object form');
    expect(discoveryReason(proof, movie)).toContain('photo');
    expect(discoveryReason(proof, movie)).not.toMatch(/tagged|looks like|shares.*style/i);
  });

  it.each([
    ['', [sculpture, documentary]],
    ['The film profiles a sculptor.', [sculpture]],
    ['The documentary follows a murder trial involving a sculptor.', [sculpture, documentary]],
    ['A documentary includes a sculpture in the background.', [sculpture, documentary]],
    ['The film explores a crime; a sculpture appears incidentally.', [sculpture, documentary]],
    ['The documentary is not about sculpture.', [sculpture, documentary]],
    ['A sculpture is visible. The film explores a family reunion.', [sculpture, documentary]],
    ['The film explores family relationships; a sculpture appears in a house.', [sculpture, documentary]],
    ['The film explores several crafts, including sculpture.', [sculpture, documentary]],
  ] as const)('rejects missing or incidental support: %s', (description, tags) => {
    expect(admitDiscovery([subject], entity(description, [...tags]), movie, { requireContent: true })).toBeNull();
  });

  it('requires the requested tag and correct target type even with a strong excerpt', () => {
    const film = entity('The film profiles a sculptor and explores his process.');
    expect(admitDiscovery([subject], film, movie, { tagIds: new Set([coffee.id]), requireContent: true })).toBeNull();
    expect(admitDiscovery([subject], { ...film, types: ['urn:entity:brand'] }, movie)).toBeNull();
    expect(admitDiscovery([subject], film, movie, { excludedIds: new Set([film.entity_id]) })).toBeNull();
    expect(admitDiscovery([subject], film, movie, { subjectIds: new Set(['other-subject']) })).toBeNull();
  });

  it('distinguishes coffee production from a crime documentary with a coffee title', () => {
    const drink = storedSubject({ category: 'food', label: 'Espresso in a ceramic cup' });
    const positive = entity('The film interviews growers and roasters to highlight the processes of specialty coffee.', [coffee, documentary]);
    expect(admitDiscovery([drink], positive, movie, { requireContent: true })?.contentEvidence?.topic).toBe('coffee');
    const negative = entity('The documentary examines the trial and conviction following a suspicious death.', [coffee, documentary]);
    expect(admitDiscovery([drink], { ...negative, name: 'Murder and Coffee' }, movie, { requireContent: true })).toBeNull();
  });

  it('does not widen content retrieval using held or retracted claims', () => {
    const base = storedSubject({ category: 'media', label: 'Decorative object' });
    for (const flags of [{ held: true }, { retracted: true }]) {
      const hidden = { ...base, aesthetics: [storedAesthetic('Sculpture', flags)] };
      expect(documentaryTopic(hidden)).toBeNull();
      expect(documentaryEvidence(hidden, entity('The film profiles a sculptor.'))).toBeNull();
    }
    expect(documentaryTopic(storedSubject({ category: 'fashion', label: 'Sculptural jacket' }))?.name).toBe('fashion_design');
  });

  it('uses bounded short descriptions and preserves the depicted thing over a material', () => {
    const film = { ...entity(''), properties: { short_description: 'The film profiles a sculptor.' } };
    expect(documentaryEvidence(subject, film)).toMatchObject({ field: 'short_description', topic: 'sculpture' });
    expect(documentaryEvidence(subject, entity('The film profiles a sculptor. ' + 'x'.repeat(20_001)))).toBeNull();
  });

  it('admits a typed narrative tennis film only with an actual topic tag and substantive content', () => {
    const racket = storedSubject({ category: 'fashion', label: 'Tennis racket' });
    const tennis = { id: 'urn:tag:keyword:qloo:tennis', name: 'Tennis' };
    const description = 'The film follows Richard Williams as he trains his daughters Venus and Serena to become tennis champions.';
    const film = { ...entity(description, [tennis]), name: 'King Richard' };
    const topicPlan = planConnectionTopics([racket])[0]!;
    const proof = admitDiscovery([racket], film, movie, { topicPlan, tagIds: new Set([tennis.id]) })!;
    expect(proof.contentEvidence).toMatchObject({ kind: 'topic_film', excerpt: description, topicTag: { id: tennis.id }, topicPlanKey: 'tennis' });
    expect(proof.contentEvidence?.documentaryTag).toBeUndefined();
    expect(proof.candidateTags).toEqual([{ id: tennis.id, label: tennis.name }]);
    expect(discoveryReason(proof, movie)).toMatch(/^Film on tennis/);
    expect(discoveryReason(proof, movie)).not.toMatch(/documentary|matches|made by/i);
    expect(admitDiscovery([racket], { ...film, tags: [] }, movie, { topicPlan })).toBeNull();
    expect(admitDiscovery([racket], { ...film, types: ['urn:entity:tv_show'] }, 'urn:entity:tv_show', { topicPlan })).toBeNull();
    expect(admitDiscovery([racket], entity('Tennis appears in the background.', [tennis]), movie)).toBeNull();
    expect(admitDiscovery([racket], film, movie, { topicPlan, subjectIds: new Set(['other']) })).toBeNull();
    expect(admitDiscovery([racket], film, movie, { topicPlan, tagIds: new Set([coffee.id]) })).toBeNull();
  });

  it('ramen requires noodle-specific primary content, not general French cookery', () => {
    const ramen = storedSubject({ category: 'food', label: 'Tonkotsu ramen bowl' });
    const culinary = { id: 'urn:tag:theme:qloo:cooking', name: 'Cooking' };
    const noodles = { id: 'urn:tag:keyword:qloo:noodles', name: 'Noodles' };
    const positive = entity('The documentary follows a ramen chef and explores the craft of noodle preparation.', [noodles, documentary]);
    const proof = admitDiscovery([ramen], positive, movie)!;
    expect(proof.contentEvidence?.topic).toBe('noodles');
    expect(discoveryReason(proof, movie)).toContain('noodle dish appearance');
    expect(discoveryReason(proof, movie)).not.toMatch(/tonkotsu|broth|pork/i);
    for (const description of [
      'The documentary follows a French chef and explores cooking with garlic.',
      'The documentary explores culinary traditions and the art of cooking.',
      'The documentary explores philosophy through vignettes of chefs, musicians and carpenters making things, including noodles.',
      'The film follows a chef cooking ramen in a brief vignette.',
    ]) {
      const film = entity(description, [noodles, culinary, documentary]);
      expect(admitDiscovery([ramen], film, movie)).toBeNull();
      expect(admitDiscovery([ramen], film, movie, { requireContent: true })).toBeNull();
    }
  });

  it('does not let broad about-subject tags bypass missing, incidental or mixed-practice content', () => {
    const topics = [
      storedSubject({ category: 'interior', label: 'Room' }),
      storedSubject({ category: 'interior', label: 'Ceramic bowl' }),
      storedSubject({ category: 'food', label: 'Ramen' }),
    ];
    const tags = ['Architecture', 'Pottery', 'Cooking'].map((name) => ({ id: `urn:tag:theme:qloo:${name.toLowerCase()}`, name }));
    for (const source of topics)
      expect(admitDiscovery([source], entity('', [...tags, documentary]), movie)).toBeNull();
    const mixed = 'The documentary explores philosophy and skilled practice through chefs, musicians, carpenters and sculptors.';
    expect(admitDiscovery([subject], entity(mixed), movie)).toBeNull();
  });

  it('rejects the retained Being in the World mixed-practice excerpt for a noodle dish', () => {
    // Exact retained description from the frozen p012 packet, not a usefulness label.
    const description = 'The film visits philosophers influenced by Martin Heidegger alongside musicians, chefs, athletes, and craftsmen, using short vignettes and interviews to show how embodied skill and creative routines reveal meaning.';
    const film = entity(description, [
      { id: 'urn:tag:subgenre:qloo:music_documentary', name: 'Music documentary' },
      { id: 'urn:tag:theme:qloo:cooking', name: 'Cooking' },
    ]);
    const source = storedSubject({ category: 'food', label: 'Tonkotsu ramen bowl' });
    expect(admitDiscovery([source], film, movie)).toBeNull();
    expect(admitDiscovery([source], film, movie, { requireContent: true })).toBeNull();
  });

  it('a stale or forged plan cannot redirect content admission or fall back to taste', () => {
    const source = storedSubject({ label: 'Jacket', aesthetics: [storedAesthetic('Tennis', { wording: 'resembles' })] });
    const topicPlan = planConnectionTopics([source])[0]!;
    const film = entity('The film follows a tennis player through training.');
    const options = { topicPlan, taste: { queryId: 'q', requestSeedIds: ['seed'], seeds: [{ id: 'seed', name: 'Seed', subjectId: source.id }] } };
    expect(admitDiscovery([{ ...source, aesthetics: [] }], film, movie, options)).toBeNull();
    expect(admitDiscovery([source], film, movie, { ...options, topicPlan: { ...topicPlan, claim: { ...topicPlan.claim, wording: 'asserted' } } })).toBeNull();
    const proof = admitDiscovery([source], film, movie, options)!;
    expect(proofIsActive(proof, [source])).toBe(true);
    expect(proofIsActive(proof, [{ ...source, aesthetics: [storedAesthetic('Tennis', { wording: 'asserted' })] }])).toBe(false);
    expect(proofIsActive(proof, [{ ...source, aesthetics: [storedAesthetic('Tennis', { wording: 'resembles', basis: 'context' })] }])).toBe(false);
  });

  it('does not cherry-pick a focused short description out of mixed-practice content', () => {
    const film = { ...entity('The documentary explores philosophy through chefs, carpenters, musicians and sculptors.'),
      properties: {
        description: 'The documentary explores philosophy through chefs, carpenters, musicians and sculptors.',
        short_description: 'The film profiles a sculptor.',
      } };
    expect(admitDiscovery([subject], film, movie)).toBeNull();
    expect(admitDiscovery([subject], entity('The film profiles a sculptor.', [{ id: documentary.id, name: 'Non-documentary' }]), movie)).toBeNull();
  });
});
