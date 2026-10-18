import { describe, expect, it, vi } from 'vitest';
import type { SessionResponse, TasteSeedStatus } from '@culture-atlas/domain/schemas';
import copy from '../../../../specs/capture-platform-v2/design/copy.json';
import {
  clampStep,
  counterText,
  exclusionLabel,
  normalizeExclusion,
  onboardingRedirect,
  pickKindLabel,
  readyTitle,
  seedPollDelay,
  seedView,
  stepLabel,
  toggleExclusion,
} from './onboarding';
import { createReadyWatcher, type ReadyPoll } from './ready';

const session = (
  kind: 'anonymous' | 'account',
  onboarding_required?: boolean,
): SessionResponse => ({
  principal: {
    kind,
    account_id: kind === 'account' ? '00000000-0000-4000-8000-000000000001' : null,
    session_id: '00000000-0000-4000-8000-000000000002',
    expires_at: null,
    is_demo_owner: false,
  },
  csrf_token: 't',
  ...(onboarding_required === undefined ? {} : { onboarding_required }),
});

describe('taste questionnaire copy and counter', () => {
  it('counts down with the exact copy, then Ready', () => {
    expect([0, 1, 2, 3, 7].map(counterText)).toEqual([
      copy['onboarding.counter.3'],
      copy['onboarding.counter.2'],
      copy['onboarding.counter.1'],
      copy['onboarding.counter.ready'],
      copy['onboarding.counter.ready'],
    ]);
  });

  it('labels and clamps mobile steps', () => {
    expect(stepLabel(2)).toBe('Step 2 of 3');
    expect([null, '0', '2', '3', '9', 'x'].map(clampStep)).toEqual([1, 1, 2, 3, 1, 1]);
  });
});

describe('onboardingRedirect (ONB-01, ONB-06)', () => {
  it('never redirects anonymous visitors, even on the questionnaire path', () => {
    expect(onboardingRedirect('/', session('anonymous'))).toBeNull();
    expect(onboardingRedirect('/', null)).toBeNull();
  });

  it('sends an account that owes the questionnaire to /welcome/taste from anywhere else', () => {
    const s = session('account', true);
    for (const p of [
      '/',
      '/collections',
      '/captures/x',
      '/settings',
      '/settings/taste',
      '/library',
    ])
      expect(onboardingRedirect(p, s)).toBe('/welcome/taste');
    for (const p of ['/welcome/taste', '/welcome/building', '/identity/callback', '/shared/abc'])
      expect(onboardingRedirect(p, s)).toBeNull();
  });

  it('leaves accounts alone once complete or when the server does not say (kill switch)', () => {
    expect(onboardingRedirect('/', session('account', false))).toBeNull();
    expect(onboardingRedirect('/', session('account'))).toBeNull();
  });
});

describe('exclusions', () => {
  it('normalizes free text and rejects empties and duplicates', () => {
    expect(normalizeExclusion('  Cilantro  Leaves ', [])).toBe('cilantro leaves');
    expect(normalizeExclusion('   ', [])).toBeNull();
    expect(normalizeExclusion('Peanuts', ['peanuts'])).toBeNull();
    expect(normalizeExclusion('x'.repeat(60), [])).toHaveLength(40);
  });

  it('toggles within the 12-item plan-constraint limit', () => {
    expect(toggleExclusion(['dairy'], 'Dairy')).toEqual([]);
    expect(toggleExclusion(['dairy'], 'eggs')).toEqual(['dairy', 'eggs']);
    const full = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(toggleExclusion(full, 'more')).toEqual(full);
    expect(exclusionLabel('tree nuts')).toBe('Tree nuts');
  });
});

describe('pickKindLabel', () => {
  it('uses the group for catalog picks and the type for search picks', () => {
    expect(pickKindLabel({ source: 'catalog', category: 'wear', item_kind: 'style' })).toBe('Wear');
    expect(pickKindLabel({ source: 'search', category: 'play', item_kind: 'artist' })).toBe(
      'Artist',
    );
    expect(pickKindLabel({ source: 'catalog', category: null, item_kind: 'reference' })).toBeNull();
  });
});

const seed = (
  state: TasteSeedStatus['state'],
  cats: Array<[string, string, number]>,
  poll: number | null = 800,
): TasteSeedStatus => ({
  job_id: null,
  state,
  categories: cats.map(([category, s, card_count]) => ({
    category: category as 'wear',
    state: s as 'ready',
    card_count,
    ready_at: null,
  })),
  first_ready_at: null,
  poll_after_ms: poll,
});

describe('seedView (screen 15)', () => {
  it('advances as soon as the first category holds real recommendations', () => {
    const v = seedView(
      seed('partial', [
        ['wear', 'ready', 6],
        ['play', 'pending', 0],
        ['watch', 'pending', 0],
        ['eat', 'pending', 0],
      ]),
    );
    expect(v.advance).toBe(true);
    expect(v.categories.map((c) => c.ready)).toEqual([true, false, false, false]);
  });

  it('never shows Ready without cards', () => {
    const v = seedView(seed('running', [['wear', 'ready', 0]]));
    expect(v.advance).toBe(false);
    expect(v.categories[0]!.ready).toBe(false);
  });

  it('is honest when Qloo is unavailable or the wait runs long', () => {
    expect(seedView(seed('retrying', [['wear', 'unavailable', 0]])).unavailable).toBe(true);
    expect(seedView(seed('failed', [])).unavailable).toBe(true);
    expect(seedView(seed('running', [['wear', 'pending', 0]]), true).unavailable).toBe(true);
    expect(
      seedView(
        seed('running', [
          ['wear', 'unavailable', 0],
          ['play', 'unavailable', 0],
          ['watch', 'unavailable', 0],
          ['eat', 'unavailable', 0],
        ]),
      ).unavailable,
    ).toBe(true);
  });

  it('goes straight to Discover when there is nothing to wait for', () => {
    expect(seedView(seed('complete', [['wear', 'empty', 0]])).done).toBe(true);
    expect(seedView(seed('not_started', [])).done).toBe(true);
    expect(seedView(seed('running', [['wear', 'pending', 0]])).done).toBe(false);
  });

  it('polls on the server hint, bounded', () => {
    expect(seedPollDelay(seed('running', [], 50))).toBe(500);
    expect(seedPollDelay(seed('running', [], 900))).toBe(900);
    expect(seedPollDelay(seed('running', [], 60_000))).toBe(5000);
    expect(seedPollDelay(null)).toBe(1000);
  });
});

describe('ready notice (screen 17)', () => {
  it('formats the hidden-tab title badge from the copy file', () => {
    expect(readyTitle(1)).toBe('(1) Your photo is ready · culture atlas');
    expect(copy['ready.title_badge']).toContain('{n}');
  });

  function harness(hidden = false) {
    const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
    let seq = 0;
    const onReady = vi.fn();
    const w = createReadyWatcher({
      setTimer: (fn, ms) => {
        const id = ++seq;
        timers.push({ fn, ms, id });
        return id;
      },
      clearTimer: (h) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
      isHidden: () => hidden,
      onReady,
      intervalMs: 100,
    });
    const run = async () => {
      const t = timers.shift();
      t?.fn();
      await new Promise((r) => setTimeout(r, 0));
      return t;
    };
    return { w, onReady, run, timers };
  }

  it('polls until ready and reports whether the person is viewing the result', async () => {
    const { w, onReady, run } = harness();
    const states: ReadyPoll[] = ['active', 'ready'];
    w.watch({
      key: 'capture:1',
      url: '/captures/1',
      thumbnail: '/t.jpg',
      poll: async () => states.shift()!,
    });
    w.setViewing('capture:1');
    await run();
    expect(onReady).not.toHaveBeenCalled();
    w.setViewing(null);
    await run();
    expect(onReady).toHaveBeenCalledWith(
      { key: 'capture:1', url: '/captures/1', thumbnail: '/t.jpg' },
      { viewing: false, hidden: false },
    );
    expect(w.has('capture:1')).toBe(false);
  });

  it('says nothing for failed or cancelled analyses, and uses a refined URL', async () => {
    const { w, onReady, run } = harness(true);
    w.watch({ key: 'a', url: '/a', thumbnail: null, poll: async () => 'gone' });
    await run();
    expect(onReady).not.toHaveBeenCalled();
    w.watch({
      key: 'b',
      url: '/b',
      thumbnail: null,
      poll: async () => ({ state: 'ready', url: '/captures/9' }),
    });
    await run();
    expect(onReady).toHaveBeenCalledWith(
      { key: 'b', url: '/captures/9', thumbnail: null },
      { viewing: false, hidden: true },
    );
  });

  it('backs off on errors and gives up after repeated failures', async () => {
    const { w, run, timers } = harness();
    w.watch({
      key: 'x',
      url: '/x',
      thumbnail: null,
      poll: async () => Promise.reject(new Error('down')),
    });
    await run();
    expect(timers[0]!.ms).toBe(200);
    for (let i = 0; i < 6; i++) await run();
    expect(w.has('x')).toBe(false);
  });

  it('re-watching the same key keeps one loop', () => {
    const { w, timers } = harness();
    const poll = async (): Promise<ReadyPoll> => 'active';
    w.watch({ key: 'k', url: '/k', thumbnail: null, poll });
    w.watch({ key: 'k', url: '/k', thumbnail: '/new.jpg', poll });
    expect(timers).toHaveLength(1);
    w.unwatch('k');
    expect(timers).toHaveLength(0);
  });
});
