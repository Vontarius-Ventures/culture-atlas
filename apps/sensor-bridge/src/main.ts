import path from 'node:path';
import { Bridge } from './bridge';
import { RelayOnlyConfigSchema, loadBridgeConfig } from './config';
import { RelayClient, isPhoto } from './relay';

/**
 * World Sensor bridge CLI (runs on the machine next to the relay).
 *
 *   pnpm sensor-bridge            poll every BRIDGE_POLL_INTERVAL_MS until stopped
 *   pnpm sensor-bridge once       one sync pass, then exit (exit 1 on error)
 *   pnpm sensor-bridge list       list photos on the relay (to choose BRIDGE_IMPORT_EXISTING)
 *
 * Reads the repo-root .env when present. Exit codes: 0 ok, 1 error/offline,
 * 2 fatal (revoked or expired token, disabled connection, bad configuration).
 */

const root = path.resolve(import.meta.dirname, '../../..');
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // no .env: use the real environment
}

const command = process.argv[2] ?? 'start';

async function list(): Promise<number> {
  const cleaned = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const c = RelayOnlyConfigSchema.parse(cleaned);
  const relay = new RelayClient({
    origin: c.BRIDGE_RELAY_ORIGIN,
    allowedOrigins: [c.BRIDGE_RELAY_ORIGIN],
    credential: c.BRIDGE_VIEWER_CREDENTIAL,
    maxAssetBytes: c.BRIDGE_MAX_ASSET_BYTES,
  });
  let cursor: string | null = null;
  let count = 0;
  console.log('asset_id\tcaptured_at\tbytes\tcommitted');
  for (let i = 0; i < 100; i++) {
    const page = await relay.listPage(cursor, 100);
    for (const a of page.assets.filter(isPhoto)) {
      count++;
      console.log(`${a.asset_id}\t${a.captured_at ?? '-'}\t${a.byte_size ?? '-'}\t${a.committed}`);
    }
    if (!page.has_more || !page.next_cursor || page.next_cursor === cursor) break;
    cursor = page.next_cursor;
  }
  console.log(`\n${count} photo(s). To import some of them on the first run, set BRIDGE_IMPORT_EXISTING=<id>,<id>.`);
  return 0;
}

async function main(): Promise<number> {
  if (command === 'list') return list();
  if (command !== 'start' && command !== 'once') {
    console.error(`Unknown command "${command}". Use: start | once | list`);
    return 2;
  }
  let config;
  try {
    config = loadBridgeConfig();
  } catch (err) {
    console.error('[sensor-bridge] invalid configuration (see .env.example, BRIDGE_*):', (err as Error).message);
    return 2;
  }
  const bridge = new Bridge({ config });
  if (command === 'once') {
    const r = await bridge.runOnce();
    if (r.fatal) return 2;
    return r.sync.error ? 1 : 0;
  }
  const stop = () => bridge.stop();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const reason = await bridge.run();
  return reason === 'fatal' ? 2 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: Error) => {
    console.error('[sensor-bridge]', err.message);
    process.exitCode = 1;
  },
);
