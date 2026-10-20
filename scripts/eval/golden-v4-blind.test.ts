import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GoldenManifestSchema, ManifestPhotoSchema, PhotoLabelSchema, loadGoldenSet, type ManifestPhoto, type PhotoLabel } from './labels';
import { blindConsumed, freezeViolations, loadFreezeRecord } from './freeze';

/**
 * golden-v4 blind held-out split h50+ (requalification round 3, docs/requalification-plan.md
 * "Round 3: structural change" item 5; fixtures/eval/golden-v4/FREEZE.md).
 *
 * The held-out entries were curated on r3/blind, apart from the round-3 tune set. Until the two
 * branches are merged they live in `golden-v4/holdout-manifest.json`; the merge appends them to
 * `golden-v4/manifest.json` unchanged (same key order, so the frozen hash still holds) and removes
 * the fragment. These tests read whichever is present and hold either way.
 */

const root = path.resolve(import.meta.dirname, '../..');
const v4Dir = path.join(root, 'fixtures/eval/golden-v4');
const earlierDirs = ['golden-v1', 'golden-v2', 'golden-v3'].map((d) => path.join(root, 'fixtures/eval', d));

type RawPhoto = { id: string; split: string; sha256: string; blind?: boolean } & Record<string, unknown>;

/** The held-out manifest entries as written: from manifest.json once merged, else from the fragment. */
async function heldOutEntries(): Promise<{ version: string; photos: RawPhoto[]; from: string }> {
  const merged = path.join(v4Dir, 'manifest.json');
  const fragment = path.join(v4Dir, 'holdout-manifest.json');
  const from = existsSync(merged) && JSON.parse(await readFile(merged, 'utf8')).photos.some((p: RawPhoto) => p.split === 'holdout') ? merged : fragment;
  const m = JSON.parse(await readFile(from, 'utf8')) as { version: string; photos: RawPhoto[] };
  return { version: m.version, photos: m.photos.filter((p) => p.split === 'holdout'), from };
}

async function heldOutLabels(ids: readonly string[]): Promise<{ labels: Map<string, PhotoLabel>; text: Map<string, string> }> {
  const labels = new Map<string, PhotoLabel>();
  const text = new Map<string, string>();
  for (const id of ids) {
    const raw = await readFile(path.join(v4Dir, 'labels', `${id}.json`), 'utf8');
    text.set(id, raw);
    labels.set(id, PhotoLabelSchema.parse(JSON.parse(raw)));
  }
  return { labels, text };
}

const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `h${from + i}`);

describe('golden-v4 (fixtures/eval/golden-v4): round-3 blind held-out split h50+', () => {
  it('holds out 24-30 fresh photos h50+, pinned by sha256 and commit, blind until a failed blind run', async () => {
    const { version, photos, from } = await heldOutEntries();
    expect(version).toBe('golden-v4');
    expect(photos.length).toBeGreaterThanOrEqual(24);
    expect(photos.length).toBeLessThanOrEqual(30);
    expect(photos.map((p) => p.id)).toEqual(ids(50, 49 + photos.length));
    const consumed = blindConsumed(await loadFreezeRecord(v4Dir));
    const parsed: ManifestPhoto[] = photos.map((p) => ManifestPhotoSchema.parse(p));
    for (const p of parsed) {
      expect(p.blind, p.id).toBe(!consumed);
      expect(p.source.raw_url, p.id).toBe(`https://raw.githubusercontent.com/${p.source.repo}/${p.source.commit}/${p.source.path}`);
    }
    // The fragment is a valid manifest on its own (unique ids and hashes).
    if (from.endsWith('holdout-manifest.json')) expect(GoldenManifestSchema.safeParse({ version, photos }).success).toBe(true);
    const { labels } = await heldOutLabels(parsed.map((p) => p.id));
    for (const p of parsed) {
      const l = labels.get(p.id)!;
      expect(l.split, p.id).toBe('holdout');
      expect(l.file, p.id).toBe(p.file);
    }
  });

  it('once merged, the full golden-v4 set loads and holds exactly the fragment entries (no fragment left behind)', async () => {
    const merged = path.join(v4Dir, 'manifest.json');
    if (!existsSync(merged)) return; // r3/blind alone: no tune manifest yet (FREEZE.md "Merging")
    const golden = await loadGoldenSet(v4Dir);
    expect(golden.manifest.version).toBe('golden-v4');
    expect(existsSync(path.join(v4Dir, 'holdout-manifest.json'))).toBe(false);
    expect(golden.manifest.photos.filter((p) => p.split === 'holdout').length).toBeGreaterThanOrEqual(24);
  });

  it('uses only photos and repositories that no earlier golden set used', async () => {
    const earlier = await Promise.all(earlierDirs.map((d) => loadGoldenSet(d)));
    const hashes = new Set(earlier.flatMap((g) => g.manifest.photos.map((p) => p.sha256)));
    const repos = new Set(earlier.flatMap((g) => g.manifest.photos.map((p) => p.source.repo.toLowerCase())));
    const { photos } = await heldOutEntries();
    for (const p of photos.map((x) => ManifestPhotoSchema.parse(x))) {
      expect(hashes.has(p.sha256), p.id).toBe(false);
      expect(repos.has(p.source.repo.toLowerCase()), `${p.id} ${p.source.repo}`).toBe(false);
    }
  });

  it('covers the cases round 3 asks of the blind set', async () => {
    const { photos } = await heldOutEntries();
    const { labels } = await heldOutLabels(photos.map((p) => p.id));
    const blind = [...labels.values()];
    type L = PhotoLabel;
    const has = (fn: (l: L) => boolean) => blind.some(fn);
    const count = (fn: (l: L) => boolean) => blind.filter(fn).length;
    const brandWithoutText = (l: L) => l.forbidden.some((f) => f.class === 'brand_without_text');
    const readBrand = (l: L) => [...l.expected, ...l.acceptable].some((e) => e.type === 'brand' && !!e.requires_text);
    const nonLatin = (t: string) => /[^\p{Script=Latin}\p{N}\p{P}\p{S}\s]/u.test(t);
    const occasionTrap = (l: L) =>
      l.people.present && l.forbidden.some((f) => f.class === 'role_inference' && /wedding|engage|birthday|trooping|ceremon|parade|celebration/.test(f.pattern));

    expect(count((l) => l.allowed_categories.includes('eat') && l.subject_domains.includes('food'))).toBeGreaterThanOrEqual(3); // dishes, pastry, drink
    expect(count((l) => l.subject_domains.includes('interior'))).toBeGreaterThanOrEqual(3); // café, home, church
    expect(has((l) => l.subject_domains.includes('interior') && /caf[eé]|restaurant/i.test(JSON.stringify(l.expected)))).toBe(true); // a café or restaurant seen as a room
    expect(count((l) => l.subject_domains.includes('craft'))).toBeGreaterThanOrEqual(2); // ceramics, calligraphy scroll
    expect(count((l) => l.subject_domains.includes('art') && l.expected.some((e) => e.type === 'work'))).toBeGreaterThanOrEqual(2); // painting, sculpture
    // Signage: Latin and non-Latin must-read text, and must-read strings printed over more than one line.
    expect(has((l) => l.subject_domains.includes('signage') && l.must_read_text.some((t) => !nonLatin(t)))).toBe(true);
    expect(count((l) => l.must_read_text.some(nonLatin))).toBeGreaterThanOrEqual(2);
    expect(count((l) => /MULTI-LINE MUST-READ/.test(l.notes ?? '') && l.must_read_text.some((t) => /\s/.test(t)))).toBeGreaterThanOrEqual(2);
    // Vehicles with and without a legible badge (no plate number is ever to be read).
    expect(has((l) => l.subject_domains.includes('vehicle') && l.expected.some((e) => e.type === 'brand') && l.must_read_text.length > 0)).toBe(true);
    expect(has((l) => l.subject_domains[0] === 'vehicle' && brandWithoutText(l) && !l.must_read_text.length && l.must_not_read_text.length > 0)).toBe(true);
    // Clothing with and without a legible logo.
    expect(has((l) => l.subject_domains.includes('fashion') && readBrand(l) && l.must_read_text.length > 0)).toBe(true);
    expect(has((l) => l.subject_domains.includes('fashion') && brandWithoutText(l) && !readBrand(l))).toBe(true);
    // People: sport roles, occasions inferred about people, well-known people never identified.
    expect(count((l) => l.subject_domains.includes('sport') && l.people.present && l.forbidden.some((f) => f.class === 'role_inference'))).toBeGreaterThanOrEqual(2);
    expect(count(occasionTrap)).toBeGreaterThanOrEqual(3);
    expect(has((l) => l.people.present && /WELL-KNOWN PEOPLE/.test(l.notes ?? '') && l.forbidden.some((f) => f.class === 'person_identity'))).toBe(true);
    expect(count((l) => l.people.present && l.forbidden.some((f) => f.field === 'observations' && f.class === 'person_descriptor'))).toBeGreaterThanOrEqual(5);
    // Unusable (dark and blurred), a prompt injection that must never be obeyed, a weak-style trap.
    expect(has((l) => !l.quality.usable && l.quality.issue === 'too_dark' && l.forbidden_classes.includes('unusable_with_candidates'))).toBe(true);
    expect(has((l) => !l.quality.usable && l.quality.issue === 'blurred' && l.forbidden_classes.includes('unusable_with_candidates'))).toBe(true);
    expect(has((l) => l.forbidden.some((f) => f.field === 'text' && /injection/i.test(f.why)))).toBe(true);
    expect(count((l) => l.subject_domains.includes('interior') && l.forbidden.some((f) => /scandinavian|mid-?century|gothic/.test(f.pattern)))).toBeGreaterThanOrEqual(2);
    for (const l of blind) expect(l.must_not_read_text.every((p) => !l.must_read_text.some((t) => new RegExp(p, 'iu').test(t))), l.id).toBe(true);
  });

  it('the held-out labels and manifest entries are exactly the frozen ones (golden-v4/FREEZE.md)', async () => {
    const freeze = await loadFreezeRecord(v4Dir);
    expect(freeze?.golden_set).toBe('golden-v4');
    expect(freeze?.model_runs_before_freeze).toBe(0);
    const { version, photos } = await heldOutEntries();
    const { text } = await heldOutLabels(photos.map((p) => p.id));
    expect(freezeViolations({ manifestVersion: version, manifestPhotos: photos, labelText: text, freeze: freeze! })).toEqual([]);
  });

  it('the freeze check catches an edited held-out label, a changed manifest entry and a missing photo', async () => {
    const freeze = (await loadFreezeRecord(v4Dir))!;
    const { version, photos } = await heldOutEntries();
    const { text } = await heldOutLabels(photos.map((p) => p.id));
    const edited = new Map(text);
    edited.set('h50', text.get('h50')!.replace('"usable": true', '"usable": false'));
    expect(freezeViolations({ manifestVersion: version, manifestPhotos: photos, labelText: edited, freeze })).toEqual(['h50: label differs from the frozen one']);
    const moved = photos.map((p, i) => (i === 0 ? { ...p, width: 1 } : p));
    expect(freezeViolations({ manifestVersion: version, manifestPhotos: moved, labelText: text, freeze })).toContain(
      'the held-out manifest entries differ from the frozen ones (beyond the blind flag)',
    );
    expect(freezeViolations({ manifestVersion: version, manifestPhotos: photos.slice(1), labelText: text, freeze }).length).toBeGreaterThan(0);
  });
});
