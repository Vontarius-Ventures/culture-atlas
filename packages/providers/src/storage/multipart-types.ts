/** Private streaming/multipart boundary. No browser receives a storage credential. */
export interface MultipartPart {
  part_number: number;
  etag: string;
  /** Stored byte size, when the provider reports it (ListParts). Never sent by clients. */
  size?: number;
}
/** Byte length of `part` (1-based) when `totalBytes` is split into `partSize` chunks. */
export function multipartPartSize(totalBytes: number, part: number, partSize: number): number {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || !Number.isSafeInteger(part) || part < 1)
    throw new Error('Invalid multipart part');
  const size = Math.min(partSize, totalBytes - (part - 1) * partSize);
  if (size < 1) throw new Error('Invalid multipart part');
  return size;
}
export interface MultipartInstruction {
  part_number: number;
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}
export interface MultipartStorage {
  begin(key: string, contentType: string): Promise<string>;
  /**
   * Signs one part PUT for exactly `byteSize` bytes. The length is part of the
   * signature, so storage refuses a larger (or smaller) body before accepting
   * any bytes beyond the upload's declared, quota-reserved size.
   */
  signPart(
    key: string,
    uploadId: string,
    part: number,
    expiresInSeconds: number,
    byteSize: number,
  ): Promise<MultipartInstruction>;
  listParts(key: string, uploadId: string): Promise<MultipartPart[]>;
  /** Must recover completion-after-lost-response by recognizing a sealed staging object. */
  finish(key: string, uploadId: string, parts: MultipartPart[]): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
  read(
    key: string,
  ): Promise<{ body: AsyncIterable<Uint8Array>; contentType: string; byteSize: number }>;
  /** At most8MiB per range; body chunks at most64KiB. Auth gateway reauthorizes every call. */
  getRange(
    key: string,
    range: { start: number; end: number },
  ): Promise<{
    body: AsyncIterable<Uint8Array>;
    contentType: string;
    byteSize: number;
    totalSize: number;
    start: number;
    end: number;
  }>;
  seal(stagingKey: string, immutableKey: string): Promise<void>;
  put(
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string,
    byteSize: number,
  ): Promise<void>;
  delete(key: string): Promise<void>;
  /** Worker-only namespace cleanup, never accepts an untrusted client prefix. */
  deletePrefix(prefix: string): Promise<void>;
  /** Worker-only reconciliation inventory of committed objects under a trusted prefix. */
  list?(prefix: string): AsyncIterable<StoredObjectInfo>;
  /** Worker-only inventory of multipart uploads that were never completed or aborted. */
  listIncompleteUploads?(prefix: string): AsyncIterable<IncompleteUploadInfo>;
}
export interface StoredObjectInfo {
  key: string;
  byteSize: number;
  lastModified: Date;
}
export interface IncompleteUploadInfo {
  key: string;
  uploadId: string;
  initiatedAt: Date;
}
export const MEDIA_RANGE_MAX_BYTES = 8388608;
export const MEDIA_STREAM_CHUNK_BYTES = 65536;
export function validateMediaRange(range: { start: number; end: number }): void {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start ||
    range.end - range.start + 1 > MEDIA_RANGE_MAX_BYTES
  )
    throw new Error('Invalid or excessive media range');
}
export async function* boundedMediaChunks(
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncIterable<Uint8Array> {
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('Media range exceeded its bound');
    for (let offset = 0; offset < chunk.byteLength; offset += MEDIA_STREAM_CHUNK_BYTES)
      yield chunk.subarray(offset, offset + MEDIA_STREAM_CHUNK_BYTES);
  }
}
