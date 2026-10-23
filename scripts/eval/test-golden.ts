import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { REQUIRED_GOLDEN_SET, type EvalBindingLike } from '../../packages/providers/src/concentrate/profiles';
import { solidJpeg } from '../../packages/providers/src/testing/images';
import { GUARDRAIL_VERSION } from '../../packages/providers/src/vlm/guardrails';
import { BOUND_CODE, codeDigest } from './binding';
import { goldenDigest, loadGoldenSet, sha256Hex, type PhotoLabel } from './labels';
import { unguardedPipeline, type ReadingPipeline } from './pipeline';
import { SCORER_VERSION } from './scorer';

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

/** The golden set the photo roles must qualify on; synthetic sets carry its name so the set gate is exercised past the name check. */
export const PHOTO_GOLDEN_SET = REQUIRED_GOLDEN_SET.vision_photo!;

export async function syntheticGolden(ids: readonly string[], prefix = 'ca-golden-'): Promise<{ dir: string; photosDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const dir = path.join(root, PHOTO_GOLDEN_SET);
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
      ...(id.startsWith('p') ? {} : { blind: true }),
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
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ version: PHOTO_GOLDEN_SET, photos }));
  return { dir, photosDir };
}

/** The unguarded pipeline wearing a guardrail version: a test double for harness plumbing only. */
export const versionedTestPipeline: ReadingPipeline = {
  ...unguardedPipeline,
  name: 'guarded',
  guardrailVersion: GUARDRAIL_VERSION,
};

const REPO = path.resolve(import.meta.dirname, '../..');

/**
 * The binding a synthetic set would have if it were committed: its own
 * golden digest, the thresholds file, the scorer version and the repository's
 * bound code. Lets the harness tests exercise the binding gate with temp
 * golden sets; undefined when the inputs cannot be read (the harness then
 * reports its own error first).
 */
export async function syntheticBinding(o: {
  golden?: { dir: string };
  fixturesDir?: string;
  textScorer?: { version?: string };
  thresholdsFile?: string;
}): Promise<EvalBindingLike | undefined> {
  try {
    const thresholds = sha256Hex(await readFile(o.thresholdsFile ?? path.join(REPO, 'fixtures/eval/thresholds.json')));
    if (o.golden) {
      const golden = await loadGoldenSet(o.golden.dir);
      const set = golden.manifest.version;
      return {
        thresholds_sha256: thresholds,
        sets: { [set]: { golden_sha256: goldenDigest(golden), scorer_version: SCORER_VERSION, code_sha256: await codeDigest(REPO, BOUND_CODE[set]!) } },
      };
    }
    if (o.fixturesDir) {
      const manifest = JSON.parse(await readFile(path.join(path.dirname(o.fixturesDir), 'manifest.json'), 'utf8')) as { golden_set: string; golden_sha256: string };
      return {
        thresholds_sha256: thresholds,
        sets: {
          [manifest.golden_set]: {
            golden_sha256: manifest.golden_sha256,
            scorer_version: o.textScorer?.version ?? 'scoreTextFixture',
            code_sha256: await codeDigest(REPO, BOUND_CODE[manifest.golden_set]!),
          },
        },
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
