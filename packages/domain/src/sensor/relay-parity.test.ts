import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The relay contract, client and sync algorithm are shared verbatim between
 * the server-side poller and the outbound bridge (which must not import the
 * domain package). Edit one copy, then copy it over the other.
 */
describe('relay.ts parity', () => {
  it('the bridge copy is identical to the domain copy', () => {
    const domain = readFileSync(path.join(import.meta.dirname, 'relay.ts'), 'utf8');
    const bridge = readFileSync(path.join(import.meta.dirname, '../../../../apps/sensor-bridge/src/relay.ts'), 'utf8');
    expect(bridge === domain, 'apps/sensor-bridge/src/relay.ts differs from packages/domain/src/sensor/relay.ts; copy the edited file over the other').toBe(true);
  });

  it('depends on Node built-ins only', () => {
    const src = readFileSync(path.join(import.meta.dirname, 'relay.ts'), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.every((i) => i!.startsWith('node:'))).toBe(true);
  });
});
