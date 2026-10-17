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
});
