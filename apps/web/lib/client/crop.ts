/**
 * Optional crop before submission. The crop box is kept in normalized
 * coordinates (0..1 of the displayed image) so it survives resizes.
 */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_CROP: CropBox = { x: 0, y: 0, w: 1, h: 1 };
export const MIN_CROP = 0.15;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keeps a box inside the image and at least MIN_CROP in each dimension. */
export function clampCrop(box: CropBox): CropBox {
  const w = clamp(box.w, MIN_CROP, 1);
  const h = clamp(box.h, MIN_CROP, 1);
  return { x: clamp(box.x, 0, 1 - w), y: clamp(box.y, 0, 1 - h), w, h };
}

export function moveCrop(box: CropBox, dx: number, dy: number): CropBox {
  return clampCrop({ ...box, x: box.x + dx, y: box.y + dy });
}

/** Resizes from the bottom-right corner (the top-left stays put). */
export function resizeCrop(box: CropBox, dw: number, dh: number): CropBox {
  const w = clamp(box.w + dw, MIN_CROP, 1 - box.x);
  const h = clamp(box.h + dh, MIN_CROP, 1 - box.y);
  return { ...box, w, h };
}

export function isFullCrop(box: CropBox): boolean {
  return box.x <= 0.001 && box.y <= 0.001 && box.w >= 0.999 && box.h >= 0.999;
}

/** Pixel rectangle for a normalized box on an image of the given natural size. */
export function cropToPixels(box: CropBox, width: number, height: number) {
  const b = clampCrop(box);
  const sx = Math.round(b.x * width);
  const sy = Math.round(b.y * height);
  return {
    sx,
    sy,
    sw: Math.max(1, Math.min(width - sx, Math.round(b.w * width))),
    sh: Math.max(1, Math.min(height - sy, Math.round(b.h * height))),
  };
}

/** Keyboard handling for the crop frame: arrows move, Shift+arrows resize. Returns null for other keys. */
export function cropForKey(box: CropBox, key: string, shift: boolean, step = 0.02): CropBox | null {
  const d = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }[key] as [number, number] | undefined;
  if (!d) return null;
  return shift ? resizeCrop(box, d[0], d[1]) : moveCrop(box, d[0], d[1]);
}

/** Crops an image file in the browser into a JPEG blob. Returns the original file when uncropped. */
export async function cropImageFile(file: File, box: CropBox): Promise<Blob> {
  if (isFullCrop(box)) return file;
  const bitmap = await createImageBitmap(file);
  try {
    const { sx, sy, sw, sh } = cropToPixels(box, bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    return await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', 0.92),
    );
  } finally {
    bitmap.close();
  }
}
