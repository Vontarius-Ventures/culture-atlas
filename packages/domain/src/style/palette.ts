/**
 * Measured palette (style design §A.4, R-7c). Pure functions over an RGBA (or
 * RGB) pixel buffer: the compiler passes a 64x64 sharp downsample. Every hex
 * shown to a user comes from these pixels; the model only names swatches.
 *
 * k-means in CIE Lab, k = 6, k-means++ seeding from a fixed PRNG (seed 0),
 * 8 iterations: the same buffer always gives the same swatches. Empty and
 * near-duplicate clusters (Delta E < 5) are merged, so a solid image gives one
 * swatch. Swatches are ordered by share (largest first) and indexed 0..n-1.
 */

export interface Swatch {
  index: number;
  hex: string;
  share: number;
  lab: [number, number, number];
}

/** k = 6 (was 5): a stripe or trim colour gets its own swatch instead of merging into a neighbouring one. */
export const PALETTE_K = 6;
export const PALETTE_ITERATIONS = 8;
/** 96 px (was 64): thin stripes and trims survive the downsample as their own colour. */
export const PALETTE_SIZE = 96;
/**
 * G-STYLE-PALETTE: a swatch counts as present in a region when >= 10% of the
 * region's pixels are nearest to it among the measured swatches (and within
 * Delta E 25 of it). The design's "within Delta E 10 of the center" dropped
 * colors that were plainly in the subject in the first live check (a k-means
 * center is an average; most of its cluster lies further than 10 from it).
 */
export const PRESENCE_SHARE = 0.08;
export const PRESENCE_DELTA_E = 25;

type Lab = [number, number, number];

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  // D65
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToHex([L, a, b]: Lab): string {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (108 / 841) * (t - 4 / 29));
  const x = inv(fx) * 0.95047;
  const y = inv(fy);
  const z = inv(fz) * 1.08883;
  const lin = [
    x * 3.2404542 + y * -1.5371385 + z * -0.4985314,
    x * -0.969266 + y * 1.8760108 + z * 0.041556,
    x * 0.0556434 + y * -0.2040259 + z * 1.0572252,
  ];
  const toByte = (v: number) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  return `#${lin.map((v) => toByte(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function deltaE(p: Lab, q: Lab): number {
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** mulberry32: a tiny deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pixelsToLab(pixels: Uint8Array | Buffer, width: number, height: number, channels: number): Lab[] {
  if (channels < 3 || pixels.length < width * height * channels) throw new Error('palette: buffer does not match its size');
  const out: Lab[] = [];
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    // Fully transparent pixels carry no color.
    if (channels === 4 && pixels[o + 3]! < 16) continue;
    out.push(rgbToLab(pixels[o]!, pixels[o + 1]!, pixels[o + 2]!));
  }
  return out;
}

/** Deterministic k-means over Lab pixels (style design §A.4). */
export function computeSwatches(pixels: Uint8Array | Buffer, width: number, height: number, channels = 4, k = PALETTE_K, iterations = PALETTE_ITERATIONS): Swatch[] {
  const labs = pixelsToLab(pixels, width, height, channels);
  if (!labs.length) return [];
  const rand = prng(0);
  // k-means++ seeding.
  const centers: Lab[] = [labs[Math.floor(rand() * labs.length)]!];
  while (centers.length < k) {
    const d2 = labs.map((p) => Math.min(...centers.map((c) => deltaE(p, c) ** 2)));
    const total = d2.reduce((s, v) => s + v, 0);
    if (total === 0) break;
    let r = rand() * total;
    let idx = 0;
    for (; idx < d2.length - 1; idx++) {
      r -= d2[idx]!;
      if (r <= 0) break;
    }
    centers.push(labs[idx]!);
  }
  const assign = new Int32Array(labs.length);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < labs.length; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = deltaE(labs[i]!, centers[c]!);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assign[i] = best;
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < labs.length; i++) {
      const s = sums[assign[i]!]!;
      const p = labs[i]!;
      s[0]! += p[0];
      s[1]! += p[1];
      s[2]! += p[2];
      s[3]! += 1;
    }
    for (let c = 0; c < centers.length; c++) {
      const s = sums[c]!;
      if (s[3]! > 0) centers[c] = [s[0]! / s[3]!, s[1]! / s[3]!, s[2]! / s[3]!];
    }
  }
  const counts = new Array<number>(centers.length).fill(0);
  for (let i = 0; i < labs.length; i++) counts[assign[i]!]! += 1;
  // Merge empty and near-duplicate clusters (largest first absorbs).
  const clusters = centers.map((lab, i) => ({ lab, n: counts[i]! })).filter((c) => c.n > 0).sort((a, b) => b.n - a.n);
  const merged: { lab: Lab; n: number }[] = [];
  for (const c of clusters) {
    const into = merged.find((m) => deltaE(m.lab, c.lab) < 5);
    if (into) {
      const n = into.n + c.n;
      into.lab = [(into.lab[0] * into.n + c.lab[0] * c.n) / n, (into.lab[1] * into.n + c.lab[1] * c.n) / n, (into.lab[2] * into.n + c.lab[2] * c.n) / n];
      into.n = n;
    } else merged.push({ lab: [...c.lab] as Lab, n: c.n });
  }
  merged.sort((a, b) => b.n - a.n);
  const total = labs.length;
  return merged.map((m, index) => ({ index, hex: labToHex(m.lab), share: m.n / total, lab: m.lab }));
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * G-STYLE-PALETTE (R-7c): the swatch is present inside the region: at least
 * 10% of the region's pixels are nearest to it (see PRESENCE_DELTA_E). Recomputed
 * server-side after the call, so a skin or hair color outside a garment's
 * region never reaches its palette.
 */
export function swatchPresentInRegion(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
  region: Region,
  swatch: Pick<Swatch, 'lab'>,
  /** Every measured swatch: a pixel counts for the swatch it is nearest to. Omitted: distance only. */
  all: readonly Pick<Swatch, 'lab'>[] = [swatch],
): boolean {
  const x0 = Math.max(0, Math.floor(region.x * width));
  const y0 = Math.max(0, Math.floor(region.y * height));
  const x1 = Math.min(width, Math.ceil((region.x + region.w) * width));
  const y1 = Math.min(height, Math.ceil((region.y + region.h) * height));
  let inside = 0;
  let near = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * channels;
      if (channels === 4 && pixels[o + 3]! < 16) continue;
      inside++;
      const lab = rgbToLab(pixels[o]!, pixels[o + 1]!, pixels[o + 2]!);
      const d = deltaE(lab, swatch.lab);
      if (d < PRESENCE_DELTA_E && all.every((other) => other === swatch || deltaE(lab, other.lab) >= d)) near++;
    }
  return inside > 0 && near / inside >= PRESENCE_SHARE;
}

/** Background test thresholds (BG-1): see swatchIsBackground. */
export const BACKGROUND_OUTSIDE_MIN_AREA = 0.15;
export const BACKGROUND_OUTSIDE_SHARE = 0.25;
export const BACKGROUND_RATIO = 1.6;

/** Share of the pixels inside and outside a region that are nearest to the swatch (among all swatches). */
export function swatchShares(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
  region: Region,
  swatch: Pick<Swatch, 'lab'>,
  all: readonly Pick<Swatch, 'lab'>[] = [swatch],
): { inside: number; outside: number; outsideArea: number } {
  const x0 = Math.max(0, Math.floor(region.x * width));
  const y0 = Math.max(0, Math.floor(region.y * height));
  const x1 = Math.min(width, Math.ceil((region.x + region.w) * width));
  const y1 = Math.min(height, Math.ceil((region.y + region.h) * height));
  let inN = 0;
  let inHit = 0;
  let outN = 0;
  let outHit = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      if (channels === 4 && pixels[o + 3]! < 16) continue;
      const lab = rgbToLab(pixels[o]!, pixels[o + 1]!, pixels[o + 2]!);
      const d = deltaE(lab, swatch.lab);
      const nearest = d < PRESENCE_DELTA_E && all.every((other) => other === swatch || deltaE(lab, other.lab) >= d);
      const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
      if (inside) {
        inN++;
        if (nearest) inHit++;
      } else {
        outN++;
        if (nearest) outHit++;
      }
    }
  const total = inN + outN;
  return { inside: inN ? inHit / inN : 0, outside: outN ? outHit / outN : 0, outsideArea: total ? outN / total : 0 };
}

/**
 * BG-1: the swatch is the scene behind the subject, not the subject: the
 * region leaves a real part of the image outside (>= 15 %), the colour covers
 * at least a quarter of that outside part, and it is far more common outside
 * than inside (>= 1.6x). A tennis court around an outfit, a gallery wall
 * around a vitrine. A colour of the subject itself (a navy stripe) is rarer
 * outside the subject than inside, so it is never caught.
 */
export function swatchIsBackground(
  pixels: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
  region: Region,
  swatch: Pick<Swatch, 'lab'>,
  all: readonly Pick<Swatch, 'lab'>[] = [swatch],
): boolean {
  const s = swatchShares(pixels, width, height, channels, region, swatch, all);
  return s.outsideArea >= BACKGROUND_OUTSIDE_MIN_AREA && s.outside >= BACKGROUND_OUTSIDE_SHARE && s.outside >= BACKGROUND_RATIO * s.inside;
}
