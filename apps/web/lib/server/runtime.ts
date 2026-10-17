import 'server-only';
import {
  agentCommands,
  createCaptureIdentityAdapter,
  createNativePrincipalResolver,
  devicePush,
  endCaptureAuthority,
  getDb,
  getDomainConfig,
  identity,
  logEvent,
  nativeSessions,
} from '@culture-atlas/domain';
import { createIdentityMailFromEnv, createPushDriverFromEnv } from '@culture-atlas/providers';
import { installCaptureV2Defaults } from './capture-v2';

/**
 * Composition root for the web server's identity, capture and push adapters
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
const warned = new Set<string>();
function warnOnce(event: string): void {
  if (warned.has(event)) return;
  warned.add(event);
  // Never print the configuration itself.
  logEvent('error', event);
}

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
      // instead of pretending to deliver.
      warnOnce('identity_mail_misconfigured');
    }
  }
  if (devicePush.getPushDriver().name === 'noop') {
    try {
      devicePush.setPushDriver(createPushDriverFromEnv(env));
    } catch {
      warnOnce('push_misconfigured');
    }
  }
  if (!agentCommands.getCommandQueuedListener())
    agentCommands.setCommandQueuedListener(async (event) => {
      const outcome = await devicePush.wakeInstallation(getDb(), event, {
        encryptionKey: getDomainConfig().CREDENTIAL_ENCRYPTION_KEY,
      });
      // IDs and an outcome code only; never the device token or command payload.
      logEvent('info', 'device_push', { command_id: event.commandId, outcome });
    });
  installed = true;
}

/** Tests only: forget that the defaults were installed. */
export function resetServerRuntimeForTesting(): void {
  installed = false;
  warned.clear();
}
