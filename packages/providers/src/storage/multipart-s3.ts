import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand,
  CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand,
  ListPartsCommand, PutObjectCommand, S3Client, UploadPartCommand,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { MultipartPart, MultipartStorage } from './multipart-types';
import { isSafeObjectKey } from './signing';

export class S3MultipartStorage implements MultipartStorage {
  private readonly client: S3Client;
  constructor(private readonly options: S3ClientConfig & { bucket: string; client?: S3Client }) {
    this.client = options.client ?? new S3Client(options);
  }
  private key(key: string): { Bucket: string; Key: string } {
    if (!isSafeObjectKey(key)) throw new Error('Invalid private object key');
    return { Bucket: this.options.bucket, Key: key };
  }
  async begin(key: string, contentType: string): Promise<string> {
    const r = await this.client.send(new CreateMultipartUploadCommand({
      ...this.key(key), ContentType: contentType, Metadata: { 'capture-v2': 'staging' },
    }));
    if (!r.UploadId) throw new Error('Missing multipart id');
    return r.UploadId;
  }
  async signPart(key: string, uploadId: string, part: number, expiresInSeconds: number) {
    const ttl = Math.min(900,Math.max(1,expiresInSeconds));
    const url = await getSignedUrl(this.client,new UploadPartCommand({
      ...this.key(key),UploadId:uploadId,PartNumber:part,
    }),{expiresIn:ttl});
    return { part_number:part,method:'PUT' as const,url,headers:{},expires_at:new Date(Date.now()+ttl*1000).toISOString() };
  }
  async listParts(key: string, uploadId: string): Promise<MultipartPart[]> {
    const parts: MultipartPart[] = [];
    let marker: string | undefined;
    do {
      const r = await this.client.send(new ListPartsCommand({
        ...this.key(key),UploadId:uploadId,PartNumberMarker:marker,
      }));
      for (const p of r.Parts ?? []) {
        if (p.PartNumber && p.ETag) parts.push({part_number:p.PartNumber,etag:p.ETag});
      }
      marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }
  async finish(key: string, uploadId: string, parts: MultipartPart[]): Promise<void> {
    try {
      await this.client.send(new CompleteMultipartUploadCommand({
        ...this.key(key),UploadId:uploadId,
        MultipartUpload:{Parts:parts.map(p=>({PartNumber:p.part_number,ETag:p.etag}))},
      }));
    } catch (error) {
      if ((error as {name?:string}).name !== 'NoSuchUpload') throw error;
      // Unique staging key + private writer policy makes this the lost-response recovery.
      const existing = await this.client.send(new HeadObjectCommand(this.key(key)));
      if (existing.Metadata?.['capture-v2'] !== 'staging') throw error;
    }
  }
  async abort(key: string, uploadId: string): Promise<void> {
    try { await this.client.send(new AbortMultipartUploadCommand({...this.key(key),UploadId:uploadId})); }
    catch (e) { if ((e as {name?:string}).name !== 'NoSuchUpload') throw e; }
  }
  async read(key: string) {
    const r = await this.client.send(new GetObjectCommand(this.key(key)));
    if (!r.Body || r.ContentLength === undefined) throw new Error('Object unavailable');
    return {body:r.Body as Readable,byteSize:r.ContentLength,contentType:r.ContentType ?? 'application/octet-stream'};
  }
  async seal(stagingKey: string, immutableKey: string): Promise<void> {
    this.key(stagingKey);
    await this.client.send(new CopyObjectCommand({
      ...this.key(immutableKey),
      CopySource:`${encodeURIComponent(this.options.bucket)}/${stagingKey.split('/').map(encodeURIComponent).join('/')}`,
      MetadataDirective:'COPY',
    }));
  }
  async put(key: string, body: AsyncIterable<Uint8Array>, contentType: string, byteSize: number): Promise<void> {
    const { Readable } = await import('node:stream');
    await this.client.send(new PutObjectCommand({
      ...this.key(key),Body:Readable.from(body),ContentType:contentType,ContentLength:byteSize,IfNoneMatch:'*',
    }));
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand(this.key(key)));
  }
}
