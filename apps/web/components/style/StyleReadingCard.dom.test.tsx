import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { styleReading } from '../../e2e/mock/style';
import { StyleReading, STYLE_COPY } from '@/lib/client/style';
import { StyleReadingCard } from './StyleReadingCard';

afterEach(cleanup);

const noop = () => undefined;
const base = {
  experimental: { label: 'Experimental', note: STYLE_COPY['experimental.note'] },
  active: null,
  onHighlight: noop,
  onFlashSubject: noop,
  onMoreLikeThis: noop,
  railSubjects: new Set<string>(),
  onRetry: noop,
  retrying: false,
  retryUsed: false,
  onAnnounce: noop,
};

describe('StyleReadingCard', () => {
  it('renders server display strings verbatim, never the internal names', () => {
    const reading = StyleReading.parse(styleReading());
    render(<StyleReadingCard {...base} state={{ kind: 'ready', reading }} />);
    expect(screen.getByRole('heading', { name: 'Style reading' })).toBeTruthy();
    expect(screen.getByText('Resembles vintage motorsport')).toBeTruthy();
    expect(screen.queryByText('Vintage motorsport')).toBeNull();
    expect(screen.getByText('Suggests the 1970s')).toBeTruthy();
    expect(screen.queryByText('#E9E1CF')).toBeNull();
    // Strength lives only in the accessible name.
    expect(screen.getByRole('button', { name: 'Sportswear, clear' })).toBeTruthy();
  });

  it('a chip with a region toggles the highlight', () => {
    const reading = StyleReading.parse(styleReading());
    const onHighlight = vi.fn();
    render(
      <StyleReadingCard {...base} onHighlight={onHighlight} state={{ kind: 'ready', reading }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Sportswear, clear' }));
    expect(onHighlight).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Sportswear',
        region: expect.objectContaining({ x: 0.22 }),
      }),
    );
  });

  it('failed shows one Try again; a used retry hides it', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <StyleReadingCard {...base} onRetry={onRetry} state={{ kind: 'failed' }} />,
    );
    expect(screen.getByText(STYLE_COPY['style.failed'])).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<StyleReadingCard {...base} retryUsed state={{ kind: 'failed' }} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('no badge when the analysis is qualified; nothing at all for older analyses', () => {
    const { container, rerender } = render(
      <StyleReadingCard {...base} experimental={null} state={{ kind: 'loading' }} />,
    );
    expect(screen.getByText(STYLE_COPY['style.reading'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Experimental' })).toBeNull();
    rerender(<StyleReadingCard {...base} state={{ kind: 'none' }} />);
    expect(container.innerHTML).toBe('');
  });
});
