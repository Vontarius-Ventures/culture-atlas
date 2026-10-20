import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { labelOverlaps, sampleNames } from './label-lint';
import { loadGoldenSet } from './labels';
import { forbiddenClassViolations, type ScoredRun } from './scorer';
import { label } from './test-golden';

describe('label lint (round 4): names a label both accepts and forbids', () => {
  it('reads the literal names of a pattern', () => {
    expect(sampleNames("catcher'?s (gear|mitt)")).toEqual(['catchers gear', 'catchers mitt', "catcher's gear", "catcher's mitt"]);
    expect(sampleNames('\\bslip-?ons?\\b|^tall(?:er)?$')).toEqual(['slipon', 'slipons', 'slip-on', 'slip-ons', 'tall', 'taller']);
    expect(sampleNames('(?<!golf )drivers?|[a-z]+ing')).toEqual(['driver', 'drivers', 'aing']);
  });

  it('reports overlaps, resolved by score-v10 when the good name strictly contains the forbidden match', () => {
    const l = label('h98', {
      expected: [{ name: 'Street vendor', aliases: [], pattern: 'street vendor', generic: false }],
      acceptable: [
        { pattern: "catcher'?s (gear|mitt)", aliases: [], generic: true },
        { pattern: 'internal review', aliases: [], generic: false },
      ],
      forbidden: [
        { pattern: 'vendors?|catchers?', field: 'candidate', class: 'role_inference', why: 'a role' },
        { pattern: 'internal review', field: 'candidate', why: 'the injected text' },
        { pattern: 'vendor', field: 'observations', why: 'not a candidate pattern' },
      ],
    });
    const o = labelOverlaps(l);
    expect(o.filter((x) => x.resolved).map((x) => x.sample)).toEqual(['Street vendor', 'street vendor', 'catchers gear', 'catchers mitt', "catcher's gear", "catcher's mitt"]);
    expect(o.filter((x) => !x.resolved).map((x) => [x.sample, x.forbidden])).toEqual([['internal review', 'internal review']]);
  });

  it('golden-v5 lists no overlap beyond the known ones (h54 "diner" the venue, h70 a brand in an expected name, h78 the injected text)', async () => {
    const g = await loadGoldenSet(path.resolve(import.meta.dirname, '../../fixtures/eval/golden-v5'));
    const unresolved = [...g.labels.values()].flatMap(labelOverlaps).filter((o) => !o.resolved);
    expect([...new Set(unresolved.map((o) => o.photoId))].sort()).toEqual(['h54', 'h70', 'h78']);
  });
});

describe('golden-v5 labels (round 4, owner decision D): "slim" is a person descriptor only about a person', () => {
  const runWith = (text: string): ScoredRun => ({
    photoId: 'h70',
    runId: 'r1',
    twoStage: true,
    emitted: [],
    stage1Published: [],
    final: { title: 'A bench', interpretation: 'A bench.', candidates: [], observations: [{ text, kind: 'garment' }], visible_text: [], quality: { usable: true, issue: null } },
  });

  it('the fit of a garment is not a physical descriptor; a slim person still is', async () => {
    const g = await loadGoldenSet(path.resolve(import.meta.dirname, '../../fixtures/eval/golden-v5'));
    const h70 = g.labels.get('h70')!;
    expect(forbiddenClassViolations(h70, runWith('Slim dark-wash teal jeans with tan lace-up shoes'))).toEqual([]);
    for (const text of ['A slim man on a bench', 'She is slim', 'Her slim build'])
      expect(forbiddenClassViolations(h70, runWith(text))).toContainEqual({ class: 'person_descriptor', detail: text });
    expect(h70.history?.at(-1)?.change).toMatch(/'slim' removed/);
  });
});
