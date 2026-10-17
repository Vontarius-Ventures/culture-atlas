import 'server-only';
import {
  createCaptureIdentityAdapter,
  createNativePrincipalResolver,
  endCaptureAuthority,
  getDb,
  identity,
  nativeSessions,
} from '@culture-atlas/domain';
import { createIdentityMailFromEnv } from '@culture-atlas/providers';
import { installCaptureV2Defaults } from './capture-v2';

/**
 * Composition root for the web server's identity and capture adapters
 * (gaps G1, G2 and G8 in docs/v2-gap-report.md).
 *
 * Called lazily by the identity and capture HTTP entry points rather than from
 * `instrumentation.ts`: Next.js compiles instrumentation into a separate
 * bundle, so module state set there is not guaranteed to be the state the
 * route handlers read. Each step only fills a slot nobody else filled, so a
 * test or an operator override that registered its own adapter always wins.
 *
 * Order matters: the authority lifecycle hook is installed before any adapter
 * that can enroll a device or issue a native session.
 */
let installed = false;
let mailWarning = false;

export function ensureServerRuntime(env: Record<string, string | undefined> = process.env): void {
  if (installed) return;
  if (!nativeSessions.getAuthorityLifecycle())
    nativeSessions.setAuthorityLifecycle(endCaptureAuthority);
  installCaptureV2Defaults({
    identity: createCaptureIdentityAdapter(getDb),
    resolveNativePrincipal: createNativePrincipalResolver(getDb),
  });
  if (!identity.hasIdentityMail()) {
    try {
      const mail = createIdentityMailFromEnv(env);
      if (mail) identity.setIdentityMail(mail);
    } catch {
      // Misconfiguration leaves mail unset: production then fails closed (503)
      // instead of pretending to deliver. Never print the configuration.
      if (!mailWarning) {
        mailWarning = true;
        console.error(JSON.stringify({ level: 'error', event: 'identity_mail_misconfigured' }));
      }
    }
  }
  installed = true;
}

/** Tests only: forget that the defaults were installed. */
export function resetServerRuntimeForTesting(): void {
  installed = false;
}
