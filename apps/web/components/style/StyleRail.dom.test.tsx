import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rail, STYLE_COPY } from '@/lib/client/style';
import { StyleRail } from './StyleRail';

afterEach(cleanup);

const rail = (empty_message: string, title = 'Qloo connections') =>
  Rail.parse({
    key: 'more_like_this:s1',
    kind: 'more_like_this',
    title,
    subtitle: 'From this reading',
    subject_id: 's1',
    status: 'empty',
    empty_message,
    cards: [],
  });

describe('server-owned exploration rails', () => {
  it('renders the server title, subtitle and unsupported message without a city prompt', () => {
    render(
      <StyleRail
        rail={rail(STYLE_COPY['style.unsupported'], 'Films to explore')}
        cards={[]}
        captureId="capture"
        caption={null}
        pulse={false}
        onSave={vi.fn()}
        onAddCity={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Films to explore' })).toBeTruthy();
    expect(screen.getByText('From this reading')).toBeTruthy();
    expect(screen.getByText(STYLE_COPY['style.unsupported'])).toBeTruthy();
    expect(screen.queryByText('More like this')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add city' })).toBeNull();
  });

  it.each([STYLE_COPY['style.no_city'], 'Add a city to see places with this style.'])(
    'offers Add city only for explicit current/legacy location copy: %s',
    (message) => {
      const onAddCity = vi.fn();
      render(
        <StyleRail
          rail={rail(message)}
          cards={[]}
          captureId="capture"
          caption={null}
          pulse={false}
          onSave={vi.fn()}
          onAddCity={onAddCity}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Add city' }));
      expect(onAddCity).toHaveBeenCalledOnce();
    },
  );
});
