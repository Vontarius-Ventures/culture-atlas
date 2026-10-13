import { MockRelay } from '../../../fixtures/sensor/mock-relay';

/**
 * Run the mock World Sensor relay locally (demos and manual testing without
 * the user's machine).
 *
 *   pnpm --filter @culture-atlas/sensor-bridge mock-relay [--port 8787] [--existing 3] [--emit-every 20]
 *
 * --existing N     photos that already exist before connecting (default 3)
 * --emit-every S   commit a new photo every S seconds (default off)
 * Credential: MOCK_RELAY_CREDENTIAL (default "dev-viewer-credential").
 */

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

const relay = new MockRelay({ credential: process.env.MOCK_RELAY_CREDENTIAL || 'dev-viewer-credential' });
const existing = arg('existing', 3);
for (let i = 0; i < existing; i++) relay.addPhoto();
const origin = await relay.start(arg('port', 8787));
console.log(`[mock-relay] listening on ${origin} with ${existing} existing photo(s): ${[...relay.assets.keys()].join(', ')}`);
console.log(`[mock-relay] viewer credential: ${relay.credential} (mock only)`);

const every = arg('emit-every', 0);
if (every > 0) {
  setInterval(() => {
    const a = relay.addPhoto({ captured_at: new Date().toISOString() });
    console.log(`[mock-relay] committed new photo ${a.asset_id}`);
  }, every * 1000);
}

const shutdown = () => void relay.stop().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
