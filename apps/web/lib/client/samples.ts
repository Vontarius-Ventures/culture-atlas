/**
 * The three supplied example photos for "Try an example". `id` is the
 * `sample_id` sent to POST /v1/captures; images are original illustrations in
 * apps/web/public/samples (licenses: fixtures/images/LICENSES.md).
 */
export interface SampleExample {
  id: 'outfit' | 'room' | 'cafe';
  label: string;
  image: string;
  alt: string;
}

export const SAMPLE_EXAMPLES: readonly SampleExample[] = [
  {
    id: 'outfit',
    label: 'An outfit',
    image: '/samples/outfit.jpg',
    alt: 'A cream racing-style jacket with red and navy stripes on a wooden chair',
  },
  {
    id: 'room',
    label: 'A room',
    image: '/samples/room.jpg',
    alt: 'A quiet room with a paned window, a low table and a branch in a vase',
  },
  {
    id: 'cafe',
    label: 'A café table',
    image: '/samples/cafe.jpg',
    alt: 'A marble café table with a cup of coffee and a pastry',
  },
];

/** Accepted upload types and limit (mirrors the server; the server re-checks actual bytes). */
export const ACCEPTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;
export const ACCEPT_ATTR = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const UPLOAD_GUIDANCE = 'Use a JPEG, PNG or WebP photo up to 15 MB.';

export type FileProblem = { kind: 'type' | 'size'; message: string } | null;

export function checkImageFile(file: Pick<File, 'type' | 'size' | 'name'>): FileProblem {
  const type = file.type.toLowerCase();
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const knownType =
    (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type) ||
    (!type && ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext));
  if (!knownType)
    return { kind: 'type', message: `That file type isn’t supported. ${UPLOAD_GUIDANCE}` };
  if (file.size > MAX_UPLOAD_BYTES)
    return { kind: 'size', message: `That photo is too large. ${UPLOAD_GUIDANCE}` };
  return null;
}

/** HEIC usually cannot be previewed in the browser; the server may also not decode it. */
export function isHeic(file: Pick<File, 'type' | 'name'>): boolean {
  return /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}
