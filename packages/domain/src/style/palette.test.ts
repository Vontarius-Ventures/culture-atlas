import { describe, expect, it } from 'vitest';
import { computeSwatches, deltaE, labToHex, paletteDecision, rgbToLab, swatchIsBackground, swatchPresentInRegion } from './palette';

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

  it('BG-1: the colour all around the subject is background; a stripe colour of the subject is not', () => {
    // A green ground around a centred white garment with navy stripes (synthetic).
    const scene = image(64, 64, (x, y) => {
      const inside = x >= 20 && x < 44 && y >= 12 && y < 52;
      if (!inside) return [70, 110, 60];
      return y % 6 < 2 ? [30, 40, 90] : [240, 240, 235];
    });
    const swatches = computeSwatches(scene, 64, 64);
    const region = { x: 20 / 64, y: 12 / 64, w: 24 / 64, h: 40 / 64 };
    const nearest = (rgb: [number, number, number]) => swatches.reduce((b, s) => (deltaE(s.lab, rgbToLab(...rgb)) < deltaE(b.lab, rgbToLab(...rgb)) ? s : b));
    const ground = nearest([70, 110, 60]);
    const navy = nearest([30, 40, 90]);
    const white = nearest([240, 240, 235]);
    expect(swatchIsBackground(scene, 64, 64, 4, region, ground, swatches)).toBe(true);
    expect(swatchIsBackground(scene, 64, 64, 4, region, navy, swatches)).toBe(false);
    expect(swatchIsBackground(scene, 64, 64, 4, region, white, swatches)).toBe(false);
    // A subject that fills the frame has no outside to compare with.
    expect(swatchIsBackground(scene, 64, 64, 4, { x: 0, y: 0, w: 1, h: 0.95 }, ground, swatches)).toBe(false);
  });
});

describe('role-aware local palette evidence', () => {
  const subject = { x: 0, y: 0, w: 1, h: 1 };
  // A small blue painted feature: 4% of the frame, below the dominant-colour bar.
  const pixels = image(100, 100, (x, y) => x < 20 && y < 20 ? [20, 60, 180] : [20, 20, 20]);
  const swatches = computeSwatches(pixels, 100, 100);
  const blue = swatches.find((s) => s.lab[2] < -20)!;
  const observation = { id: 'o1', kind: 'surface', region: { x: 0, y: 0, w: 0.2, h: 0.2 }, certainty: 0.9 };
  const accent = { swatch: blue.index, role: 'accent' as const, evidence_ids: ['o1'] };

  it('keeps a locally measured accent that cannot pass the full-subject presence bar', () => {
    expect(swatchPresentInRegion(pixels, 100, 100, 4, subject, blue, swatches)).toBe(false);
    expect(paletteDecision(pixels, 100, 100, 4, subject, accent, swatches, [observation])).toBe('supported');
    expect(paletteDecision(pixels, 100, 100, 4, subject, { ...accent, role: 'secondary' }, swatches, [observation])).toBe('supported');
    expect(paletteDecision(pixels, 100, 100, 4, subject, { ...accent, role: 'dominant' }, swatches, [observation])).toBe('not_present');
  });

  it('does not reject a white subject stripe just because white also dominates the background', () => {
    const region = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const stripe = { x: 0.25, y: 0.25, w: 0.5, h: 0.05 };
    const scene = image(100, 100, (x, y) => x < 25 || x >= 75 || y < 25 || y >= 75 || y < 30 ? [245, 245, 245] : [20, 20, 60]);
    const measured = computeSwatches(scene, 100, 100);
    const white = measured.find((s) => s.lab[0] > 90)!;
    expect(swatchIsBackground(scene, 100, 100, 4, region, white, measured)).toBe(true);
    const entry = { swatch: white.index, role: 'accent' as const, evidence_ids: ['o1'] };
    expect(paletteDecision(scene, 100, 100, 4, region, entry, measured, [{ ...observation, region: stripe }])).toBe('supported');
    expect(paletteDecision(scene, 100, 100, 4, region, { ...entry, role: 'dominant' }, measured, [{ ...observation, region: stripe }])).toBe('background');
  });

  it('rejects absent colours, dangling links, text evidence, whole-subject accents and outside boxes', () => {
    const decide = (entry = accent, observations = [observation]) => paletteDecision(pixels, 100, 100, 4, subject, entry, swatches, observations);
    expect(decide({ ...accent, swatch: 99 })).toBe('not_measured');
    expect(decide({ ...accent, evidence_ids: ['missing'] })).toBe('invalid_reference');
    expect(decide(accent, [{ ...observation, kind: 'text' }])).toBe('invalid_reference');
    expect(decide(accent, [{ ...observation, region: subject }])).toBe('invalid_reference');
    expect(decide(accent, [{ ...observation, region: { x: -0.1, y: 0, w: 0.2, h: 0.2 } }])).toBe('invalid_reference');
    expect(decide(accent, [{ ...observation, region: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } }])).toBe('not_present');
    expect(decide(accent, [{ ...observation, region: { x: 0, y: 0, w: 0.001, h: 0.001 } }])).toBe('invalid_reference');
  });

  it('does not manufacture local colour evidence for a legacy entry', () => {
    expect(paletteDecision(pixels, 100, 100, 4, subject, { swatch: blue.index }, swatches)).toBe('not_present');
  });
});
