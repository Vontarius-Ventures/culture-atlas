import path from 'node:path';
import {
  JOB_HANDLERS,
  devicePush,
  getDb,
  getDomainConfig,
  loadRootEnv,
  setAccountMediaStorage,
  setAnalysisReadyListener,
  setAudioOriginalStorage,
} from '@culture-atlas/domain';
import { configureProviderRuntime, createPushDriverFromEnv, getProviders } from '@culture-atlas/providers';
import { createCaptureStorage } from './capture-storage';
import { MediaAnalysisWorker } from './media-analysis';
import { Worker } from './worker';

loadRootEnv(path.resolve(import.meta.dirname, '../../..'));

const config = getDomainConfig();
// Operator alerts from the model gateway: safe codes only (no payloads, keys or bodies).
configureProviderRuntime({
  gateway: {
    db: () => getDb(),
    onAlert: (alert) => console.error('[alert] model_gateway', JSON.stringify(alert)),
  },
});
const providers = getProviders();

// Screen 17 on native: wake the phone that started an analysis once it is published.
try {
  devicePush.setPushDriver(createPushDriverFromEnv(process.env));
} catch {
  console.error('[worker] push misconfigured; ready notices fall back to in-app polling');
}
setAnalysisReadyListener(async (event) => {
  const outcome = await devicePush.wakeInstallation(getDb(), event, { encryptionKey: config.CREDENTIAL_ENCRYPTION_KEY });
  // IDs and an outcome code only; never the device token.
  console.log('[worker] ready_notice', JSON.stringify({ analysis_id: event.analysisId, state: event.state, outcome }));
});
// Music Mode reads recordings from the capture-v2 namespace (POST /v2/media/audio), not the legacy store.
setAudioOriginalStorage(createCaptureStorage(providers.config, config.SESSION_SECRET));
// Account-deletion cleanup deletes the same v2 media namespace (accounts/<id>/...).
setAccountMediaStorage(createCaptureStorage(providers.config, config.SESSION_SECRET));
const worker = new Worker({ db: getDb(), providers, config, handlers: JOB_HANDLERS });

// v2 media analysis (Concentrate). Disable only for a dedicated non-analysis worker.
const analysis =
  process.env.MEDIA_ANALYSIS_WORKER_ENABLED === 'false'
    ? undefined
    : new MediaAnalysisWorker({
        db: getDb(),
        storage: createCaptureStorage(providers.config, config.SESSION_SECRET),
        displayStorage: providers.storage,
        gateway: providers.modelGateway,
        // MODEL_FALLBACK=elorian + ELORIAN_API_KEY: Elorian backs up the gateway's vision roles.
        fallbackVlm: providers.fallbackVlm,
        config,
        photoConcurrency: Number(process.env.MEDIA_ANALYSIS_PHOTO_CONCURRENCY ?? 2),
        videoConcurrency: Number(process.env.MEDIA_ANALYSIS_VIDEO_CONCURRENCY ?? 1),
      });

const caps = providers.capabilities();
console.log(
  `[worker] starting ${worker.workerId} concurrency=${config.WORKER_CONCURRENCY}; llm=${providers.config.LLM_PROVIDER}; capabilities:`,
  Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v.status])),
);
if (providers.modelGateway)
  void providers.modelGateway
    .readiness()
    .then((r) => {
      console.log(
        '[worker] model roles:',
        Object.fromEntries(
          Object.entries(r).map(([role, d]) => [
            role,
            `${d.reason ? `${d.state} (${d.reason})` : d.state}${d.experimental ? ' [experimental demo override]' : ''}`,
          ]),
        ),
      );
      const unqualified = Object.values(r)
        .filter((d) => d.reason === 'not_qualified')
        .map((d) => d.role);
      if (unqualified.length)
        console.error(
          `\x1b[31m[worker] UNQUALIFIED model roles (analysis for them fails closed): ${unqualified.join(', ')}. ` +
            'Commit passing qualification artifacts, set MODEL_FALLBACK=elorian, or (non-production demo only) ' +
            `CONCENTRATE_DEMO_ALLOW_ROLES=${unqualified.join(',')}.\x1b[0m`,
        );
    })
    .catch(() => console.error('[worker] model readiness unavailable'));
worker.start();
analysis?.start();

const shutdown = async (signal: string) => {
  console.log(`[worker] ${signal}: draining`);
  await Promise.all([worker.stop(), analysis?.stop()]);
  await getDb().end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
