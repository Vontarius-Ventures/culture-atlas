import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDiscoveryIntents } from '@/lib/client/style';
import {
  COMMONS_FIXTURE_CARD,
  discoveryIntentsFixture,
  type VisualFixtureMode,
} from '../../e2e/mock/discovery-intents';
import { DiscoveryModes, VisualReferences } from './DiscoveryModes';

afterEach(cleanup);
const visual = (mode: VisualFixtureMode) =>
  parseDiscoveryIntents(discoveryIntentsFixture(mode))?.visual ?? null;

describe('discovery mode controls', () => {
  it('defaults to the unchanged accessible connections list and supports Tab/Enter/Space', async () => {
    const user = userEvent.setup();
    render(
      <DiscoveryModes visual={visual('ready')} timedOut={false} pollingError={false}>
        <ul aria-label="Discoveries from your photo">
          <li>Legacy contextual connection</li>
        </ul>
      </DiscoveryModes>,
    );
    expect(screen.getByRole('list', { name: 'Discoveries from your photo' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Attributed reference images' })).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Connections' }));
    await user.tab();
    await user.keyboard('{Enter}');
    const selected = screen.getByRole('button', { name: 'Visual references' });
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(selected);
    expect(screen.queryByRole('list', { name: 'Discoveries from your photo' })).toBeNull();
    const museum = screen.getByRole('list', { name: 'Attributed reference images' });
    expect(within(museum).getAllByRole('listitem')).toHaveLength(1);
    expect(
      screen.getByText(/not authentication|not.*authentication|—not authentication/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /save|buy/i })).toBeNull();
    expect(screen.getByRole('link', { name: /View at The Metropolitan/ }).getAttribute('rel')).toBe(
      'noopener noreferrer',
    );
    await user.tab({ shift: true });
    await user.keyboard(' ');
    expect(screen.getByRole('list', { name: 'Discoveries from your photo' })).toBeTruthy();
  });

  it('handles rapid toggles without changing the data or connections semantics', () => {
    render(
      <DiscoveryModes visual={visual('ready')} timedOut={false} pollingError={false}>
        <ul aria-label="Discoveries from your photo">
          <li>Connection evidence</li>
        </ul>
      </DiscoveryModes>,
    );
    for (let n = 0; n < 20; n++) {
      fireEvent.click(screen.getByRole('button', { name: 'Visual references' }));
      expect(screen.getByRole('list', { name: 'Attributed reference images' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    }
    expect(screen.getByRole('list', { name: 'Discoveries from your photo' }).textContent).toBe(
      'Connection evidence',
    );
  });
});

describe('truthful visual states', () => {
  it.each([
    ['unavailable', 'not available for this photo'],
    ['pending', 'waiting for comparison'],
    ['running', 'Comparing reference images'],
    ['empty', 'No reference images passed'],
    ['failed', 'could not complete the visual comparison'],
    ['missing-image', 'No displayable reference images'],
    ['commons-missing-credit', 'No displayable reference images'],
    ['missing-profile', 'Visual comparison is not available right now'],
    ['malformed', 'not available for this photo'],
  ] as const)('renders %s without contextual backfill', (mode, copy) => {
    render(<VisualReferences visual={visual(mode)} />);
    expect(screen.getByRole('status').textContent).toContain(copy);
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.queryByRole('button', { name: /save|buy/i })).toBeNull();
  });

  it('reports timeout as unknown, not a failed or successful comparison', () => {
    render(<VisualReferences visual={visual('running')} timedOut />);
    expect(screen.getByRole('status').textContent).toContain('their result is not known yet');
    expect(screen.queryByText(/could not complete|No reference images passed/)).toBeNull();
  });

  it.each(['unknown_public_reason', 'constructor'])(
    'uses bounded friendly copy, never unknown public codes or raw errors: %s',
    (reason) => {
      const value = visual('failed')!;
      value.reason = reason;
      render(<VisualReferences visual={value} />);
      expect(screen.queryByText(reason)).toBeNull();
    },
  );

  it('falls back honestly if the owned cached image fails to load', () => {
    render(<VisualReferences visual={visual('ready')} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Reference image unavailable')).toBeTruthy();
    expect(screen.getByRole('link', { name: /View at/ })).toBeTruthy();
  });

  it('distinguishes a transport progress error from comparison failure', () => {
    render(<VisualReferences visual={visual('running')} pollingError />);
    expect(screen.getByRole('status').textContent).toContain(
      'could not check visual reference progress',
    );
    expect(screen.queryByText(/could not complete the visual comparison/)).toBeNull();
  });

  it.each(['commons-by', 'commons-sa'] as const)(
    'renders adjacent escaped credit and keyboard-accessible license for %s',
    async (mode) => {
      const user = userEvent.setup();
      const value = visual(mode)!;
      const card = value.cards[0]!;
      card.credit!.changes = '<script>not executable</script>';
      const { container } = render(
        <DiscoveryModes visual={value} timedOut={false} pollingError={false}>
          <ul aria-label="Discoveries from your photo">
            <li>Unchanged connection</li>
          </ul>
        </DiscoveryModes>,
      );
      await user.tab();
      await user.tab();
      await user.keyboard('{Enter}');
      const button = screen.getByRole('button', { name: 'Visual references' });
      expect(document.getElementById(button.getAttribute('aria-controls')!)?.hidden).toBe(false);
      const list = screen.getByRole('list', { name: 'Attributed reference images' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
      const figure = screen.getByRole('figure');
      const caption = figure.querySelector('figcaption')!;
      expect(within(figure).getByRole('img')).toBeTruthy();
      expect(caption.textContent).toContain(COMMONS_FIXTURE_CARD.credit.attribution);
      expect(caption.textContent).toContain('Changes: <script>not executable</script>');
      expect(container.querySelector('em, script')).toBeNull();
      const license = within(figure).getByRole('link', { name: /^CC-BY/ });
      expect(license.getAttribute('href')).toBe(card.credit!.license_url);
      expect(license.getAttribute('rel')).toBe('noopener noreferrer');
      await user.tab();
      expect(document.activeElement).toBe(license);
      await user.tab();
      expect(document.activeElement).toBe(
        screen.getByRole('link', { name: /View at Wikimedia Commons/ }),
      );
      expect(list.textContent).not.toMatch(/museum|public domain/i);
      expect(
        screen.getByText(/not authentication, maker attribution, or items available to buy/),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: /save|buy/i })).toBeNull();
      fireEvent.error(screen.getByRole('img'));
      expect(screen.getByText('Reference image unavailable')).toBeTruthy();
      expect(caption.textContent).toContain(card.credit!.license);
      expect(screen.queryByRole('img')).toBeNull();
    },
  );

  it('drops malformed Commons credit without hiding a valid old Met card or backfilling', () => {
    render(<VisualReferences visual={visual('commons-invalid-credit')} />);
    const list = screen.getByRole('list', { name: 'Attributed reference images' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Synthetic museum reference')).toBeTruthy();
    expect(screen.queryByText('Synthetic Commons reference')).toBeNull();
    expect(screen.queryByRole('link', { name: /^CC-BY/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /save|buy/i })).toBeNull();
  });
});
