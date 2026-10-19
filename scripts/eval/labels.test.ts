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
  sha256Hex,
} from './labels';
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

  it('tunes on p01-p15 plus the no-longer-blind h01-h13, and holds out 12-16 blind photos h14+', async () => {
    const { manifest, labels } = await loadGoldenSet(v2Dir);
    const tune = manifest.photos.filter((p) => p.split === 'tune');
    const holdout = manifest.photos.filter((p) => p.split === 'holdout');
    expect(tune.map((p) => p.id)).toEqual([...ids('p', 1, 15), ...ids('h', 1, 13)]);
    expect(tune.every((p) => p.blind === undefined)).toBe(true);
    expect(holdout.length).toBeGreaterThanOrEqual(12);
    expect(holdout.length).toBeLessThanOrEqual(16);
    expect(holdout.map((p) => p.id)).toEqual(ids('h', 14, 13 + holdout.length));
    for (const p of holdout) {
      expect(p.blind).toBe(true);
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
    const freeze = JSON.parse(await readFile(path.join(v2Dir, 'freeze.json'), 'utf8')) as {
      golden_set: string;
      holdout_manifest_sha256: string;
      photos: Record<string, { label_sha256: string; photo_sha256: string }>;
    };
    const manifest = JSON.parse(await readFile(path.join(v2Dir, 'manifest.json'), 'utf8')) as { version: string; photos: { id: string; split: string; sha256: string }[] };
    const holdout = manifest.photos.filter((p) => p.split === 'holdout');
    expect(freeze.golden_set).toBe(manifest.version);
    expect(Object.keys(freeze.photos).sort()).toEqual(holdout.map((p) => p.id).sort());
    expect(sha256Hex(JSON.stringify(holdout))).toBe(freeze.holdout_manifest_sha256);
    for (const p of holdout) {
      const raw = (await readFile(path.join(v2Dir, 'labels', `${p.id}.json`), 'utf8')).replace(/\r\n/g, '\n');
      expect({ id: p.id, label: sha256Hex(raw), photo: p.sha256 }).toEqual({
        id: p.id,
        label: freeze.photos[p.id]!.label_sha256,
        photo: freeze.photos[p.id]!.photo_sha256,
      });
    }
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
