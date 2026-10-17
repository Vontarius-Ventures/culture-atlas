import path from 'node:path';
import { JOB_HANDLERS, getDb, getDomainConfig, loadRootEnv } from '@culture-atlas/domain';
import { configureProviderRuntime, getProviders } from '@culture-atlas/providers';
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
    .then((r) =>
      console.log(
        '[worker] model roles:',
        Object.fromEntries(
          Object.entries(r).map(([role, d]) => [
            role,
            d.reason ? `${d.state} (${d.reason})` : d.state,
          ]),
        ),
      ),
    )
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
