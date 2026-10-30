import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET_CONTROL_SELECTORS } from '../../e2e/secret-mask';
import { SecretOnce } from './AgentPlatformView';

/**
 * credential-evidence-containment (EXP-SCR-024): a committed journey
 * screenshot disclosed the generated test-journey agent credential because
 * the screenshot mask covered readonly INPUTS but not the readonly TEXTAREA
 * SecretOnce actually renders the credential in.
 *
 * This is the selector-coverage half of the masking proof: render the REAL
 * component and require that every element carrying the once-shown
 * credential is matched by the shared journey mask inventory
 * (e2e/secret-mask.ts). If SecretOnce ever moves the credential into a
 * control the inventory does not match, this fails — a committed screenshot
 * would disclose the credential again. The other half,
 * e2e/real/screenshot-mask.spec.ts, proves the mask mechanics hide whatever
 * the selectors match. The value below is synthetic; no real credential is
 * ever copied into tests, logs or evidence.
 */
const SYNTHETIC_CREDENTIAL = 'cat_TESTONLY_synthetic_masking_probe_not_a_real_credential';

function credentialBearingElements(root: HTMLElement): Element[] {
  return Array.from(root.querySelectorAll('input, textarea, code')).filter(
    (el) =>
      (el as HTMLInputElement | HTMLTextAreaElement).value === SYNTHETIC_CREDENTIAL ||
      el.textContent === SYNTHETIC_CREDENTIAL,
  );
}

describe('SecretOnce is covered by the journey screenshot mask', () => {
  afterEach(cleanup);

  it('renders the once-shown credential only inside controls the mask selectors match', () => {
    const { container } = render(
      <SecretOnce
        credential={SYNTHETIC_CREDENTIAL}
        mcpUrl="http://127.0.0.1:3200/mcp"
        onDone={() => undefined}
      />,
    );

    // The credential really is on screen: that is SecretOnce's whole purpose.
    const bearing = credentialBearingElements(container);
    expect(bearing.length).toBeGreaterThan(0);

    for (const el of bearing) {
      const covered = SECRET_CONTROL_SELECTORS.some((selector) => el.matches(selector));
      expect(
        covered,
        `the credential control <${el.tagName.toLowerCase()}> must match one of the journey mask selectors ${SECRET_CONTROL_SELECTORS.join(', ')}`,
      ).toBe(true);
    }
  });

  it('keeps the credential control a readonly textarea, exactly the shape the mask must cover', () => {
    const { container } = render(<SecretOnce credential={SYNTHETIC_CREDENTIAL} onDone={() => undefined} />);
    const control = container.querySelector('textarea');
    expect(control).not.toBeNull();
    expect((control as HTMLTextAreaElement).readOnly).toBe(true);
  });
});
