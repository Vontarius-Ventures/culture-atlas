/** Private streaming/multipart boundary. No browser receives a storage credential. */
export interface MultipartPart { part_number: number; etag: string }
export interface MultipartInstruction {
  part_number: number;
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}
export interface MultipartStorage {
  begin(key: string, contentType: string): Promise<string>;
  signPart(key: string, uploadId: string, part: number, expiresInSeconds: number): Promise<MultipartInstruction>;
  listParts(key: string, uploadId: string): Promise<MultipartPart[]>;
  /** Must recover completion-after-lost-response by recognizing a sealed staging object. */
  finish(key: string, uploadId: string, parts: MultipartPart[]): Promise<void>;
  abort(key: string, uploadId: string): Promise<void>;
  read(key: string): Promise<{ body: AsyncIterable<Uint8Array>; contentType: string; byteSize: number }>;
  seal(stagingKey: string, immutableKey: string): Promise<void>;
  put(key: string, body: AsyncIterable<Uint8Array>, contentType: string, byteSize: number): Promise<void>;
  delete(key: string): Promise<void>;
}
