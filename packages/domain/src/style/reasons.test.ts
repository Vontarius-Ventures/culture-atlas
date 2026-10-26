import { describe, expect, it } from 'vitest';
import type { AcceptedTag } from './map-tags';
import { selectExemplars } from './exemplars';
import { REASON_MAX_CHARS, buildStyleReason, reasonAttributes, sharedClaims } from './reasons';
import { storedAesthetic, storedSubject } from './test-support';

const tag = (id: string, claimName: string, over: Partial<AcceptedTag> = {}): AcceptedTag => ({ id, slot: 'aesthetics', claimName, wording: 'asserted', weight: 1, primary: true, use: 'filter', ...over });
const accepted: AcceptedTag[] = [
  tag('urn:tag:fashion_segment:qloo:workwear', 'Workwear'),
  tag('urn:tag:personal_style:qloo:workwear', 'Workwear', { primary: false, use: 'reason' }),
  tag('urn:tag:material:qloo:canvas', 'duck canvas', { slot: 'materials', weight: 0.6, use: 'signal' }),
  tag('urn:tag:design_inspiration:qloo:american_heritage', 'American heritage', { slot: 'lineage', weight: 0.4, wording: 'resembles', use: 'signal' }),
];

describe('per-card reasons from real overlap only (style design §C.4, sr-1)', () => {
  it('revalidates cached overlaps against active source claims, including era', () => {
    const cached = [
      tag('work', 'Workwear'),
      tag('heritage', 'American heritage', { slot: 'lineage' }),
      tag('era', '1970s', { slot: 'era' }),
      tag('classic', 'Classic'),
    ];
    const subject = storedSubject({
      aesthetics: [storedAesthetic('Workwear', { held: true }), storedAesthetic('Classic')],
      lineage: [storedAesthetic('American heritage', { retracted: true })],
      era: { ...storedAesthetic('1970s', { retracted: true }), cue: 'cut' },
    });
    const ids = cached.map((c) => c.id);
    expect(sharedClaims(cached, ids, subject).map((c) => c.name)).toEqual(['Classic']);
    const reason = buildStyleReason({ claims: sharedClaims(cached, ids), subject, palette: [], via: 'overlap' });
    expect(reason).toBe('Because of the classic look');
    expect(buildStyleReason({ claims: sharedClaims(cached.slice(0, 3), ids), subject, palette: [], via: 'overlap' })).toBeNull();
    const denim = storedSubject({
      aesthetics: [storedAesthetic('Classic denim', { held: true })],
      materials: [{ ...storedAesthetic('Denim'), texture: 'twill' }],
    });
    expect(sharedClaims([tag('a', 'Classic denim'), tag('b', 'Denim', { slot: 'materials', weight: 0.6 })], ['a', 'b'], denim).map((c) => c.name)).toEqual(['Denim']);
  });
  it('names only the claims whose accepted tags are on the result, strongest slot first, once each', () => {
    const claims = sharedClaims(accepted, ['urn:tag:material:qloo:canvas', 'urn:tag:personal_style:qloo:workwear', 'urn:tag:keyword:qloo:boots']);
    expect(claims.map((c) => c.name)).toEqual(['Workwear', 'duck canvas']);
    expect(sharedClaims(accepted, ['urn:tag:keyword:qloo:boots'])).toEqual([]);
  });

  it('chooses the template by wording and adds the palette only with a shared aesthetic', () => {
    const asserted = sharedClaims(accepted, ['urn:tag:fashion_segment:qloo:workwear', 'urn:tag:material:qloo:canvas']);
    expect(buildStyleReason({ claims: asserted, palette: ['Tobacco brown'], via: 'overlap' })).toBe('Because of the workwear look and duck canvas and the tobacco brown palette');
    const resembles = sharedClaims(accepted, ['urn:tag:fashion_segment:qloo:workwear', 'urn:tag:design_inspiration:qloo:american_heritage']);
    expect(buildStyleReason({ claims: resembles, palette: [], via: 'overlap' })).toBe('For the workwear and American heritage look your photo resembles');
    const materialOnly = sharedClaims(accepted, ['urn:tag:material:qloo:canvas']);
    expect(buildStyleReason({ claims: materialOnly, palette: ['Tobacco brown'], via: 'overlap' })).toBe('Because of the duck canvas');
  });

  it('falls back to the identified entity, else says nothing (never a guessed reason)', () => {
    expect(buildStyleReason({ claims: [], palette: [], via: 'entity', entityName: 'Carhartt' })).toBe('Connected to Carhartt in your photo.');
    expect(buildStyleReason({ claims: [], palette: ['brown'], via: 'exemplar' })).toBeNull();
  });

  it('the bridge template names the bridge and the shared claim', () => {
    const claims = sharedClaims(accepted, ['urn:tag:fashion_segment:qloo:workwear']);
    expect(buildStyleReason({ claims, palette: [], via: 'bridge', bridgeName: 'Filson' })).toBe('Linked through Filson, which shares the workwear look');
  });

  it('stays within 90 characters: drops the palette, then the second claim', () => {
    const long: AcceptedTag[] = [tag('a', 'Extraordinarily ornamented baroque revival'), tag('b', 'Hand-loomed silk brocade weave', { slot: 'materials', weight: 0.6 })];
    const reason = buildStyleReason({ claims: sharedClaims(long, ['a', 'b']), palette: ['antique gold', 'oxblood red'], via: 'overlap' })!;
    expect(reason.length).toBeLessThanOrEqual(REASON_MAX_CHARS);
    expect(reason).not.toContain('palette');
    expect(reason.startsWith('Because of the extraordinarily ornamented baroque revival look')).toBe(true);
  });

  it('a claim already inside a stronger claim adds nothing ("classic denim" and "denim")', () => {
    const t: AcceptedTag[] = [tag('a', 'Classic denim', { wording: 'resembles' }), tag('b', 'Denim', { slot: 'materials', weight: 0.6 })];
    expect(sharedClaims(t, ['a', 'b']).map((c) => c.name)).toEqual(['Classic denim']);
  });

  it('property: no reason ever names an attribute outside the real overlap (M-R3 = 1.0)', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const names = ['Workwear', 'Japandi', 'linen', 'Art deco', 'velvet', 'Boho', 'Mid-century modern', 'raw denim'];
    for (let i = 0; i < 300; i++) {
      const acc: AcceptedTag[] = names.map((n, j) => tag(`t${j}`, n, { slot: j % 3 === 0 ? 'materials' : 'aesthetics', wording: rand() > 0.5 ? 'asserted' : 'resembles', weight: j % 3 === 0 ? 0.6 : 1 }));
      const resultTags = acc.filter(() => rand() > 0.6).map((a) => a.id);
      const claims = sharedClaims(acc, resultTags);
      const reason = buildStyleReason({ claims, palette: rand() > 0.5 ? ['oat'] : [], via: 'overlap' });
      const overlap = new Set(acc.filter((a) => resultTags.includes(a.id)).map((a) => a.claimName.toLowerCase()));
      for (const n of names) if (reason?.toLowerCase().includes(n.toLowerCase()) && !names.some((o) => o !== n && o.toLowerCase().includes(n.toLowerCase()))) expect(overlap.has(n.toLowerCase()), `${reason} / ${n}`).toBe(true);
      for (const a of reasonAttributes(reason, claims)) expect(overlap.has(a.toLowerCase())).toBe(true);
    }
  });
});

describe('exemplar anchors (style design R-1)', () => {
  const brands = [
    { id: 'B1', name: 'One', popularity: 0.99, style_tag_ids: ['F', 'm1', 'x'], price_level: '$$' },
    { id: 'B2', name: 'Two', popularity: 0.95, style_tag_ids: ['F', 'm1', 'l1'], price_level: '$$' },
    { id: 'B3', name: 'Three', popularity: 0.7, style_tag_ids: ['F', 'm1', 'l1'], price_level: '$$' },
    { id: 'B4', name: 'Four', popularity: 0.99, style_tag_ids: ['m1', 'l1'], price_level: '$$' },
    { id: 'B5', name: 'Five', popularity: 0.9, style_tag_ids: ['F'], price_level: '$$' },
  ];
  const acc: AcceptedTag[] = [tag('F', 'Workwear'), tag('m1', 'canvas', { slot: 'materials', weight: 0.6 }), tag('l1', 'heritage', { slot: 'lineage', weight: 0.4 })];

  it('qualifies only brands with F, >= 2 accepted tags and popularity >= 0.8; deterministic by score then popularity', () => {
    const picked = selectExemplars(brands, acc, 'F');
    expect(picked.map((b) => b.id)).toEqual(['B2', 'B1']);
    expect(selectExemplars(brands, acc, 'F')).toEqual(picked);
    expect(selectExemplars(brands, acc, 'F', { exclude: new Set(['B2']) }).map((b) => b.id)).toEqual(['B1']);
  });

  it('every exemplar comes from the recorded matrix and carries the required tag', () => {
    for (const e of selectExemplars(brands, acc, 'F')) {
      expect(brands.some((b) => b.id === e.id)).toBe(true);
      expect(e.shared).toContain('F');
    }
  });
});
