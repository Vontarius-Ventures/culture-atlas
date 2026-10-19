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

describe('label and manifest schemas', () => {
  it('rejects an entry with neither a name nor a pattern, and an invalid regular expression', () => {
    expect(PhotoLabelSchema.safeParse({ ...label('p01'), expected: [{ aliases: [] }] }).success).toBe(false);
    expect(PhotoLabelSchema.safeParse({ ...label('p01'), forbidden: [{ pattern: '(', why: 'x' }] }).success).toBe(false);
  });

  it('ties p* ids to the tune split and h* ids to held-out', () => {
    expect(PhotoLabelSchema.safeParse({ ...label('p01'), split: 'holdout' }).success).toBe(false);
    expect(PhotoLabelSchema.safeParse(label('h01')).success).toBe(true);
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
    expect(thresholds.version).toBe('thr-v1');
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(thresholds.replay.M1).toEqual({ op: '==', value: 0 });
    expect(thresholds.replay.M3).toEqual({ op: '>=', value: 0.85 });
    expect(thresholds.live.M2).toEqual({ op: '<=', value: 0.05 });
    expect(thresholds.live.M14_stage1_p95).toEqual({ op: '<=', value: 6000 });
    expect(thresholds.live_tune.M5).toEqual({ op: '>=', value: 0.8 });
    expect(ThresholdsSchema.safeParse({ ...thresholds, replay: { X1: { op: '==', value: 0 } } }).success).toBe(false);
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
