/**
 * Resumable multipart upload queue for the /v2 upload contract.
 *
 *   add → (persist client_capture_id + bytes) → hash → POST /v2/uploads →
 *   PUT signed parts → POST /complete → poll GET /v2/media/{id} until the
 *   server finishes verifying and preparing (no fabricated percent).
 *
 * Byte progress comes from verified part receipts plus the in-flight part;
 * preparation progress is a separate server status. Resume always asks the
 * server first (GET /v2/uploads/{id}); its verified parts are the truth, so a
 * lost response never re-sends or duplicates committed media. Each file is
 * independent: a rejected or failed sibling never blocks the others.
 */
import { ApiError } from '@/lib/client/api';
import {
  checkMediaFile,
  DEFAULT_LIMITS,
  durationReason,
  pixelReason,
  type ClientLimits,
} from './media-format';
import type { MediaDetail, PartInstruction, UploadResponse } from './media-api';
import type { PauseReason, UploadEntry, UploadStore } from './upload-store';
import { isQuotaError } from './upload-store';

export interface UploadApi {
  createUpload(
    body: {
      client_capture_id: string;
      kind: 'photo' | 'video';
      source: 'browser_camera' | 'upload';
      filename: string;
      content_type:
        'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'video/quicktime' | 'video/webm';
      byte_size: number;
      sha256: string;
      captured_at?: string;
    },
    idempotencyKey: string,
  ): Promise<UploadResponse>;
  getUpload(id: string): Promise<UploadResponse>;
  resumeUpload(id: string): Promise<UploadResponse>;
  parts(id: string, partNumbers: number[]): Promise<{ parts: PartInstruction[] }>;
  completeUpload(
    id: string,
    parts: Array<{ part_number: number; etag: string }>,
    key: string,
  ): Promise<UploadResponse>;
  abortUpload(id: string): Promise<unknown>;
  media(id: string): Promise<MediaDetail>;
}

export interface FileFacts {
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  thumb: Blob | null;
}

export interface EngineDeps {
  store: UploadStore;
  api: UploadApi;
  /** PUT one part; resolves with the ETag. Reports loaded bytes of this part. */
  putPart(
    instruction: PartInstruction,
    body: Blob,
    onProgress: (loaded: number) => void,
    signal: AbortSignal,
  ): Promise<string>;
  sha256(blob: Blob): Promise<string>;
  describe(file: Blob, kind: 'photo' | 'video'): Promise<FileFacts>;
  uuid(): string;
  now(): Date;
  online(): boolean;
  /** Wait before the next preparation poll (injectable for tests). */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Optional cross-tab lock so two tabs never transfer the same file. */
  withLock?<T>(name: string, fn: () => Promise<T>): Promise<T | undefined>;
}

export interface UploadView extends UploadEntry {
  /** Bytes confirmed or in flight (0..byte_size). */
  sent_bytes: number;
}

export interface EngineSnapshot {
  ready: boolean;
  accountId: string | null;
  items: UploadView[];
  /** Records retained for other accounts (count only; never names or previews). */
  lockedCount: number;
  storageError: string | null;
}

const OFFLINE_REASON = 'Connection lost. Your file is still selected.';
const POLL_START_MS = 1500;
const POLL_MAX_MS = 10_000;
const POLL_BUDGET = 120;

type UploadContentType = Parameters<UploadApi['createUpload']>[0]['content_type'];
const CONTENT_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
];
function contentTypeOk(t: string): t is UploadContentType {
  return CONTENT_TYPES.includes(t);
}

export class UploadEngine {
  private entries = new Map<string, UploadEntry>();
  private sent = new Map<string, number>();
  private controllers = new Map<string, AbortController>();
  private running = new Set<string>();
  private listeners = new Set<() => void>();
  private snapshot: EngineSnapshot = {
    ready: false,
    accountId: null,
    items: [],
    lockedCount: 0,
    storageError: null,
  };
  private accountId: string | null = null;
  private limits: ClientLimits = DEFAULT_LIMITS;
  private loaded: Promise<void> | null = null;
  private storageError: string | null = null;
  private markStarted: () => void = () => undefined;
  /** Resolves once a signed-in account has been bound (files added earlier wait for it). */
  private readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  constructor(private readonly deps: EngineDeps) {}

  // ---- subscription ----------------------------------------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;

  private emit() {
    const mine = [...this.entries.values()]
      .filter((e) => this.accountId && e.account_id === this.accountId)
      .sort((a, b) => a.added_at.localeCompare(b.added_at));
    this.snapshot = {
      ready: this.loaded !== null,
      accountId: this.accountId,
      items: mine.map((e) => ({ ...e, sent_bytes: this.sentBytes(e) })),
      lockedCount: [...this.entries.values()].filter(
        (e) => this.accountId && e.account_id !== this.accountId && e.blob,
      ).length,
      storageError: this.storageError,
    };
    this.listeners.forEach((l) => l());
  }

  private sentBytes(e: UploadEntry): number {
    if (['verifying', 'processing', 'ready'].includes(e.phase)) return e.byte_size;
    if (!e.part_size) return 0;
    const confirmed = e.receipts.reduce(
      (n, r) => n + Math.min(e.part_size!, e.byte_size - (r.part_number - 1) * e.part_size!),
      0,
    );
    return Math.min(e.byte_size, confirmed + (this.sent.get(e.client_capture_id) ?? 0));
  }

  // ---- lifecycle -------------------------------------------------------------

  /** Loads persisted records once and binds the engine to the signed-in account. */
  async start(accountId: string | null, limits?: ClientLimits): Promise<void> {
    if (limits) this.limits = limits;
    if (!this.loaded) {
      this.loaded = this.deps.store
        .all()
        .then((rows) => {
          for (const row of rows) {
            // A transfer interrupted by a reload resumes from the server's receipts.
            if (['hashing', 'uploading'].includes(row.phase)) row.phase = 'queued';
            this.entries.set(row.client_capture_id, row);
          }
        })
        .catch(() => {
          this.storageError = 'Uploads cannot be kept on this device in this browser mode.';
        });
    }
    await this.loaded;
    if (this.accountId !== accountId) {
      // Account changed: stop transfers for the previous account; its bytes stay locked to it.
      for (const [id, entry] of this.entries)
        if (entry.account_id !== accountId) this.controllers.get(id)?.abort();
      this.accountId = accountId;
    }
    if (accountId) this.markStarted();
    this.emit();
    this.pump();
    for (const e of this.entries.values())
      if (e.account_id === accountId && ['verifying', 'processing'].includes(e.phase))
        void this.watch(e);
  }

  setLimits(limits: ClientLimits) {
    this.limits = limits;
  }

  /** Validates, persists and queues files. Returns the new client capture ids. */
  async add(
    files: Array<File | (Blob & { name: string; lastModified?: number })>,
    source: 'browser_camera' | 'upload',
  ): Promise<string[]> {
    // Files chosen before the session is known wait briefly for the account binding.
    if (!this.accountId)
      await Promise.race([this.started, new Promise((r) => setTimeout(r, 5000))]);
    if (!this.accountId)
      throw new ApiError(401, {
        code: 'unauthenticated',
        message: 'Sign in to upload to your library.',
        retryable: false,
        request_id: 'client',
      });
    const ids: string[] = [];
    const now = this.deps.now().toISOString();
    for (const [index, file] of files.entries()) {
      const check = checkMediaFile(file, this.limits);
      const facts =
        check.ok && check.kind
          ? await this.deps.describe(file, check.kind).catch((): FileFacts => ({
              duration_ms: null,
              width: null,
              height: null,
              thumb: null,
            }))
          : { duration_ms: null, width: null, height: null, thumb: null };
      let reason = check.reason;
      if (!reason && index >= this.limits.batch_max_files)
        reason = `You can add up to ${this.limits.batch_max_files} files at a time.`;
      if (!reason && check.kind === 'video' && facts.duration_ms !== null)
        reason = durationReason(facts.duration_ms, this.limits);
      if (!reason && check.kind === 'photo' && facts.width && facts.height)
        reason = pixelReason(facts.width, facts.height, this.limits);
      const entry: UploadEntry = {
        client_capture_id: this.deps.uuid(),
        account_id: this.accountId,
        filename: file.name.slice(0, 255) || 'Untitled',
        kind: check.kind ?? (file.type.startsWith('video/') ? 'video' : 'photo'),
        content_type: check.contentType ?? file.type,
        source,
        byte_size: file.size,
        sha256: null,
        captured_at:
          'lastModified' in file && file.lastModified
            ? new Date(file.lastModified).toISOString()
            : now,
        duration_ms: facts.duration_ms,
        width: facts.width,
        height: facts.height,
        added_at: new Date(this.deps.now().getTime() + index).toISOString(),
        updated_at: now,
        blob: reason ? null : file,
        thumb: facts.thumb,
        create_key: this.deps.uuid(),
        complete_key: this.deps.uuid(),
        upload_id: null,
        asset_id: null,
        part_size: null,
        part_count: null,
        receipts: [],
        phase: reason ? 'rejected' : 'queued',
        pause_reason: null,
        error: reason,
        media_status: null,
      };
      try {
        await this.deps.store.put(entry);
      } catch (err) {
        if (isQuotaError(err)) {
          entry.blob = null;
          entry.phase = 'rejected';
          entry.error = 'This device is out of storage. Free up space and add the file again.';
        } else this.storageError = 'Uploads cannot be kept on this device in this browser mode.';
      }
      this.entries.set(entry.client_capture_id, entry);
      ids.push(entry.client_capture_id);
    }
    this.emit();
    this.pump();
    return ids;
  }

  pause(id: string) {
    const e = this.entries.get(id);
    if (!e || !['queued', 'hashing', 'uploading'].includes(e.phase)) return;
    this.controllers.get(id)?.abort();
    void this.update(e, { phase: 'paused', pause_reason: 'user', error: null });
  }

  /** Resume or retry: always re-reads server state before moving bytes. */
  retry(id: string) {
    const e = this.entries.get(id);
    if (!e || e.account_id !== this.accountId) return;
    if (!['paused', 'failed'].includes(e.phase) && !(e.phase === 'rejected' && e.blob)) return;
    if (!e.blob && !e.upload_id) return;
    void this.update(e, { phase: 'queued', pause_reason: null, error: null }).then(() =>
      this.pump(),
    );
  }

  /** Cancels the transfer and aborts the server upload. Committed media is deleted from the library instead. */
  async cancel(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e) return;
    this.controllers.get(id)?.abort();
    if (e.upload_id && !['ready', 'processing', 'verifying'].includes(e.phase)) {
      try {
        await this.deps.api.abortUpload(e.upload_id);
      } catch (err) {
        if (!(err instanceof ApiError && (err.code === 'not_found' || err.code === 'conflict'))) {
          await this.update(e, {
            phase: 'paused',
            pause_reason: 'error',
            error: 'This upload could not be cancelled right now. Try again.',
          });
          throw err;
        }
      }
    }
    await this.remove(id);
  }

  /** Removes a finished or rejected row from this device's list (library media is unaffected). */
  async dismiss(id: string) {
    const e = this.entries.get(id);
    if (!e || !['ready', 'rejected', 'failed'].includes(e.phase)) return;
    if (e.phase === 'failed' && e.upload_id && !e.asset_id) return;
    await this.remove(id);
  }

  /** Deletes retained local drafts of other accounts without revealing them. */
  async discardLocked() {
    for (const e of [...this.entries.values()])
      if (e.account_id !== this.accountId) await this.remove(e.client_capture_id);
  }

  onOffline() {
    for (const e of this.entries.values())
      if (['hashing', 'uploading', 'queued'].includes(e.phase) && e.account_id === this.accountId) {
        this.controllers.get(e.client_capture_id)?.abort();
        void this.update(e, { phase: 'paused', pause_reason: 'offline', error: OFFLINE_REASON });
      }
  }

  onOnline() {
    for (const e of this.entries.values())
      if (e.phase === 'paused' && e.pause_reason === 'offline') this.retry(e.client_capture_id);
  }

  // ---- internals -------------------------------------------------------------

  private async remove(id: string) {
    this.entries.delete(id);
    this.sent.delete(id);
    await this.deps.store.delete(id).catch(() => undefined);
    this.emit();
  }

  private async update(e: UploadEntry, patch: Partial<UploadEntry>) {
    Object.assign(e, patch, { updated_at: this.deps.now().toISOString() });
    this.emit();
    try {
      await this.deps.store.put(e);
    } catch {
      // Keep going in memory; the row survives until reload.
    }
  }

  private pump() {
    if (!this.accountId) return;
    const queued = [...this.entries.values()]
      .filter((e) => e.account_id === this.accountId && e.phase === 'queued')
      .sort((a, b) => a.added_at.localeCompare(b.added_at));
    for (const e of queued) {
      if (this.running.size >= this.limits.concurrent_transfers) break;
      if (this.running.has(e.client_capture_id)) continue;
      if (!this.deps.online()) {
        void this.update(e, { phase: 'paused', pause_reason: 'offline', error: OFFLINE_REASON });
        continue;
      }
      this.running.add(e.client_capture_id);
      const job = async () => {
        await this.run(e);
      };
      const locked = this.deps.withLock
        ? this.deps.withLock(`ca-upload:${e.client_capture_id}`, job)
        : job();
      void locked.finally(() => {
        this.running.delete(e.client_capture_id);
        this.pump();
      });
    }
  }

  private async run(e: UploadEntry) {
    const controller = new AbortController();
    this.controllers.set(e.client_capture_id, controller);
    const { signal } = controller;
    try {
      if (!e.sha256) {
        if (!e.blob) throw new LocalFileMissing();
        await this.update(e, { phase: 'hashing' });
        const sha = await this.deps.sha256(e.blob);
        if (signal.aborted) return;
        await this.update(e, { sha256: sha });
      }
      let server: UploadResponse;
      if (!e.upload_id) {
        if (!e.blob) throw new LocalFileMissing();
        if (!contentTypeOk(e.content_type)) throw new LocalFileMissing();
        server = await this.deps.api.createUpload(
          {
            client_capture_id: e.client_capture_id,
            kind: e.kind,
            source: e.source,
            filename: e.filename,
            content_type: e.content_type,
            byte_size: e.byte_size,
            sha256: e.sha256!,
            ...(e.captured_at ? { captured_at: e.captured_at } : {}),
          },
          e.create_key,
        );
      } else {
        // Resume: the server's record decides what is left.
        server = await this.deps.api.getUpload(e.upload_id);
        if (server.state === 'paused' && server.pause_reason === 'authority_ended')
          server = await this.deps.api.resumeUpload(e.upload_id);
      }
      if (signal.aborted) return;
      await this.update(e, {
        upload_id: server.upload_id,
        asset_id: server.asset_id,
        part_size: server.part_size,
        part_count: server.part_count,
        receipts: server.verified_parts.length ? server.verified_parts : e.receipts,
      });
      if (await this.settleTerminal(e, server)) return;

      await this.update(e, { phase: 'uploading', pause_reason: null, error: null });
      const instructions = new Map<number, PartInstruction>(
        server.parts.map((p) => [p.part_number, p]),
      );
      for (let part = 1; part <= server.part_count; part++) {
        if (signal.aborted) return;
        if (e.receipts.some((r) => r.part_number === part)) continue;
        let instruction = instructions.get(part);
        if (
          !instruction ||
          Date.parse(instruction.expires_at) - this.deps.now().getTime() < 30_000
        ) {
          const missing: number[] = [];
          for (let p = part; p <= server.part_count && missing.length < 100; p++)
            if (!e.receipts.some((r) => r.part_number === p)) missing.push(p);
          const fresh = await this.deps.api.parts(server.upload_id, missing);
          fresh.parts.forEach((p) => instructions.set(p.part_number, p));
          instruction = instructions.get(part);
          if (!instruction)
            throw new ApiError(500, {
              code: 'internal',
              message: 'The server did not return upload instructions.',
              retryable: true,
              request_id: 'client',
            });
        }
        if (!e.blob) throw new LocalFileMissing();
        const start = (part - 1) * server.part_size;
        const slice = e.blob.slice(start, Math.min(e.byte_size, start + server.part_size));
        const etag = await this.deps.putPart(
          instruction,
          slice,
          (loaded) => {
            this.sent.set(e.client_capture_id, loaded);
            this.emit();
          },
          signal,
        );
        this.sent.delete(e.client_capture_id);
        await this.update(e, {
          receipts: [...e.receipts, { part_number: part, etag }].sort(
            (a, b) => a.part_number - b.part_number,
          ),
        });
      }
      if (signal.aborted) return;
      const done = await this.deps.api.completeUpload(server.upload_id, e.receipts, e.complete_key);
      if (await this.settleTerminal(e, done)) return;
      await this.update(e, { phase: 'verifying' });
      void this.watch(e);
    } catch (err) {
      this.sent.delete(e.client_capture_id);
      if (signal.aborted || (err as { name?: string })?.name === 'AbortError') return;
      await this.fail(e, err);
    } finally {
      if (this.controllers.get(e.client_capture_id) === controller)
        this.controllers.delete(e.client_capture_id);
    }
  }

  /** Applies server states that end or skip the transfer. Returns true when no bytes should move. */
  private async settleTerminal(e: UploadEntry, server: UploadResponse): Promise<boolean> {
    switch (server.state) {
      case 'verifying':
      case 'committed':
        await this.update(e, { phase: 'verifying', error: null, pause_reason: null });
        void this.watch(e);
        return true;
      case 'paused':
        await this.update(e, {
          phase: 'paused',
          pause_reason: 'authority_ended',
          error: 'Sign in again to resume this upload.',
        });
        return true;
      case 'expired':
        // Never committed: retrying starts a fresh upload of the same bytes.
        await this.update(e, {
          phase: 'failed',
          upload_id: null,
          asset_id: null,
          receipts: [],
          create_key: this.deps.uuid(),
          complete_key: this.deps.uuid(),
          error: 'This upload expired before it finished. Retry to send it again.',
        });
        await this.rekey(e);
        return true;
      case 'aborted':
        await this.remove(e.client_capture_id);
        return true;
      case 'rejected':
        await this.update(e, {
          phase: 'rejected',
          error: rejectionReason(server.error_code, e.kind),
          blob: null,
        });
        return true;
      default:
        return false;
    }
  }

  /** An expired upload gets a new client_capture_id; the old one may only replay the expired record. */
  private async rekey(e: UploadEntry) {
    const old = e.client_capture_id;
    const next = this.deps.uuid();
    this.entries.delete(old);
    await this.deps.store.delete(old).catch(() => undefined);
    e.client_capture_id = next;
    this.entries.set(next, e);
    await this.deps.store.put(e).catch(() => undefined);
    this.emit();
  }

  private async fail(e: UploadEntry, err: unknown) {
    if (err instanceof LocalFileMissing) {
      await this.update(e, {
        phase: 'failed',
        error: 'The original file is no longer on this device. Add it again.',
      });
      return;
    }
    if (err instanceof ApiError) {
      if (err.status === 0 || err.code === 'offline') {
        await this.update(e, { phase: 'paused', pause_reason: 'offline', error: OFFLINE_REASON });
        return;
      }
      if (err.code === 'account_mismatch') {
        await this.update(e, {
          phase: 'paused',
          pause_reason: 'authority_ended',
          error: err.message,
        });
        return;
      }
      if (err.retryable) {
        await this.update(e, { phase: 'paused', pause_reason: 'error', error: err.message });
        return;
      }
      if (['payload_too_large', 'invalid_input', 'unsupported_image'].includes(err.code)) {
        await this.update(e, { phase: 'rejected', error: err.message, blob: null });
        return;
      }
      await this.update(e, { phase: 'failed', error: err.message });
      return;
    }
    await this.update(e, {
      phase: 'paused',
      pause_reason: 'error' as PauseReason,
      error: 'The upload stopped. Retry to continue.',
    });
  }

  private watching = new Set<string>();

  /** Polls preparation: verifying → processing → ready/failed. Never invents a percent. */
  private async watch(e: UploadEntry) {
    if (!e.asset_id || this.watching.has(e.client_capture_id)) return;
    this.watching.add(e.client_capture_id);
    const controller = new AbortController();
    let delay = POLL_START_MS;
    try {
      for (let i = 0; i < POLL_BUDGET; i++) {
        if (!this.entries.has(e.client_capture_id) || e.account_id !== this.accountId) return;
        let detail: MediaDetail;
        try {
          detail = await this.deps.api.media(e.asset_id);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'not_found') {
            await this.update(e, {
              phase: 'failed',
              error: 'This file was removed from your library.',
            });
            return;
          }
          await this.deps.sleep(delay, controller.signal);
          delay = Math.min(POLL_MAX_MS, delay * 1.6);
          continue;
        }
        const status = detail.media.status;
        const committed = status === 'processing' || status === 'ready' || status === 'failed';
        const patch: Partial<UploadEntry> = { media_status: status };
        if (committed && e.blob) patch.blob = null;
        if (status === 'ready') {
          await this.update(e, { ...patch, phase: 'ready', error: null });
          return;
        }
        if (status === 'failed' && e.upload_id) {
          const upload = await this.deps.api.getUpload(e.upload_id).catch(() => null);
          if (upload?.state === 'rejected') {
            await this.update(e, {
              ...patch,
              phase: 'rejected',
              blob: null,
              error: rejectionReason(upload.error_code, e.kind),
            });
            return;
          }
        }
        if (status === 'failed') {
          await this.update(e, {
            ...patch,
            phase: 'failed',
            error:
              e.kind === 'video'
                ? 'This video could not be prepared. The original is kept.'
                : 'This photo could not be prepared.',
          });
          return;
        }
        if (status === 'processing' && e.phase !== 'processing') patch.phase = 'processing';
        await this.update(e, patch);
        await this.deps.sleep(delay, controller.signal);
        delay = Math.min(POLL_MAX_MS, delay * 1.4);
      }
    } finally {
      this.watching.delete(e.client_capture_id);
    }
  }
}

class LocalFileMissing extends Error {}

function rejectionReason(code: string | null, kind: 'photo' | 'video'): string {
  switch (code) {
    case 'payload_too_large':
      return `This ${kind} is larger than the limit.`;
    case 'quota_exceeded':
      return 'Your library is full. Delete something to make room.';
    case 'invalid_input':
      return 'The file changed while uploading or did not match its type. Add it again.';
    case 'unsupported_image':
      return `This ${kind} could not be read. Export it again and retry.`;
    default:
      return `This ${kind} was not accepted.`;
  }
}
