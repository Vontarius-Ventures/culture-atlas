import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InterestGraphSummaryResponse } from '@culture-atlas/domain/schemas';
import { TasteGraphSection } from './TasteGraphSection';

/**
 * SCREEN-CONTRACT + VAL-FEED-001: the Settings → Taste graph section must
 * reflect server truth — pending/empty/error states truthful, pause and
 * suppress/restore as desired-state PATCHes with honest conflict handling,
 * never a faked saved state.
 */

let seq = 0;
const request = vi.fn(async (name: string, payload?: unknown): Promise<unknown> => ({}));
let signedIn = true;

const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      readonly status: number,
      readonly body: { code: string; message: string; retryable: boolean; request_id: string; details?: unknown },
    ) {
      super(body.message);
    }
    get code() {
      return this.body.code;
    }
  }
  return { MockApiError };
});

vi.mock('@/lib/client/session', () => ({
  useSession: () => ({
    isAccount: signedIn,
    session: signedIn ? { principal: { kind: 'account', account_id: 'acc-1' } } : { principal: { kind: 'session', session_id: 's-1' } },
  }),
}));
vi.mock('@/lib/client/api', () => ({
  api: { request: (name: string, payload: unknown) => request(name, payload), refreshSession: vi.fn(async () => undefined) },
  ApiError: MockApiError,
  newIdempotencyKey: () => `idem-${++seq}`,
}));

function conflict(currentRevision: number) {
  return new MockApiError(409, {
    code: 'revision_conflict',
    message: 'Just updated elsewhere.',
    retryable: false,
    request_id: 'r',
    details: { current_revision: currentRevision },
  });
}

function summary(over: {
  settings?: Partial<InterestGraphSummaryResponse['settings']>;
  projection?: Partial<InterestGraphSummaryResponse['projection']>;
  counts?: Partial<InterestGraphSummaryResponse['counts']>;
  interests?: InterestGraphSummaryResponse['interests'];
  tentative?: InterestGraphSummaryResponse['tentative'];
} = {}): InterestGraphSummaryResponse {
  return {
    owner_account_id: 'acc-1',
    settings: { revision: 3, discovery_paused: false, paused_at: null, ...over.settings },
    projection: {
      state: 'ready',
      support_version: 2,
      target_taste_revision: 4,
      applied_taste_revision: 4,
      current_taste_revision: 4,
      lagging: false,
      pending_events: 0,
      last_projected_at: '2026-10-17T00:00:00Z',
      ...over.projection,
    },
    counts: { confirmed: 2, tentative: 1, suppressed: 0, ...over.counts },
    interests:
      over.interests ??
      ({
        items: [
          {
            edge_id: 'e-1',
            item_id: 'i-1',
            canonical_key: 'qloo:a',
            kind: 'artist',
            title: 'Auguste Rodin',
            origin: 'explicit',
            state: 'confirmed',
            saved_item_id: 's-1',
            pick_ids: [],
            capture_id: null,
            analysis_id: null,
          },
          {
            edge_id: null,
            item_id: 'i-2',
            canonical_key: 'chip:jazz',
            kind: 'track',
            title: 'Jazz',
            origin: 'explicit',
            state: 'confirmed',
            saved_item_id: 's-2',
            pick_ids: ['p-1'],
            capture_id: null,
            analysis_id: null,
          },
        ],
        next_cursor: null,
      } as InterestGraphSummaryResponse['interests']),
    tentative:
      over.tentative ??
      ({
        items: [
          {
            edge_id: 'e-9',
            node_id: 'n-9',
            name: 'Café culture',
            relation: 'depicted',
            resolution_status: 'resolved',
            is_anchor: true,
            origin: 'derived',
            state: 'tentative',
            capture_id: 'c-1',
            analysis_id: 'a-1',
            analysis_version: 1,
            capture_reference_id: 'cr-1',
            reference_id: 'r-1',
          },
        ],
        next_cursor: null,
      } as InterestGraphSummaryResponse['tentative']),
  };
}

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async () => ({}));
  signedIn = true;
  seq = 0;
});
afterEach(cleanup);

describe('TasteGraphSection', () => {
  it('renders the confirmed interests distinctly from the tentative photo affinities', async () => {
    request.mockImplementation(async (name: string) =>
      name === 'getMyInterestGraph' ? summary() : {},
    );
    render(<TasteGraphSection />);
    expect(await screen.findByText('Auguste Rodin')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('getMyInterestGraph', { query: {} });
    expect(screen.getByText('From your saves and picks (2)')).toBeTruthy();
    expect(screen.getByText('Also picked up from your photos (1)')).toBeTruthy();
    // The tentative affinity carries its own control, never a remove button.
    expect(screen.getByRole('button', { name: 'Stop showing Café culture' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    // Projection truth: up to date, last projected shown as status only.
    expect(screen.getByText('Up to date with your saves and picks.')).toBeTruthy();
    // Pause control present, currently running.
    expect(screen.getByRole('button', { name: 'Pause background discovery' })).toBeTruthy();
  });

  it('shows the honest empty state when nothing is confirmed or tentative yet', async () => {
    request.mockImplementation(
      async (name: string) =>
        name === 'getMyInterestGraph'
          ? summary({
              projection: { state: 'never_projected', lagging: false, last_projected_at: null },
              counts: { confirmed: 0, tentative: 0, suppressed: 0 },
              interests: { items: [], next_cursor: null },
              tentative: { items: [], next_cursor: null },
            })
          : {},
    );
    render(<TasteGraphSection />);
    expect(
      await screen.findByText('Nothing here yet. What you save and pick will appear.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Affinities your photos suggest will appear here.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Background discovery follows what you save and pick.'),
    ).toBeTruthy();
  });

  it('reports a failed projection as needing attention, without hiding the lists', async () => {
    request.mockImplementation(
      async (name: string) =>
        name === 'getMyInterestGraph'
          ? summary({ projection: { state: 'failed', lagging: false, pending_events: 0 } })
          : {},
    );
    render(<TasteGraphSection />);
    expect(await screen.findByText('Auguste Rodin')).toBeTruthy();
    expect(
      screen.getByText('Background discovery hit a problem and will retry with your next change.'),
    ).toBeTruthy();
  });

  it('pauses and resumes through one desired-state PATCH with the revision it read', async () => {
    request.mockImplementation(async (name: string, payload: unknown) => {
      if (name === 'getMyInterestGraph') return summary();
      if (name === 'updateMyInterestGraphSettings')
        return { settings: { revision: 4, discovery_paused: true, paused_at: '2026-10-17T01:00:00Z' } };
      return {};
    });
    render(<TasteGraphSection />);
    const pause = await screen.findByRole('button', { name: 'Pause background discovery' });
    fireEvent.click(pause);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('updateMyInterestGraphSettings', {
        body: { expected_revision: 3, discovery_paused: true },
        idempotencyKey: 'idem-1',
      }),
    );
    expect(await screen.findByText(/Background discovery is paused\./)).toBeTruthy();

    // Resume echoes the NEW revision the mutation returned.
    request.mockImplementation(async (name: string) =>
      name === 'getMyInterestGraph'
        ? summary({ settings: { revision: 4, discovery_paused: true, paused_at: '2026-10-17T01:00:00Z' } })
        : { settings: { revision: 5, discovery_paused: false, paused_at: null } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resume background discovery' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('updateMyInterestGraphSettings', {
        body: { expected_revision: 4, discovery_paused: false },
        idempotencyKey: 'idem-2',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Pause background discovery' })).toBeTruthy();
  });

  it('keeps server truth when the pause PATCH hits a revision conflict', async () => {
    request.mockImplementation(async (name: string) => {
      if (name === 'getMyInterestGraph') return summary();
      throw conflict(7);
    });
    render(<TasteGraphSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause background discovery' }));
    expect(await screen.findByText('Just updated elsewhere. Showing the latest state.')).toBeTruthy();
    // Refetched to stay truthful, and still not paused per the server.
    await waitFor(() =>
      expect(request.mock.calls.filter(([n]) => n === 'getMyInterestGraph').length).toBeGreaterThanOrEqual(2),
    );
    expect(screen.getByRole('button', { name: 'Pause background discovery' })).toBeTruthy();
    expect(screen.queryByText(/Background discovery is paused\./)).toBeNull();
  });

  it('suppresses and restores a tentative affinity without touching the lists', async () => {
    request.mockImplementation(async (name: string) => {
      if (name === 'getMyInterestGraph') return summary();
      if (name === 'updateMyInterestGraphInterest')
        return { edge_id: 'e-9', node_id: 'n-9', state: 'suppressed', settings: { revision: 4, discovery_paused: false, paused_at: null } };
      return {};
    });
    render(<TasteGraphSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop showing Café culture' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('updateMyInterestGraphInterest', {
        params: { id: 'e-9' },
        body: { expected_revision: 3, state: 'suppressed' },
        idempotencyKey: 'idem-1',
      }),
    );
    // The row stays visible, now offering restore, and the confirmed list is untouched.
    expect(await screen.findByRole('button', { name: 'Show again Café culture' })).toBeTruthy();
    expect(screen.getByText('Auguste Rodin')).toBeTruthy();

    request.mockImplementation(async (name: string) => {
      if (name === 'getMyInterestGraph') return summary();
      if (name === 'updateMyInterestGraphInterest')
        return { edge_id: 'e-9', node_id: 'n-9', state: 'tentative', settings: { revision: 5, discovery_paused: false, paused_at: null } };
      return {};
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show again Café culture' }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('updateMyInterestGraphInterest', {
        params: { id: 'e-9' },
        body: { expected_revision: 4, state: 'tentative' },
        idempotencyKey: 'idem-2',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Stop showing Café culture' })).toBeTruthy();
  });

  it('keeps the affinity row intact when suppression fails or conflicts', async () => {
    request.mockImplementation(async (name: string) => {
      if (name === 'getMyInterestGraph') return summary();
      throw conflict(8);
    });
    render(<TasteGraphSection />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop showing Café culture' }));
    expect(await screen.findByText('Just updated elsewhere. Showing the latest state.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop showing Café culture' })).toBeTruthy();
    expect(request.mock.calls.filter(([n]) => n === 'getMyInterestGraph').length).toBeGreaterThanOrEqual(2);

    // A transport failure keeps the row too, with its own message.
    request.mockImplementation(async (name: string) => {
      if (name === 'getMyInterestGraph') return summary();
      throw new MockApiError(500, { code: 'internal', message: 'Nope', retryable: true, request_id: 'r' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stop showing Café culture' }));
    expect(await screen.findByText('That could not be updated right now.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop showing Café culture' })).toBeTruthy();
  });

  it('loads more only for the list that has a next cursor', async () => {
    request.mockImplementation(async (name: string, payload: unknown) => {
      if (name !== 'getMyInterestGraph') return {};
      const q = (payload as { query: { interests_cursor?: string } }).query ?? {};
      if (!q.interests_cursor)
        return summary({ interests: { items: [{ edge_id: 'e-1', item_id: 'i-1', canonical_key: 'qloo:a', kind: 'artist', title: 'Auguste Rodin', origin: 'explicit', state: 'confirmed', saved_item_id: 's-1', pick_ids: [], capture_id: null, analysis_id: null }], next_cursor: 'cur-2' } });
      return summary({
        interests: {
          items: [
            { edge_id: 'e-1', item_id: 'i-1', canonical_key: 'qloo:a', kind: 'artist', title: 'Auguste Rodin', origin: 'explicit', state: 'confirmed', saved_item_id: 's-1', pick_ids: [], capture_id: null, analysis_id: null },
            { edge_id: 'e-2', item_id: 'i-3', canonical_key: 'qloo:b', kind: 'artist', title: 'Georges Seurat', origin: 'explicit', state: 'confirmed', saved_item_id: 's-3', pick_ids: [], capture_id: null, analysis_id: null },
          ],
          next_cursor: null,
        },
      });
    });
    render(<TasteGraphSection />);
    expect(await screen.findByText('Auguste Rodin')).toBeTruthy();
    expect(screen.queryByText('Georges Seurat')).toBeNull();
    // Only the interests list offers more; the tentative list has no cursor.
    const more = screen.getByRole('button', { name: 'Show more from your saves and picks' });
    expect(screen.queryByRole('button', { name: /Show more from your photos/ })).toBeNull();
    fireEvent.click(more);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('getMyInterestGraph', { query: { interests_cursor: 'cur-2' } }),
    );
    expect(await screen.findByText('Georges Seurat')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more from your saves and picks' })).toBeNull();
  });

  it('reports a failed summary load with a retry, not invented content', async () => {
    request.mockRejectedValueOnce(
      new MockApiError(500, { code: 'internal', message: 'Nope', retryable: true, request_id: 'r' }),
    );
    request.mockImplementation(async () => summary());
    render(<TasteGraphSection />);
    // The server's own message is shown, not a substitute line.
    expect(await screen.findByText('Nope')).toBeTruthy();
    expect(request.mock.calls.filter(([n]) => n === 'getMyInterestGraph').length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Auguste Rodin')).toBeTruthy();
  });

  it('shows nothing for visitors without an account', () => {
    signedIn = false;
    const { container } = render(<TasteGraphSection />);
    expect(container.textContent).toBe('');
    expect(request).not.toHaveBeenCalled();
  });
});
