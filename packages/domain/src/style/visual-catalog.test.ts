import { afterEach, describe, expect, it } from 'vitest';
import { symlink, unlink, writeFile } from 'node:fs/promises';
import { AnyVisualCatalogSchema, COMMONS_LICENSES, CommonsVisualCatalogObjectSchema, loadVisualCatalog, readVisualCatalogImage, VisualCatalogSchema, VisualCatalogV2Schema, visualSha256 } from './visual-catalog';
import { syntheticVisualCatalog } from './visual-test-support';
import { getVisualReferenceImage } from './visual-reference-image';
import { testConfig } from '../testing';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });
async function fixture() { const f = await syntheticVisualCatalog(); cleanups.push(f.cleanup); return f; }

describe('bounded public visual catalog', () => {
  it('loads only a local configured catalog and validates hash/type/dimensions on every read', async () => {
    const f = await fixture();
    const loaded = await loadVisualCatalog(f.file);
    expect(loaded?.catalog.catalog_version).toBe('synthetic-test-v1');
    expect(loaded?.hash).toMatch(/^[a-f0-9]{64}$/);
    const image = await readVisualCatalogImage(f.catalog, f.catalog.objects[0]!);
    expect(image.contentType).toBe('image/jpeg');
    expect(visualSha256(image.bytes)).toBe(f.catalog.objects[0]!.image_sha256);
    await writeFile(`${f.dir}/1.jpg`, 'changed');
    await expect(readVisualCatalogImage(f.catalog, f.catalog.objects[0]!)).rejects.toThrow();
  });
  it.each([undefined, 'relative.json', 'https://images.metmuseum.org/catalog.json', '/tmp/nonexistent-visual-catalog'])(
    'fails closed for missing/nonlocal config %s', async file => expect(await loadVisualCatalog(file)).toBeNull());
  it('rejects traversal, nonpublic records, external/private hosts, credentials, source mismatch and oversized catalogs', async () => {
    const f = await fixture();
    for (const patch of [
      { image_path: '../secret.jpg' }, { image_path: '/private/photo.jpg' }, { image_path: 'a\\b.jpg' },
      { is_public_domain: false }, { license: 'private' }, { width: 100_000 },
      { source_url: 'https://www.metmuseum.org/art/collection/search/3' },
      { image_url: 'https://127.0.0.1/photo.jpg' }, { image_url: 'https://images.metmuseum.org.evil.test/photo.jpg' },
      { image_url: 'https://user:secret@images.metmuseum.org/photo.jpg' },
      { image_url: 'http://images.metmuseum.org/photo.jpg' },
    ]) expect(VisualCatalogSchema.safeParse({ ...f.catalog, objects: [{ ...f.catalog.objects[0], ...patch }] }).success).toBe(false);
    expect(VisualCatalogSchema.safeParse({ ...f.catalog, objects: Array(501).fill(f.catalog.objects[0]) }).success).toBe(false);
    expect(VisualCatalogSchema.safeParse({ ...f.catalog, objects: [f.catalog.objects[0], f.catalog.objects[0]] }).success).toBe(false);
  });
  it('rejects symlink escape, wrong dimensions and non-image bytes even with a matching declared hash', async () => {
    const f = await fixture();
    await unlink(`${f.dir}/1.jpg`);
    await symlink('/etc/hosts', `${f.dir}/1.jpg`);
    await expect(readVisualCatalogImage(f.catalog, f.catalog.objects[0]!)).rejects.toThrow();
    await expect(readVisualCatalogImage(f.catalog, { ...f.catalog.objects[1]!, width: 15 })).rejects.toThrow();
    await unlink(`${f.dir}/1.jpg`);
    const bytes = Buffer.from('<svg onload="bad()"></svg>');
    await writeFile(`${f.dir}/1.jpg`, bytes);
    await expect(readVisualCatalogImage(f.catalog, { ...f.catalog.objects[0]!, image_sha256: visualSha256(bytes) })).rejects.toThrow();
  });
  it('serves by exact public catalog hash only, never URL/path/private storage keys', async () => {
    const f = await fixture();
    const config = testConfig({ VISUAL_REFERENCE_CATALOG_FILE: f.file });
    expect((await getVisualReferenceImage(config, f.catalog.objects[0]!.image_sha256))?.contentType).toBe('image/jpeg');
    for (const input of ['../1.jpg', f.catalog.objects[0]!.image_url, 'owners/private/derivative.jpg', 'f'.repeat(64)]) {
      expect(await getVisualReferenceImage(config, input)).toBeNull();
    }
  });
  it('preserves strict v1 while admitting only exact attribution-bound Commons v2 records', async () => {
    const f = await fixture();
    const item = {
      ...f.catalog.objects[0], id: 'commons:123', institution: 'Wikimedia Commons', title: 'SYNTHETIC room',
      object_type: 'bedroom', source_url: 'https://commons.wikimedia.org/?curid=123',
      image_url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Synthetic.jpg',
      license: 'CC-BY-SA-4.0', license_url: COMMONS_LICENSES['CC-BY-SA-4.0'], is_public_domain: false,
      creator: 'SYNTHETIC creator', attribution: 'SYNTHETIC credit', source_title: 'File:Synthetic.jpg',
      retrieval: { basis: 'static_query_hint_not_verified_identity', query_class: 'bedroom', depiction: 'scene' },
    };
    expect(CommonsVisualCatalogObjectSchema.safeParse(item).success).toBe(true);
    const v2 = { ...f.catalog, schema_version: 'atlas_visual_catalog_v2', objects: [f.catalog.objects[0], item] };
    expect(VisualCatalogV2Schema.safeParse(v2).success).toBe(true);
    expect(AnyVisualCatalogSchema.safeParse(f.catalog).success).toBe(true);
    expect(VisualCatalogSchema.safeParse(v2).success).toBe(false);
    expect(VisualCatalogSchema.safeParse({ ...f.catalog, objects: [item] }).success).toBe(false);
    for (const patch of [
      { source_url: 'https://commons.wikimedia.org/?curid=124' },
      { source_url: 'https://commons.wikimedia.org/?curid=123&other=1' },
      { source_url: 'https://commons.wikimedia.org/?curid=0123' },
      { source_url: 'https://commons.wikimedia.org/wiki/File:Synthetic.jpg' },
      { id: 'commons:0' }, { is_public_domain: true }, { license: 'CC-BY-SA-3.0' },
      { license_url: COMMONS_LICENSES['CC-BY-4.0'] }, { creator: '' }, { creator: undefined },
      { attribution: '' }, { attribution: '<b>credit</b>' }, { creator: 'secret\ntext' },
      { creator: 'a'.repeat(301), attribution: 'b'.repeat(301) },
      { image_url: 'https://images.metmuseum.org/a.jpg' },
      { image_url: 'https://upload.wikimedia.org.evil.invalid/wikipedia/commons/a/ab/Synthetic.jpg' },
      { retrieval: { ...item.retrieval, depiction: 'object' } },
      { object_type: 'vase' },
    ]) expect(CommonsVisualCatalogObjectSchema.safeParse({ ...item, ...patch }).success, JSON.stringify(patch)).toBe(false);
    expect(VisualCatalogV2Schema.safeParse({ ...v2, objects: [item, item] }).success).toBe(false);
    await writeFile(f.file, JSON.stringify(v2));
    expect((await loadVisualCatalog(f.file))?.catalog.schema_version).toBe('atlas_visual_catalog_v2');
    expect((await getVisualReferenceImage(testConfig({ VISUAL_REFERENCE_CATALOG_FILE: f.file }), item.image_sha256!))?.contentType).toBe('image/jpeg');
  });
  it('rejects symlinks even when their target is inside the asset root', async () => {
    const f = await fixture();
    await symlink(`${f.dir}/1.jpg`, `${f.dir}/inside.jpg`);
    await expect(readVisualCatalogImage(f.catalog, { ...f.catalog.objects[0]!, image_path: 'inside.jpg' })).rejects.toThrow();
    await symlink(f.file, `${f.dir}/manifest-link.json`);
    expect(await loadVisualCatalog(`${f.dir}/manifest-link.json`)).toBeNull();
  });
});
