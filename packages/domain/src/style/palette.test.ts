import { describe, expect, it } from 'vitest';
import { computeSwatches, deltaE, labToHex, rgbToLab, swatchPresentInRegion } from './palette';

function image(width: number, height: number, paint: (x: number, y: number) => [number, number, number]): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const o = (y * width + x) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = 255;
    }
  return buf;
}

describe('measured palette (style design §A.4)', () => {
  const stripes = image(64, 64, (x) => (x < 32 ? [123, 90, 58] : x < 48 ? [43, 42, 40] : [210, 200, 180]));

  it('is deterministic for the same buffer', () => {
    expect(computeSwatches(stripes, 64, 64)).toEqual(computeSwatches(stripes, 64, 64));
  });

  it('has shares that sum to 1, largest first, indexed 0..n-1', () => {
    const swatches = computeSwatches(stripes, 64, 64);
    expect(swatches.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 10);
    expect(swatches.map((s) => s.index)).toEqual(swatches.map((_, i) => i));
    for (let i = 1; i < swatches.length; i++) expect(swatches[i - 1]!.share).toBeGreaterThanOrEqual(swatches[i]!.share);
    expect(swatches[0]!.share).toBeCloseTo(0.5, 2);
    expect(swatches[0]!.hex).toBe('#7B5A3A');
  });

  it('gives one dominant swatch for a solid image', () => {
    const solid = image(64, 64, () => [20, 120, 200]);
    const swatches = computeSwatches(solid, 64, 64);
    expect(swatches).toHaveLength(1);
    expect(swatches[0]!.share).toBe(1);
    expect(swatches[0]!.hex).toBe('#1478C8');
  });

  it('round-trips sRGB through Lab', () => {
    expect(labToHex(rgbToLab(123, 90, 58))).toBe('#7B5A3A');
    expect(deltaE(rgbToLab(0, 0, 0), rgbToLab(0, 0, 0))).toBe(0);
  });

  it('G-STYLE-PALETTE: a swatch counts only where it is in the subject region', () => {
    const swatches = computeSwatches(stripes, 64, 64);
    const brown = swatches.find((s) => s.hex === '#7B5A3A')!;
    const light = swatches.find((s) => s.hex !== '#7B5A3A' && s.lab[0] > 70)!;
    const left = { x: 0, y: 0, w: 0.45, h: 1 };
    expect(swatchPresentInRegion(stripes, 64, 64, 4, left, brown, swatches)).toBe(true);
    expect(swatchPresentInRegion(stripes, 64, 64, 4, left, light, swatches)).toBe(false);
    expect(swatchPresentInRegion(stripes, 64, 64, 4, { x: 0.8, y: 0, w: 0.2, h: 1 }, light, swatches)).toBe(true);
  });
});
