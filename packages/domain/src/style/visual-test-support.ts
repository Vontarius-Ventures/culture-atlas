import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import sharp from 'sharp';
import { storedAesthetic, storedSubject } from './test-support';
import { VisualCatalogSchema, visualSha256, type VisualCatalog } from './visual-catalog';
import type { StoredStyleReading } from './types';

/** Explicitly synthetic local fixtures; never acquired museum evidence. */
export async function syntheticVisualCatalog(count = 2) {
  const dir = await realpath(await mkdtemp('/tmp/atlas-visual-'));
  const objects = [];
  for (let n = 1; n <= count; n++) {
    const bytes = await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: n * 40, g: 50, b: 90 } } }).jpeg().toBuffer();
    await writeFile(`${dir}/${n}.jpg`, bytes);
    objects.push({
      id: `met:${n}`, institution: 'SYNTHETIC TEST MUSEUM — not acquired', title: `Synthetic vessel ${n}`,
      object_type: 'Vase', medium: 'Synthetic metadata', object_date: 'Synthetic',
      source_url: `https://www.metmuseum.org/art/collection/search/${n}`,
      image_url: `https://images.metmuseum.org/CRDImages/test/original/${n}.jpg`,
      license: 'CC0' as const, is_public_domain: true as const, image_path: `${n}.jpg`,
      image_sha256: visualSha256(bytes), width: 16, height: 12, tags: ['synthetic'], retrieved_at: '2026-10-27T00:00:00Z',
    });
  }
  const catalog: VisualCatalog = VisualCatalogSchema.parse({
    schema_version: 'atlas_visual_catalog_v1', catalog_version: 'synthetic-test-v1', generated_at: '2026-10-27T00:00:00Z',
    asset_root: dir, acquisition_status: 'complete', objects,
  });
  const file = `${dir}/catalog.json`;
  await writeFile(file, JSON.stringify(catalog));
  return { dir, file, catalog, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
export function syntheticVisualReading(): StoredStyleReading {
  return {
    schema: 'atlas_style_reading_v1', wording_version: 'synthetic', guard_version: 'synthetic', vocab_version: 'synthetic',
    rev: 1, model: { role: 'vision_style', profile: 'synthetic', model: 'synthetic', experimental: true, ms: 0 },
    image: { width: 16, height: 12, frame_index: null }, swatches: [], summary: 'Synthetic vase fixture',
    subjects: [storedSubject({ category: 'interior', label: 'Ceramic vase', aesthetics: [storedAesthetic('Rounded form')] })],
    dropped: [], held: [], retracted: [],
  };
}
