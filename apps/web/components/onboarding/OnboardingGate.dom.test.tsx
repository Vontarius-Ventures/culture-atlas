import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ONBOARDING_PATH } from '@/lib/client/onboarding';
import { redirectToOnboarding, useOnboardingGate } from './OnboardingGate';

/**
 * SCREEN-CONTRACT + VAL-CROSS-005: the onboarding redirect must respect the
 * dialog hold — a save dialog that just created the account finishes first.
 * The shell gate redirects once the dialog closes, and the feed-level
 * onboarding_required gate (Discover) navigates through redirectToOnboarding
 * for the same hold instead of interrupting the dialog mid-save. Found as a
 * real race: the claimed account's example-feed poll answered
 * onboarding_required and hard-navigated away from the open save dialog.
 */

const replace = vi.hoisted(() => vi.fn());
const sessionReplace = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: sessionReplace }) }));
vi.mock('@/lib/client/navigate', () => ({ hardReplace: replace }));

let required = false;
let account = false;

vi.mock('@/lib/client/session', () => ({
  useSession: () => ({
    session: account
      ? { principal: { kind: 'account', account_id: 'acc-1' }, onboarding_required: required }
      : { principal: { kind: 'session', session_id: 's-1' }, onboarding_required: false },
  }),
}));

/** The shell's inert root a dialog marks while it holds the page. */
function mountAppRoot(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'app-root';
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  replace.mockClear();
  sessionReplace.mockClear();
});

afterEach(() => {
  cleanup();
  document.getElementById('app-root')?.remove();
});

describe('useOnboardingGate', () => {
  it('sends an account that owes the questionnaire to the questionnaire', async () => {
    account = true;
    required = true;
    mountAppRoot();
    const Harness = ({ pathname }: { pathname: string }) => {
      const pending = useOnboardingGate(pathname);
      return <span data-testid="pending">{String(pending)}</span>;
    };
    render(<Harness pathname="/" />);
    await waitFor(() => expect(sessionReplace).toHaveBeenCalledWith(ONBOARDING_PATH));
    expect(screen.getByTestId('pending').textContent).toBe('true');
  });

  it('holds the redirect while a dialog is open, then redirects when it closes', async () => {
    account = true;
    required = true;
    const root = mountAppRoot();
    root.setAttribute('inert', ''); // a dialog holds the page
    const Harness = ({ pathname }: { pathname: string }) => {
      const pending = useOnboardingGate(pathname);
      return <span data-testid="pending">{String(pending)}</span>;
    };
    const { rerender } = render(<Harness pathname="/" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(sessionReplace).not.toHaveBeenCalled();
    expect(screen.getByTestId('pending').textContent).toBe('false');

    root.removeAttribute('inert'); // the dialog finished its save
    await waitFor(() => expect(sessionReplace).toHaveBeenCalledWith(ONBOARDING_PATH));
    rerender(<Harness pathname="/" />);
    expect(screen.getByTestId('pending').textContent).toBe('true');
  });

  it('never redirects an account that owes nothing', async () => {
    account = true;
    required = false;
    mountAppRoot();
    const Harness = ({ pathname }: { pathname: string }) => {
      const pending = useOnboardingGate(pathname);
      return <span data-testid="pending">{String(pending)}</span>;
    };
    render(<Harness pathname="/" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(sessionReplace).not.toHaveBeenCalled();
  });
});

describe('redirectToOnboarding', () => {
  it('navigates to the questionnaire when no dialog holds the page', () => {
    mountAppRoot();
    redirectToOnboarding();
    expect(replace).toHaveBeenCalledWith(ONBOARDING_PATH);
  });

  it('waits for an open dialog instead of interrupting it', () => {
    const root = mountAppRoot();
    root.setAttribute('inert', '');
    redirectToOnboarding();
    expect(replace).not.toHaveBeenCalled();
  });
});
