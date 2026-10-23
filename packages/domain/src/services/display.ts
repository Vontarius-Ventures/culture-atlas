import { z } from 'zod';

/**
 * Contract for discovery_items.display_metadata (jsonb). Every writer of
 * discovery items must produce this shape; cards.ts reads it.
 * Images: `object_key` for private/stored media (signed on read) or `url` for
 * public licensed assets (e.g. /samples/... or a provider image we may display).
 */
export const DisplayImage = z.object({
  object_key: z.string().optional(),
  url: z.string().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  alt: z.string().default(''),
  license: z.string().optional(),
  attribution: z.string().optional(),
});
export type DisplayImage = z.infer<typeof DisplayImage>;

export const DisplayMetadata = z.object({
  subtitle: z.string().nullable().optional(),
  year: z.number().int().nullable().optional(),
  description: z.string().nullable().optional(),
  image: DisplayImage.nullable().optional(),
  /** Verified destination only (official site, Wikipedia, etc.). */
  destination_url: z.string().nullable().optional(),
  /** For food ideas: cuisine label. For tracks: artist name. */
  detail: z.string().nullable().optional(),
  /**
   * True when the item came from replayed/sample provider data, false once a
   * live provider response produced it. Durable, so every later view (saved,
   * collections, related, plans) keeps the "Example result" label.
   */
  example: z.boolean().optional(),
});
export type DisplayMetadata = z.infer<typeof DisplayMetadata>;

/** Lenient parse for stored rows (bad data degrades to no image rather than throwing). */
/**
 * Shortens provider prose without cutting a word: the last full sentence that
 * fits, else the last whole word plus an ellipsis. Text already cut mid-word
 * by an older writer (no closing punctuation at the cap) is repaired the same way.
 */
export function clipText(text: string | null | undefined, max = 280): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const looksCut = t.length >= max - 12 && !/[.!?…"”')\]]$/.test(t);
  if (t.length <= max && !looksCut) return t;
  const window = t.slice(0, Math.min(t.length, max));
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentenceEnd >= max * 0.5) return window.slice(0, sentenceEnd + 1);
  const room = window.slice(0, Math.min(window.length, max - 1));
  const space = room.lastIndexOf(' ');
  const cut = (space > 0 ? room.slice(0, space) : room).replace(/[\s,;:–—-]+$/, '');
  return `${cut}…`;
}

export function readDisplayMetadata(value: unknown): DisplayMetadata {
  const parsed = DisplayMetadata.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * JSONB `||` overwrites keys present on the right, including `"image": null`.
 * Drop null/undefined so a later writer that has no picture cannot wipe one
 * Qloo already stored on the same canonical item.
 */
export function forDisplayUpsert(meta: DisplayMetadata): Record<string, unknown> {
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined && v !== null));
}

/**
 * Real provider picture only: an https URL Qloo actually returned. Never a
 * guessed portrait or a generated stand-in. Attribution/license pass through
 * when present so the card can credit the source.
 */
export function imageFromQlooProperties(
  properties: Record<string, unknown> | undefined,
  alt: string,
): DisplayImage | null {
  if (!properties) return null;
  const candidates: unknown[] = [properties.image, properties.photo];
  if (Array.isArray(properties.images)) candidates.push(...properties.images);
  for (const raw of candidates) {
    const parsed = parseQlooImage(raw, alt);
    if (parsed) return parsed;
  }
  return null;
}

function parseQlooImage(raw: unknown, alt: string): DisplayImage | null {
  let url: string | undefined;
  let attribution: string | undefined;
  let license: string | undefined;
  if (typeof raw === 'string') url = raw.trim();
  else if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.url === 'string') url = rec.url.trim();
    else if (rec.url && typeof rec.url === 'object') {
      const nested = rec.url as Record<string, unknown>;
      if (typeof nested.value === 'string') url = nested.value.trim();
    }
    if (typeof rec.attribution === 'string') attribution = rec.attribution.trim() || undefined;
    if (typeof rec.license === 'string') license = rec.license.trim() || undefined;
  }
  if (!url || !/^https:\/\//i.test(url)) return null;
  return { url, alt, attribution, license };
}

/**
 * Qloo sometimes returns a real https URL that is a 30×30 placeholder PNG
 * (often served with a .jpg path). A restaurant photo or album cover is tens
 * of kilobytes; anything under this is not a usable source image.
 */
export const MIN_SOURCE_IMAGE_BYTES = 2048;

export function sourceImageTooSmall(byteLength: number | null | undefined): boolean {
  return typeof byteLength !== 'number' || !Number.isFinite(byteLength) || byteLength < MIN_SOURCE_IMAGE_BYTES;
}

/** Keep the URL only when the bytes behind it are a real picture, not a stub. */
export async function qlooImageIfRenderable(
  image: DisplayImage | null,
  fetchImpl: typeof fetch = fetch,
): Promise<DisplayImage | null> {
  if (!image?.url) return null;
  try {
    const head = await fetchImpl(image.url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(2500) });
    const headLen = Number(head.headers.get('content-length'));
    if (head.ok && Number.isFinite(headLen)) {
      return sourceImageTooSmall(headLen) ? null : image;
    }
    const get = await fetchImpl(image.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(2500) });
    if (!get.ok) return image;
    const buf = await get.arrayBuffer();
    return sourceImageTooSmall(buf.byteLength) ? null : image;
  } catch {
    // Probe failed: keep the URL. Do not drop a real photo because HEAD timed out.
    return image;
  }
}

/** Official https site Qloo actually returned. Never a guessed Wikipedia URL. */
export function destinationFromQlooProperties(
  properties: Record<string, unknown> | undefined,
): string | null {
  if (!properties) return null;
  const raw = properties.website;
  let url: string | undefined;
  if (typeof raw === 'string') url = raw.trim();
  else if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.url === 'string') url = rec.url.trim();
  }
  if (!url || !/^https:\/\//i.test(url)) return null;
  return url;
}

/** Home feed and similar rails: keep sourced pictures; only fall back to imageless when none have one. */
export function preferPicturedCards<T extends { image?: unknown }>(cards: readonly T[]): T[] {
  const pictured = cards.filter((c) => c.image != null);
  return pictured.length > 0 ? pictured : [...cards];
}
