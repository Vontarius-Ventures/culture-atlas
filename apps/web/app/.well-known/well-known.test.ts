import { describe, expect, it } from 'vitest';
import { GET as aasa } from './apple-app-site-association/route';

describe('Apple App Site Association', () => {
  it('lists iOS App IDs for identity callback paths', async () => {
    const body = (await aasa().json()) as {
      applinks: { details: { appID: string; paths: string[] }[] };
    };
    const ids = body.applinks.details.map((d) => d.appID);
    expect(ids.some((id) => id.endsWith('.com.cultureatlas.app'))).toBe(true);
    expect(ids.some((id) => id.endsWith('.com.aomg.cultureatlas'))).toBe(true);
    expect(body.applinks.details[0]?.paths).toContain('/identity/callback');
  });
});
