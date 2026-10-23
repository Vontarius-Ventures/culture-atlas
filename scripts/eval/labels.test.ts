import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GoldenManifestSchema,
  PhotoLabelSchema,
  ThresholdsSchema,
  entryMatches,
  findEntry,
  goldenDigest,
  loadGoldenSet,
  loadThresholds,
} from './labels';
import { blindConsumed, checkFreeze, loadFreezeRecord } from './freeze';
import { label, syntheticGolden } from './test-golden';

const root = path.resolve(import.meta.dirname, '../..');
const goldenDir = path.join(root, 'fixtures/eval/golden-v1');

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

describe('golden-v1 (fixtures/eval/golden-v1)', () => {
  it('loads: every manifest photo has a matching label and vice versa', async () => {
    const golden = await loadGoldenSet(goldenDir);
    expect(golden.manifest.version).toBe('golden-v1');
    expect(golden.labels.size).toBe(golden.manifest.photos.length);
  });

  it('has the 15 tuning photos and at least 10 held-out photos, pinned by sha256 and commit', async () => {
    const { manifest } = await loadGoldenSet(goldenDir);
    const tune = manifest.photos.filter((p) => p.split === 'tune');
    const holdout = manifest.photos.filter((p) => p.split === 'holdout');
    expect(tune.map((p) => p.id)).toEqual(Array.from({ length: 15 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`));
    expect(holdout.length).toBeGreaterThanOrEqual(10);
    for (const p of manifest.photos) {
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      if (p.source.raw_url) expect(p.source.raw_url).toContain(`/${p.source.commit}/`);
    }
  });

  it('withholds only the p11 source path, so no person name is written in git', async () => {
    const { manifest } = await loadGoldenSet(goldenDir);
    expect(manifest.photos.filter((p) => p.source.raw_url === null).map((p) => p.id)).toEqual(['p11']);
    const p11 = JSON.parse(await readFile(path.join(goldenDir, 'labels/p11.json'), 'utf8'));
    expect(p11.forbidden_classes).toEqual(expect.arrayContaining(['person_identity', 'person_descriptor', 'role_inference']));
    expect(p11.people).toEqual({ present: true });
  });

  it('covers the held-out cases the plan lists (§7.1), with an unusable photo per split', async () => {
    const { labels } = await loadGoldenSet(goldenDir);
    const holdout = [...labels.values()].filter((l) => l.split === 'holdout');
    const has = (fn: (l: (typeof holdout)[number]) => boolean) => holdout.some(fn);
    expect(has((l) => l.subject_domains.includes('vehicle') && l.must_read_text.length > 0)).toBe(true); // legible badge
    expect(has((l) => l.subject_domains.includes('vehicle') && l.forbidden.some((f) => f.class === 'brand_without_text') && !l.must_read_text.length)).toBe(true);
    expect(has((l) => l.subject_domains.includes('fashion') && l.expected.some((e) => e.type === 'brand'))).toBe(true);
    expect(has((l) => l.subject_domains.includes('fashion') && !l.expected.some((e) => e.type === 'brand'))).toBe(true);
    expect(has((l) => l.allowed_categories.includes('eat'))).toBe(true);
    expect(has((l) => l.subject_domains.includes('craft'))).toBe(true);
    expect(has((l) => l.quality.issue === 'too_dark')).toBe(true);
    expect(has((l) => l.allowed_categories.includes('watch') && l.must_read_text.length > 0)).toBe(true); // poster
    expect([...labels.values()].some((l) => l.split === 'tune' && !l.quality.usable)).toBe(true);
  });

  it('never stores images or model outputs under fixtures/eval', async () => {
    const files = await walk(path.join(root, 'fixtures/eval'));
    expect(files.filter((f) => /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(f))).toEqual([]);
    expect(files.every((f) => /\.(json|md)$/.test(f))).toBe(true);
  });

  it('binds the labels into a digest: any label edit changes it', async () => {
    const golden = await loadGoldenSet(goldenDir);
    const before = goldenDigest(golden);
    const edited = new Map(golden.labels);
    edited.set('p01', { ...golden.labels.get('p01')!, allowed_categories: [] });
    expect(goldenDigest({ manifest: golden.manifest, labels: edited })).not.toBe(before);
    expect(goldenDigest(golden)).toBe(before);
  });
});

describe('golden-v2 (fixtures/eval/golden-v2): blind held-out set h14+', () => {
  const v2Dir = path.join(root, 'fixtures/eval/golden-v2');
  const ids = (prefix: string, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, '0')}`);

  it('loads: every manifest photo has a matching label and vice versa', async () => {
    const golden = await loadGoldenSet(v2Dir);
    expect(golden.manifest.version).toBe('golden-v2');
    expect(golden.labels.size).toBe(golden.manifest.photos.length);
  });

  it('tunes on p01-p15 plus the no-longer-blind h01-h13, and holds out 12-16 photos h14+, blind until a failed blind run', async () => {
    const { manifest, labels } = await loadGoldenSet(v2Dir);
    // The blind run on h14-h29 failed (freeze.json blind_run): the split has been read and is no longer blind.
    const consumed = blindConsumed(await loadFreezeRecord(v2Dir));
    expect(consumed).toBe(true);
    const tune = manifest.photos.filter((p) => p.split === 'tune');
    const holdout = manifest.photos.filter((p) => p.split === 'holdout');
    expect(tune.map((p) => p.id)).toEqual([...ids('p', 1, 15), ...ids('h', 1, 13)]);
    expect(tune.every((p) => p.blind === undefined)).toBe(true);
    expect(holdout.length).toBeGreaterThanOrEqual(12);
    expect(holdout.length).toBeLessThanOrEqual(16);
    expect(holdout.map((p) => p.id)).toEqual(ids('h', 14, 13 + holdout.length));
    for (const p of holdout) {
      expect(p.blind).toBe(!consumed);
      expect(p.source.raw_url).toContain(`/${p.source.repo}/${p.source.commit}/`);
      expect(labels.get(p.id)!.split).toBe('holdout');
    }
  });

  it('uses only photos and repositories that golden-v1 never used', async () => {
    const v1 = await loadGoldenSet(goldenDir);
    const v2 = await loadGoldenSet(v2Dir);
    const v1Hashes = new Set(v1.manifest.photos.map((p) => p.sha256));
    const v1Repos = new Set(v1.manifest.photos.map((p) => p.source.repo.toLowerCase()));
    for (const p of v2.manifest.photos.filter((x) => x.split === 'holdout')) {
      expect(v1Hashes.has(p.sha256)).toBe(false);
      expect(v1Repos.has(p.source.repo.toLowerCase())).toBe(false);
    }
  });

  it('covers the cases the requalification plan lists for the blind set', async () => {
    const { labels } = await loadGoldenSet(v2Dir);
    const blind = [...labels.values()].filter((l) => l.split === 'holdout');
    const has = (fn: (l: (typeof blind)[number]) => boolean) => blind.some(fn);
    const brandWithoutText = (l: (typeof blind)[number]) => l.forbidden.some((f) => f.class === 'brand_without_text');
    const readBrand = (l: (typeof blind)[number]) => [...l.expected, ...l.acceptable].some((e) => e.type === 'brand' && !!e.requires_text);
    expect(blind.filter((l) => l.allowed_categories.includes('eat')).length).toBeGreaterThanOrEqual(2); // food dishes
    expect(has((l) => l.subject_domains.includes('interior'))).toBe(true);
    expect(has((l) => l.subject_domains.includes('craft'))).toBe(true);
    expect(has((l) => l.subject_domains.includes('signage') && l.must_read_text.some((t) => /^[\p{Script=Latin}\s]+$/u.test(t)))).toBe(true);
    expect(has((l) => l.subject_domains.includes('signage') && l.must_read_text.some((t) => /[^\p{Script=Latin}\p{N}\p{P}\s]/u.test(t)))).toBe(true);
    expect(has((l) => l.subject_domains.includes('vehicle') && l.expected.some((e) => e.type === 'brand') && l.must_read_text.length > 0)).toBe(true);
    expect(has((l) => l.subject_domains[0] === 'vehicle' && brandWithoutText(l) && !l.must_read_text.length)).toBe(true);
    expect(has((l) => l.subject_domains.includes('fashion') && readBrand(l) && l.must_read_text.length > 0)).toBe(true); // logo with legible text
    expect(has((l) => l.subject_domains.includes('fashion') && brandWithoutText(l) && !readBrand(l))).toBe(true); // no legible logo
    expect(has((l) => l.people.present && l.forbidden.some((f) => f.class === 'person_identity') && l.forbidden.some((f) => f.class === 'role_inference'))).toBe(true);
    expect(has((l) => l.people.present && l.subject_domains.length >= 3 && l.subject_domains.includes('signage'))).toBe(true); // busy scene
    for (const l of blind) expect(l.must_not_read_text.every((p) => !l.must_read_text.some((t) => new RegExp(p, 'iu').test(t)))).toBe(true);
  });

  it('the held-out labels and manifest entries are exactly the frozen ones (FREEZE.md)', async () => {
    // Only permitted change since the freeze: after the recorded failed blind run, every held-out entry's
    // blind flag went from true to false (scripts/eval/freeze.ts, freezeViolations).
    const { freeze, violations } = await checkFreeze(v2Dir);
    expect(freeze?.golden_set).toBe('golden-v2');
    expect(violations).toEqual([]);
    // The record of the one blind run (FREEZE.md "Record"): code 303b29b, failed M1, M4 and M11.
    expect(freeze?.blind_run).toMatchObject({
      binding_commit: 'b2cf11ac7d7ac76ec1e5ae2e70a650074c4423a6',
      code_commit: '303b29ba4f333288891f5fc9b5ef28a63abad1fa',
      result: 'fail',
      failed_gates: ['M1', 'M4', 'M11'],
    });
  });
});

describe('golden-v3 (fixtures/eval/golden-v3): round-2 tune labels', () => {
  const v2Dir = path.join(root, 'fixtures/eval/golden-v2');
  const v3Dir = path.join(root, 'fixtures/eval/golden-v3');

  it('tunes on golden-v2 with every photo in tune (h14-h29 joined after their failed blind run); only h30+ is held out', async () => {
    const v2 = await loadGoldenSet(v2Dir);
    const v3 = await loadGoldenSet(v3Dir);
    expect(v3.manifest.version).toBe('golden-v3');
    const tune = v3.manifest.photos.filter((p) => p.split === 'tune');
    const v2Ids = new Set(v2.manifest.photos.map((p) => p.id));
    expect(tune.every((p) => p.blind === undefined)).toBe(true);
    // Every golden-v2 photo is in tune, and nothing else is: the held-out split is only the fresh h30+ photos.
    expect(tune.map((p) => p.id)).toEqual([...v2Ids]);
    expect(v3.manifest.photos.filter((p) => p.split !== 'tune').every((p) => !v2Ids.has(p.id) && Number(p.id.slice(1)) >= 30)).toBe(true);
    // Same photos, files, hashes and sources; only the split (and the held-out blind flag) differ.
    expect(tune.map(({ split: _s, blind: _b, ...rest }) => rest)).toEqual(v2.manifest.photos.map(({ split: _s, blind: _b, ...rest }) => rest));
    // The freeze record covers only the h30+ held-out split (golden-v3/FREEZE.md), never a tune photo.
    const freeze = await loadFreezeRecord(v3Dir);
    expect(Object.keys(freeze?.photos ?? {}).filter((id) => v2Ids.has(id))).toEqual([]);
    for (const [id, l3] of v3.labels) {
      if (!v2Ids.has(id)) continue;
      const l2 = v2.labels.get(id)!;
      expect(l3.split).toBe('tune');
      if (id === 'h26') continue;
      expect({ ...l3, split: l2.split }, id).toEqual(l2);
    }
  });

  it('h26: the expected roadster pattern no longer counts a make or model read off the shape, and the change is in its history', async () => {
    const v3 = await loadGoldenSet(v3Dir);
    const v2 = await loadGoldenSet(v2Dir);
    const h26 = v3.labels.get('h26')!;
    const old = v2.labels.get('h26')!;
    // Only the expected pattern and the history changed.
    expect({ ...h26, split: old.split, expected: old.expected, history: undefined }).toEqual({ ...old, history: undefined });
    expect(h26.history).toHaveLength(1);
    expect(h26.history![0]).toMatchObject({ date: '2026-10-19' });
    expect(h26.history![0]!.reason).toContain('MG MGA roadster');
    const roadster = h26.expected[0]!;
    for (const name of ['Classic roadster', 'British sports car', 'Red classic roadster', 'Vintage convertible', 'Mid-century British sports car'])
      expect(entryMatches(roadster, name, 'exact'), name).toBe(true);
    for (const name of ['MG MGA roadster', 'MGA roadster', 'Austin-Healey sports car'])
      expect(entryMatches(roadster, name, 'exact'), name).toBe(false);
    // The make is judged by the MGA entry: good only when "MG" is read.
    expect(findEntry(h26.acceptable, 'MG MGA roadster')?.name).toBe('MGA');
    expect(entryMatches(old.expected[0]!, 'MG MGA roadster', 'exact')).toBe(true);
  });
});

describe('golden-v4 (fixtures/eval/golden-v4): round-3 tune labels', () => {
  const v3Dir = path.join(root, 'fixtures/eval/golden-v3');
  const v4Dir = path.join(root, 'fixtures/eval/golden-v4');
  const FIXED = ['h01', 'h31', 'h43', 'h46'];

  it('tunes on every golden-v3 photo (h30-h49 joined after their failed blind run); only the fresh h50+ photos are held out', async () => {
    const v3 = await loadGoldenSet(v3Dir);
    const v4 = await loadGoldenSet(v4Dir);
    expect(v4.manifest.version).toBe('golden-v4');
    const tune = v4.manifest.photos.filter((p) => p.split === 'tune');
    const v3Ids = new Set(v3.manifest.photos.map((p) => p.id));
    expect(tune.every((p) => p.blind === undefined)).toBe(true);
    // Every golden-v3 photo is in tune, and nothing else is: the held-out split is only the fresh h50+ photos.
    expect(tune.map((p) => p.id)).toEqual([...v3Ids]);
    expect(v4.manifest.photos.filter((p) => p.split !== 'tune').every((p) => !v3Ids.has(p.id) && Number(p.id.slice(1)) >= 50)).toBe(true);
    // Same photos, files, hashes and sources; only the split and the blind flag differ.
    expect(tune.map(({ split: _s, blind: _b, ...rest }) => rest)).toEqual(v3.manifest.photos.map(({ split: _s, blind: _b, ...rest }) => rest));
    // The freeze record covers only the h50+ held-out split (golden-v4/FREEZE.md), never a tune photo.
    const freeze = await loadFreezeRecord(v4Dir);
    expect(Object.keys(freeze?.photos ?? {}).filter((id) => v3Ids.has(id))).toEqual([]);
    // Every tune label is golden-v3's, moved to tune, except the four fixed ones (each with its history).
    for (const [id, l4] of v4.labels) {
      if (!v3Ids.has(id)) continue;
      const l3 = v3.labels.get(id)!;
      expect(l4.split).toBe('tune');
      expect(l4.blind).toBeUndefined();
      if (FIXED.includes(id)) continue;
      const { blind: _b, ...rest3 } = l3;
      expect({ ...l4, split: l3.split }, id).toEqual(rest3);
    }
    for (const id of FIXED) {
      const history = v4.labels.get(id)!.history!;
      expect(history.at(-1), id).toMatchObject({ date: '2026-10-20' });
      expect(history.at(-1)!.decision, id).toContain('round 3');
    }
  });

  it('golden-v3 itself is untouched: still consumed, with its frozen held-out labels', async () => {
    const v3 = await loadGoldenSet(v3Dir);
    expect(v3.manifest.photos.filter((p) => p.split === 'holdout')).toHaveLength(20);
    expect(blindConsumed(await loadFreezeRecord(v3Dir))).toBe(true);
  });

  it('h31: a regional pizza style is unlabelled, as the notes say; pepperoni and plain pizza stay expected', async () => {
    const v4 = await loadGoldenSet(v4Dir);
    const entry = v4.labels.get('h31')!.expected[0]!;
    for (const name of ['Pepperoni pizza', 'Pizza', 'Homemade pizza', 'Sliced pizza', 'Wood-fired pizza']) expect(entryMatches(entry, name, 'exact'), name).toBe(true);
    for (const name of ['Neapolitan-style pizza', 'New York-style pizza', 'Neapolitan pizza']) expect(entryMatches(entry, name, 'exact'), name).toBe(false);
    expect(v4.labels.get('h31')!.notes).toContain('Regional styles (Neapolitan, New York) are left unlabelled');
    // Round-3 Tune: the scorer also matches by name similarity when no entry matches exactly, so the whole
    // label is checked, not one entry: no alias may make a regional style expected again ("Pizza" in
    // "Neapolitan-style pizza" scored 0.85). Plain "Pizza" stays expected through the pattern.
    const h31 = v4.labels.get('h31')!;
    for (const name of ['Neapolitan-style pizza', 'New York-style pizza', 'Neapolitan pizza'])
      expect(findEntry([...h31.expected, ...h31.acceptable], name), name).toBeUndefined();
    expect(findEntry(h31.expected, 'Pizza')?.name).toBe('Pepperoni pizza');
    expect(h31.history).toHaveLength(2);
  });

  it('h43: the full concept name needs "EfficientDynamics" read; "BMW Vision" needs "Vision"', async () => {
    const v4 = await loadGoldenSet(v4Dir);
    const h43 = v4.labels.get('h43')!;
    expect(findEntry(h43.acceptable, 'BMW Vision EfficientDynamics')).toMatchObject({ requires_text: 'EfficientDynamics' });
    expect(findEntry(h43.acceptable, 'BMW Vision EfficientDynamics concept')).toMatchObject({ requires_text: 'EfficientDynamics' });
    expect(findEntry(h43.acceptable, 'BMW Vision')).toMatchObject({ name: 'BMW Vision', requires_text: 'Vision' });
    expect(findEntry(h43.expected, 'BMW')).toMatchObject({ requires_text: 'BMW' });
  });

  it('h46: "NBA basketball" is judged by the NBA entry (NBA must be read), not by the sport', async () => {
    const v4 = await loadGoldenSet(v4Dir);
    const h46 = v4.labels.get('h46')!;
    const sport = h46.expected[0]!;
    for (const name of ['Basketball', 'Basketball game', 'Indoor basketball']) expect(entryMatches(sport, name, 'exact'), name).toBe(true);
    for (const name of ['NBA basketball', 'Lakers basketball']) expect(entryMatches(sport, name, 'exact'), name).toBe(false);
    expect(findEntry([...h46.expected, ...h46.acceptable], 'NBA basketball')).toMatchObject({ name: 'NBA', requires_text: 'NBA' });
  });

  it('h01: a generation, mark or phase read off the shape is a brand claim without text', async () => {
    const v4 = await loadGoldenSet(v4Dir);
    const h01 = v4.labels.get('h01')!;
    const re = new RegExp(h01.forbidden.at(-1)!.pattern, 'iu');
    for (const name of ['Citroën Berlingo (first generation)', 'Berlingo Mk II', 'Citroën Berlingo phase 2']) expect(re.test(name), name).toBe(true);
    for (const name of ['Citroën Berlingo', 'Berlingo', 'Citroën']) expect(re.test(name), name).toBe(false);
    expect(h01.forbidden.at(-1)!.class).toBe('brand_without_text');
    expect(h01.forbidden_classes).toContain('brand_without_text');
  });
});

describe('label and manifest schemas', () => {
  it('rejects an entry with neither a name nor a pattern, and an invalid regular expression', () => {
    expect(PhotoLabelSchema.safeParse({ ...label('p01'), expected: [{ aliases: [] }] }).success).toBe(false);
    expect(PhotoLabelSchema.safeParse({ ...label('p01'), forbidden: [{ pattern: '(', why: 'x' }] }).success).toBe(false);
  });

  it('ties p* ids to the tune split; held-out photos are h*, and an h* photo may move to tune', () => {
    expect(PhotoLabelSchema.safeParse({ ...label('p01'), split: 'holdout' }).success).toBe(false);
    expect(PhotoLabelSchema.safeParse(label('h01')).success).toBe(true);
    expect(PhotoLabelSchema.safeParse({ ...label('h01'), split: 'tune' }).success).toBe(true);
  });

  it('an unusable photo has no good references and must forbid published candidates', () => {
    const unusable = { ...label('p15'), quality: { usable: false, issue: 'blurred' } };
    expect(PhotoLabelSchema.safeParse(unusable).success).toBe(false);
    expect(PhotoLabelSchema.safeParse({ ...unusable, expected: [], forbidden_classes: ['unusable_with_candidates'] }).success).toBe(true);
  });

  it('the manifest refuses unpinned URLs, duplicate ids or hashes, and half-withheld sources', () => {
    const photo = {
      id: 'p01',
      split: 'tune',
      file: 'p01.jpg',
      sha256: 'a'.repeat(64),
      width: 1,
      height: 1,
      source: { repo: 'o/r', path: 'x.jpg', commit: 'b'.repeat(40), license: 'MIT', raw_url: `https://raw.githubusercontent.com/o/r/${'b'.repeat(40)}/x.jpg` },
    };
    expect(GoldenManifestSchema.safeParse({ version: 'golden-v1', photos: [photo] }).success).toBe(true);
    expect(GoldenManifestSchema.safeParse({ version: 'golden-v1', photos: [{ ...photo, source: { ...photo.source, raw_url: 'https://raw.githubusercontent.com/o/r/main/x.jpg' } }] }).success).toBe(false);
    expect(GoldenManifestSchema.safeParse({ version: 'golden-v1', photos: [photo, { ...photo, id: 'p02' }] }).success).toBe(false);
    expect(GoldenManifestSchema.safeParse({ version: 'golden-v1', photos: [{ ...photo, source: { ...photo.source, raw_url: null, path: null } }] }).success).toBe(false);
    expect(
      GoldenManifestSchema.safeParse({ version: 'golden-v1', photos: [{ ...photo, source: { ...photo.source, raw_url: null, path: null, withheld: 'name in path' } }] }).success,
    ).toBe(true);
  });

  it('loadGoldenSet refuses a label without a manifest photo', async () => {
    const { dir } = await syntheticGolden(['p01', 'p02']);
    await writeFile(path.join(dir, 'labels', 'p03.json'), JSON.stringify(label('p03')));
    await expect(loadGoldenSet(dir)).rejects.toThrow('p03 has no manifest photo');
  });

  it('thresholds parse, are versioned and carry the replay and live gates of §7.2', async () => {
    const { thresholds, sha256 } = await loadThresholds(path.join(root, 'fixtures/eval/thresholds.json'));
    expect(thresholds.version).toBe('thr-v2');
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(thresholds.replay.M1).toEqual({ op: '==', value: 0 });
    expect(thresholds.replay.M3).toEqual({ op: '>=', value: 0.85 });
    expect(thresholds.live.M2).toEqual({ op: '<=', value: 0.05 });
    expect(thresholds.live.M14_stage1_p95).toEqual({ op: '<=', value: 6000 });
    expect(thresholds.live_tune.M5).toEqual({ op: '>=', value: 0.8 });
    expect(ThresholdsSchema.safeParse({ ...thresholds, replay: { X1: { op: '==', value: 0 } } }).success).toBe(false);
    expect(ThresholdsSchema.safeParse({ ...thresholds, two_stage_only: ['coverage'] }).success).toBe(false);
  });

  it('thr-v2 changes only what the requalification decisions allow (docs/requalification-plan.md 3 and 4)', async () => {
    const { thresholds } = await loadThresholds(path.join(root, 'fixtures/eval/thresholds.json'));
    // Decision 3: which run M5 and M9 gate, not their values (M5 0.80 tune / 0.70, M9 0.90; stage-1 coverage M15 0.60).
    expect(thresholds.two_stage_only).toEqual(['M5', 'M9']);
    expect([thresholds.replay.M5, thresholds.live.M5, thresholds.live_tune.M5].map((g) => g?.value)).toEqual([0.8, 0.7, 0.8]);
    expect([thresholds.replay.M9, thresholds.live.M9].map((g) => g?.value)).toEqual([0.9, 0.9]);
    expect([thresholds.replay.M15, thresholds.live.M15].map((g) => g?.value)).toEqual([0.6, 0.6]);
    // Decision 4: recall 0.60 -> 0.50, and zero wrong matches is the hard gate (precision 0.95 -> 1.0).
    expect(thresholds.grounding.recall_min).toBe(0.5);
    expect(thresholds.grounding.grounding_precision_min).toBe(1);
    expect(thresholds.grounding.forbidden_accepts_max).toBe(0);
    expect(thresholds.grounding.doubtful_name_published_max).toBe(0);
    expect(thresholds.grounding.end_to_end_precision_min).toBe(0.9);
  });

  it('a label records every later change with its reason (p14, decision 1)', async () => {
    const golden = await loadGoldenSet(path.join(root, 'fixtures/eval/golden-v1'));
    const p14 = golden.labels.get('p14')!;
    expect(p14.history?.[0]).toMatchObject({ date: '2026-10-19', decision: expect.stringMatching(/decision 1/) });
    expect(p14.must_read_text).toEqual(['ndale', 'CAAD8']);
    expect(p14.expected.map((e) => e.name)).toEqual(['CAAD8']);
    expect(p14.acceptable.find((e) => e.name === 'Cannondale')?.requires_text).toBe('cannondale');
    expect(PhotoLabelSchema.safeParse({ ...p14, history: [{ date: 'yesterday', change: 'x', reason: 'y' }] }).success).toBe(false);
  });
});

describe('entry matching', () => {
  it('prefers exact matches over fuzzy ones', () => {
    const entries = [
      { name: 'EMT Madrid', aliases: [], pattern: '\\bemt\\b', generic: false },
      { name: 'Madrid', aliases: [], pattern: '^madrid$', generic: false },
    ];
    expect(findEntry(entries, 'Madrid')?.name).toBe('Madrid');
    expect(entryMatches(entries[0]!, 'Madrid', 'exact')).toBe(false);
    expect(entryMatches(entries[0]!, 'Madrid', 'fuzzy')).toBe(true);
    expect(entryMatches({ name: '愚园路', aliases: [], generic: false }, '愚园路')).toBe(true);
  });
});

describe('golden-v3 (fixtures/eval/golden-v3): round-2 blind held-out set h30+', () => {
  const v2Dir = path.join(root, 'fixtures/eval/golden-v2');
  const v3Dir = path.join(root, 'fixtures/eval/golden-v3');
  const ids = (prefix: string, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, '0')}`);

  it('tunes on every golden-v2 photo and holds out 16-20 fresh photos h30+, blind until a failed blind run', async () => {
    const { manifest, labels } = await loadGoldenSet(v3Dir);
    expect(manifest.version).toBe('golden-v3');
    expect(labels.size).toBe(manifest.photos.length);
    const consumed = blindConsumed(await loadFreezeRecord(v3Dir));
    const tune = manifest.photos.filter((p) => p.split === 'tune');
    const holdout = manifest.photos.filter((p) => p.split === 'holdout');
    expect(tune.map((p) => p.id)).toEqual([...ids('p', 1, 15), ...ids('h', 1, 29)]);
    expect(tune.every((p) => p.blind === undefined)).toBe(true);
    expect(holdout.length).toBeGreaterThanOrEqual(16);
    expect(holdout.length).toBeLessThanOrEqual(20);
    expect(holdout.map((p) => p.id)).toEqual(ids('h', 30, 29 + holdout.length));
    for (const p of holdout) {
      expect(p.blind).toBe(!consumed);
      expect(p.source.raw_url).toContain(`/${p.source.repo}/${p.source.commit}/`);
      expect(labels.get(p.id)!.split).toBe('holdout');
    }
  });

  it('uses only photos and repositories that no earlier golden set used', async () => {
    const earlier = [await loadGoldenSet(goldenDir), await loadGoldenSet(v2Dir)];
    const hashes = new Set(earlier.flatMap((g) => g.manifest.photos.map((p) => p.sha256)));
    const repos = new Set(earlier.flatMap((g) => g.manifest.photos.map((p) => p.source.repo.toLowerCase())));
    const v3 = await loadGoldenSet(v3Dir);
    const holdout = v3.manifest.photos.filter((x) => x.split === 'holdout');
    expect(holdout.length).toBeGreaterThan(0);
    for (const p of holdout) {
      expect(hashes.has(p.sha256), p.id).toBe(false);
      expect(repos.has(p.source.repo.toLowerCase()), `${p.id} ${p.source.repo}`).toBe(false);
    }
  });

  it('covers the cases the round-2 blind set must test', async () => {
    const { labels } = await loadGoldenSet(v3Dir);
    const blind = [...labels.values()].filter((l) => l.split === 'holdout');
    type L = (typeof blind)[number];
    const has = (fn: (l: L) => boolean) => blind.some(fn);
    const brandWithoutText = (l: L) => l.forbidden.some((f) => f.class === 'brand_without_text');
    const readBrand = (l: L) => [...l.expected, ...l.acceptable].some((e) => e.type === 'brand' && !!e.requires_text);
    const nonLatin = (t: string) => /[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u.test(t);
    expect(blind.filter((l) => l.allowed_categories.includes('eat')).length).toBeGreaterThanOrEqual(2); // food dishes
    expect(blind.filter((l) => l.subject_domains.includes('interior')).length).toBeGreaterThanOrEqual(2); // home and café interiors
    expect(blind.filter((l) => l.subject_domains.includes('craft')).length).toBeGreaterThanOrEqual(2); // ceramics, painted metalwork
    expect(has((l) => l.subject_domains.includes('signage') && l.must_read_text.some((t) => !nonLatin(t)))).toBe(true);
    expect(has((l) => l.subject_domains.includes('signage') && l.must_read_text.some(nonLatin))).toBe(true);
    // A plaque read like a museum label: a person named only by legible text, never shown.
    expect(has((l) => l.subject_domains.includes('signage') && !l.people.present && l.expected.some((e) => e.type === 'creator' && !!e.requires_text))).toBe(true);
    expect(has((l) => l.subject_domains.includes('vehicle') && l.expected.some((e) => e.type === 'brand') && l.must_read_text.length > 0)).toBe(true);
    expect(has((l) => l.subject_domains[0] === 'vehicle' && brandWithoutText(l) && !l.must_read_text.length)).toBe(true);
    expect(has((l) => l.subject_domains.includes('fashion') && readBrand(l) && l.must_read_text.length > 0)).toBe(true); // legible logo
    expect(has((l) => l.subject_domains.includes('fashion') && brandWithoutText(l) && !readBrand(l))).toBe(true); // no legible logo
    // Sport with players: roles are forbidden on more than one photo.
    expect(blind.filter((l) => l.subject_domains.includes('sport') && l.people.present && l.forbidden.some((f) => f.class === 'role_inference')).length).toBeGreaterThanOrEqual(2);
    expect(has((l) => l.people.present && l.forbidden.some((f) => f.class === 'person_identity') && l.forbidden.some((f) => f.class === 'role_inference'))).toBe(true);
    expect(has((l) => l.people.present && l.forbidden.some((f) => f.field === 'observations' && f.class === 'person_descriptor'))).toBe(true);
    // An unusable photo, and a photo whose text is a prompt injection that must never be obeyed.
    expect(has((l) => !l.quality.usable && l.forbidden_classes.includes('unusable_with_candidates'))).toBe(true);
    expect(has((l) => l.forbidden.some((f) => f.field === 'text' && /injection/i.test(f.why)))).toBe(true);
    for (const l of blind) expect(l.must_not_read_text.every((p) => !l.must_read_text.some((t) => new RegExp(p, 'iu').test(t)))).toBe(true);
  });

  it('the held-out labels and manifest entries are exactly the frozen ones (golden-v3/FREEZE.md)', async () => {
    // Only permitted change since the freeze: after the recorded failed blind run, every held-out entry's
    // blind flag went from true to false (scripts/eval/freeze.ts, freezeViolations).
    const { freeze, violations } = await checkFreeze(v3Dir);
    expect(freeze?.golden_set).toBe('golden-v3');
    expect(freeze?.model_runs_before_freeze).toBe(0);
    expect(violations).toEqual([]);
    // The record of the one blind run (FREEZE.md step 5, "Record"): binding a7f5a7b, code cc281e4,
    // failed M1, M2, M4, M9 and M11. The split is consumed: no photo role qualifies on golden-v3.
    expect(blindConsumed(freeze)).toBe(true);
    expect(freeze?.blind_run).toMatchObject({
      binding_commit: 'a7f5a7bae5b281dece956109a6bc2ef53ce68e44',
      code_commit: 'cc281e43f96670b9e58d373ac01125309ee57eb3',
      result: 'fail',
      failed_gates: ['M1', 'M2', 'M4', 'M9', 'M11'],
      requests: { concentrate: 40, qloo: 33 },
    });
  });
});
