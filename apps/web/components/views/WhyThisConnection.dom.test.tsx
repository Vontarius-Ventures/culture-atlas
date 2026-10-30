import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecommendationConnectionResponse } from '@culture-atlas/domain/schemas';
import { WhyThisConnection } from './WhyThisConnection';

/**
 * VAL-FEED-003: the "Why this?" disclosure for a recommendation the owner
 * already saw. It must show the pinned proof exactly — the owner's support
 * roots, the shared cultural path, permitted source links — and stay honest
 * when the proof is unavailable, without substituting another reason, and
 * without raw scores or provider identifiers.
 */

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
  newIdempotencyKey: () => 'k',
}));

const RODIN_EDGE = {
  subject: { node_id: 'n-rodin', name: 'Auguste Rodin' },
  predicate: 'DOCUMENTED_ASSOCIATION' as const,
  object: { node_id: 'n-aic', name: 'Art Institute of Chicago' },
  association_subtype: 'work_on_display_at',
};

const AIC_SOURCE = {
  id: 's-1',
  url: 'https://www.artic.edu/artworks/11320',
  title: 'Adam — Art Institute of Chicago',
  publisher: 'Art Institute of Chicago',
  locator: 'artist_display',
  excerpt: null,
  retrieved_at: '2026-10-01T00:00:00Z',
};

function connection(
  over: Partial<RecommendationConnectionResponse> = {},
): RecommendationConnectionResponse {
  return {
    recommendation_id: 'rec-1',
    origin: 'catalog',
    provenance: 'graph_run',
    state: 'connected',
    intent: 'personal',
    graph_run_id: 'run-1',
    reason: { text: 'Also work on display at Art Institute of Chicago.', template: 'co_documented_association' },
    path: [RODIN_EDGE],
    sources: [AIC_SOURCE],
    support: {
      roots: [
        { edge_id: 'e-1', origin: 'explicit_save', label: 'Auguste Rodin' },
      ],
    },
    unavailable_reason: null,
    ...over,
  };
}

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(async () => ({}));
  signedIn = true;
});
afterEach(cleanup);

async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Why this?' }));
}

describe('WhyThisConnection', () => {
  it('discloses the pinned personal proof: support roots, cultural path, and source links', async () => {
    request.mockResolvedValueOnce(connection());
    render(<WhyThisConnection recommendationId="rec-1" />);
    expect(request).not.toHaveBeenCalled();
    await open();
    expect(request).toHaveBeenCalledWith('getMyRecommendationConnection', {
      params: { id: 'rec-1' },
    });
    expect(await screen.findByText('Because you saved Auguste Rodin.')).toBeTruthy();
    expect(screen.getByText('Also work on display at Art Institute of Chicago.')).toBeTruthy();
    expect(
      screen.getByText('Auguste Rodin — work on display at — Art Institute of Chicago'),
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: /Adam — Art Institute of Chicago/ });
    expect(link.getAttribute('href')).toBe('https://www.artic.edu/artworks/11320');
    expect(screen.getByText(/Art Institute of Chicago · artist_display/)).toBeTruthy();
    expect(screen.queryByText(/score|qloo/i)).toBeNull();
  });

  it('phrases capture-reference roots as what the photo shows', async () => {
    request.mockResolvedValueOnce(
      connection({
        intent: 'photo',
        support: { roots: [{ edge_id: 'e-2', origin: 'capture_reference', label: 'Auguste Rodin' }] },
      }),
    );
    render(<WhyThisConnection recommendationId="rec-1" />);
    await open();
    expect(await screen.findByText('Because your photo shows Auguste Rodin.')).toBeTruthy();
  });

  it('never substitutes when the pinned proof is unavailable', async () => {
    request.mockResolvedValueOnce(
      connection({
        state: 'unavailable',
        intent: null,
        reason: { text: null, template: null },
        path: null,
        sources: [],
        support: null,
        unavailable_reason: 'support_withdrawn',
      }),
    );
    render(<WhyThisConnection recommendationId="rec-1" />);
    await open();
    expect(
      await screen.findByText('The background for this suggestion is no longer available.'),
    ).toBeTruthy();
    expect(screen.getByText('What it was based on has changed.')).toBeTruthy();
    expect(screen.queryByText('Because you saved')).toBeNull();
    expect(screen.queryByText(/Art Institute of Chicago/)).toBeNull();
  });

  it('maps a rights-expired proof to its own honest line', async () => {
    request.mockResolvedValueOnce(
      connection({
        state: 'unavailable',
        reason: { text: null, template: null },
        path: null,
        sources: [],
        support: null,
        unavailable_reason: 'rights_expired',
      }),
    );
    render(<WhyThisConnection recommendationId="rec-1" />);
    await open();
    expect(await screen.findByText('The source link’s permission ended.')).toBeTruthy();
  });

  it('serves scoped Discover proofs without account support roots', async () => {
    request.mockResolvedValueOnce(
      connection({
        provenance: 'scoped_discovery',
        intent: null,
        graph_run_id: null,
        support: null,
        reason: { text: 'From your grant’s catalog.', template: 'scoped' },
      }),
    );
    render(<WhyThisConnection recommendationId="rec-1" />);
    await open();
    expect(await screen.findByText('From your grant’s catalog.')).toBeTruthy();
    expect(screen.queryByText('What this builds on:')).toBeNull();
    expect(
      screen.getByText('Auguste Rodin — work on display at — Art Institute of Chicago'),
    ).toBeTruthy();
  });

  it('serves the legacy record as-is: reason and sources, no graph path', async () => {
    request.mockResolvedValueOnce(
      connection({
        provenance: 'legacy',
        intent: null,
        graph_run_id: null,
        reason: { text: 'A classic pick for you.', template: null },
        path: null,
        support: null,
      }),
    );
    render(<WhyThisConnection recommendationId="rec-1" />);
    await open();
    expect(await screen.findByText('A classic pick for you.')).toBeTruthy();
    expect(screen.queryByText(/work on display/)).toBeNull();
    expect(screen.queryByText('What this builds on:')).toBeNull();
    expect(screen.getByRole('link', { name: /Adam — Art Institute of Chicago/ })).toBeTruthy();
  });

  it('offers a retry when the connection cannot load', async () => {
    request.mockRejectedValueOnce(
      new MockApiError(500, { code: 'internal', message: 'Nope', retryable: true, request_id: 'r' }),
    );
    request.mockResolvedValueOnce(connection());
    render(<WhyThisConnection recommendationId="rec-1" />);
    await open();
    expect(
      await screen.findByText('This suggestion’s background could not load.'),
    ).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Because you saved Auguste Rodin.')).toBeTruthy();
  });

  it('stays quiet when the recommendation is not the owner’s', async () => {
    request.mockRejectedValue(
      new MockApiError(404, { code: 'not_found', message: 'No such recommendation', retryable: false, request_id: 'r' }),
    );
    const { container } = render(<WhyThisConnection recommendationId="rec-1" />);
    await open();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders nothing for visitors without an account', () => {
    signedIn = false;
    const { container } = render(<WhyThisConnection recommendationId="rec-1" />);
    expect(container.textContent).toBe('');
    expect(request).not.toHaveBeenCalled();
  });
});
