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

describe('OAuth protected-resource metadata (MCP)', () => {
  it('advertises every grantable scope, including captures, taste, media and devices', async () => {
    const { SCOPES } = await import('@culture-atlas/domain');
    const { GET } = await import('./oauth-protected-resource/mcp/route');
    const body = (await GET().json()) as { resource: string; scopes_supported: string[] };
    expect(body.resource).toMatch(/\/mcp$/);
    expect(body.scopes_supported).toEqual([...SCOPES]);
    for (const s of ['captures:read', 'captures:write', 'taste:read', 'taste:write', 'media:analyze', 'devices:command']) {
      expect(body.scopes_supported).toContain(s);
    }
  });
});
