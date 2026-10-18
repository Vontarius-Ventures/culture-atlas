import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COPY } from './copy';

describe('v2 copy', () => {
  it('matches design/copy.json exactly', () => {
    const file = fileURLToPath(
      new URL('../../../../specs/capture-platform-v2/design/copy.json', import.meta.url),
    );
    expect(COPY).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });

  it('carries every exact UI string of spec amendment 2.2', () => {
    const spec = readFileSync(
      fileURLToPath(new URL('../../../../specs/onboarding-and-fast-analysis.md', import.meta.url)),
      'utf8',
    );
    // Exact UI copy is bold-quoted in the amendment ("**\"...\"**"), plus the
    // quoted honest-unavailable line of screen 15 and the screen 16 collapse label.
    const bold = [...spec.matchAll(/\*\*"([^"]+)"\*\*/g)].map((m) => m[1]!);
    const strings = [...bold, "We'll keep building in the background.", 'More to explore'];
    expect(bold.length).toBeGreaterThanOrEqual(12);
    const values = new Set(Object.values(COPY) as string[]);
    for (const text of strings) expect(values, text).toContain(text);
  });
});
