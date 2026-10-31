import type { DomainConfig } from '../config';
import { loadVisualCatalog, readVisualCatalogImage, VisualImageHash } from './visual-catalog';

/** Only validated PUBLIC catalog bytes. No input URL, storage key or filesystem path. */
export async function getVisualReferenceImage(config: DomainConfig, hash: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!VisualImageHash.safeParse(hash).success) return null;
  const loaded = await loadVisualCatalog(config.VISUAL_REFERENCE_CATALOG_FILE);
  const item = loaded?.catalog.objects.find(o => o.image_sha256 === hash);
  if (!loaded || !item) return null;
  try { return await readVisualCatalogImage(loaded.catalog, item); } catch { return null; }
}
