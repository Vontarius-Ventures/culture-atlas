import { describe, expect, it } from 'vitest';
import { moodContradicts, moodFamiliesOf, MOOD_CONTRADICTION_FACTOR, MOOD_WORDS, type MoodFamily } from './mood';

describe('mood vocabulary (eval r3, relevance cause 2)', () => {
  it('maps the reading\'s own mood strings and aesthetic words to families', () => {
    expect([...moodFamiliesOf('cozy')]).toEqual(['warm']);
    expect([...moodFamiliesOf('warm, cozy')]).toEqual(['warm']);
    expect([...moodFamiliesOf('serene intimate')]).toEqual(['warm', 'serene']);
    expect([...moodFamiliesOf('Abandoned decay')]).toEqual(['melancholy']);
    expect([...moodFamiliesOf('Playful eclectic')]).toEqual(['playful']);
    expect(moodFamiliesOf('Canvas work jacket')).toEqual(new Set());
    expect(moodFamiliesOf('')).toEqual(new Set());
  });

  it('every family is non-empty and every word maps back to exactly the families it belongs to', () => {
    for (const words of Object.values(MOOD_WORDS)) for (const w of words) expect([...moodFamiliesOf(w)].length).toBeGreaterThan(0);
    expect([...moodFamiliesOf('cheerful')]).toEqual(['warm']);
    expect([...moodFamiliesOf('stark minimal')]).toEqual(['austere']);
    expect([...moodFamiliesOf('rugged weathered')]).toEqual(['rugged']);
    expect([...moodFamiliesOf('opulent')]).toEqual(['opulent']);
    expect([...moodFamiliesOf('vibrant dynamic')]).toEqual(['energetic']);
  });

  it('contradicts only on opposite pairs, and never when either side is silent', () => {
    const F = (f: MoodFamily) => new Set<MoodFamily>([f]);
    // The judged failure: cheerful/cozy cards for an abandoned motel room.
    expect(moodContradicts(F('melancholy'), F('warm'))).toBe(true);
    expect(moodContradicts(F('warm'), F('melancholy'))).toBe(true);
    expect(moodContradicts(F('playful'), F('austere'))).toBe(true);
    expect(moodContradicts(F('opulent'), F('rugged'))).toBe(true);
    expect(moodContradicts(F('energetic'), F('serene'))).toBe(true);
    expect(moodContradicts(F('airy'), F('melancholy'))).toBe(true);
    // Quiet moods are adjacent, not contradictory; silence never is.
    expect(moodContradicts(F('serene'), F('melancholy'))).toBe(false);
    expect(moodContradicts(F('rugged'), F('melancholy'))).toBe(false);
    expect(moodContradicts(F('melancholy'), new Set())).toBe(false);
    expect(moodContradicts(new Set(), F('warm'))).toBe(false);
  });

  it('the contradiction factor is a strong down-rank, not a removal', () => {
    expect(MOOD_CONTRADICTION_FACTOR).toBeLessThan(0.5);
    expect(MOOD_CONTRADICTION_FACTOR).toBeGreaterThan(0);
  });
});
