import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  AppError,
  CaptureDevice,
  MediaIntake,
  MediaAnalysis,
  createCaptureV2Context,
  getDb,
  getDomainConfig,
  assertExpectedCaptureAccount,
  evaluateCaptureCapabilities,
  toErrorBody,
  enforceIpLimit,
  assertCaptureAuthority,
  hasQualifiedVideoWorker,
  type CaptureV2Context,
  type InstallationAuthority,
  type CaptureIdentityAdapter,
  auth,
  captures,
  createServiceContext,
} from '@culture-atlas/domain';
import {
  LocalMultipartStorage,
  S3MultipartStorage,
  loadProviderConfig,
  getProviders,
  type MultipartStorage,
} from '@culture-atlas/providers';
import { abuseLimitIp } from './http';
import { ensureServerRuntime } from './runtime';

/** Identity/P2 integration seam. Server startup must register before enabling those capabilities. */
export interface CaptureV2Runtime {
  identity?: CaptureIdentityAdapter;
  resolveNativePrincipal?: (token: string) => Promise<InstallationAuthority>;
  verifier?: CaptureV2Context['verifier'];
  storage?: MultipartStorage;
  agentAuthorization?: CaptureV2Context['agentAuthorization'];
}
let runtime: CaptureV2Runtime = {};
let storage: MultipartStorage | undefined;
/** Set by tests/explicit composition; production defaults are then never applied. */
let explicitRuntime = false;
export function setCaptureV2Runtime(value: CaptureV2Runtime): void {
  runtime = value;
  explicitRuntime = true;
  storage = undefined;
}
/** Production defaults (runtime.ts). Fills only slots that are still empty. */
export function installCaptureV2Defaults(value: Partial<CaptureV2Runtime>): void {
  runtime = { ...value, ...runtime };
}
function prepareRuntime(): void {
  if (!explicitRuntime) ensureServerRuntime();
}
export function configureCaptureV2Runtime(value: Partial<CaptureV2Runtime>): void {
  runtime = { ...runtime, ...value };
  storage = undefined;
}
export function getCaptureV2Storage(): MultipartStorage {
  if (runtime.storage) return runtime.storage;
  if (storage) return storage;
  const config = loadProviderConfig();
  if (config.STORAGE_DRIVER === 's3') {
    if (!config.S3_BUCKET)
      throw new AppError('service_unavailable', {
        message: 'Private media storage is not configured.',
      });
    storage = new S3MultipartStorage({
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials:
        config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
          : undefined,
    });
  } else {
    if (process.env.NODE_ENV === 'production')
      throw new AppError('service_unavailable', {
        message: 'Production media requires private S3 storage.',
      });
    storage = new LocalMultipartStorage(
      resolve(config.STORAGE_LOCAL_DIR, 'capture-v2'),
      config.APP_BASE_URL,
      config.STORAGE_SIGNING_SECRET ?? getDomainConfig().SESSION_SECRET,
    );
  }
  return storage;
}
async function jsonBody(request: NextRequest): Promise<unknown> {
  if (!request.body) return {};
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new AppError('invalid_input');
  let length = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of Readable.fromWeb(
    request.body as NodeReadableStream<Uint8Array>,
  )) {
    length += chunk.length;
    if (length > 1048576)
      throw new AppError('payload_too_large', { message: 'Request metadata is too large.' });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new AppError('invalid_input');
  }
}
function integerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new AppError('service_unavailable');
  return n;
}
function rejectShareAuthority(request: NextRequest): void {
  if (
    request.headers.has('x-atlas-share-session') ||
    request.headers.has('x-atlas-share-token') ||
    request.cookies.getAll().some((cookie) => /^ca_(?:share|shared)/i.test(cookie.name))
  )
    throw new AppError('scope_denied', {
      message: 'Share viewers must use the recipient media gateway.',
    });
}
/** P5 calls this only AFTER its live AgentAuthorization scope/resource check. */
export async function createCaptureV2HttpContext(
  authority: CaptureV2Context['authority'],
  options: { db?: CaptureV2Context['db']; agent?: CaptureV2Context['agent'] } = {},
): Promise<CaptureV2Context> {
  prepareRuntime();
  const db = options.db ?? getDb();
  const ctx = createCaptureV2Context({
    db,
    authority,
    storage: getCaptureV2Storage(),
    identity: runtime.identity,
    verifier: runtime.verifier,
    agent: options.agent,
    agentAuthorization: runtime.agentAuthorization,
    videoEnabled: await hasQualifiedVideoWorker(
      db,
      new Date(),
      process.env.CAPTURE_VIDEO_UPLOAD_ENABLED !== 'false',
    ),
    mediaCreationEnabled: process.env.CAPTURE_MEDIA_CREATION_ENABLED !== 'false',
    deleteAnalysisCapture: async (tx, accountId, captureId) => {
      const legacy = createServiceContext(
        { kind: 'account', accountId, sessionId: null, isDemoOwner: false },
        { db: tx },
      );
      await captures.deleteCapture(legacy, { id: captureId });
    },
    readLegacyObject: async (key) => {
      const object = await getProviders().storage.get(key);
      if (!object) throw new AppError('not_found');
      return {
        body: Readable.from([object.body]),
        contentType: object.contentType,
        byteSize: object.body.byteLength,
      };
    },
  });
  ctx.limits = {
    ...ctx.limits,
    accountQuotaBytes: integerEnv('ACCOUNT_MEDIA_QUOTA_BYTES', ctx.limits.accountQuotaBytes),
    photoMaxBytes: integerEnv('MEDIA_PHOTO_MAX_BYTES', ctx.limits.photoMaxBytes),
    photoMaxPixels: integerEnv('MEDIA_PHOTO_MAX_PIXELS', ctx.limits.photoMaxPixels),
    videoMaxBytes: integerEnv('MEDIA_VIDEO_MAX_BYTES', ctx.limits.videoMaxBytes),
  };
  return ctx;
}
/** Native-only HTTP context for P5 command claim/ack; cookies and share tokens confer no authority. */
export async function requireCaptureV2InstallationContext(
  request: NextRequest,
): Promise<CaptureV2Context> {
  rejectShareAuthority(request);
  prepareRuntime();
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer cna_')) throw new AppError('unauthenticated');
  if (!runtime.resolveNativePrincipal) throw new AppError('service_unavailable');
  const authority = await runtime.resolveNativePrincipal(authorization.slice(7));
  if (authority.kind !== 'installation') throw new AppError('scope_denied');
  assertExpectedCaptureAccount(
    authority,
    request.headers.get('x-atlas-expected-account'),
    request.method !== 'GET',
  );
  const ctx = await createCaptureV2HttpContext(authority);
  await assertCaptureAuthority(ctx, ctx.db);
  return ctx;
}
/** Authenticates once; all ownership and lifecycle policy lives in deep domain modules. */
export async function captureV2Route(request: NextRequest): Promise<Response> {
  const requestId = randomUUID(),
    headers = { 'x-request-id': requestId, 'cache-control': 'private, no-store' };
  try {
    prepareRuntime();
    const url = new URL(request.url),
      path = url.pathname.replace(/\/$/, ''),
      method = request.method,
      mutation = method !== 'GET';
    const db = getDb(),
      config = getDomainConfig();
    rejectShareAuthority(request);
    const localPart = /^\/v2\/storage\/parts\/([a-f0-9-]{36})\/(\d+)$/.exec(path);
    if (localPart && method === 'PUT') {
      const local = getCaptureV2Storage();
      if (!(local instanceof LocalMultipartStorage) || !request.body)
        throw new AppError('not_found');
      const etag = await local.acceptSignedPart(
        localPart[1]!,
        Number(localPart[2]),
        Number(url.searchParams.get('expires')),
        url.searchParams.get('signature') ?? '',
        Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>),
      );
      return new Response(null, { status: 200, headers: { ...headers, ETag: etag } });
    }
    const enrollment = path === '/v2/devices/enroll' || path === '/v2/devices/enrollment/challenge';
    let body: unknown;
    let grantAuthority = false;
    let authority: CaptureV2Context['authority'];
    const authorization = request.headers.get('authorization');
    if (enrollment) body = await jsonBody(request);
    const enrollmentGrant = (body as { enrollment_grant?: unknown } | undefined)?.enrollment_grant;
    if (enrollment && typeof enrollmentGrant === 'string') {
      if (!runtime.identity) throw new AppError('service_unavailable');
      await enforceIpLimit(db, { ip: abuseLimitIp(request, config), config, now: new Date() });
      const platform = (body as { platform?: unknown }).platform;
      if (platform !== 'ios' && platform !== 'android') throw new AppError('invalid_input');
      const verified = await runtime.identity.peekNativeEnrollmentGrant(
        db,
        enrollmentGrant,
        platform,
        new Date(),
      );
      authority = { kind: 'account', accountId: verified.accountId, sessionId: null };
      grantAuthority = true;
    } else if (authorization?.startsWith('Bearer cna_')) {
      if (!runtime.resolveNativePrincipal)
        throw new AppError('service_unavailable', {
          message: 'Native identity is not configured.',
        });
      authority = await runtime.resolveNativePrincipal(authorization.slice(7));
    } else {
      if (authorization)
        throw new AppError(
          authorization.startsWith('Bearer cat_') ? 'scope_denied' : 'unauthenticated',
        );
      const principal = await auth.resolvePrincipal(db, {
        sessionToken: request.cookies.get(auth.SESSION_COOKIE)?.value,
        authorization,
      });
      if (principal?.kind === 'account') authority = principal;
      else throw new AppError(principal ? 'scope_denied' : 'unauthenticated');
    }
    if (!grantAuthority)
      assertExpectedCaptureAccount(
        authority,
        request.headers.get('x-atlas-expected-account'),
        mutation,
      );
    else if (request.headers.has('x-atlas-expected-account')) {
      assertExpectedCaptureAccount(
        authority,
        request.headers.get('x-atlas-expected-account'),
        mutation,
      );
    }
    if (mutation && authority.kind === 'account' && !grantAuthority) {
      if (
        !authority.sessionId ||
        !auth.verifyCsrf(
          authority.sessionId,
          config.SESSION_SECRET,
          request.headers.get(auth.CSRF_HEADER),
        )
      ) {
        throw new AppError('csrf_failed');
      }
    }
    if (mutation && !grantAuthority)
      await enforceIpLimit(db, { ip: abuseLimitIp(request, config), config, now: new Date() });
    if (mutation && body === undefined) body = await jsonBody(request);
    const key = request.headers.get('idempotency-key') ?? '';
    if (mutation && !enrollment && !z.uuid().safeParse(key).success)
      throw new AppError('invalid_input', { message: 'Idempotency-Key must be a UUID.' });
    const ctx = await createCaptureV2HttpContext(authority, { db });
    const intake = new MediaIntake(ctx),
      devices = new CaptureDevice(ctx),
      analysis = new MediaAnalysis(ctx);
    let result: unknown,
      status = 200,
      match: RegExpExecArray | null;
    if (path === '/v2/capabilities' && method === 'GET') {
      result = evaluateCaptureCapabilities(
        {
          mediaCreationEnabled: process.env.CAPTURE_MEDIA_CREATION_ENABLED !== 'false',
          cameraVideoEnabled: true,
          videoDecoderQualified: ctx.videoEnabled,
          glasses: {
            buildSupported: false,
            channelEligible: false,
            rolloutEligible: false,
            deviceCompatible: false,
            permissionGranted: false,
            locallyReady: false,
            killed: true,
          },
          analysisReady: false,
          agentApiEnabled: false,
          sharingEnabled: false,
        },
        ctx.limits,
      );
    } else if (path === '/v2/uploads' && method === 'POST') {
      result = await intake.createUpload(body, key);
      status = 201;
    } else if ((match = /^\/v2\/uploads\/([^/]+)(?:\/(parts|complete|resume))?$/.exec(path))) {
      const id = z.uuid().parse(match[1]);
      if (method === 'GET' && !match[2]) result = await intake.getUpload(id);
      else if (method === 'POST' && match[2] === 'parts')
        result = await intake.parts(id, body, key);
      else if (method === 'POST' && match[2] === 'resume')
        result = await intake.resumeUpload(id, key);
      else if (method === 'POST' && match[2] === 'complete') {
        result = await intake.completeUpload(id, body, key);
        status = (result as { state: string }).state === 'committed' ? 200 : 202;
      } else if (method === 'DELETE' && !match[2]) {
        result = await intake.abortUpload(id, key);
        status = 202;
      } else throw new AppError('not_found');
    } else if (path === '/v2/library' && method === 'GET')
      result = await intake.library(Object.fromEntries(url.searchParams));
    else if (path === '/v2/media/batch-delete' && method === 'POST') {
      result = await intake.batchDelete(body, key);
    } else if (
      (match = /^\/v2\/media\/([^/]+)(?:\/(analysis|content)(?:\/([^/]+))?)?$/.exec(path))
    ) {
      const id = z.uuid().parse(match[1]);
      if (match[2] === 'content' && match[3] && method === 'GET') {
        const object = await intake.content(id, match[3]);
        const range = request.headers.get('range');
        let start = 0,
          end = object.byteSize - 1,
          partial = false;
        if (range) {
          const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!parsed || (!parsed[1] && !parsed[2]))
            return new Response(null, {
              status: 416,
              headers: { ...headers, 'content-range': `bytes */${object.byteSize}` },
            });
          start = parsed[1] ? Number(parsed[1]) : Math.max(0, object.byteSize - Number(parsed[2]));
          end = parsed[1] ? (parsed[2] ? Math.min(Number(parsed[2]), end) : end) : end;
          partial = true;
          if (start > end || start >= object.byteSize)
            return new Response(null, {
              status: 416,
              headers: { ...headers, 'content-range': `bytes */${object.byteSize}` },
            });
        }
        async function* slices() {
          let offset = 0;
          for await (const chunk of object.body) {
            if (offset + chunk.length > start && offset <= end)
              yield chunk.subarray(
                Math.max(0, start - offset),
                Math.min(chunk.length, end - offset + 1),
              );
            offset += chunk.length;
            if (offset > end) break;
          }
        }
        return new Response(Readable.toWeb(Readable.from(slices())) as ReadableStream, {
          status: partial ? 206 : 200,
          headers: {
            ...headers,
            'content-type': object.contentType,
            'content-length': String(end - start + 1),
            'accept-ranges': 'bytes',
            'x-content-type-options': 'nosniff',
            ...(partial ? { 'content-range': `bytes ${start}-${end}/${object.byteSize}` } : {}),
          },
        });
      }
      if (match[2] === 'analysis' && method === 'POST' && !match[3]) {
        result = await analysis.request(id, body, key);
        status = 202;
      } else if (match[2] === 'analysis' && method === 'GET' && match[3])
        result = await analysis.get(id, z.uuid().parse(match[3]));
      else if (!match[2] && method === 'GET') result = await intake.detail(id);
      else if (!match[2] && method === 'PATCH') result = await intake.updateMedia(id, body, key);
      else if (!match[2] && method === 'DELETE') {
        result = await intake.deleteMedia(id, body, key);
        status = 202;
      } else throw new AppError('not_found');
    } else if (path === '/v2/devices/enrollment/challenge' && method === 'POST') {
      result = await devices.challenge(body);
      status = 201;
    } else if (path === '/v2/devices/enroll' && method === 'POST') {
      result = await devices.enroll(body);
      status = 201;
    } else if (path === '/v2/devices' && method === 'GET')
      result = await devices.list(
        url.searchParams.get('cursor') ?? undefined,
        Number(url.searchParams.get('limit') ?? 30),
      );
    else if ((match = /^\/v2\/devices\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      result = await devices.revoke(z.uuid().parse(match[1]), body, key);
      status = 202;
    } else if (path === '/v2/device/status' && method === 'PUT')
      result = await devices.status(body, key);
    else if (path === '/v2/device/wearables' && method === 'POST') {
      result = await devices.wearable(body, key);
      status = 201;
    } else if ((match = /^\/v2\/device\/wearables\/([^/]+)$/.exec(path)) && method === 'DELETE') {
      await devices.unlinkWearable(z.uuid().parse(match[1]), key);
      return new Response(null, { status: 204, headers });
    } else if (path === '/v2/device/capture-sessions' && method === 'POST') {
      result = await devices.createSession(body, key);
      status = 201;
    } else if (
      (match = /^\/v2\/device\/capture-sessions\/([^/]+)\/(arm|end)$/.exec(path)) &&
      method === 'POST'
    ) {
      const id = z.uuid().parse(match[1]);
      result =
        match[2] === 'arm'
          ? await devices.arm(id, body, key)
          : await devices.endSession(id, body, key);
    } else throw new AppError('not_found');
    return Response.json(result, { status, headers });
  } catch (error) {
    const safe = error instanceof z.ZodError ? new AppError('invalid_input') : error;
    const result = toErrorBody(safe, requestId);
    return Response.json({ error: result.body }, { status: result.status, headers });
  }
}
