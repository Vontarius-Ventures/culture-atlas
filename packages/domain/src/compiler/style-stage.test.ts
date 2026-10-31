import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  buildVlmStyleUserText, catalogReservationMicros, guardStyleReading, loadModelProfiles,
  loadProviderConfig, normalizeStyleReading, resolveFromWorkspace, structuredOutputContract, VLM_STYLE_SYSTEM_PROMPT,
  STYLE_WIRE_SCHEMA, VlmStyleWireSchema, type CatalogSnapshot, type VlmStyleReader, type VlmStyleObservationWire,
} from '@culture-atlas/providers';
import { computeSwatches, deltaE, paletteDecision, rgbToLab } from '../style/palette';
import { closedVocabularyLists } from '../style/vocabulary';
import { NO_CORROBORATION, wordSubject } from '../style/wording';
import { prereadStyle, publicSwatches, selectConnectionConcepts, StyleStage, stylePixels, styleRailCardKind, type StyleHost } from './style-stage';
import type { CandidateProof } from '../style/discovery-evidence';

describe('style-stage observation metadata flow, offline', () => {
  it('resolves two source plans single-flight rather than memoizing the first subject or a not-yet-ready reader', async () => {
    const stage = new StyleStage({} as StyleHost);
    expect(await stage.documentaryPlansFor()).toEqual([]);
    const source = (id: string, category: string, label: string) => ({
      id, category, label, aesthetics: [], materials: [], construction: [], details: [], mood: [], lineage: [], era: null,
    });
    const tags = new Map([
      ['sculpture', [{ id: 'urn:tag:keyword:qloo:sculpture', name: 'Sculpture', type: 'urn:tag:keyword:qloo', parents: ['urn:entity:movie'] }]],
      ['coffee', [{ id: 'urn:tag:keyword:qloo:coffee', name: 'Coffee', type: 'urn:tag:keyword:qloo', parents: ['urn:entity:movie'] }]],
      ['documentary', [{ id: 'urn:tag:genre:media:documentary', name: 'Documentary', type: 'urn:tag:genre:media', parents: ['urn:entity:movie'] }]],
    ]);
    const lookupTags = vi.fn(async () => tags);
    // Only the guarded subjects and lookup seam are needed for this unit test;
    // the full worker/DB test exercises their real publication and provider paths.
    Object.assign(stage, { stored: { subjects: [source('s1', 'other', 'Stone sculpture'), source('s2', 'food', 'Espresso coffee drink')] }, lookupTags });
    const first = stage.documentaryPlansFor();
    const second = stage.documentaryPlansFor();
    expect(first).toBe(second);
    const plans = await first;
    expect(lookupTags).toHaveBeenCalledTimes(1);
    expect(lookupTags).toHaveBeenCalledWith(['sculpture', 'coffee', 'documentary'], true);
    expect(plans.map((p) => [p.plan.subjectId, p.plan.key, p.topic.tagId])).toEqual([
      ['s1', 'sculpture', 'urn:tag:keyword:qloo:sculpture'], ['s2', 'coffee', 'urn:tag:keyword:qloo:coffee'],
    ]);
    expect(stage.connectionRequestHeadroom).toBe(2);
    stage.completeConnectionPlan('sculpture');
    stage.completeConnectionPlan('coffee');
    expect(stage.connectionRequestHeadroom).toBe(0);
  });

  it('diversifies actual proof subjects/concepts with deterministic provider-ranked ties and no fabricated origin references', () => {
    const candidate = (id: string, subjectId: string, concept: string) => {
      const claim = { slot: 'label' as const, name: concept, wording: 'asserted' as const };
      const proof: CandidateProof = { subjectId, candidateId: id, relation: 'about_subject', origin: 'topic', claim, candidateTags: [],
        contentEvidence: { topic: concept, claim, field: 'description', excerpt: 'Fixture substantive content.', topicPlanKey: concept } };
      return { id, proof };
    };
    const pool = [candidate('a1', 's1', 'sculpture'), candidate('a2', 's1', 'sculpture'), candidate('b1', 's2', 'coffee'), candidate('c1', 's1', 'pottery')];
    expect(selectConnectionConcepts(pool, 4, (c) => c.proof).map((c) => c.id)).toEqual(['a1', 'b1', 'c1', 'a2']);
    expect(selectConnectionConcepts(pool.slice(1), 2, (c) => c.proof, [pool[0]!]).map((c) => c.id)).toEqual(['b1', 'c1']);
  });

  it('projects all uniform claim slots into the existing stored/public shape without manufacturing independent evidence', () => {
    const local = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
    const claim = (slot: VlmStyleObservationWire['claims'][number]['slot'], name: string, evidence = 'o1') =>
      ({ subject: 's1', slot, name, certainty: 0.9, basis: 'visible' as const, evidence, kind: '', tag_query: '' });
    const flat: VlmStyleObservationWire = {
      schema: STYLE_WIRE_SCHEMA, usable: true, unusable_reason: 'none', summary: 'A canvas work jacket.',
      subjects: [{ id: 's1', category: 'fashion', label: 'Canvas work jacket', box: [0, 0, 1, 1], brand_name: '', brand_text: '' }],
      observations: [
        { subject: 's1', id: 'o1', kind: 'surface', text: 'brown woven canvas', box: [local.x, local.y, local.w, local.h], certainty: 0.9 },
        { subject: 's1', id: 'o2', kind: 'construction', text: 'boxy cut and metal snaps', box: [], certainty: 0.9 },
      ],
      claims: [
        claim('aesthetics', 'Workwear', 'o1,o2'), claim('era', '1990s'),
        { ...claim('lineage', 'Utility'), basis: 'context' },
        claim('materials', 'Canvas'), { ...claim('construction', 'Boxy cut', 'o2'), kind: 'cut' },
        claim('details', 'Brown canvas panel'), claim('mood', 'rugged'),
      ],
      palette: [{ subject: 's1', swatch: 0, name: 'brown', role: 'accent', evidence: 'o1' }],
    };
    const normalized = normalizeStyleReading(flat, 1);
    const guarded = guardStyleReading(normalized, { stage1: { usable: true, peopleShown: false, visibleText: [] } }).reading.subjects[0]!;
    const stored = wordSubject({
      subject: guarded, swatches: [{ index: 0, hex: '#775533', share: 1 }], presentSwatches: new Set([0]),
      corroboration: NO_CORROBORATION, keepClaimRegions: false,
    }, []);
    expect(stored.aesthetics[0]?.defining_features).toEqual(['brown woven canvas', 'boxy cut and metal snaps']);
    expect(stored.aesthetics[0]?.evidence_ids).toEqual(['o1', 'o2']);
    expect(stored.era?.cue).toBe('brown woven canvas');
    expect(stored.lineage[0]?.basis).toBe('context');
    expect(stored.materials[0]?.texture).toBe('brown woven canvas');
    expect(stored.construction[0]?.kind).toBe('cut');
    expect(stored.details[0]?.region).toBeNull();
    expect(stored.details[0]?.evidence_ids).toEqual(['o1']);
    expect(stored.mood[0]?.display).toBe('Feels rugged');
    expect(stored.observations?.[0]?.region).toEqual(local);
    expect(stored.palette[0]).toMatchObject({ role: 'accent', evidence_ids: ['o1'], hex: '#775533' });
  });

  it('does not label home or unknown brands as Wear, without adding public categories', () => {
    const brand = ['urn:entity:brand'];
    expect(styleRailCardKind(brand, 'fashion')).toEqual({ kind: 'brand', category: 'wear' });
    expect(styleRailCardKind(brand, 'food')).toEqual({ kind: 'brand', category: 'eat' });
    for (const category of ['interior', 'place', 'media', 'other', undefined] as const)
      expect(styleRailCardKind(brand, category)).toEqual({ kind: 'brand', category: null });
    expect(styleRailCardKind(['urn:entity:movie'], 'interior')).toEqual({ kind: 'film', category: 'watch' });
    expect(styleRailCardKind(['urn:entity:artist'], 'fashion')).toEqual({ kind: 'artist', category: 'play' });
  });

  it('fits the actual full-vocabulary request in the active profile without raising the per-call spend cap', () => {
    const profile = loadModelProfiles(resolveFromWorkspace('fixtures/concentrate/profiles.json')).vision_style!;
    const input = {
      image: { bytes: new Uint8Array(), mediaType: 'image/jpeg' as const },
      swatches: Array.from({ length: 6 }, (_, index) => ({ index, hex: '#ABCDEF', share: 0.15 })),
      vocabulary: closedVocabularyLists(),
    };
    const bytes = Buffer.byteLength(VLM_STYLE_SYSTEM_PROMPT)
      + Buffer.byteLength(buildVlmStyleUserText(input))
      + Buffer.byteLength(JSON.stringify(structuredOutputContract(VlmStyleWireSchema).jsonSchema));
    expect(bytes).toBeLessThanOrEqual(profile.maxInputBytes);
    expect(bytes).toBeLessThanOrEqual(profile.maxInputTokens);
    const catalog = JSON.parse(readFileSync(resolveFromWorkspace('fixtures/concentrate/catalog-snapshot.json'), 'utf8')) as CatalogSnapshot;
    const reservation = catalogReservationMicros(profile, catalog);
    expect(reservation).not.toBeNull();
    expect(reservation!).toBeLessThanOrEqual(loadProviderConfig({}).STYLE_MAX_CALL_USD * 1_000_000);
    expect(profile.reservationMicros).toBe(reservation);
  });

  it('reuses one preread with the same six-swatch measurement and retains local evidence independently of public regions', async () => {
    const raw = Buffer.alloc(100 * 100 * 3);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const rgb = x < 20 && y < 20 ? [20, 60, 180] : [20, 20, 20];
      raw.set(rgb, (y * 100 + x) * 3);
    }
    const bytes = await sharp(raw, { raw: { width: 100, height: 100, channels: 3 } }).jpeg().toBuffer();
    const px = await stylePixels(bytes);
    const measured = computeSwatches(px.data, px.width, px.height, px.channels);
    const blue = measured.reduce((a, b) => deltaE(a.lab, rgbToLab(20, 60, 180)) < deltaE(b.lab, rgbToLab(20, 60, 180)) ? a : b);
    const local = { x: 0, y: 0, w: 0.2, h: 0.2 };
    const readStyle = vi.fn<VlmStyleReader['readStyle']>(async () => ({
      model: 'fixture', durationMs: 1, image: { width: 100, height: 100 },
      reading: {
        schema: 'atlas_style_reading_v1', usable: true, unusable_reason: null, summary: 'A tile with a blue patch.',
        subjects: [{
          id: 's1', category: 'interior', label: 'Decorative tile', region: { x: 0, y: 0, w: 1, h: 1 },
          observations: [{ id: 'o1', kind: 'surface', text: 'blue glazed patch', region: local, certainty: 0.9 }],
          aesthetics: [], era: null, lineage: [], materials: [], construction: [], mood: [], brand: null,
          details: [{ text: 'blue glazed patch', certainty: 0.9, evidence: { basis: 'visible', region: local }, evidence_ids: ['o1'] }],
          palette: [{ swatch: blue.index, name: 'blue', role: 'accent', evidence_ids: ['o1'] }],
        }],
      },
    }));
    const out = await prereadStyle({
      vlmStyle: { id: 'fixture-style', capability: () => ({ provider: 'fixture', status: 'available' }), readStyle },
      modelGateway: undefined,
    }, bytes, {});
    expect(readStyle).toHaveBeenCalledTimes(1);
    expect(readStyle.mock.calls[0]?.[0].swatches).toEqual(publicSwatches(measured));
    expect(measured.length).toBeLessThanOrEqual(6);
    expect(out.errorCode).toBeNull();
    const guarded = guardStyleReading(out.reading!, { stage1: { usable: true, peopleShown: false, visibleText: [] } }).reading.subjects[0]!;
    const entry = guarded.palette[0]!;
    expect(paletteDecision(px.data, px.width, px.height, px.channels, guarded.region, entry, measured, guarded.observations)).toBe('supported');
    const stored = wordSubject({
      subject: guarded, swatches: publicSwatches(measured), presentSwatches: new Set([blue.index]),
      corroboration: NO_CORROBORATION, keepClaimRegions: false,
    }, []);
    expect(stored.observations?.[0]?.region).toEqual(local);
    expect(stored.details[0]?.region).toBeNull();
    expect(stored.details[0]?.evidence_ids).toEqual(['o1']);
    expect(stored.palette[0]).toMatchObject({ role: 'accent', evidence_ids: ['o1'], hex: blue.hex });
  });
});
