import { randomUUID } from 'node:crypto';
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
  captureLimitsFromEnv,
  parseByteRange,
  MediaRangeNotSatisfiable,
  type CaptureV2Context,
  type InstallationAuthority,
  type CaptureIdentityAdapter,
  auth,
  captures,
  createServiceContext,
} from '@culture-atlas/domain';
import {
  LocalMultipartStorage,
  MultipartStorageUnavailableError,
  createMultipartStorage,
  loadProviderConfig,
  getProviders,
  type MultipartStorage,
} from '@culture-atlas/providers';
import { abuseLimitIp } from './http';
import { analysisAvailability, photoAnalysisReady } from './model-readiness';

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
export function setCaptureV2Runtime(value: CaptureV2Runtime): void {
  runtime = value;
  storage = undefined;
}
export function configureCaptureV2Runtime(value: Partial<CaptureV2Runtime>): void {
  runtime = { ...runtime, ...value };
  storage = undefined;
}
export function getCaptureV2Storage(): MultipartStorage {
  if (runtime.storage) return runtime.storage;
  if (storage) return storage;
  try {
    storage = createMultipartStorage(loadProviderConfig(), {
      production: process.env.NODE_ENV === 'production',
      fallbackSigningSecret: getDomainConfig().SESSION_SECRET,
    });
  } catch (error) {
    if (error instanceof MultipartStorageUnavailableError)
      throw new AppError('service_unavailable', { message: error.message });
    throw error;
  }
  return storage;
}
async function jsonBody(request: NextRequest): Promise<unknown> {
  if (!request.body) return {};
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new AppError('invalid_input');
  let length = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>)) {
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
    analysisAvailability,
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
  ctx.limits = captureLimitsFromEnv(process.env, ctx.limits);
  return ctx;
}
/** Native-only HTTP context for P5 command claim/ack; cookies and share tokens confer no authority. */
export async function requireCaptureV2InstallationContext(
  request: NextRequest,
): Promise<CaptureV2Context> {
  rejectShareAuthority(request);
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
          analysisReady: await photoAnalysisReady(),
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
      (match = /^\/v2\/media\/([^/]+)(?:\/(analysis|content|preparation)(?:\/([^/]+))?)?$/.exec(
        path,
      ))
    ) {
      const id = z.uuid().parse(match[1]);
      if (match[2] === 'content' && match[3] && method === 'GET') {
        const range = parseByteRange(request.headers.get('range'));
        if (range === 'invalid') return new Response(null, { status: 416, headers });
        let object;
        try {
          object = await intake.content(id, match[3], range);
        } catch (error) {
          if (!(error instanceof MediaRangeNotSatisfiable)) throw error;
          return new Response(null, {
            status: 416,
            headers: { ...headers, 'content-range': `bytes */${error.totalSize}` },
          });
        }
        return new Response(Readable.toWeb(Readable.from(object.body)) as ReadableStream, {
          status: object.partial ? 206 : 200,
          headers: {
            ...headers,
            'content-type': object.contentType,
            'content-length': String(object.byteSize),
            'accept-ranges': 'bytes',
            'x-content-type-options': 'nosniff',
            'content-disposition': match[3] === 'original' ? 'attachment' : 'inline',
            ...(object.partial
              ? { 'content-range': `bytes ${object.start}-${object.end}/${object.totalSize}` }
              : {}),
          },
        });
      }
      if (match[2] === 'analysis' && method === 'POST' && !match[3]) {
        result = await analysis.request(id, body, key);
        status = 202;
      } else if (match[2] === 'preparation' && method === 'POST' && !match[3]) {
        result = await intake.retryPreparation(id, body, key);
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
