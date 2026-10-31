import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as aasa } from './apple-app-site-association/route';

describe('Apple App Site Association', () => {
  afterEach(() => vi.unstubAllEnvs());
  const read = async () =>
    (await aasa().json()) as {
      applinks: { details: { appIDs: string[]; components: Record<string, unknown>[] }[] };
    };

  it('claims only iOS email links, leaving web sign-in callbacks in the browser', async () => {
    const [detail] = (await read()).applinks.details;
    expect(detail?.appIDs).toContain('U9XG3X374H.com.cultureatlas.app');
    expect(detail?.appIDs).toContain('U9XG3X374H.com.aomg.cultureatlas');
    expect(detail?.components).toEqual([{ '/': '/identity/callback', '?': { destination: 'ios' } }]);
  });

  it('never publishes an App ID with a blank team when Compose passes an empty value', async () => {
    vi.stubEnv('APPLE_TEAM_ID', '  ');
    expect((await read()).applinks.details[0]?.appIDs[0]).toBe('U9XG3X374H.com.cultureatlas.app');
    vi.stubEnv('APPLE_TEAM_ID', 'ABCDE12345');
    expect((await read()).applinks.details[0]?.appIDs[0]).toBe('ABCDE12345.com.cultureatlas.app');
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
