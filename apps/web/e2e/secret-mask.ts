import type { Locator, Page } from '@playwright/test';

/**
 * The single inventory of secret-bearing controls a real-journey screenshot
 * must mask before capture. Every helper that commits evidence uses
 * `secretControlMask` so one list covers all surfaces:
 *
 *  - a once-shown agent credential (SecretOnce renders it in a readonly
 *    TEXTAREA, and the rotate flow reuses the same control);
 *  - a once-shown collection share link (CopyField renders `<input readonly>`);
 *  - the v1 Settings API-key display (`.credential__value` code element);
 *  - password and email inputs.
 *
 * EXP-SCR-024: the v2 journey helper previously masked readonly inputs and
 * `.credential__value` but NOT the readonly textarea, so the committed
 * secret-once screenshots disclosed the generated test-journey agent
 * credential. Two provider-free synthetic proofs keep this honest:
 *
 *  - apps/web/components/views/SecretOnce.mask.dom.test.tsx renders the REAL
 *    SecretOnce component and fails unless the control that carries the
 *    credential matches one of the selectors below;
 *  - e2e/real/screenshot-mask.spec.ts proves a masked capture cannot depend
 *    on the content of any control the list matches.
 */
export const SECRET_CONTROL_SELECTORS = [
  'input[readonly]',
  'textarea[readonly]',
  '.credential__value',
  'input[type="password"]',
  'input[type="email"]',
] as const;

/** The mask argument every real-journey screenshot must pass. */
export function secretControlMask(page: Page): Locator[] {
  return SECRET_CONTROL_SELECTORS.map((selector) => page.locator(selector));
}
