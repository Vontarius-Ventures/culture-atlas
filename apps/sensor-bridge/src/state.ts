import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Bridge state persisted across restarts (BRIDGE_STATE_FILE). The `known`
 * map is the bridge's import ledger: every asset it has resolved, so a
 * restart or a re-read page never uploads twice. The app dedupes on
 * connection + asset_id as well, so a lost state file cannot duplicate
 * captures either; it only costs re-uploads. Writes are atomic (temp file +
 * rename). The file holds relay asset ids and app upload ids, never the
 * viewer credential or the capture token.
 */
export interface BridgeState {
  version: 1;
  connection_id: string;
  cursor: string | null;
  baseline_done: boolean;
  selection: string[];
  /** asset id -> outcome ("imported", "duplicate", "skipped:<code>", "failed:<code>"). */
  known: Record<string, string>;
  /** Upload created for an asset whose capture is not confirmed yet (reused on retry). */
  pending_uploads: Record<string, { upload_id: string; expires_at: string }>;
  updated_at: string;
}

export function initialState(connectionId: string, selection: string[]): BridgeState {
  return {
    version: 1,
    connection_id: connectionId,
    cursor: null,
    baseline_done: false,
    selection: [...new Set(selection)],
    known: {},
    pending_uploads: {},
    updated_at: new Date().toISOString(),
  };
}

export class StateStore {
  constructor(readonly file: string) {}

  /** Loads the state, or creates it on first run. Refuses a file that belongs to another connection. */
  async load(connectionId: string, selection: string[]): Promise<BridgeState> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return initialState(connectionId, selection);
      throw err;
    }
    const state = JSON.parse(raw) as BridgeState;
    if (state.version !== 1) throw new Error(`Unsupported bridge state version in ${this.file}`);
    if (state.connection_id !== connectionId) {
      throw new Error(
        `${this.file} belongs to sensor connection ${state.connection_id}, not ${connectionId}. ` +
          'Use a separate BRIDGE_STATE_FILE per connection.',
      );
    }
    state.known ??= {};
    state.pending_uploads ??= {};
    state.selection ??= [];
    return state;
  }

  async save(state: BridgeState): Promise<void> {
    state.updated_at = new Date().toISOString();
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
