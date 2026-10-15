import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectAgentView, DEFAULT_AGENT_SCOPES } from './AgentPlatformView';

vi.mock('@/lib/client/session', () => ({ useSession: () => ({ isAccount: true }) }));
vi.mock('@/lib/client/api', () => ({ api: { request: vi.fn(async () => ({ collections: [] })) }, newIdempotencyKey: () => 'key' }));
afterEach(cleanup);

describe('agent consent interface', () => {
  it('starts with setup/preferences only, no library or capture control', () => {
    render(<ConnectAgentView />);
    expect(DEFAULT_AGENT_SCOPES).toEqual(['setup:read', 'preferences:read']);
    expect((screen.getByLabelText('View my device setup') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Read my preferences') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Request capture while I allow it') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Library access') as HTMLSelectElement).value).toBe('none');
    expect(screen.getByText(/Capture also requires permission on your phone/)).toBeTruthy();
  });
  it('separates original download and analysis permission from preview access', () => {
    render(<ConnectAgentView />);
    for (const label of ['Download permitted originals', 'Request analysis of permitted media', 'View permitted photos and videos']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(false);
    }
  });
});
