import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  captureLimitsFromEnv,
  captures,
  createServiceContext,
  getDb,
  getDomainConfig,
  loadRootEnv,
} from '@culture-atlas/domain';
import { createMultipartStorage, loadProviderConfig } from '@culture-atlas/providers';
import { DEFAULT_TOOL_CONFIG } from './probe';
import { cleanStaleScratch } from './scratch';
import { MediaWorker } from './worker';

loadRootEnv(path.resolve(import.meta.dirname, '../../..'));

function positive(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

const config = getDomainConfig();
const db = getDb();
const storage = createMultipartStorage(loadProviderConfig(), {
  production: process.env.NODE_ENV === 'production',
  fallbackSigningSecret: config.SESSION_SECRET,
});
const scratchRoot = path.resolve(
  process.env.MEDIA_WORKER_SCRATCH_DIR?.trim() || path.join(tmpdir(), 'culture-atlas-media'),
);
const worker = new MediaWorker({
  db,
  storage,
  scratchRoot,
  limits: captureLimitsFromEnv(process.env),
  tools: {
    ...DEFAULT_TOOL_CONFIG,
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || DEFAULT_TOOL_CONFIG.ffmpegPath,
    ffprobePath: process.env.FFPROBE_PATH?.trim() || DEFAULT_TOOL_CONFIG.ffprobePath,
    threads: positive('MEDIA_WORKER_THREADS', DEFAULT_TOOL_CONFIG.threads),
  },
  concurrency: positive('MEDIA_WORKER_CONCURRENCY', 1),
  includeLegacySensor: process.env.CAPTURE_LEGACY_SENSOR_IMPORT_ENABLED === 'true',
  // Same compatibility rule as the web API: deleting a v2 asset removes its legacy analysis capture.
  deleteAnalysisCapture: async (tx, accountId, captureId) => {
    const legacy = createServiceContext(
      { kind: 'account', accountId, sessionId: null, isDemoOwner: false },
      { db: tx },
    );
    await captures.deleteCapture(legacy, { id: captureId });
  },
});

await cleanStaleScratch(scratchRoot, 0);
const qualification = await worker.qualify();
console.log(
  `[media-worker] ${worker.workerId} started; video ${qualification.preparation ? 'qualified' : 'NOT qualified (photos only)'}`,
);
worker.start();

const shutdown = async (signal: string) => {
  console.log(`[media-worker] ${signal}: draining`);
  await worker.stop();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
