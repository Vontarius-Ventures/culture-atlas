/**
 * Local stand-ins for the two AWS transports the production build requires,
 * for running `next start` and the workers offline (design-fidelity runs,
 * demos without an AWS account). NOT for deployment and never imported by the
 * app: the app talks to them through its normal S3 and SESv2 clients.
 *
 *   pnpm exec tsx scripts/local-aws.ts --dir .data/local-aws [--s3-port 4569] [--ses-port 4580]
 *
 * Then point the app at them:
 *   STORAGE_DRIVER=s3 S3_ENDPOINT=http://127.0.0.1:4569 S3_FORCE_PATH_STYLE=true
 *   S3_BUCKET=<any> S3_ACCESS_KEY_ID=local S3_SECRET_ACCESS_KEY=local
 *   AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED
 *   IDENTITY_MAIL_DRIVER=ses IDENTITY_MAIL_FROM=... IDENTITY_MAIL_SES_REGION=us-east-1
 *   AWS_ENDPOINT_URL_SESV2=http://127.0.0.1:4580 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local
 *
 * S3: path-style buckets with the operations the storage adapters use
 * (multipart create/upload/list/complete/abort, ListMultipartUploads, Get with
 * Range, Head, Put, Copy, Delete, DeleteObjects, ListObjectsV2) and browser
 * CORS that exposes ETag. Signatures are not verified. Objects persist under
 * --dir so a restart keeps the library.
 * SES: POST /v2/email/outbound-emails writes {to, subject, callback} to
 * <dir>/mail/<ISO time>-<uuid>.json (mode 0600, the dev file mailbox format)
 * instead of sending mail.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import path from 'node:path';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const DIR = path.resolve(arg('dir', '.data/local-aws'));
const S3_PORT = Number(arg('s3-port', '4569'));
const SES_PORT = Number(arg('ses-port', '4580'));
const OBJECTS = path.join(DIR, 's3', 'objects');
const UPLOADS = path.join(DIR, 's3', 'uploads');
const MAIL = path.join(DIR, 'mail');
for (const d of [OBJECTS, UPLOADS, MAIL]) mkdirSync(d, { recursive: true });

interface Meta {
  bucket: string;
  key: string;
  contentType: string;
  metadata: Record<string, string>;
  etag: string;
  size: number;
  lastModified: string;
}

const esc = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );
const fileId = (bucket: string, key: string) =>
  createHash('sha256').update(`${bucket}/${key}`).digest('hex');
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

function readMeta(bucket: string, key: string): Meta | null {
  const p = path.join(OBJECTS, `${fileId(bucket, key)}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Meta) : null;
}
function writeObject(
  meta: Omit<Meta, 'etag' | 'size' | 'lastModified'>,
  body: Buffer,
  etag?: string,
) {
  const id = fileId(meta.bucket, meta.key);
  writeFileSync(path.join(OBJECTS, `${id}.bin`), body);
  const full: Meta = {
    ...meta,
    etag: etag ?? `"${md5(body)}"`,
    size: body.length,
    lastModified: new Date().toUTCString(),
  };
  writeFileSync(path.join(OBJECTS, `${id}.json`), JSON.stringify(full));
  return full;
}
function deleteObject(bucket: string, key: string) {
  const id = fileId(bucket, key);
  rmSync(path.join(OBJECTS, `${id}.bin`), { force: true });
  rmSync(path.join(OBJECTS, `${id}.json`), { force: true });
}
function allObjects(bucket: string): Meta[] {
  return readdirSync(OBJECTS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(path.join(OBJECTS, f), 'utf8')) as Meta)
    .filter((m) => m.bucket === bucket);
}

interface Upload {
  bucket: string;
  key: string;
  contentType: string;
  metadata: Record<string, string>;
  initiated: string;
}
const uploadDir = (id: string) => path.join(UPLOADS, id.replace(/[^a-zA-Z0-9-]/g, ''));
function readUpload(id: string): Upload | null {
  const p = path.join(uploadDir(id), 'upload.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Upload) : null;
}
function uploadParts(id: string) {
  return readdirSync(uploadDir(id))
    .filter((f) => f.endsWith('.part'))
    .map((f) => {
      const n = Number(f.replace('.part', ''));
      const body = readFileSync(path.join(uploadDir(id), f));
      return {
        n,
        body,
        etag: `"${md5(body)}"`,
        modified: statSync(path.join(uploadDir(id), f)).mtime,
      };
    })
    .sort((a, b) => a.n - b.n);
}

/** Body bytes, with aws-chunked (streaming) encoding removed when present. */
function decodeBody(req: http.IncomingMessage, raw: Buffer): Buffer {
  const enc = String(req.headers['content-encoding'] ?? '');
  const sha = String(req.headers['x-amz-content-sha256'] ?? '');
  if (!enc.includes('aws-chunked') && !sha.startsWith('STREAMING-')) return raw;
  const out: Buffer[] = [];
  let i = 0;
  while (i < raw.length) {
    const eol = raw.indexOf('\r\n', i);
    if (eol < 0) break;
    const size = parseInt(raw.subarray(i, eol).toString().split(';')[0]!, 16);
    if (!size) break;
    out.push(raw.subarray(eol + 2, eol + 2 + size));
    i = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

function metaHeaders(req: http.IncomingMessage) {
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers))
    if (k.startsWith('x-amz-meta-')) metadata[k.slice(11)] = String(v);
  return metadata;
}

function cors(req: http.IncomingMessage, res: http.ServerResponse) {
  res.setHeader('access-control-allow-origin', String(req.headers.origin ?? '*'));
  res.setHeader('access-control-allow-methods', 'GET, PUT, POST, DELETE, HEAD');
  res.setHeader(
    'access-control-allow-headers',
    String(req.headers['access-control-request-headers'] ?? '*'),
  );
  res.setHeader('access-control-expose-headers', 'ETag, Content-Range, Content-Length');
  res.setHeader('access-control-max-age', '3000');
  res.setHeader('vary', 'Origin');
}

function xml(res: http.ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
}
function s3Error(res: http.ServerResponse, status: number, code: string, method?: string) {
  if (method === 'HEAD') {
    res.writeHead(status);
    res.end();
    return;
  }
  xml(
    res,
    status,
    `<Error><Code>${code}</Code><Message>${code}</Message><RequestId>${randomUUID()}</RequestId></Error>`,
  );
}
const tag = (name: string, value: string | number) => `<${name}>${esc(String(value))}</${name}>`;

function sendObject(req: http.IncomingMessage, res: http.ServerResponse, meta: Meta) {
  const body = readFileSync(path.join(OBJECTS, `${fileId(meta.bucket, meta.key)}.bin`));
  const headers: Record<string, string | number> = {
    'content-type': meta.contentType,
    etag: meta.etag,
    'last-modified': meta.lastModified,
    'accept-ranges': 'bytes',
  };
  for (const [k, v] of Object.entries(meta.metadata)) headers[`x-amz-meta-${k}`] = v;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
    const end =
      range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    if (start >= body.length || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${body.length}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': end - start + 1,
    });
    res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function handleS3(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer) {
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://local');
  const [bucket = '', ...rest] = url.pathname.slice(1).split('/');
  const key = rest.map(decodeURIComponent).join('/');
  const q = url.searchParams;
  const method = req.method ?? 'GET';
  const body = decodeBody(req, raw);

  if (!key) {
    // Bucket-level operations.
    if (method === 'GET' && q.has('uploads')) {
      const prefix = q.get('prefix') ?? '';
      const uploads = readdirSync(UPLOADS)
        .map((id) => ({ id, u: readUpload(id) }))
        .filter((x) => x.u && x.u.bucket === bucket && x.u.key.startsWith(prefix));
      return xml(
        res,
        200,
        `<ListMultipartUploadsResult>${tag('Bucket', bucket)}${tag('Prefix', prefix)}<IsTruncated>false</IsTruncated>${uploads
          .map(
            (x) =>
              `<Upload>${tag('Key', x.u!.key)}${tag('UploadId', x.id)}${tag('Initiated', x.u!.initiated)}</Upload>`,
          )
          .join('')}</ListMultipartUploadsResult>`,
      );
    }
    if (method === 'GET' && q.get('list-type') === '2') {
      const prefix = q.get('prefix') ?? '';
      const items = allObjects(bucket)
        .filter((m) => m.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key));
      return xml(
        res,
        200,
        `<ListBucketResult>${tag('Name', bucket)}${tag('Prefix', prefix)}${tag('KeyCount', items.length)}<MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${items
          .map(
            (m) =>
              `<Contents>${tag('Key', m.key)}${tag('LastModified', new Date(m.lastModified).toISOString())}${tag('ETag', m.etag)}${tag('Size', m.size)}<StorageClass>STANDARD</StorageClass></Contents>`,
          )
          .join('')}</ListBucketResult>`,
      );
    }
    if (method === 'POST' && q.has('delete')) {
      const keys = [...body.toString().matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((m) =>
        m[1]!
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&'),
      );
      keys.forEach((k) => deleteObject(bucket, k));
      return xml(
        res,
        200,
        `<DeleteResult>${keys.map((k) => `<Deleted>${tag('Key', k)}</Deleted>`).join('')}</DeleteResult>`,
      );
    }
    if (method === 'HEAD' || method === 'PUT') {
      res.writeHead(200);
      res.end();
      return;
    }
    return s3Error(res, 405, 'MethodNotAllowed', method);
  }

  const uploadId = q.get('uploadId');
  if (method === 'POST' && q.has('uploads')) {
    const id = randomUUID().replace(/-/g, '');
    mkdirSync(uploadDir(id), { recursive: true });
    const u: Upload = {
      bucket,
      key,
      contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
      metadata: metaHeaders(req),
      initiated: new Date().toISOString(),
    };
    writeFileSync(path.join(uploadDir(id), 'upload.json'), JSON.stringify(u));
    return xml(
      res,
      200,
      `<InitiateMultipartUploadResult>${tag('Bucket', bucket)}${tag('Key', key)}${tag('UploadId', id)}</InitiateMultipartUploadResult>`,
    );
  }
  if (uploadId) {
    const u = readUpload(uploadId);
    if (!u || u.bucket !== bucket || u.key !== key)
      return s3Error(res, 404, 'NoSuchUpload', method);
    if (method === 'PUT' && q.has('partNumber')) {
      writeFileSync(path.join(uploadDir(uploadId), `${Number(q.get('partNumber'))}.part`), body);
      res.writeHead(200, { etag: `"${md5(body)}"` });
      res.end();
      return;
    }
    if (method === 'GET') {
      const parts = uploadParts(uploadId);
      return xml(
        res,
        200,
        `<ListPartsResult>${tag('Bucket', bucket)}${tag('Key', key)}${tag('UploadId', uploadId)}<IsTruncated>false</IsTruncated>${parts
          .map(
            (p) =>
              `<Part>${tag('PartNumber', p.n)}${tag('LastModified', p.modified.toISOString())}${tag('ETag', p.etag)}${tag('Size', p.body.length)}</Part>`,
          )
          .join('')}</ListPartsResult>`,
      );
    }
    if (method === 'POST') {
      const wanted = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) =>
        Number(m[1]),
      );
      const parts = uploadParts(uploadId);
      const chosen = wanted.map((n) => parts.find((p) => p.n === n));
      if (!wanted.length || chosen.some((p) => !p)) return s3Error(res, 400, 'InvalidPart', method);
      const data = Buffer.concat(chosen.map((p) => p!.body));
      const etag = `"${md5(Buffer.concat(chosen.map((p) => Buffer.from(md5(p!.body), 'hex'))))}-${chosen.length}"`;
      writeObject({ bucket, key, contentType: u.contentType, metadata: u.metadata }, data, etag);
      rmSync(uploadDir(uploadId), { recursive: true, force: true });
      return xml(
        res,
        200,
        `<CompleteMultipartUploadResult>${tag('Location', `/${bucket}/${key}`)}${tag('Bucket', bucket)}${tag('Key', key)}${tag('ETag', etag)}</CompleteMultipartUploadResult>`,
      );
    }
    if (method === 'DELETE') {
      rmSync(uploadDir(uploadId), { recursive: true, force: true });
      res.writeHead(204);
      res.end();
      return;
    }
  }
  if (method === 'PUT' && req.headers['x-amz-copy-source']) {
    const source = decodeURIComponent(
      String(req.headers['x-amz-copy-source']).split('?')[0]!,
    ).replace(/^\//, '');
    const [srcBucket = '', ...srcKey] = source.split('/');
    const from = readMeta(srcBucket, srcKey.join('/'));
    if (!from) return s3Error(res, 404, 'NoSuchKey', method);
    const replace = req.headers['x-amz-metadata-directive'] === 'REPLACE';
    const copy = writeObject(
      {
        bucket,
        key,
        contentType: replace
          ? String(req.headers['content-type'] ?? from.contentType)
          : from.contentType,
        metadata: replace ? metaHeaders(req) : from.metadata,
      },
      readFileSync(path.join(OBJECTS, `${fileId(srcBucket, srcKey.join('/'))}.bin`)),
    );
    return xml(
      res,
      200,
      `<CopyObjectResult>${tag('ETag', copy.etag)}${tag('LastModified', new Date(copy.lastModified).toISOString())}</CopyObjectResult>`,
    );
  }
  if (method === 'PUT') {
    const m = writeObject(
      {
        bucket,
        key,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        metadata: metaHeaders(req),
      },
      body,
    );
    res.writeHead(200, { etag: m.etag });
    res.end();
    return;
  }
  if (method === 'GET' || method === 'HEAD') {
    const meta = readMeta(bucket, key);
    if (!meta) return s3Error(res, 404, 'NoSuchKey', method);
    return sendObject(req, res, meta);
  }
  if (method === 'DELETE') {
    deleteObject(bucket, key);
    res.writeHead(204);
    res.end();
    return;
  }
  return s3Error(res, 405, 'MethodNotAllowed', method);
}

function handleSes(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer) {
  if (req.method !== 'POST' || !req.url?.startsWith('/v2/email/outbound-emails')) {
    res.writeHead(404);
    res.end();
    return;
  }
  const msg = JSON.parse(raw.toString()) as {
    Destination?: { ToAddresses?: string[] };
    Content?: { Simple?: { Subject?: { Data?: string }; Body?: { Text?: { Data?: string } } } };
  };
  const text = msg.Content?.Simple?.Body?.Text?.Data ?? '';
  // Same file name and fields as the app's development file mailbox, so the
  // journeys that read V2_MAIL_DIR work with either.
  const file = path.join(
    MAIL,
    `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify({
      to: msg.Destination?.ToAddresses?.[0] ?? '',
      subject: msg.Content?.Simple?.Subject?.Data ?? '',
      callback: text.split('\n').find((l) => /^https?:\/\//.test(l)) ?? '',
    }),
    { mode: 0o600 },
  );
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ MessageId: randomUUID() }));
}

function serve(port: number, handler: typeof handleS3, label: string) {
  http
    .createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          handler(req, res, Buffer.concat(chunks));
        } catch (error) {
          console.error(`[${label}]`, req.method, req.url, error);
          if (!res.headersSent) s3Error(res, 500, 'InternalError');
        }
      });
    })
    .listen(port, '127.0.0.1', () =>
      console.log(`${label} listening on 127.0.0.1:${port} (${DIR})`),
    );
}

serve(S3_PORT, handleS3, 'local S3');
serve(SES_PORT, handleSes, 'local SESv2');
