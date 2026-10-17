import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { activityLabel, connectionScopeLine, consentSummary, dayTime, expiresIn, lastUsed } from './agents-sharing-format';
import { ConnectAgentView, DEFAULT_AGENT_SCOPES } from './AgentPlatformView';

vi.mock('@/lib/client/session', () => ({ useSession: () => ({ isAccount: true, session: { principal: { kind: 'account' } } }) }));
vi.mock('@/lib/client/api', () => ({
  api: { request: vi.fn(async () => ({ collections: [{ id: 'c1', name: 'Quiet weekends' }] })) },
  newIdempotencyKey: () => 'key',
}));
afterEach(cleanup);

describe('connection card capability line (screen 10)', () => {
  it('lists capabilities in consent order and leaves collection reading to the Collections line', () => {
    expect(connectionScopeLine(['collections:read', 'preferences:read', 'setup:read'], 'selected_collections')).toBe(
      'View device setup · Read preferences',
    );
    expect(connectionScopeLine(['media:read', 'collections:read', 'setup:read'], 'none')).toBe(
      'View device setup · View collections · View photos and videos',
    );
    expect(connectionScopeLine(['devices:command', 'preferences:write', 'preferences:read'], 'all')).toBe(
      'Read preferences · Change preferences · Request capture',
    );
  });
});

describe('agent consent interface (screen 11)', () => {
  it('starts with setup/preferences only, no library, media or capture control', () => {
    render(<ConnectAgentView />);
    expect(DEFAULT_AGENT_SCOPES).toEqual(['setup:read', 'preferences:read']);
    expect((screen.getByLabelText('View my device setup') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Read my preferences') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Change ordinary preferences') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('View selected collections') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Request capture while I allow it') as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByLabelText('Library access')).toBeNull();
    expect(screen.getByText('Capture also requires permission on your phone.')).toBeTruthy();
    expect(screen.getByText('Setup and preferences only')).toBeTruthy();
    expect(screen.getByText('No media, microphone or camera access')).toBeTruthy();
    expect(screen.getByText('Your credential will be shown once. You can revoke it at any time.')).toBeTruthy();
  });

  it('separates original download and analysis permission from preview access', () => {
    render(<ConnectAgentView />);
    fireEvent.click(screen.getByLabelText('View selected collections'));
    expect((screen.getByLabelText('Library access') as HTMLSelectElement).value).toBe('selected_collections');
    for (const label of ['Download permitted originals', 'Request analysis of permitted media', 'View permitted photos and videos']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
    }
    // No collection chosen yet: Connect stays disabled with the reason shown.
    expect((screen.getByRole('button', { name: 'Connect agent' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Choose at least one collection.')).toBeTruthy();
  });

  it('requires an explicit phone for capture requests', () => {
    render(<ConnectAgentView />);
    fireEvent.click(screen.getByLabelText('Request capture while I allow it'));
    expect((screen.getByRole('button', { name: 'Connect agent' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Choose the phone this agent may ask.')).toBeTruthy();
  });
});

describe('agents and sharing copy helpers', () => {
  it('formats activity, expiry and last use like the mockup', () => {
    const now = new Date('2026-10-17T12:00:00');
    expect(activityLabel('preferences.read')).toBe('Read your preferences');
    expect(activityLabel('collection.read', 'Quiet weekends')).toBe('Viewed Quiet weekends');
    expect(dayTime(new Date('2026-10-17T10:42:00').toISOString(), now)).toBe('Today, 10:42');
    expect(expiresIn(new Date(now.getTime() + 23.5 * 86_400_000).toISOString(), now.getTime())).toBe('Expires in 24 days');
    expect(lastUsed(new Date('2026-10-17T09:00:00').toISOString(), now)).toBe('Last used today');
    expect(lastUsed(null, now)).toBe('Not used yet');
    expect(consentSummary(['setup:read', 'preferences:read'], 'none', 0)).toEqual(['Setup and preferences only', 'No media, microphone or camera access']);
  });
});
