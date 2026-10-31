import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';

export const VISUAL_CATALOG_LIMITS = { objects: 500, manifestBytes: 2_000_000, imageBytes: 8_000_000, pixels: 20_000_000 } as const;
export const VisualImageHash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(300);
function officialUrl(value: string, hosts: string[], object = false): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && hosts.includes(u.hostname) && !u.port && !u.username && !u.password &&
      (!object || /^\/art\/collection\/search\/[1-9]\d*\/?$/.test(u.pathname)) && !u.hash && !u.search;
  } catch { return false; }
}
export const VisualCatalogObjectSchema = z.strictObject({
  id: z.string().regex(/^met:[1-9]\d*$/),
  institution: text,
  title: text,
  object_type: text,
  medium: z.string().max(600),
  object_date: z.string().max(200),
  source_url: z.string().max(1000).refine(v => officialUrl(v, ['www.metmuseum.org', 'metmuseum.org'], true)),
  image_url: z.string().max(2000).refine(v => officialUrl(v, ['images.metmuseum.org', 'collectionapi.metmuseum.org'])),
  license: z.literal('CC0'),
  is_public_domain: z.literal(true),
  image_path: z.string().min(1).max(300).refine(v => !path.isAbsolute(v) && !v.includes('\\') &&
    v.split('/').every(p => p !== '' && p !== '.' && p !== '..') && /\.(jpe?g|png|webp)$/i.test(v)),
  image_sha256: VisualImageHash,
  width: z.number().int().positive().max(20_000),
  height: z.number().int().positive().max(20_000),
  tags: z.array(z.string().min(1).max(100)).max(40),
  retrieved_at: z.iso.datetime({ offset: true }),
}).refine(v => v.width * v.height <= VISUAL_CATALOG_LIMITS.pixels)
  .refine(v => {
    try { return new URL(v.source_url).pathname.replace(/\/$/, '').endsWith('/' + v.id.slice(4)); }
    catch { return false; }
  });
export const VisualCatalogSchema = z.strictObject({
  schema_version: z.literal('atlas_visual_catalog_v1'),
  catalog_version: z.string().min(1).max(100),
  generated_at: z.iso.datetime({ offset: true }),
  asset_root: z.string().max(2000).refine(v => path.isAbsolute(v)),
  acquisition_status: z.enum(['complete', 'partial']),
  objects: z.array(VisualCatalogObjectSchema).max(VISUAL_CATALOG_LIMITS.objects),
}).refine(v => new Set(v.objects.map(o => o.id)).size === v.objects.length);
/** v1 remains a strict, unchanged Met/explicit-public-domain contract. */
export const COMMONS_LICENSES = {
  CC0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
} as const;
export const COMMONS_QUERY_CLASSES = ['outfit', 'jacket', 'shirt', 'shoes', 'bedroom', 'interior', 'bed', 'mug', 'vase', 'sculpture'] as const;
const plainText = z.string().trim().min(1).max(1000).refine(v => !/[<>]/.test(v) &&
  [...v].every(c => c.charCodeAt(0) >= 32 && !(c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)));
export function officialCommonsImageUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return !/[\\\s]/.test(value) && officialUrl(value, ['upload.wikimedia.org']) &&
      /^\/wikipedia\/commons\/[a-f0-9]\/[a-f0-9]{2}\/[^/]+$/.test(u.pathname) &&
      !/%(?:2f|5c|00)/i.test(u.pathname);
  } catch { return false; }
}
export const CommonsVisualCatalogObjectSchema = z.strictObject({
  ...VisualCatalogObjectSchema.shape,
  id: z.string().regex(/^commons:[1-9]\d*$/),
  institution: z.literal('Wikimedia Commons'),
  title: plainText.max(300),
  object_type: z.enum(COMMONS_QUERY_CLASSES),
  source_url: z.string().max(1000),
  image_url: z.string().max(2000).refine(officialCommonsImageUrl),
  license: z.enum(['CC0', 'CC-BY-4.0', 'CC-BY-SA-4.0']),
  license_url: z.enum(Object.values(COMMONS_LICENSES) as [string, ...string[]]),
  is_public_domain: z.boolean(),
  creator: plainText,
  attribution: plainText,
  source_title: plainText.max(300).refine(v => v.startsWith('File:')),
  retrieval: z.strictObject({
    basis: z.literal('static_query_hint_not_verified_identity'),
    query_class: z.enum(COMMONS_QUERY_CLASSES),
    depiction: z.enum(['scene', 'object']),
  }),
}).refine(v => v.source_url === `https://commons.wikimedia.org/?curid=${v.id.slice(8)}`)
  .refine(v => (v.creator === v.attribution ? v.creator : `${v.creator}; ${v.attribution}`).length <= 600)
  .refine(v => v.license_url === COMMONS_LICENSES[v.license] && v.is_public_domain === (v.license === 'CC0'))
  .refine(v => v.width * v.height <= VISUAL_CATALOG_LIMITS.pixels)
  .refine(v => v.object_type === v.retrieval.query_class &&
    v.retrieval.depiction === (['bedroom', 'interior'].includes(v.object_type) ? 'scene' : 'object'));
export const VisualCatalogV2ObjectSchema = z.union([VisualCatalogObjectSchema, CommonsVisualCatalogObjectSchema]);
export const VisualCatalogV2Schema = z.strictObject({
  ...VisualCatalogSchema.shape,
  schema_version: z.literal('atlas_visual_catalog_v2'),
  objects: z.array(VisualCatalogV2ObjectSchema).max(VISUAL_CATALOG_LIMITS.objects),
}).refine(v => new Set(v.objects.map(o => o.id)).size === v.objects.length);
export const AnyVisualCatalogSchema = z.union([VisualCatalogSchema, VisualCatalogV2Schema]);
export type VisualCatalogV1 = z.infer<typeof VisualCatalogSchema>;
export type CommonsVisualCatalogObject = z.infer<typeof CommonsVisualCatalogObjectSchema>;
export type VisualCatalog = z.infer<typeof AnyVisualCatalogSchema>;
export type VisualCatalogObject = z.infer<typeof VisualCatalogV2ObjectSchema>;
export type LoadedVisualCatalog = { catalog: VisualCatalog; hash: string };
export const visualSha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

async function boundedFile(file: string, max: number): Promise<Buffer> {
  // Nonblocking rejects FIFO/device inputs; NOFOLLOW closes final-component symlink races.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.size <= 0 || s.size > max) throw new Error('invalid_catalog_asset');
    const bytes = Buffer.alloc(s.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== s.size) throw new Error('changed_catalog_asset');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
async function canonicalNoSymlinks(file: string): Promise<string> {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error('invalid_catalog_asset');
  let current = path.parse(file).root;
  for (const component of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('invalid_catalog_asset');
  }
  if (await realpath(file) !== file) throw new Error('invalid_catalog_asset');
  return file;
}
/** Local-only. No remote fetching; invalid or missing operator configuration fails closed. */
export async function loadVisualCatalog(file: string | undefined): Promise<LoadedVisualCatalog | null> {
  if (!file || !path.isAbsolute(file)) return null;
  try {
    const bytes = await boundedFile(await canonicalNoSymlinks(file), VISUAL_CATALOG_LIMITS.manifestBytes);
    const catalog = AnyVisualCatalogSchema.parse(JSON.parse(bytes.toString('utf8')));
    const root = await canonicalNoSymlinks(catalog.asset_root);
    if (!(await stat(root)).isDirectory()) return null;
    return { catalog: { ...catalog, asset_root: root }, hash: visualSha256(bytes) };
  } catch { return null; }
}
/** Revalidates containment, type, dimensions and hash every read, including HTTP delivery. */
export async function readVisualCatalogImage(catalog: VisualCatalog, item: VisualCatalogObject): Promise<{ bytes: Buffer; contentType: string }> {
  const root = await canonicalNoSymlinks(catalog.asset_root);
  const file = await canonicalNoSymlinks(path.join(root, item.image_path));
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('invalid_catalog_asset');
  const bytes = await boundedFile(file, VISUAL_CATALOG_LIMITS.imageBytes);
  if (visualSha256(bytes) !== item.image_sha256) throw new Error('changed_catalog_asset');
  const m = await sharp(bytes, { limitInputPixels: VISUAL_CATALOG_LIMITS.pixels, animated: false }).metadata();
  if (!['jpeg', 'png', 'webp'].includes(m.format ?? '') || (m.pages ?? 1) !== 1 ||
    m.width !== item.width || m.height !== item.height) throw new Error('invalid_catalog_asset');
  return { bytes, contentType: `image/${m.format}` };
}
