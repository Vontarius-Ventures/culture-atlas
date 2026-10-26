import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DiscoveryCard } from '@culture-atlas/domain/schemas';
import { Conveyor } from './Conveyor';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('fills the animated rail when a static pool grows before passive effects run', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly callback: () => void) {}
      observe() {
        this.callback();
      }
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
  const cards = Array.from({ length: 6 }, (_, i) => ({
    id: `card-${i}`,
    title: `Card ${i}`,
    image: null,
  })) as DiscoveryCard[];
  const rail = (items: DiscoveryCard[]) => (
    <Conveyor
      items={items}
      axis="horizontal"
      label="Related discoveries"
      renderItem={(card) => card.title}
      fallback={() => <p>Static cards</p>}
    />
  );
  const view = render(rail(cards.slice(0, 3)));
  expect(view.getByText('Static cards')).toBeTruthy();
  view.rerender(rail(cards));
  expect(view.container.querySelectorAll('.conveyor__item').length).toBeGreaterThan(0);
  expect(view.queryByText('Static cards')).toBeNull();
});
