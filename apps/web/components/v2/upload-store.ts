/**
 * Durable upload queue records. Each file gets a client_capture_id that is
 * written here BEFORE any bytes move (BACKEND-CONTRACTS "client IDs persist
 * before uploads start"), together with its bytes, upload id, idempotency keys
 * and verified part receipts, so a reload or a lost response resumes the same
 * upload instead of creating a duplicate asset.
 *
 * Records carry the owning account id; the engine never shows or resumes a
 * record for any other signed-in account.
 */
import type { MediaStatus } from './media-format';

export type UploadPhase =
  | 'queued'
  | 'hashing'
  | 'uploading'
  | 'paused'
  | 'verifying'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'rejected';

export type PauseReason = 'offline' | 'user' | 'authority_ended' | 'error' | null;

export interface PartReceipt {
  part_number: number;
  etag: string;
}

export interface UploadEntry {
  client_capture_id: string;
  account_id: string;
  filename: string;
  /** The byte-transfer queue carries photos and videos; recordings keep through POST /v2/media/audio. */
  kind: 'photo' | 'video';
  content_type: string;
  source: 'browser_camera' | 'upload';
  byte_size: number;
  sha256: string | null;
  captured_at: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  added_at: string;
  updated_at: string;
  /** Original bytes; dropped once the server has committed the media. */
  blob: Blob | null;
  /** Small local JPEG preview (never uploaded). */
  thumb: Blob | null;
  create_key: string;
  complete_key: string;
  upload_id: string | null;
  asset_id: string | null;
  part_size: number | null;
  part_count: number | null;
  receipts: PartReceipt[];
  phase: UploadPhase;
  pause_reason: PauseReason;
  /** Per-item reason shown next to the file. */
  error: string | null;
  media_status: MediaStatus | null;
}

export interface UploadStore {
  all(): Promise<UploadEntry[]>;
  put(entry: UploadEntry): Promise<void>;
  delete(id: string): Promise<void>;
}

export class MemoryUploadStore implements UploadStore {
  private readonly rows = new Map<string, UploadEntry>();
  async all() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async put(entry: UploadEntry) {
    this.rows.set(entry.client_capture_id, { ...entry });
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
}

const DB_NAME = 'culture-atlas-uploads';
const STORE = 'uploads';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB-backed store. Throws QuotaExceededError through `put` when the device is full. */
export class IndexedDbUploadStore implements UploadStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE))
            req.result.createObjectStore(STORE, { keyPath: 'client_capture_id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('Upload storage is blocked by another tab.'));
      });
      this.db.catch(() => {
        this.db = null;
      });
    }
    return this.db;
  }

  private async tx(mode: IDBTransactionMode) {
    const db = await this.open();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async all() {
    return request((await this.tx('readonly')).getAll() as IDBRequest<UploadEntry[]>);
  }
  async put(entry: UploadEntry) {
    const store = await this.tx('readwrite');
    await request(store.put(entry));
    await new Promise<void>((resolve, reject) => {
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => reject(store.transaction.error);
      store.transaction.onabort = () => reject(store.transaction.error);
    });
  }
  async delete(id: string) {
    await request((await this.tx('readwrite')).delete(id));
  }
}

export function defaultUploadStore(): UploadStore {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbUploadStore();
  } catch {
    // Private mode / blocked storage: fall back to memory (no resume after reload).
  }
  return new MemoryUploadStore();
}

export function isQuotaError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
