import { describe, expect, it } from 'vitest';
import type { AgentPrincipal, AnonymousPrincipal, AccountPrincipal } from '../principal';
import {
  collectionGranted,
  requireCanCreateCollection,
  requireCollectionGrant,
  requireScopes,
  requireWholeLibrary,
  resolveTasteScope,
} from './index';

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

describe('authz', () => {
  it('accounts hold every scope; anonymous are prompted to create an account', () => {
    expect(() => requireScopes(account, 'collections:write', 'plans:write')).not.toThrow();
    expect(() => requireScopes(anon, 'collections:read')).toThrowError(expect.objectContaining({ code: 'account_required' }));
    expect(() => requireScopes(anon, 'captures:write')).not.toThrow();
  });

  it('agents are limited to their scopes', () => {
    expect(() => requireScopes(agent(), 'collections:write')).toThrowError(expect.objectContaining({ code: 'scope_denied', status: 403 }));
  });

  it('selected-collection grants hide other collections as 404', () => {
    expect(collectionGranted(agent(), 'col-1')).toBe(true);
    expect(() => requireCollectionGrant(agent(), 'col-2')).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(collectionGranted(agent({ libraryAccess: 'none' }), 'col-1')).toBe(false);
  });

  it('global actions need whole-library access', () => {
    expect(() => requireWholeLibrary(agent())).toThrow();
    expect(() => requireWholeLibrary(agent({ libraryAccess: 'all' }))).not.toThrow();
    expect(() => requireCanCreateCollection(agent({ scopes: ['collections:write'] }))).toThrow();
    expect(() => requireCanCreateCollection(agent({ scopes: ['collections:write'], libraryAccess: 'all' }))).not.toThrow();
  });

  it('get_taste is collection-scoped for selected-collection agents', () => {
    expect(() => resolveTasteScope(agent())).toThrow();
    expect(resolveTasteScope(agent(), 'col-1')).toEqual({ kind: 'collection', collectionId: 'col-1' });
    expect(resolveTasteScope(account)).toEqual({ kind: 'global' });
  });
});
