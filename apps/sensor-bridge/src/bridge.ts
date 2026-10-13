import { AppClient } from './app-client';
import type { BridgeConfig } from './config';
import { RelayClient, SinkError, syncOnce, type ImportOutcome, type RelayAsset, type RelayContent, type SyncResult, type SyncSink, type SyncState } from './relay';
import { StateStore, type BridgeState } from './state';

/**
 * Outbound World Sensor bridge. Every BRIDGE_POLL_INTERVAL_MS it lists newly
 * committed photos on the private relay (viewer credential stays local),
 * downloads and verifies each one (same-origin only, size and content-type
 * limits, declared sha256), then uploads it to the public app with the
 * restricted capture-write token. The dedupe key is the same as the
 * server-side poller's: sensor connection + relay asset id.
 *
 * Offline handling: if the relay or the app is unreachable the cursor stays
 * put and the next attempt backs off (up to 5 minutes); nothing is skipped and
 * nothing is imported twice when it comes back. A revoked or expired token
 * stops the bridge with a clear message.
 */

const EXPIRY_MARGIN_MS = 60 * 60_000;

export interface BridgeDeps {
  config: BridgeConfig;
  fetch?: typeof fetch;
  log?: (message: string, data?: Record<string, unknown>) => void;
  now?: () => Date;
}

export class BridgeSink implements SyncSink {
  constructor(
    private readonly state: BridgeState,
    private readonly store: StateStore,
    private readonly app: AppClient,
    private readonly now: () => Date,
    private readonly signal?: AbortSignal,
  ) {}

  async isKnown(assetId: string): Promise<boolean> {
    return this.state.known[assetId] !== undefined;
  }

  private async uploadFor(asset: RelayAsset, content: RelayContent, fresh: boolean): Promise<string> {
    const pending = this.state.pending_uploads[asset.asset_id];
    if (!fresh && pending && Date.parse(pending.expires_at) - this.now().getTime() > EXPIRY_MARGIN_MS) return pending.upload_id;
    const ext = content.content_type.split('/')[1] ?? 'jpg';
    const up = await this.app.upload(content.bytes, content.content_type, `${asset.asset_id}.${ext}`, this.signal);
    this.state.pending_uploads[asset.asset_id] = { upload_id: up.upload_id, expires_at: up.expires_at };
    await this.store.save(this.state);
    return up.upload_id;
  }

  async importAsset(asset: RelayAsset, content: RelayContent): Promise<ImportOutcome> {
    const sensor = {
      connection_id: this.state.connection_id,
      asset_id: asset.asset_id,
      ...(asset.captured_at ? { captured_at: asset.captured_at } : {}),
      ...(asset.sha256 ? { declared_sha256: asset.sha256 } : {}),
    };
    let outcome: ImportOutcome;
    try {
      let uploadId = await this.uploadFor(asset, content, false);
      try {
        outcome = (await this.app.createCapture(uploadId, sensor, this.signal)).reused ? 'duplicate' : 'imported';
      } catch (err) {
        // The cached upload may have expired or been purged: retry once with a fresh one.
        if (!(err instanceof SinkError) || err.code !== 'not_found') throw err;
        uploadId = await this.uploadFor(asset, content, true);
        try {
          outcome = (await this.app.createCapture(uploadId, sensor, this.signal)).reused ? 'duplicate' : 'imported';
        } catch (err2) {
          if (err2 instanceof SinkError && err2.code === 'not_found') {
            throw new SinkError('connection', 'connection_unavailable', 'The app no longer accepts imports for this sensor connection.', { fatal: true });
          }
          throw err2;
        }
      }
    } catch (err) {
      if (err instanceof SinkError && err.code === 'already_imported') outcome = 'duplicate';
      else throw err;
    }
    this.state.known[asset.asset_id] = outcome;
    delete this.state.pending_uploads[asset.asset_id];
    await this.store.save(this.state);
    return outcome;
  }

  async recordSkipped(asset: RelayAsset, status: 'failed' | 'skipped', code: string): Promise<void> {
    this.state.known[asset.asset_id] = `${status}:${code}`;
    delete this.state.pending_uploads[asset.asset_id];
    await this.store.save(this.state);
  }

  async saveState(s: SyncState): Promise<void> {
    this.state.cursor = s.cursor;
    this.state.baseline_done = s.baselineDone;
    this.state.selection = s.selection;
    await this.store.save(this.state);
  }
}

export interface BridgeRunResult {
  sync: SyncResult;
  /** Delay before the next run. */
  nextDelayMs: number;
  /** Stop the bridge (revoked token, disabled connection, misconfiguration). */
  fatal: boolean;
}

export class Bridge {
  private failures = 0;
  private stopped = false;
  private wake: (() => void) | null = null;
  private readonly controller = new AbortController();
  readonly relay: RelayClient;
  readonly app: AppClient;
  readonly store: StateStore;

  constructor(private readonly deps: BridgeDeps) {
    const c = deps.config;
    this.relay = new RelayClient({
      origin: c.BRIDGE_RELAY_ORIGIN,
      allowedOrigins: [c.BRIDGE_RELAY_ORIGIN],
      credential: c.BRIDGE_VIEWER_CREDENTIAL,
      maxAssetBytes: c.BRIDGE_MAX_ASSET_BYTES,
      fetch: deps.fetch,
    });
    this.app = new AppClient({ appUrl: c.BRIDGE_APP_URL, token: c.BRIDGE_CAPTURE_TOKEN, fetch: deps.fetch });
    this.store = new StateStore(c.BRIDGE_STATE_FILE);
  }

  private log(message: string, data?: Record<string, unknown>): void {
    (this.deps.log ?? ((m, d) => console.log(`[sensor-bridge] ${m}`, d ? JSON.stringify(d) : '')))(message, data);
  }

  /** One sync pass. */
  async runOnce(): Promise<BridgeRunResult> {
    const c = this.deps.config;
    const now = this.deps.now ?? (() => new Date());
    const state = await this.store.load(c.BRIDGE_CONNECTION_ID, c.BRIDGE_IMPORT_EXISTING);
    const sink = new BridgeSink(state, this.store, this.app, now, this.controller.signal);
    const sync = await syncOnce(
      this.relay,
      { cursor: state.cursor, baselineDone: state.baseline_done, selection: state.selection },
      sink,
      { pageSize: 50, maxPages: 20, maxImports: 25, signal: this.controller.signal },
    );
    const summary = {
      imported: sync.imported.length,
      duplicates: sync.duplicates.length,
      failed: sync.failed.length,
      baseline_skipped: sync.baselineSkipped,
      pending_uncommitted: sync.pendingUncommitted,
      pages: sync.pagesRead,
    };
    if (sync.selectionNotFound.length > 0) this.log('selected photos not found on the relay', { asset_ids: sync.selectionNotFound });
    for (const f of sync.failed) this.log('photo skipped', f);
    if (sync.error) {
      const fatal = sync.error instanceof SinkError && sync.error.options.fatal === true;
      this.failures++;
      const backoff = Math.min(c.BRIDGE_POLL_INTERVAL_MS * 2 ** Math.min(this.failures, 8), 5 * 60_000);
      const nextDelayMs = Math.max(backoff, Math.min(sync.error.options.retryAfterMs ?? 0, 60 * 60_000));
      this.log(fatal ? 'stopping' : 'offline, will retry', { code: sync.error.code, message: sync.error.message, retry_in_ms: fatal ? null : nextDelayMs, ...summary });
      return { sync, nextDelayMs, fatal };
    }
    this.failures = 0;
    if (summary.imported + summary.failed + summary.baseline_skipped > 0) this.log('synced', summary);
    return { sync, nextDelayMs: sync.more ? 1000 : c.BRIDGE_POLL_INTERVAL_MS, fatal: false };
  }

  /** Poll until stopped or a fatal error. Resolves with the exit reason. */
  async run(): Promise<'stopped' | 'fatal'> {
    this.log('started', { connection_id: this.deps.config.BRIDGE_CONNECTION_ID, interval_ms: this.deps.config.BRIDGE_POLL_INTERVAL_MS });
    while (!this.stopped) {
      let delay: number;
      try {
        const r = await this.runOnce();
        if (r.fatal) return 'fatal';
        delay = r.nextDelayMs;
      } catch (err) {
        if (this.stopped) break;
        // Unexpected (state file I/O, bugs): keep the process alive and retry.
        this.failures++;
        delay = Math.min(this.deps.config.BRIDGE_POLL_INTERVAL_MS * 2 ** Math.min(this.failures, 8), 5 * 60_000);
        this.log('error, will retry', { error: (err as Error).message, retry_in_ms: delay });
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.wake = null;
    }
    return 'stopped';
  }

  stop(): void {
    this.stopped = true;
    this.controller.abort();
    this.wake?.();
  }
}
