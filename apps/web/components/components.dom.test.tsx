import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CaptureResponse,
  CollectionSummary,
  DiscoveryCard as Card,
  SensorConnectionDto,
} from '@culture-atlas/domain/schemas';

vi.mock('next/navigation', () => ({
  usePathname: () => '/collections/abc',
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { sectionFor } from './AppShell';
import { CoverMosaic } from './CollectionCover';
import { Dialog } from './Dialog';
import { DiscoveryCard } from './DiscoveryCard';
import { FilterRow } from './FilterRow';
import { initialDestination, recentFirst } from './SavePicker';
import { ToastProvider, useToast } from './Toast';
import { deriveCaptureState, readTextAttribution, referencePhrase } from './views/CaptureResultView';
import { defaultSelection, moveMembership } from './views/CollectionDetailView';
import { backTarget } from './views/ItemView';
import { addExclusions } from './views/PlanFormView';
import { accessSummary, sensorStatus } from './views/SettingsView';

afterEach(cleanup);

const card = (over: Partial<Card> = {}): Card => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'style',
  category: 'wear',
  title: 'Vintage racing',
  subtitle: null,
  image: { url: '/samples/outfit.jpg', width: 1000, height: 1250, alt: 'jacket' },
  is_example: false,
  saved: false,
  saved_item_id: null,
  recommendation_id: null,
  evidence_available: true,
  ...over,
});

describe('DiscoveryCard', () => {
  it('renders title link, Save over the image and the Example result label', async () => {
    const onSave = vi.fn();
    render(<DiscoveryCard card={card({ is_example: true })} href="/items/1" onSave={onSave} />);
    expect(screen.getByRole('link', { name: 'Vintage racing' })).toHaveProperty(
      'href',
      expect.stringContaining('/items/1'),
    );
    expect(screen.getByText('Example result')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Save Vintage racing' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Vintage racing' }),
      expect.any(HTMLButtonElement),
    );
  });

  it('uses a text treatment without an image and an explicit selection control', async () => {
    const onToggle = vi.fn();
    render(
      <DiscoveryCard
        card={card({ image: null, kind: 'artist', title: 'Bill Evans' })}
        href="/x"
        selection={{ selected: false, onToggle }}
      />,
    );
    expect(screen.getByText('Artist')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Bill Evans' }));
    expect(onToggle).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
  });
});

describe('FilterRow', () => {
  it('renders All plus supported filters as toggle buttons', async () => {
    function Harness() {
      const [v, setV] = useState<'wear' | 'eat' | null>(null);
      return (
        <FilterRow
          label="Filter"
          options={[
            { value: 'wear', label: 'Wear' },
            { value: 'eat', label: 'Eat' },
          ]}
          value={v}
          onChange={setV}
        />
      );
    }
    render(<Harness />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Wear', 'Eat']);
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(screen.getByRole('button', { name: 'Eat' }));
    expect(screen.getByRole('button', { name: 'Eat' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('Dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <div id="app-root">
          <button onClick={() => setOpen(true)}>Open picker</button>
        </div>
        <Dialog open={open} onClose={() => setOpen(false)} title="Save to a collection">
          <button>First</button>
          <button>Last</button>
        </Dialog>
      </>
    );
  }

  it('traps focus, makes the background inert, closes on Escape and returns focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open picker' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Save to a collection' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById('app-root')!.hasAttribute('inert')).toBe(true);
    // First focusable is Close; Tab cycles inside.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Last' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.getElementById('app-root')!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});

describe('Toast', () => {
  it('announces politely and runs Undo', async () => {
    const undo = vi.fn();
    function Harness() {
      const toast = useToast();
      return (
        <button
          onClick={() =>
            toast.show({
              message: 'Saved to Slow Sunday',
              action: { label: 'Undo', onAction: undo },
            })
          }
        >
          Save
        </button>
      );
    }
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('Saved to Slow Sunday');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('auto-dismisses', () => {
    vi.useFakeTimers();
    function Harness() {
      const toast = useToast();
      return <button onClick={() => toast.show({ message: 'Hidden', duration: 1000 })}>Go</button>;
    }
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(document.querySelector('.toast')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1100));
    expect(document.querySelector('.toast')).toBeNull();
    vi.useRealTimers();
  });
});

describe('CoverMosaic', () => {
  it('uses the mockup 07 layout: three tiles from three images, otherwise one (mini: up to three)', () => {
    const imgs = Array.from({ length: 6 }, (_, i) => ({
      url: `/i${i}.jpg`,
      width: null,
      height: null,
      alt: '',
    }));
    const { container, rerender } = render(<CoverMosaic images={imgs} />);
    expect(container.querySelectorAll('img')).toHaveLength(3);
    expect(container.querySelector('.mosaic--n3')).not.toBeNull();
    rerender(<CoverMosaic images={imgs.slice(0, 2)} />);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.querySelector('.mosaic--n1')).not.toBeNull();
    rerender(<CoverMosaic images={[]} />);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('.mosaic__empty')).not.toBeNull();
    rerender(<CoverMosaic images={imgs} size="mini" />);
    expect(container.querySelectorAll('img')).toHaveLength(3);
  });
});

describe('view logic', () => {
  it('maps paths to primary destinations', () => {
    expect(sectionFor('/')).toBe('discover');
    expect(sectionFor('/items/1')).toBe('discover');
    expect(sectionFor('/collections/later')).toBe('collections');
    expect(sectionFor('/plans/1')).toBe('plans');
    expect(sectionFor('/settings')).toBeNull();
  });

  it('picks the remembered save destination, else the most recent collection, else Save for later', () => {
    const c = (id: string, updated: string) => ({ id, updated_at: updated }) as CollectionSummary;
    const list = recentFirst([c('old', '2026-01-01T00:00:00Z'), c('new', '2026-05-01T00:00:00Z')]);
    expect(list.map((x) => x.id)).toEqual(['new', 'old']);
    expect(initialDestination(list, 'old')).toBe('old');
    expect(initialDestination(list, 'gone')).toBe('new');
    expect(initialDestination(list, 'later')).toBe('later');
    expect(initialDestination([], null)).toBe('later');
  });

  it('suggests a diverse default selection of at most five', () => {
    const kinds: Card['kind'][] = [
      'film',
      'film',
      'food',
      'capture',
      'artist',
      'style',
      'brand',
      'reference',
    ];
    const cards = kinds.map((kind, i) => card({ id: `id-${i}`, kind }));
    const picked = defaultSelection(cards);
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((id) => cards.find((c) => c.id === id)!.kind)).size).toBe(5);
    expect(defaultSelection(cards.slice(0, 2))).toEqual(['id-0', 'id-1']);
  });

  it('moves memberships while keeping every id exactly once', () => {
    expect(moveMembership(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveMembership(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });

  it('derives capture phases: processing, partial retry and no subject', () => {
    const base = {
      job_id: null,
      status: 'ready',
      recommendations: [card()],
      references: [],
      analysis: {
        id: 'a',
        version: 1,
        title: 'T',
        interpretation: 'I',
        sections: { wear: 'complete', play: 'unavailable' },
        question: null,
        warnings: [],
        created_at: '',
      },
    } as unknown as CaptureResponse;
    expect(deriveCaptureState(null, { state: 'running' }, false).phase).toBe('processing');
    const partial = deriveCaptureState(base, { state: 'partial' }, false);
    expect(partial).toMatchObject({ phase: 'results', showRetry: true, noSubject: false });
    const empty = {
      ...base,
      recommendations: [],
      analysis: {
        ...base.analysis!,
        sections: { wear: 'complete' },
        warnings: [{ code: 'blurred', message: '' }],
      },
    } as CaptureResponse;
    expect(deriveCaptureState(empty, { state: 'complete' }, false).noSubject).toBe(true);
    expect(
      deriveCaptureState(
        {
          ...base,
          status: 'failed',
          recommendations: [],
          analysis: null,
        } as unknown as CaptureResponse,
        { state: 'failed' },
        false,
      ).phase,
    ).toBe('failed');
  });

  it('phrases resemblances as resemblances', () => {
    expect(referencePhrase({ name: 'Bauhaus', qualified: true, relation: 'resembles' })).toBe(
      'Resembles Bauhaus',
    );
    expect(referencePhrase({ name: 'Eames chair', qualified: false, relation: 'depicted' })).toBe(
      'Eames chair',
    );
  });

  it('shows a text-only reference by name with the text it was read from, never as a resemblance', () => {
    const nba = { name: 'NBA', qualified: true, relation: 'depicted' as const, read_text: 'NBA' };
    expect(referencePhrase(nba)).toBe('NBA');
    expect(readTextAttribution(nba)).toBe('Read in the photo: “NBA”');
    expect(readTextAttribution({ read_text: null })).toBeNull();
    expect(readTextAttribution({})).toBeNull();
  });

  it('builds Back targets from where the item was opened', () => {
    expect(backTarget(new URLSearchParams('from=capture&capture=c1'))).toEqual({
      href: '/captures/c1',
      label: 'Your photo',
    });
    expect(backTarget(new URLSearchParams('from=collection&collection=k'))).toEqual({
      href: '/collections/k',
      label: 'Collection',
    });
    expect(backTarget(new URLSearchParams(''))).toEqual({ href: '/', label: 'Discover' });
  });

  it('bounds and dedupes dietary exclusions', () => {
    expect(addExclusions(['Peanuts'], 'peanuts, shellfish ,, sesame')).toEqual([
      'Peanuts',
      'shellfish',
      'sesame',
    ]);
    expect(addExclusions([], 'x'.repeat(60))[0]).toHaveLength(40);
    expect(
      addExclusions(
        Array.from({ length: 12 }, (_, i) => `f${i}`),
        'more',
      ),
    ).toHaveLength(12);
  });

  it('reports World Sensor status, including offline with the last import', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    const conn = (over: Partial<SensorConnectionDto>): SensorConnectionDto => ({
      id: 'x',
      origin: 'https://relay.example',
      mode: 'bridge',
      enabled: true,
      last_success_at: null,
      last_attempt_at: null,
      last_error_code: null,
      created_at: '',
      ...over,
    });
    expect(
      sensorStatus(
        conn({ last_success_at: '2026-10-13T11:59:00Z', last_attempt_at: '2026-10-13T11:59:00Z' }),
        now,
      ),
    ).toEqual({ label: 'Connected · last import 1 minute ago', offline: false });
    expect(
      sensorStatus(
        conn({
          last_success_at: '2026-10-13T09:00:00Z',
          last_attempt_at: '2026-10-13T11:59:50Z',
          last_error_code: 'relay_unreachable',
        }),
        now,
      ),
    ).toEqual({ label: 'Offline · last import 3 hours ago', offline: true });
    expect(sensorStatus(conn({}), now).label).toBe('Waiting for the first import');
    expect(sensorStatus(conn({ enabled: false }), now).label).toBe('Import is off');
  });

  it('summarizes agent access by collection names', () => {
    const names = new Map([['c1', 'Slow Sunday']]);
    expect(accessSummary({ library_access: 'all', collection_ids: [] }, names)).toBe(
      'Whole library',
    );
    expect(
      accessSummary(
        { library_access: 'selected_collections', collection_ids: ['c1', 'c2'] },
        names,
      ),
    ).toBe('Slow Sunday, A collection');
  });
});

describe('SavePicker (account)', () => {
  it('preselects the most recent collection and saves to it', async () => {
    const { SavePicker } = await import('./SavePicker');
    const { api } = await import('@/lib/client/api');
    const list = {
      collections: [
        {
          id: '00000000-0000-4000-8000-0000000000c1',
          name: 'Slow Sunday',
          description: null,
          item_count: 2,
          cover: [],
          revision: 3,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-06-01T00:00:00Z',
        },
        {
          id: '00000000-0000-4000-8000-0000000000c2',
          name: 'After dark',
          description: null,
          item_count: 1,
          cover: [],
          revision: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-02-01T00:00:00Z',
        },
      ],
      unfiled: { item_count: 0, cover: [] },
    };
    const spy = vi.spyOn(api, 'request').mockResolvedValue(list as never);
    const onSave = vi.fn(async () => undefined);
    render(
      <>
        <div id="app-root" />
        <SavePicker
          open
          isAccount
          target={{ itemId: 'i1', title: 'Vintage racing', image: null, saved: false }}
          returnFocus={null}
          onClose={() => undefined}
          onSave={onSave}
          onUnsave={async () => undefined}
          onAccountCreated={() => undefined}
        />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: 'Slow Sunday' }) as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Slow Sunday' })),
    );
    await userEvent.click(screen.getByRole('radio', { name: 'New collection' }));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Collection name'), 'Weekend');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ kind: 'new', name: 'Weekend' });
    spy.mockRestore();
  });
});

describe('SavePicker (visitor)', () => {
  it('offers account creation only: no temporary save the service would refuse', async () => {
    const { SavePicker } = await import('./SavePicker');
    render(
      <>
        <div id="app-root" />
        <SavePicker
          open
          isAccount={false}
          target={{ itemId: 'i1', title: 'Vintage racing', image: null, saved: false }}
          returnFocus={null}
          onClose={() => undefined}
          onSave={async () => undefined}
          onUnsave={async () => undefined}
          onAccountCreated={() => undefined}
        />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Create account' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /for this visit/i })).toBeNull();
  });
});
