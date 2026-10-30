import { expect, test } from '@playwright/test';
import { SECRET_CONTROL_SELECTORS, secretControlMask } from '../secret-mask';

/**
 * credential-evidence-containment (EXP-SCR-024): the synthetic masking-mechanics
 * half of the proof. No app, database, worker or provider is involved — the
 * page below renders the same control shapes the real app uses for secrets,
 * filled with obviously synthetic patterns, and asserts the shared journey
 * mask makes the captured bytes independent of those controls' content:
 *
 *   1. without the mask, two different secret contents produce different
 *      images (the content really is on screen, so an unmasked capture would
 *      disclose it);
 *   2. with the mask every real-journey helper applies, the images are
 *      byte-identical (no trace of the content survives capture);
 *   3. the masked image differs from the unmasked one (the mask is painted,
 *      not a no-op).
 *
 * If a secret-bearing control shape stops matching the selector inventory
 * (e.g. a credential moves into an unlisted element), assertion 2 fails —
 * exactly the EXP-SCR-024 regression class. The companion component test
 * (apps/web/components/views/SecretOnce.mask.dom.test.tsx) keeps the real
 * rendered control matched by the same list.
 */

/** The real control shapes: SecretOnce's textarea, CopyField's input, the v1 API-key code element, and sign-in inputs. */
function secretPage(variant: 'A' | 'B') {
  const mark = variant === 'A' ? 'x' : 'o';
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  /* Monospace keeps the two variants' layout identical; only the masked
     controls' content differs, so any byte difference is masking, not layout.
     overflow-wrap: anywhere mirrors the real .credential__value rule so long
     unbroken keys wrap INSIDE the code box instead of painting past the mask. */
  body { font: 16px ui-monospace, Menlo, monospace; margin: 24px; }
  textarea, input { display: block; margin: 8px 0; width: 340px; }
  code { display: block; margin: 8px 0; padding: 4px; overflow-wrap: anywhere; }
</style></head>
<body>
  <h1>Copy your agent credential</h1>
  <label for="secret">Agent credential</label>
  <textarea id="secret" readonly rows="3" spellcheck="false">${mark.repeat(240)}</textarea>
  <label for="link">Link (shown once)</label>
  <input id="link" readonly value="share=${mark.repeat(120)}">
  <code class="credential__value">key-${mark.repeat(60)}</code>
  <label for="pw">Password</label>
  <input id="pw" type="password" value="${mark.repeat(60)}">
  <label for="em">Email</label>
  <input id="em" type="email" value="${mark.repeat(30)}@example.com">
</body></html>`;
}

test('a masked journey screenshot cannot depend on secret-control content', async ({ page }) => {
  await page.setContent(secretPage('A'));
  const unmaskedA = await page.screenshot({ animations: 'disabled' });

  await page.setContent(secretPage('B'));
  const unmaskedB = await page.screenshot({ animations: 'disabled' });

  // 1. The synthetic secrets are visible and differ, so an unmasked capture
  //    would disclose them (this is the EXP-SCR-024 failure mode).
  expect(Buffer.compare(unmaskedA, unmaskedB)).not.toBe(0);

  // 2. With the shared journey mask, the content of every covered control
  //    cannot reach the image: different contents, identical bytes.
  await page.setContent(secretPage('A'));
  const maskedA = await page.screenshot({ animations: 'disabled', mask: secretControlMask(page) });
  await page.setContent(secretPage('B'));
  const maskedB = await page.screenshot({ animations: 'disabled', mask: secretControlMask(page) });
  expect(
    Buffer.compare(maskedA, maskedB),
    'the masked capture must not depend on the content of any control matched by ' +
      SECRET_CONTROL_SELECTORS.join(', '),
  ).toBe(0);

  // 3. The mask is really painted over the page (not a silent no-op).
  expect(Buffer.compare(maskedA, unmaskedA)).not.toBe(0);
});
