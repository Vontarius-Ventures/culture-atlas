import { describe, expect, it } from 'vitest';
import { ROUTES } from '../schemas/routes';
import type { AccountPrincipal, AgentPrincipal, AnonymousPrincipal } from '../principal';
import { authorizeOperation, describeConnectionAccess, requireAgentConnection } from './index';

const account: AccountPrincipal = { kind: 'account', accountId: 'a1', sessionId: 's1', isDemoOwner: false };
const anon: AnonymousPrincipal = { kind: 'anonymous', sessionId: 's2', expiresAt: new Date() };
const agent = (over: Partial<AgentPrincipal> = {}): AgentPrincipal => ({
  kind: 'agent',
  accountId: 'a1',
  connectionId: 'c1',
  clientName: 'demo',
  purpose: 'agent',
  scopes: ['collections:read', 'taste:read', 'plans:read', 'captures:read'],
  libraryAccess: 'selected_collections',
  allowedCollectionIds: ['col-1'],
  sensorConnectionId: null,
  expiresAt: new Date(Date.now() + 1e6),
  ...over,
});
const bridge = agent({ purpose: 'sensor_bridge', scopes: ['captures:write', 'captures:read'], libraryAccess: 'none', allowedCollectionIds: [] });

const code = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code: string }).code;
  }
};

describe('authorizeOperation (shared by REST and MCP)', () => {
  it('enforces auth level and scopes with spec codes', () => {
    expect(code(() => authorizeOperation(account, ROUTES.createCollection))).toBeNull();
    expect(code(() => authorizeOperation(anon, ROUTES.listCollections))).toBe('account_required');
    expect(code(() => authorizeOperation(agent(), ROUTES.listCollections))).toBeNull();
    expect(code(() => authorizeOperation(agent(), ROUTES.createCollection))).toBe('scope_denied');
    expect(code(() => authorizeOperation(agent(), ROUTES.createPlan))).toBe('scope_denied');
    expect(code(() => authorizeOperation(agent({ scopes: ['plans:write', 'collections:read'] }), ROUTES.createPlan))).toBeNull();
  });

  it('keeps connection management and the inspector away from agents and anonymous sessions', () => {
    for (const route of [ROUTES.createAgentConnection, ROUTES.revokeAgentConnection, ROUTES.updateAgentConnection, ROUTES.getTrace]) {
      expect(code(() => authorizeOperation(agent({ libraryAccess: 'all' }), route))).toBe('scope_denied');
      expect(code(() => authorizeOperation(anon, route))).toBe('account_required');
      expect(code(() => authorizeOperation(account, route))).toBeNull();
    }
  });

  it('limits the sensor-bridge token to its three REST routes and nothing over MCP', () => {
    expect(code(() => authorizeOperation(bridge, ROUTES.createUpload))).toBeNull();
    expect(code(() => authorizeOperation(bridge, ROUTES.createCapture))).toBeNull();
    expect(code(() => authorizeOperation(bridge, ROUTES.getJob))).toBeNull();
    expect(code(() => authorizeOperation(bridge, ROUTES.getCapture))).toBe('scope_denied');
    expect(code(() => authorizeOperation(bridge, ROUTES.createCapture, 'mcp'))).toBe('scope_denied');
    expect(code(() => authorizeOperation(bridge, ROUTES.getJob, 'mcp'))).toBe('scope_denied');
  });

  it('MCP only serves agent principals', () => {
    expect(code(() => requireAgentConnection(null))).toBe('unauthenticated');
    expect(code(() => requireAgentConnection(account))).toBe('unauthenticated');
    expect(code(() => requireAgentConnection(agent()))).toBeNull();
  });
});

describe('describeConnectionAccess', () => {
  it('explains a selected-collection grant', () => {
    const s = describeConnectionAccess(['collections:read', 'collections:write', 'taste:read', 'plans:write'], 'selected_collections', ['Tokyo evenings']);
    expect(s.reads).toContain('Items in the collection “Tokyo evenings”');
    expect(s.reads).toContain('Interests within the collection “Tokyo evenings”');
    expect(s.writes).toContain('Add or remove items in the collection “Tokyo evenings”');
    expect(s.limits).toContain('New collections are not added automatically.');
    expect(s.limits).toContain('Cannot delete photos or unsave items everywhere.');
  });

  it('explains a whole-library read-only grant', () => {
    const s = describeConnectionAccess(['collections:read', 'taste:read', 'plans:read', 'captures:read'], 'all');
    expect(s.reads).toEqual([
      'Items in your whole library',
      'Compiled results of your photos (not the original images)',
      'Your saved interests',
      'Your plans',
    ]);
    expect(s.writes).toEqual([]);
  });
});
