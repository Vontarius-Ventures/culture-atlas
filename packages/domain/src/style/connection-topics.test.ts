import { describe, expect, it } from 'vitest';
import { activeConnectionTopicPlan, planConnectionTopics } from './connection-topics';
import { storedAesthetic, storedSubject } from './test-support';

describe('bounded source-bound Connections topic plans', () => {
  it.each([
    ['fashion', 'Tennis racket', 'tennis'],
    ['fashion', 'Tennis outfit', 'tennis'],
    ['fashion', 'Canvas sneakers', 'sneaker_culture'],
    ['fashion', 'Tailored suit', 'tailoring'],
    ['fashion', 'Sculptural jacket', 'fashion_design'],
    ['interior', 'Ceramic bowl', 'pottery'],
    ['other', 'Terracotta head sculpture', 'sculpture'],
    ['interior', 'Four-poster bed', 'furniture'],
    ['interior', 'Abandoned motel bedroom', 'abandoned_buildings'],
    ['food', 'Tonkotsu ramen bowl', 'noodles'],
    ['food', 'Espresso cup', 'coffee'],
    ['place', 'Architectural facade', 'architecture'],
  ] as const)('%s / %s opens only an explicit topic', (category, label, key) => {
    const subject = storedSubject({ category, label });
    expect(planConnectionTopics([subject])[0]).toMatchObject({ key, subjectId: subject.id, claim: { slot: 'label', name: label } });
  });

  it('does not manufacture coffee from cafe furniture or sculpture from a jacket', () => {
    expect(planConnectionTopics([storedSubject({ category: 'interior', label: 'Cafe furniture' })]).map((p) => p.key)).toEqual(['furniture']);
    expect(planConnectionTopics([storedSubject({ category: 'fashion', label: 'Sculptural jacket' })]).map((p) => p.key)).toEqual(['fashion_design']);
    expect(planConnectionTopics([storedSubject({ category: 'fashion', label: 'Architectural dress' })]).map((p) => p.key)).toEqual(['fashion_design']);
    expect(planConnectionTopics([storedSubject({ category: 'place', label: 'Cafe' })])).toEqual([]);
  });

  it('retains the original claim but public cues do not assert composition or broth identity', () => {
    const source = storedSubject({ category: 'food', label: 'Tonkotsu ramen with pork broth' });
    const plan = planConnectionTopics([source])[0]!;
    expect(plan.claim.name).toBe(source.label);
    expect(plan.sourceCue).toBe('noodle dish appearance');
    expect(plan.tagQuery).toBe('noodles');
    expect(plan.sourceCue).not.toMatch(/tonkotsu|pork|broth/i);
    const garment = planConnectionTopics([storedSubject({ label: 'Leather canvas jacket' })])[0]!;
    expect(garment.sourceCue).not.toMatch(/leather|canvas/i);
  });

  it.each([{ held: true }, { retracted: true }, { basis: 'context' as const }])('cannot open a topic from an inactive/context claim %j', (flags) => {
    const subject = storedSubject({ category: 'media', label: 'Decorative object', aesthetics: [storedAesthetic('Sculpture', flags)] });
    expect(planConnectionTopics([subject])).toEqual([]);
  });

  it('returns at most two deterministic distinct topics and gives distinct subjects a turn', () => {
    const art = storedSubject({ id: 'art', category: 'media', label: 'Ceramic sculpture' });
    const tennis = storedSubject({ id: 'racket', category: 'fashion', label: 'Tennis racket' });
    const plans = planConnectionTopics([art, tennis, storedSubject({ category: 'food', label: 'Ramen' })]);
    expect(plans.map((p) => [p.subjectId, p.key])).toEqual([['art', 'sculpture'], ['racket', 'tennis']]);
    expect(planConnectionTopics([art, tennis])).toEqual(plans);
  });

  it('does not trust a supplied forged, stale, or wrong-subject plan', () => {
    const subject = storedSubject({ label: 'Jacket', aesthetics: [storedAesthetic('Tennis culture', { wording: 'resembles' })] });
    const plan = planConnectionTopics([subject])[0]!;
    expect(plan.claim).toEqual({ slot: 'aesthetics', name: 'Tennis culture', wording: 'resembles' });
    expect(activeConnectionTopicPlan(subject, plan)).toEqual(plan);
    for (const change of [{ subjectId: 'other' }, { tagQuery: 'crime' }, { sourceCue: 'Leather composition' }, { requiresDocumentary: true }])
      expect(activeConnectionTopicPlan(subject, { ...plan, ...change })).toBeNull();
    expect(activeConnectionTopicPlan({ ...subject, aesthetics: [] }, plan)).toBeNull();
  });
});
