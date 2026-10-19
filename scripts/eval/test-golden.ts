import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { solidJpeg } from '../../packages/providers/src/testing/images';
import { sha256Hex, type PhotoLabel } from './labels';
import { unguardedPipeline, type ReadingPipeline } from './pipeline';

/**
 * Test helpers: a synthetic golden set in a temp dir (solid-colour JPEGs, not
 * real photos) and a pipeline double that reports a guardrail version. They
 * exercise plumbing and gates; they never stand in for a real evaluation.
 */

export function label(id: string, overrides: Partial<PhotoLabel> = {}): PhotoLabel {
  return {
    id,
    split: id.startsWith('p') ? 'tune' : 'holdout',
    file: `${id}.jpg`,
    subject_domains: ['interior'],
    quality: { usable: true, issue: null },
    expected: [{ name: 'Mid-century modern', aliases: [], pattern: 'mid-?century', generic: false }],
    acceptable: [],
    forbidden: [{ pattern: 'eames', field: 'candidate', why: 'no designer piece is identifiable' }],
    forbidden_classes: ['brand_without_text', 'medium', 'person_identity', 'person_descriptor', 'role_inference', 'cuisine_without_food'],
    allowed_categories: [],
    must_read_text: [],
    must_not_read_text: [],
    people: { present: false },
    qloo: { forbidden_entity_types: [], forbidden_tag_families: [] },
    ...overrides,
  };
}

export async function syntheticGolden(ids: readonly string[], prefix = 'ca-golden-'): Promise<{ dir: string; photosDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const dir = path.join(root, 'golden-v1');
  const photosDir = path.join(root, 'photos');
  await mkdir(path.join(dir, 'labels'), { recursive: true });
  await mkdir(photosDir, { recursive: true });
  const photos = [];
  for (const [i, id] of ids.entries()) {
    const bytes = await solidJpeg(640, 480, `#${(i * 20 + 16).toString(16).padStart(2, '0')}6040`);
    await writeFile(path.join(photosDir, `${id}.jpg`), bytes);
    await writeFile(path.join(dir, 'labels', `${id}.json`), JSON.stringify(label(id)));
    photos.push({
      id,
      split: id.startsWith('p') ? 'tune' : 'holdout',
      file: `${id}.jpg`,
      sha256: sha256Hex(bytes),
      width: 640,
      height: 480,
      source: {
        repo: 'fixture/photos',
        path: `${id}.jpg`,
        commit: '0'.repeat(40),
        license: 'test-only',
        raw_url: `https://raw.githubusercontent.com/fixture/photos/${'0'.repeat(40)}/${id}.jpg`,
      },
    });
  }
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: 'golden-v1', photos }));
  return { dir, photosDir };
}

/** The unguarded pipeline wearing a guardrail version: a test double for harness plumbing only. */
export const versionedTestPipeline: ReadingPipeline = {
  ...unguardedPipeline,
  name: 'guarded',
  guardrailVersion: 'guard-v1',
};
