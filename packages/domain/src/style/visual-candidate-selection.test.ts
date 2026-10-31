import { describe, expect, it } from 'vitest';
import { storedAesthetic, storedSubject } from './test-support';
import { syntheticVisualReading } from './visual-test-support';
import type { StoredClaim, StoredSubject } from './types';
import type { LoadedVisualCatalog, VisualCatalogObject } from './visual-catalog';
import { eligibleVisualSubjects, selectVisualCandidates, VISUAL_CANDIDATE_SELECTION_POLICY_VERSION } from './visual-candidate-selection';
import { shortlistVisualCandidates } from './visual-references';

/** Synthetic metadata only: these tests make no image-quality or human-label claim. */
type SyntheticObject = Extract<VisualCatalogObject, { is_public_domain: true }>;
function item(id: number, object_type = 'Chair', title = object_type, medium = ''): SyntheticObject {
  return {
    id: `met:${id}`, object_type, title, medium, institution: 'SYNTHETIC',
    object_date: '', source_url: `https://www.metmuseum.org/art/collection/search/${id}`,
    image_url: 'https://images.metmuseum.org/synthetic.jpg', license: 'CC0', is_public_domain: true,
    image_path: `${id}.jpg`, image_sha256: 'a'.repeat(64), width: 1, height: 1, tags: [],
    retrieved_at: '2026-10-27T00:00:00Z',
  };
}
function catalog(objects: SyntheticObject[]): LoadedVisualCatalog {
  return {
    hash: 'b'.repeat(64),
    catalog: {
      schema_version: 'atlas_visual_catalog_v1', catalog_version: 'synthetic',
      generated_at: '2026-10-27T00:00:00Z', asset_root: '/tmp/synthetic-not-read',
      acquisition_status: 'partial', objects,
    },
  };
}
function reading(label = 'Chair', category: StoredSubject['category'] = 'interior') {
  const r = syntheticVisualReading();
  r.subjects[0]!.label = label;
  r.subjects[0]!.category = category;
  return r;
}
function material(name: string, patch: Partial<StoredClaim> = {}) {
  return { ...storedAesthetic(name), texture: '', ...patch };
}
function construction(name: string, patch: Partial<StoredClaim> = {}) {
  return { ...storedAesthetic(name), kind: '', ...patch };
}
function detail(name: string, patch: Partial<StoredClaim> = {}) {
  return { ...storedAesthetic(name), text: '', ...patch };
}
const ids = (result: ReturnType<typeof selectVisualCandidates>) => result.candidates.map(c => c.catalog_id);

describe('versioned whole-object visual candidate retrieval', () => {
  it('a lower-ID part cannot displace a whole chair and preserves the public shortlist shape', () => {
    const r = reading();
    const c = catalog([item(1, 'Chair fragment'), item(2, 'Chair', 'Chair fragment'), item(9)]);
    const result = selectVisualCandidates(r, c, 1);
    expect(ids(result)).toEqual(['met:9']);
    expect(result).toMatchObject({ policy_version: VISUAL_CANDIDATE_SELECTION_POLICY_VERSION, retrieval_only: true, limit: 1 });
    expect(result.diagnostics).toMatchObject([
      { catalog_id: 'met:1', admitted: false, reason: 'part_or_tool', exclusion: { field: 'object_type', term: 'fragment' }, rank: null },
      { catalog_id: 'met:2', admitted: false, reason: 'part_or_tool', exclusion: { field: 'title', term: 'fragment' }, rank: null },
      { catalog_id: 'met:9', admitted: true, reason: 'admitted', selected: true },
    ]);
    expect(shortlistVisualCandidates(r, c, 1)).toEqual(result.candidates);
    expect(Object.keys(result.candidates[0]!).sort()).toEqual(['catalog_id', 'image_hash', 'region', 'subject_id', 'subject_label']);
  });

  it('uses actual object nouns, never ceramic/pottery material alone, for family admission', () => {
    const c = catalog([item(1, 'Ceramic sculpture'), item(2, 'Vase'), item(3, 'Ceramic'), item(4, 'Pottery')]);
    expect(ids(selectVisualCandidates(reading('Ceramic sculpture'), c, 2))).toEqual(['met:1']);
    const vase = selectVisualCandidates(reading('Ceramic vase'), c, 2);
    expect(ids(vase)).toEqual(['met:2']);
    expect(vase.diagnostics[0]).toMatchObject({ object_kind: 'sculpture', reason: 'family_mismatch' });
    expect(ids(selectVisualCandidates(reading('Pottery'), c, 2))).toEqual([]);
  });

  it.each([
    ['Chair fragment', 'Chair', 'part_or_tool'], ['Chair', 'Fragment of chair', 'part_or_tool'],
    ['Chair', 'Chair back', 'part_or_tool'], ['Chair', 'Chair leg', 'part_or_tool'],
    ['Chair', 'Chair seat', 'part_or_tool'], ['Vase', 'Vase handle', 'part_or_tool'],
    ['Chair', 'Back of a chair', 'part_or_tool'], ['Chair', 'Cover for chair', 'part_or_tool'],
    ['Vase', 'Lid from the vase', 'part_or_tool'], ['Vase', 'Fragmentary vase', 'part_or_tool'],
    ['Mold for statuette', 'Statuette', 'part_or_tool'], ['Statuette', 'Mould for a statuette', 'part_or_tool'],
    ['Print depicting vase', 'Vase', 'representation'], ['Vase', 'Print depicting vase', 'representation'],
    ['Sculpture', 'Engraving of Sculpture', 'representation'], ['Chair', 'Drawing of chair', 'representation'],
    ['Vase', 'Photograph of vase', 'representation'], ['Chair', 'Design for chair', 'representation'],
    ['Chair', 'Model of chair', 'representation'], ['Chair', 'Miniature chair', 'representation'],
  ])('excludes %s / %s before ranking', (type, title, reason) => {
    const r = reading(type.includes('statuette') || type === 'Statuette' ? 'Statuette' :
      type === 'Sculpture' ? 'Sculpture' : type.includes('Vase') || /vase/i.test(type) ? 'Vase' : 'Chair');
    const result = selectVisualCandidates(r, catalog([item(1, type, title, 'Carved wood bronze glazed')]), 2);
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics[0]).toMatchObject({ admitted: false, reason, rank: null, matched_features: [] });
  });

  it('does not confuse molded/cast construction with production molds or painted objects with paintings', () => {
    const c = catalog([item(1, 'Vases', 'Molded vase', 'Painted cast bronze')]);
    expect(ids(selectVisualCandidates(reading('Vase'), c, 2))).toEqual(['met:1']);
  });

  it.each(['Decorative arts', 'Furniture', 'Ceramics', 'Vase-like ornament', 'Chair and table', 'Seating furniture', 'Uncatalogued object'])(
    'abstains on unknown/ambiguous catalog taxonomy %s even when title is familiar', type => {
      const result = selectVisualCandidates(reading('Vase'), catalog([item(1, type, 'Vase')]), 2);
      expect(result.candidates).toEqual([]);
      expect(result.diagnostics[0]?.reason).toBe('unknown_object_type');
    },
  );
  it('does not repair unknown taxonomy with medium, title or tags, and retains empty/all-reject outcomes', () => {
    const unknown = item(1, 'Object', 'Chair', 'Wood chair');
    unknown.tags = ['Chair'];
    expect(selectVisualCandidates(reading(), catalog([unknown]), 2).candidates).toEqual([]);
    expect(selectVisualCandidates(reading(), catalog([]), 2).diagnostics).toEqual([]);
    expect(selectVisualCandidates(reading(), catalog([item(1, 'Vase')]), 2).candidates).toEqual([]);
    expect(selectVisualCandidates(reading('Chair or table'), catalog([item(1)]), 2).subjects[0]?.reason).toBe('unsupported_subject');
  });

  it('prefers exact normalized object kind before bounded feature agreement', () => {
    const r = reading('Ceramic vase');
    r.subjects[0]!.materials = [material('Bronze')];
    const c = catalog([item(1, 'Urn', 'Urn', 'Bronze'), item(9, 'Vases', 'Vase')]);
    const result = selectVisualCandidates(r, c, 2);
    expect(ids(result)).toEqual(['met:9', 'met:1']);
    expect(result.diagnostics.map(d => d.rank)).toEqual([
      { exact_kind: 0, feature_agreement: 1 }, { exact_kind: 1, feature_agreement: 0 },
    ]);
  });

  it('orders only admitted candidates by active visible material/construction/detail agreements', () => {
    const r = reading();
    r.subjects[0]!.materials = [material('Oak')];
    r.subjects[0]!.construction = [construction('Carved')];
    r.subjects[0]!.details = [detail('Fluted')];
    const result = selectVisualCandidates(r, catalog([
      item(1, 'Chair', 'Chair', 'Oak'), item(2, 'Chair', 'Fluted chair', 'Oak'),
      item(3, 'Chair', 'Chair', 'Carved oak, fluted'), item(4, 'Chair', 'Chair fragment', 'Carved oak, fluted'),
    ]), 2);
    expect(ids(result)).toEqual(['met:3', 'met:2']);
    expect(result.diagnostics[2]).toMatchObject({
      rank: { exact_kind: 1, feature_agreement: 3 },
      matched_features: ['construction:carved', 'details:fluted', 'materials:oak'],
    });
    expect(result.diagnostics[3]).toMatchObject({ admitted: false, rank: null, matched_features: [] });
  });

  it.each([{ held: true }, { retracted: true }, { basis: 'context' as const }, { basis: 'read_text' as const }, { certainty: 0.34 }])(
    'ineligible evidence %j cannot affect ranking in any allowed slot', patch => {
      const r = reading();
      const c = catalog([item(1), item(9, 'Chair', 'Carved fluted chair', 'Bronze')]);
      const baseline = selectVisualCandidates(r, c, 2);
      r.subjects[0]!.materials = [material('Bronze', patch)];
      r.subjects[0]!.construction = [construction('Carved', patch)];
      r.subjects[0]!.details = [detail('Fluted', patch)];
      expect(selectVisualCandidates(r, c, 2)).toEqual(baseline);
    },
  );

  it('never ranks by aesthetics, era, lineage, brand, entity, labels, display or cultural/style metadata', () => {
    const r = reading('Bronze carved fluted chair');
    const s = r.subjects[0]!;
    const c = catalog([item(1), item(9, 'Chair', 'Baroque chair by Maker', 'Bronze carved fluted')]);
    const baseline = selectVisualCandidates(r, c, 2);
    s.aesthetics = [storedAesthetic('Bronze carved fluted Baroque')];
    s.era = { ...storedAesthetic('Bronze carved fluted'), cue: 'Baroque' };
    s.lineage = [storedAesthetic('Bronze carved fluted')];
    s.mood = [storedAesthetic('Bronze carved fluted')];
    s.brand = { name: 'Bronze carved fluted', read_text: 'Maker' };
    s.entity = { id: 'Maker', name: 'Bronze carved fluted', types: [] };
    s.qloo_links = ['Bronze carved fluted'];
    s.materials = [material('Unknown', { display: 'Bronze carved fluted' })];
    expect(selectVisualCandidates(r, c, 2)).toEqual(baseline);
    c.catalog.objects[1]!.tags = ['Bronze', 'carved', 'fluted'];
    c.catalog.objects[1]!.object_date = 'Bronze';
    c.catalog.objects[1]!.institution = 'Carved fluted';
    c.catalog.objects[1]!.title = 'Chair';
    c.catalog.objects[1]!.medium = '';
    expect(ids(selectVisualCandidates(r, c, 2))).toEqual(['met:1', 'met:9']);
  });

  it('uses actual slot payload evidence, ignores repeated terms, and caps feature rank at three', () => {
    const r = reading();
    r.subjects[0]!.materials = [{ ...material('Unknown'), texture: 'Oak bronze' }, material('Oak')];
    r.subjects[0]!.construction = [{ ...construction('Unknown'), kind: 'Carved' }];
    r.subjects[0]!.details = [{ ...detail('Unknown'), text: 'Fluted' }];
    const result = selectVisualCandidates(r, catalog([
      item(1, 'Chair', 'Fluted chair', 'Carved oak bronze'), item(9, 'Chair', 'Chair', 'Carved oak bronze oak oak'),
    ]), 2);
    expect(result.diagnostics.map(d => d.rank?.feature_agreement)).toEqual([3, 3]);
    expect(result.diagnostics[0]?.matched_features).toHaveLength(4);
    expect(ids(result)).toEqual(['met:1', 'met:9']);
  });

  it('abstains on negated/comparative feature text rather than rewarding the mentioned material', () => {
    for (const name of ['not bronze', 'without bronze', 'faux bronze', 'bronze style', 'after bronze']) {
      const r = reading();
      r.subjects[0]!.materials = [material(name)];
      expect(ids(selectVisualCandidates(r, catalog([item(1), item(9, 'Chair', 'Chair', 'Bronze')]), 1))).toEqual(['met:1']);
    }
    const r = reading();
    r.subjects[0]!.materials = [material('Bronze')];
    expect(ids(selectVisualCandidates(r, catalog([item(1), item(9, 'Chair', 'Chair', 'Not bronze')]), 1))).toEqual(['met:1']);
  });

  it('is permutation-invariant, uses deterministic ID ties and never mutates the reading/catalog', () => {
    const r = reading();
    const objects = [item(2), item(10), item(3)];
    const before = JSON.stringify({ r, objects });
    const baseline = selectVisualCandidates(r, catalog(objects), 2);
    for (const order of [objects, [...objects].reverse(), [objects[1]!, objects[2]!, objects[0]!]]) {
      expect(selectVisualCandidates(r, catalog(order), 2)).toEqual(baseline);
    }
    expect(ids(baseline)).toEqual(['met:10', 'met:2']); // Codepoint ID tie, not locale-dependent.
    expect(JSON.stringify({ r, objects })).toBe(before);
  });

  it.each([0, 1, 2, 999, -1, 1.9, Number.NaN])('bounds one-subject shortlist for limit %s', limit => {
    const result = selectVisualCandidates(reading(), catalog([item(1), item(2), item(3)]), limit);
    const length = Number.isNaN(limit) ? 0 : Math.min(2, Math.max(0, Math.floor(limit)));
    expect(result.candidates).toHaveLength(length);
    expect(result.diagnostics.filter(d => d.selected)).toHaveLength(length);
  });

  it.each([0, 1, 2])('round-robins two subject relations with limit %s, including shared image/item identity', limit => {
    const r = reading();
    r.subjects.push(storedSubject({ ...r.subjects[0]!, id: 's2' }));
    const result = selectVisualCandidates(r, catalog([item(1), item(2)]), limit);
    expect(result.candidates.map(c => [c.subject_id, c.catalog_id])).toEqual(
      [['s1', 'met:1'], ['s2', 'met:1']].slice(0, limit),
    );
  });

  it('fills the second slot for the compatible subject but never uses more than the first two subjects', () => {
    const r = reading('Vase');
    r.subjects.push(storedSubject({ ...r.subjects[0]!, id: 's2', label: 'Chair' }));
    r.subjects.push(storedSubject({ ...r.subjects[0]!, id: 's3', label: 'Chair' }));
    expect(selectVisualCandidates(r, catalog([item(1), item(2), item(3)]), 999).candidates.map(c => c.subject_id)).toEqual(['s2', 's2']);
  });

  it('preserves category/person/region/subject-hold/retraction and active visible evidence guards', () => {
    const patches: ((s: StoredSubject) => void)[] = [
      s => { s.category = 'fashion'; }, s => { s.label = 'Woman beside chair'; },
      s => { s.label = 'Print depicting chair'; }, s => { s.id = 's3'; },
      s => { s.region = { x: 0.9, y: 0, w: 0.5, h: 1 }; },
      s => { s.aesthetics[0]!.held = true; }, s => { s.aesthetics[0]!.retracted = true; },
      s => { s.aesthetics[0]!.basis = 'context'; }, s => { s.aesthetics[0]!.certainty = 0.34; },
    ];
    for (const patch of patches) {
      const r = reading(); patch(r.subjects[0]!);
      expect(eligibleVisualSubjects(r)).toEqual([]);
      expect(selectVisualCandidates(r, catalog([item(1)]), 2).candidates).toEqual([]);
    }
    for (const path of ['s1', 'subjects.s1']) {
      const held = reading(); held.held.push({ path, rule: 'synthetic' });
      expect(eligibleVisualSubjects(held)).toEqual([]);
      const retracted = reading(); retracted.retracted.push(path);
      expect(eligibleVisualSubjects(retracted)).toEqual([]);
    }
    const threshold = reading(); threshold.subjects[0]!.aesthetics[0]!.certainty = 0.35;
    expect(eligibleVisualSubjects(threshold)).toHaveLength(1);
  });
});

describe('v3 clothing, footwear, bed and actual interior-scene supply support', () => {
  it.each([
    ['Clothing ensemble', 'Outfit', 'outfit'], ['Outfit', 'Clothing ensembles', 'outfit'],
    ['Denim jacket', 'Jackets', 'jacket'], ['Blazer', 'Jacket', 'jacket'],
    ['Trench coat', 'Coats', 'coat'], ['Wool overcoat', 'Coat', 'coat'],
    ['Cotton T-shirt', 'T shirts', 'shirt'], ['Button-down shirt', 'Shirt', 'shirt'],
    ['Blouse', 'Shirt', 'shirt'], ['Wool cardigan', 'Sweater', 'sweater'],
    ['Knitted pullover', 'Sweaters', 'sweater'], ['Hoodie', 'Sweatshirt', 'sweater'],
    ['Leather shoes', 'Shoes', 'shoe'], ['Ankle boots', 'Boots', 'boot'],
    ['Sneakers', 'Trainers', 'sneaker'], ['Athletic shoes', 'Sneaker', 'sneaker'],
  ])('admits guarded fashion noun %s against bounded catalog alias %s', (label, objectType, kind) => {
    const result = selectVisualCandidates(reading(label, 'fashion'), catalog([item(1, objectType)]), 1);
    expect(result.policy_version).toBe(VISUAL_CANDIDATE_SELECTION_POLICY_VERSION);
    expect(ids(result)).toEqual(['met:1']);
    expect(result.subjects[0]).toMatchObject({ reason: 'eligible', object_kind: kind, reference_kind: 'physical_object' });
    expect(result.diagnostics[0]).toMatchObject({ admitted: true, object_kind: kind, reference_kind: 'physical_object' });
  });

  it.each([
    ['Bed', 'Beds', 'bed'], ['Four-poster bed', 'Bedstead', 'bed'],
    ['Bedroom', 'Bedroom photo', 'bedroom'], ['Bedroom interior', 'Bedroom photograph', 'bedroom'],
    ['Room interior', 'Interior photo', 'interior'], ['Living room', 'Living room photograph', 'interior'],
  ])('admits guarded interior noun %s against %s', (label, objectType, kind) => {
    const result = selectVisualCandidates(reading(label), catalog([item(1, objectType)]), 1);
    expect(ids(result)).toEqual(['met:1']);
    expect(result.subjects[0]?.object_kind).toBe(kind);
    expect(result.diagnostics[0]?.reference_kind).toBe(kind === 'bed' ? 'physical_object' : 'scene');
  });

  it('recognizes explicit room-with-contents labels without guessing from arbitrary mixed nouns', () => {
    for (const label of ['Bedroom with bed', 'Bedroom interior featuring bed and chair', 'Living room containing chair and table']) {
      const result = selectVisualCandidates(reading(label), catalog([item(1, 'Interior photo')]), 1);
      expect(ids(result)).toEqual(['met:1']);
      expect(result.subjects[0]?.reference_kind).toBe('scene');
    }
    expect(eligibleVisualSubjects(reading('Bed in bedroom'))).toEqual([]);
    expect(eligibleVisualSubjects(reading('Chair or bedroom'))).toEqual([]);
  });

  it.each(['Person wearing a jacket', 'Woman in a coat', 'Man wearing sneakers', 'Clothing ensemble worn by a person', 'Model wearing an outfit'])(
    'still excludes person-labelled clothing subject %s', label => {
      const result = selectVisualCandidates(reading(label, 'fashion'), catalog([item(1, 'Outfit'), item(2, 'Jacket')]), 2);
      expect(result.candidates).toEqual([]);
      expect(result.subjects[0]?.reason).toBe('unsupported_subject');
    },
  );

  it('does not turn a fashion category, aesthetic name or retrieval-query hint into an object type', () => {
    for (const label of ['Fashion', 'Clothing', 'Streetwear', 'Minimalism', 'Unidentified item', 'Blue fabric']) {
      const r = reading(label, 'fashion');
      r.subjects[0]!.aesthetics = [storedAesthetic('Jacket outfit')];
      expect(eligibleVisualSubjects(r)).toEqual([]);
    }
    for (const objectType of ['Fashion', 'Clothing', 'Object', 'Photograph', 'Bedroom furniture']) {
      const unknown = item(1, objectType, 'Denim jacket in bedroom', 'Cotton');
      unknown.tags = ['retrieval-query:denim jacket', 'jacket', 'bedroom', 'interior photograph'];
      expect(selectVisualCandidates(reading('Jacket', 'fashion'), catalog([unknown]), 2).candidates).toEqual([]);
      expect(selectVisualCandidates(reading('Bedroom'), catalog([unknown]), 2).candidates).toEqual([]);
    }
  });

  it('keeps clothing, beds, outfit ensembles and room scenes in their own retrieval families', () => {
    const result = selectVisualCandidates(reading('Jacket', 'fashion'), catalog([
      item(1, 'Bed'), item(2, 'Bedroom photo'), item(3, 'Outfit'), item(4, 'Sneaker'), item(9, 'Jacket'),
    ]), 2);
    expect(ids(result)).toEqual(['met:9']);
    expect(result.diagnostics.slice(0, 4).map(d => d.reason)).toEqual([
      'family_mismatch', 'reference_kind_mismatch', 'family_mismatch', 'family_mismatch',
    ]);
    expect(eligibleVisualSubjects(reading('Bed', 'fashion'))).toEqual([]);
    expect(eligibleVisualSubjects(reading('Jacket', 'interior'))).toEqual([]);
  });

  it('room retrieval never consumes a vase, bed or printed depiction and admits only explicit scene taxonomy', () => {
    const result = selectVisualCandidates(reading('Bedroom'), catalog([
      item(1, 'Vase'), item(2, 'Print', 'Bedroom'), item(3, 'Bedroom photo', 'Print of bedroom'),
      item(4, 'Bed'), item(5, 'Interior photograph', 'Photograph of a living room'),
      item(9, 'Bedroom photograph', 'Bedroom photo'),
    ]), 2);
    expect(ids(result)).toEqual(['met:9', 'met:5']);
    expect(result.diagnostics.map(d => d.reason)).toEqual([
      'reference_kind_mismatch', 'representation', 'representation', 'reference_kind_mismatch', 'admitted', 'admitted',
    ]);
    expect(result.diagnostics[5]?.rank?.exact_kind).toBe(1);
  });

  it.each([
    ['Jacket', 'Print of jacket'], ['Jacket', 'Photograph of jacket'],
    ['Jacket', 'Jacket sleeve'], ['Shirt', 'Sewing pattern for shirt'],
    ['Sneaker', 'Sneaker sole'], ['Bed', 'Painting of bed'], ['Bed', 'Poster of four-poster bed'],
  ])('does not waive physical-object exclusions for %s / %s', (objectType, title) => {
    const category = objectType === 'Bed' ? 'interior' : 'fashion';
    const result = selectVisualCandidates(reading(objectType, category), catalog([item(1, objectType, title)]), 1);
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics[0]?.reason).toMatch(/part_or_tool|representation/);
  });

  it('retains mug/cup compatibility and exact mug preference, without requiring a vase fallback', () => {
    const result = selectVisualCandidates(reading('Ceramic coffee mug'), catalog([
      item(1, 'Cup'), item(2, 'Vase'), item(9, 'Mugs'),
    ]), 2);
    expect(ids(result)).toEqual(['met:9', 'met:1']);
    expect(result.subjects[0]?.object_kind).toBe('mug');
    expect(ids(selectVisualCandidates(reading('Tea cup'), catalog([item(1, 'Cup')]), 1))).toEqual(['met:1']);
  });

  it('credits new physical features only from active visible claim slots, never query tags or style terms', () => {
    const r = reading('Jacket', 'fashion');
    const s = r.subjects[0]!;
    const c = catalog([item(1, 'Jacket'), item(9, 'Jacket', 'Striped jacket', 'Knitted wool')]);
    const baseline = selectVisualCandidates(r, c, 2);
    for (const patch of [{ held: true }, { retracted: true }, { basis: 'context' as const }, { certainty: 0.34 }]) {
      s.materials = [material('Wool', patch)];
      s.construction = [construction('Knitted', patch)];
      s.details = [detail('Striped', patch)];
      expect(selectVisualCandidates(r, c, 2)).toEqual(baseline);
    }
    s.materials = [material('Wool')];
    s.construction = [construction('Knitted')];
    s.details = [detail('Striped')];
    expect(ids(selectVisualCandidates(r, c, 1))).toEqual(['met:9']);
    expect(selectVisualCandidates(r, c, 1).diagnostics[1]?.matched_features).toEqual([
      'construction:knitted', 'details:striped', 'materials:wool',
    ]);
    c.catalog.objects[0]!.tags = ['retrieval-query:striped knitted wool jacket'];
    expect(ids(selectVisualCandidates(r, c, 1))).toEqual(['met:9']);
  });

  it('preserves guarded region/evidence/hold/retraction checks for both new clothing and scenes', () => {
    for (const [label, category] of [['Outfit', 'fashion'], ['Bedroom', 'interior']] as const) {
      for (const path of ['s1', 'subjects.s1']) {
        const r = reading(label, category);
        r.held.push({ path, rule: 'synthetic' });
        expect(eligibleVisualSubjects(r)).toEqual([]);
        r.held = []; r.retracted.push(path);
        expect(eligibleVisualSubjects(r)).toEqual([]);
      }
      const r = reading(label, category);
      r.subjects[0]!.aesthetics[0]!.basis = 'context';
      expect(eligibleVisualSubjects(r)).toEqual([]);
      r.subjects[0]!.aesthetics[0]!.basis = 'visible';
      r.subjects[0]!.region.x = 2;
      expect(eligibleVisualSubjects(r)).toEqual([]);
    }
  });

  it.each([0, 1, 2])('round-robins clothing and scenes with deterministic namespace-independent ties at limit %s', limit => {
    const r = reading('Outfit', 'fashion');
    r.subjects.push(storedSubject({ ...reading('Bedroom').subjects[0]!, id: 's2' }));
    const a = item(1, 'Clothing ensemble'); a.id = 'commons:101';
    const b = item(2, 'Outfit'); b.id = 'commons:102';
    const scene = item(3, 'Bedroom photograph'); scene.id = 'commons:103';
    const objects = [b, scene, a];
    const before = JSON.stringify({ r, objects });
    const result = selectVisualCandidates(r, catalog(objects), limit);
    expect(result.candidates.map(c => [c.subject_id, c.catalog_id])).toEqual(
      [['s1', 'commons:101'], ['s2', 'commons:103']].slice(0, limit),
    );
    expect(selectVisualCandidates(r, catalog([...objects].reverse()), limit)).toEqual(result);
    expect(JSON.stringify({ r, objects })).toBe(before);
  });
});

describe('v4 explicit garment nouns, bounded scenes and functional drinkware compatibility', () => {
  it.each([
    ['Colour-block cropped tee', 'Tee', 'shirt'],
    ['Breton striped top', 'Top', 'top'],
    ['Black hybrid sneaker-shoes', 'Sneaker shoes', 'sneaker'],
    ['Ditsy floral dress', 'Dress', 'dress'],
    ['Tan leather crossbody bag', 'Handbag', 'bag'],
    ['Black suit with satin tie', 'Suit', 'suit'],
    ['Sequined bodice dress', 'Gown', 'dress'],
    ['Indigo jeans', 'Trousers', 'trousers'],
  ])('supports explicit source noun %s against whole-object type %s', (label, type, kind) => {
    const result = selectVisualCandidates(reading(label, 'fashion'), catalog([item(1, type)]), 1);
    expect(result.policy_version).toBe('atlas_visual_candidate_selection_v4');
    expect(ids(result)).toEqual(['met:1']);
    expect(result.subjects[0]).toMatchObject({ reason: 'eligible', object_kind: kind, reference_kind: 'physical_object' });
    expect(result.diagnostics[0]).toMatchObject({ object_kind: kind, rank: { exact_kind: 1 }, selected: true });
  });

  it.each([
    ['Four-poster canopy bed', 'Four poster canopy bed', 'bed'],
    ['Loft bedroom with platform bed', 'Loft bedroom', 'bedroom'],
    ['Sunroom dining nook', 'Sunroom dining nook', 'sunroom'],
    ['Galley kitchen', 'Galley kitchen', 'kitchen'],
    ['Bright compact bedroom featuring platform bed', 'Bedroom photo', 'bedroom'],
    ['Spacious dining room with chair and table', 'Dining room photograph', 'dining_room'],
  ])('supports explicit interior noun %s without merging its contents', (label, type, kind) => {
    const result = selectVisualCandidates(reading(label), catalog([item(1, type)]), 1);
    expect(ids(result)).toEqual(['met:1']);
    expect(result.subjects[0]).toMatchObject({ reason: 'eligible', object_kind: kind, reference_kind: kind === 'bed' ? 'physical_object' : 'scene' });
  });

  it.each([
    ['Tee', 'Tees', 'shirt'], ['Cropped tee', 'Shirts', 'shirt'], ['Top', 'Tops', 'top'],
    ['Gown', 'Dresses', 'dress'], ['Suit', 'Suits', 'suit'], ['Pantsuit', 'Trouser suits', 'suit'],
    ['Trousers', 'Jeans', 'trousers'], ['Pants', 'Trousers', 'trousers'],
    ['Bag', 'Handbags', 'bag'], ['Crossbody bag', 'Bags', 'bag'],
    ['Clothing ensemble', 'Ensemble', 'outfit'],
  ])('normalizes bounded source/catalog aliases %s / %s', (label, type, kind) => {
    const result = selectVisualCandidates(reading(label, 'fashion'), catalog([item(1, type)]), 1);
    expect(result.diagnostics[0]).toMatchObject({ admitted: true, object_kind: kind, rank: { exact_kind: 1 } });
  });

  it('keeps dresses, suits, trousers, bags, ensembles and upperwear in distinct explicit families', () => {
    const c = catalog([
      item(1, 'Dress'), item(2, 'Suit'), item(3, 'Trousers'), item(4, 'Handbag'), item(5, 'Ensemble'), item(6, 'Top'),
    ]);
    for (const [label, id] of [['Dress', 1], ['Suit', 2], ['Jeans', 3], ['Crossbody bag', 4], ['Outfit', 5], ['Top', 6]] as const) {
      const result = selectVisualCandidates(reading(label, 'fashion'), c, 2);
      expect(ids(result)).toEqual([`met:${id}`]);
      expect(result.diagnostics.filter(d => !d.admitted).every(d => d.reason === 'family_mismatch')).toBe(true);
    }
    expect(ids(selectVisualCandidates(reading('Top', 'fashion'), catalog([item(1, 'Shirt'), item(9, 'Top')]), 1))).toEqual(['met:9']);
  });

  it('recognizes only the named sneaker-shoes compound, not arbitrary mixed footwear', () => {
    for (const label of ['Boots and sneakers', 'Boots/sneakers', 'Shoes and sneakers', 'Sneaker and boot']) {
      expect(eligibleVisualSubjects(reading(label, 'fashion'))).toEqual([]);
    }
    for (const type of ['Boots and sneakers', 'Shoes and sneakers', 'Hybrid footwear object']) {
      const result = selectVisualCandidates(reading('Sneaker-shoes', 'fashion'), catalog([item(1, type)]), 2);
      expect(result.candidates).toEqual([]);
      expect(result.diagnostics[0]?.reason).toBe('unknown_object_type');
    }
  });

  it('fixes only the literal four-poster canopy bed phrase, never a poster of that bed', () => {
    const result = selectVisualCandidates(reading('Four-poster canopy bed'), catalog([
      item(1, 'Bed', 'Poster of four-poster canopy bed'), item(2, 'Bed', 'Four-poster canopy bed'),
      item(3, 'Four-poster canopy bed', 'Print depicting bed'),
    ]), 2);
    expect(ids(result)).toEqual(['met:2']);
    expect(result.diagnostics.map(d => d.reason)).toEqual(['representation', 'admitted', 'representation']);
    expect(eligibleVisualSubjects(reading('Poster of four-poster canopy bed'))).toEqual([]);
  });

  it('uses a bounded scene qualifier and content connector, not arbitrary mixed room/object inference', () => {
    for (const label of ['Bed in loft bedroom', 'Loft bedroom and platform bed', 'Chair or kitchen', 'Galley kitchen and vase', 'Unclassified bedroom with bed']) {
      expect(eligibleVisualSubjects(reading(label))).toEqual([]);
    }
    for (const type of ['Unclassified bedroom', 'Loft furniture', 'Kitchen object', 'Galley', 'Dining']) {
      expect(selectVisualCandidates(reading('Bedroom'), catalog([item(1, type)]), 1).candidates).toEqual([]);
    }
    const r = reading('Loft bedroom with platform bed');
    r.subjects.push(storedSubject({ ...reading('Platform bed').subjects[0]!, id: 's2' }));
    const result = selectVisualCandidates(r, catalog([item(1, 'Platform bed'), item(2, 'Bedroom photograph')]), 2);
    expect(result.candidates.map(c => [c.subject_id, c.catalog_id])).toEqual([['s1', 'met:2'], ['s2', 'met:1']]);
    expect(result.diagnostics.filter(d => !d.admitted).every(d => d.reason === 'reference_kind_mismatch')).toBe(true);
  });

  it.each([
    ['Dress', 'Dress bodice'], ['Gown', 'Gown sleeve'], ['Suit', 'Suit cuff'],
    ['Trousers', 'Trouser leg'], ['Jeans', 'Jeans waistband'], ['Handbag', 'Handbag strap'],
    ['Dress', 'Mold for dress'], ['Suit', 'Print of suit'], ['Trousers', 'Sewing pattern for trousers'],
    ['Dress', 'Bodice from the dress'], ['Suit', 'Cuff of a suit'], ['Handbag', 'Strap for handbag'],
  ])('requires whole %s, not %s', (type, title) => {
    const result = selectVisualCandidates(reading(type, 'fashion'), catalog([item(1, type, title)]), 1);
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics[0]?.reason).toMatch(/part_or_tool|representation/);
  });

  it('still excludes Tennis outfit without active visible evidence rather than filling from its noun', () => {
    const r = reading('Tennis outfit', 'fashion');
    r.subjects[0]!.aesthetics = [];
    expect(selectVisualCandidates(r, catalog([item(1, 'Ensemble')]), 2)).toMatchObject({
      candidates: [], subjects: [{ reason: 'no_active_visible_evidence', object_kind: 'outfit' }],
    });
    r.subjects[0]!.aesthetics = [storedAesthetic('Tennis', { basis: 'context' })];
    expect(eligibleVisualSubjects(r)).toEqual([]);
    r.subjects[0]!.aesthetics[0]!.basis = 'visible'; r.subjects[0]!.aesthetics[0]!.held = true;
    expect(eligibleVisualSubjects(r)).toEqual([]);
    r.subjects[0]!.aesthetics[0]!.held = false; r.subjects[0]!.aesthetics[0]!.retracted = true;
    expect(eligibleVisualSubjects(r)).toEqual([]);
  });

  it('does not waive food/place/person/unknown guards or infer clothing from material/category/style', () => {
    for (const [label, category] of [
      ['Dress', 'food'], ['Kitchen', 'place'], ['Portrait of a woman in a dress', 'other'],
      ['Person wearing a suit', 'fashion'], ['Leather', 'fashion'], ['Sequined', 'fashion'],
      ['Clothing', 'fashion'], ['Elegant', 'fashion'],
      // The existing provider person guard flags standalone "body"; do not
      // waive it here merely because the unhyphenated crossbody alias is safe.
      ['Cross-body bag', 'fashion'],
    ] as const) {
      const r = reading(label, category);
      r.subjects[0]!.aesthetics = [storedAesthetic('Dress suit handbag')];
      expect(eligibleVisualSubjects(r)).toEqual([]);
    }
    const unknown = item(1, 'Garment', 'Dress', 'Silk');
    unknown.tags = ['retrieval-query:dress'];
    expect(selectVisualCandidates(reading('Dress', 'fashion'), catalog([unknown]), 1).candidates).toEqual([]);
    const held = reading('Dress', 'fashion'); held.held.push({ path: 'subjects.s1', rule: 'synthetic' });
    expect(eligibleVisualSubjects(held)).toEqual([]);
    const retracted = reading('Handbag', 'fashion'); retracted.retracted.push('s1');
    expect(eligibleVisualSubjects(retracted)).toEqual([]);
    const threshold = reading('Suit', 'fashion'); threshold.subjects[0]!.aesthetics[0]!.certainty = 0.34;
    expect(eligibleVisualSubjects(threshold)).toEqual([]);
  });

  it.each(['Mug', 'Cup'])('v4 functional compatibility for %s permits drinkware, never vase/generic vessel fallbacks', label => {
    const result = selectVisualCandidates(reading(label), catalog([
      item(1, 'Vase'), item(2, 'Vessel'), item(3, 'Bowl'), item(4, 'Urn'), item(8, 'Cup'), item(9, 'Mug'),
    ]), 2);
    expect(ids(result)).toEqual(label === 'Mug' ? ['met:9', 'met:8'] : ['met:8', 'met:9']);
    expect(result.diagnostics.slice(0, 4).every(d => d.reason === 'family_mismatch' && d.rank === null)).toBe(true);
    expect(selectVisualCandidates(reading(label), catalog([item(1, 'Vase'), item(2, 'Vessel')]), 2).candidates).toEqual([]);
  });

  it.each(['Vase', 'Vessel', 'Bowl', 'Urn'])('v4 %s compatibility does not backfill from mug/cup in the reverse direction', label => {
    const result = selectVisualCandidates(reading(label), catalog([item(1, 'Mug'), item(2, 'Cup')]), 2);
    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.every(d => d.reason === 'family_mismatch')).toBe(true);
  });

  it.each([0, 1, 2])('retains deterministic permutations, guarded feature rank and two-subject round-robin at limit %s', limit => {
    const r = reading('Floral dress', 'fashion');
    r.subjects[0]!.details = [detail('Floral')];
    r.subjects.push(storedSubject({ ...reading('Suit', 'fashion').subjects[0]!, id: 's2' }));
    const objects = [item(1, 'Dress'), item(2, 'Dress', 'Floral dress'), item(3, 'Suit'), item(4, 'Dress', 'Dress fragment', 'Floral')];
    const result = selectVisualCandidates(r, catalog(objects), limit);
    expect(result.candidates.map(c => [c.subject_id, c.catalog_id])).toEqual([['s1', 'met:2'], ['s2', 'met:3']].slice(0, limit));
    expect(selectVisualCandidates(r, catalog([...objects].reverse()), limit)).toEqual(result);
    r.subjects[0]!.details[0]!.held = true;
    expect(ids(selectVisualCandidates(r, catalog(objects), 1))).toEqual(['met:1']);
    expect(selectVisualCandidates(r, catalog(objects), 999).candidates).toHaveLength(2);
  });
});
