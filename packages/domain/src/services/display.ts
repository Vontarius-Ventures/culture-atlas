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
});
export type DisplayMetadata = z.infer<typeof DisplayMetadata>;

/** Lenient parse for stored rows (bad data degrades to no image rather than throwing). */
export function readDisplayMetadata(value: unknown): DisplayMetadata {
  const parsed = DisplayMetadata.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}
