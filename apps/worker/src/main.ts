import path from 'node:path';
import { JOB_HANDLERS, getDb, getDomainConfig, loadRootEnv } from '@culture-atlas/domain';
import { getProviders } from '@culture-atlas/providers';
import { Worker } from './worker';

loadRootEnv(path.resolve(import.meta.dirname, '../../..'));

const config = getDomainConfig();
const providers = getProviders();
const worker = new Worker({ db: getDb(), providers, config, handlers: JOB_HANDLERS });

const caps = providers.capabilities();
console.log(
  `[worker] starting ${worker.workerId} concurrency=${config.WORKER_CONCURRENCY}; capabilities:`,
  Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, v.status])),
);
worker.start();

const shutdown = async (signal: string) => {
  console.log(`[worker] ${signal}: draining`);
  await worker.stop();
  await getDb().end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
