import { z } from 'zod';

/**
 * Contract for discovery_items.display_metadata (jsonb). Every writer of
 * discovery items must produce this shape; cards.ts reads it.
 * Images: `object_key` for private/stored media (signed on read) or `url` for
 * app-owned public assets (e.g. /samples/...). An external absolute URL is
 * never a cleared display asset while no independent rights review has
 * recorded one (see isClearedDisplayImageUrl).
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
 * an earlier writer stored on the same canonical item.
 */
export function forDisplayUpsert(meta: DisplayMetadata): Record<string, unknown> {
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined && v !== null));
}

// --- Provider display-rights boundary (VAL-EVID-005 / DISC-SCR-001) ------------------

/** external_ids keys that hold Qloo ids (entities and tags). */
export const QLOO_EXTERNAL_ID_KEYS = ['qloo', 'qloo_tag'] as const;

/** True when the item's material is Qloo-backed (an entity or tag id is stored on it). */
export function isProviderBackedItem(externalIds: Record<string, unknown> | null | undefined): boolean {
  if (!externalIds) return false;
  return QLOO_EXTERNAL_ID_KEYS.some((k) => k in externalIds);
}

/**
 * External image origins with an INDEPENDENT, recorded clearance review.
 * Empty today: no external host has one yet. HTTPS is transport security, a
 * provider-returned license/attribution field is the provider's own claim
 * about upstream material, and operator assurance is not a rights record —
 * none of them clear an external URL for retention or display. Extend only
 * with a documented independent review.
 */
export const CLEARED_EXTERNAL_IMAGE_URL_PREFIXES: readonly string[] = [];

/**
 * May this URL be served as a display asset? Only app-served relative assets
 * ("/samples/...", served by this application and owned/reviewed by it) and
 * the independently cleared external prefixes above qualify.
 */
export function isClearedDisplayImageUrl(url: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  return CLEARED_EXTERNAL_IMAGE_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * The image a reader may actually serve: user-owned stored media
 * (object_key, signed on read) or an app-owned/cleared asset URL. Any other
 * image (an external absolute URL with no recorded clearance — e.g. a
 * Qloo-returned picture) never displays.
 */
export function clearedDisplayImage(image: DisplayImage | null | undefined): DisplayImage | null {
  if (!image) return null;
  if (image.object_key) return image;
  const url = image.url?.trim();
  if (url && isClearedDisplayImageUrl(url)) return { ...image, url };
  return null;
}

/**
 * The display metadata a discovery-item upsert may persist:
 *  - Qloo prose (or any prose on a provider-backed item) never persists —
 *    provider responses are transient under the recorded rights policy;
 *  - an image persists only when it is user-owned stored media or an
 *    app-owned/cleared asset — never an uncleared external URL.
 * Independently produced prose (model/user) on non-provider items passes.
 */
export function storeSanitizedDisplayMetadata(
  meta: DisplayMetadata,
  externalIds: Record<string, unknown> | undefined,
): DisplayMetadata {
  return {
    ...meta,
    image: clearedDisplayImage(meta.image),
    description: isProviderBackedItem(externalIds) ? null : meta.description ?? null,
  };
}

/**
 * Real provider picture URL only: an https URL Qloo actually returned. This is
 * TRANSIENT-ONLY extraction (VAL-EVID-005): the recorded provider_rights_policies
 * row for qloo keeps response_retention = transient_only and
 * public_display = owned_or_cleared_only while its retention/display rights are
 * undocumented, so Qloo prose and Qloo-returned image URLs are never persisted
 * or displayed. Producers may use the URL transiently (the renderability probe
 * below); they must not turn it into stored or displayed content.
 */
export function qlooImageUrl(properties: Record<string, unknown> | undefined): string | null {
  if (!properties) return null;
  const candidates: unknown[] = [properties.image, properties.photo];
  if (Array.isArray(properties.images)) candidates.push(...properties.images);
  for (const raw of candidates) {
    const url = parseQlooImageUrl(raw);
    if (url) return url;
  }
  return null;
}

function parseQlooImageUrl(raw: unknown): string | null {
  let url: string | undefined;
  if (typeof raw === 'string') url = raw.trim();
  else if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.url === 'string') url = rec.url.trim();
    else if (rec.url && typeof rec.url === 'object') {
      const nested = rec.url as Record<string, unknown>;
      if (typeof nested.value === 'string') url = nested.value.trim();
    }
  }
  if (!url || !/^https:\/\//i.test(url)) return null;
  return url;
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

/**
 * Transient renderability probe: is the picture behind this Qloo URL a real
 * image and not a stub? Producers use the answer as a quality gate (a venue
 * without a renderable photo is not worth a card) WITHOUT keeping the URL.
 * The bytes are inspected transiently and then discarded; a failed probe never
 * drops a real venue (the URL was Qloo's, the card's text is ours).
 */
export async function qlooImageUrlIfRenderable(url: string | null, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!url) return false;
  try {
    const head = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(2500) });
    const headLen = Number(head.headers.get('content-length'));
    if (head.ok && Number.isFinite(headLen)) {
      return !sourceImageTooSmall(headLen);
    }
    const get = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(2500) });
    if (!get.ok) return true;
    const buf = await get.arrayBuffer();
    return !sourceImageTooSmall(buf.byteLength);
  } catch {
    // Probe failed: keep the card. Do not drop a real venue because HEAD timed out.
    return true;
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
