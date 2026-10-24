import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  AppError,
  AudioAnalysis,
  AudioLibrary,
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
  resolveFeatureFlags,
  applyFeatureFlagsToCapabilities,
  type AnalysisReadiness,
  type FeatureFlagEvaluation,
  type CaptureV2Context,
  type InstallationAuthority,
  type CaptureIdentityAdapter,
  auth,
  captures,
  createServiceContext,
  agentCommands,
  schemas,
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
const { STYLE_COPY } = schemas;
import { analysisAvailability, photoAnalysisReadiness } from './model-readiness';
import { musicMatchAvailability } from './music-readiness';
import { ensureServerRuntime } from './runtime';
import { audioAssetKind, isCreateAudioUpload, readKeepAudioBody } from './audio-http';

/** Identity/P2 integration seam. Server startup must register before enabling those capabilities. */
export interface CaptureV2Runtime {
  identity?: CaptureIdentityAdapter;
  resolveNativePrincipal?: (token: string) => Promise<InstallationAuthority>;
  verifier?: CaptureV2Context['verifier'];
  storage?: MultipartStorage;
  agentAuthorization?: CaptureV2Context['agentAuthorization'];
  /** Model gateway readiness for concentrate_analysis_enabled; defaults to the gateway's read-only readiness. */
  analysisReadiness?: () => Promise<AnalysisReadiness>;
  /** Per-mode analysis admission (POST /v2/media/{id}/analysis); defaults to model-readiness.ts. */
  analysisAvailability?: CaptureV2Context['analysisAvailability'];
}
/** Server-side flag evaluation behind each HTTP context (feature-flags.json activation rules). */
const contextFlags = new WeakMap<CaptureV2Context, FeatureFlagEvaluation>();
export function captureV2ContextFlags(ctx: CaptureV2Context): FeatureFlagEvaluation | undefined {
  return contextFlags.get(ctx);
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
  prepareRuntime();
  const db = options.db ?? getDb();
  const now = new Date();
  const decoderQualified = await hasQualifiedVideoWorker(db, now, true);
  const flags = await resolveFeatureFlags(db, {
    accountId: authority.accountId,
    installationId: authority.kind === 'installation' ? authority.installationId : null,
    env: process.env,
    now,
    videoDecoderQualified: decoderQualified,
    analysisReadiness: await (runtime.analysisReadiness ?? photoAnalysisReadiness)(),
  });
  // Kill switches are enforced per media kind (fail closed): killing either
  // photo flag pauses new photo creation, either video flag pauses video.
  const killed = new Set<string>(flags.killed);
  const ctx = createCaptureV2Context({
    db,
    authority,
    storage: getCaptureV2Storage(),
    identity: runtime.identity,
    verifier: runtime.verifier,
    agent: options.agent,
    agentAuthorization: runtime.agentAuthorization,
    videoEnabled:
      decoderQualified &&
      process.env.CAPTURE_VIDEO_UPLOAD_ENABLED !== 'false' &&
      !killed.has('camera_video') &&
      !killed.has('file_video_upload'),
    mediaCreationEnabled:
      process.env.CAPTURE_MEDIA_CREATION_ENABLED !== 'false' &&
      !killed.has('camera_photo') &&
      !killed.has('file_photo_upload'),
    glassesEnabled: flags.flags.meta_glasses_capture_enabled,
    analysisAvailability: runtime.analysisAvailability ?? analysisAvailability,
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
  contextFlags.set(ctx, flags);
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
    // Agent bearer credentials use the live-authorized agent façade (REST media parity, G7).
    if (request.headers.get('authorization')?.startsWith('Bearer cat_')) {
      const { agentMediaRoute } = await import('./agent-media-http');
      return agentMediaRoute(request);
    }
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
        Number(url.searchParams.get('size')),
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
    const keepAudio = path === '/v2/media/audio' && method === 'POST';
    if (mutation && body === undefined && !keepAudio) body = await jsonBody(request);
    const key = request.headers.get('idempotency-key') ?? '';
    if (mutation && !enrollment && !z.uuid().safeParse(key).success)
      throw new AppError('invalid_input', { message: 'Idempotency-Key must be a UUID.' });
    const ctx = await createCaptureV2HttpContext(authority, { db });
    const intake = new MediaIntake(ctx),
      devices = new CaptureDevice(ctx),
      analysis = new MediaAnalysis(ctx),
      audioLibrary = new AudioLibrary(ctx),
      audioAnalysis = new AudioAnalysis(ctx);
    let result: unknown,
      status = 200,
      match: RegExpExecArray | null;
    if (path === '/v2/capabilities' && method === 'GET') {
      const evaluation = contextFlags.get(ctx)!;
      const caps = applyFeatureFlagsToCapabilities(
        evaluateCaptureCapabilities(
          {
            mediaCreationEnabled: ctx.mediaCreationEnabled,
            cameraVideoEnabled: evaluation.flags.camera_video,
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
            analysisReady: evaluation.flags.concentrate_analysis_enabled,
            agentApiEnabled: evaluation.flags.agent_api_enabled,
            sharingEnabled: evaluation.flags.collection_sharing_enabled,
          },
          ctx.limits,
        ),
        evaluation,
      );
      const readiness = await (runtime.analysisReadiness ?? photoAnalysisReadiness)();
      result = {
        ...caps,
        availability: {
          ...caps.availability,
          // Style design §D.3: an unqualified role (ANALYSIS_EXPERIMENTAL_ROLES in any
          // environment, or the non-production demo override) runs labelled in every
          // client; the kill switch experimental_analysis_enabled pauses it (D.2).
          ...(readiness.experimental
            ? {
                analysis: evaluation.killed.includes('experimental_analysis_enabled')
                  ? {
                      ...caps.availability.analysis,
                      available: false,
                      reasons: ['paused'],
                      reason: 'paused',
                      message: STYLE_COPY.style.paused,
                      experimental: true,
                      label: STYLE_COPY.experimental.badge,
                      note: STYLE_COPY.experimental.note,
                    }
                  : caps.availability.analysis.available
                    ? {
                        ...caps.availability.analysis,
                        experimental: true,
                        label: STYLE_COPY.experimental.badge,
                        note: STYLE_COPY.experimental.note,
                        reason: readiness.access === 'demo_override' ? 'demo_override' : 'experimental_production',
                      }
                    : caps.availability.analysis,
              }
            : {}),
          music_match: musicMatchAvailability({
            ELEVENLABS_API_KEY: getDomainConfig().ELEVENLABS_API_KEY,
            QLOO_API_KEY: process.env.QLOO_API_KEY,
          }),
        },
      };
    } else if (keepAudio) {
      const kept = await readKeepAudioBody(request);
      result = await audioLibrary.keepRecording(kept.meta, kept.bytes, key);
      status = 201;
    } else if (path === '/v2/uploads' && method === 'POST') {
      result = isCreateAudioUpload(body)
        ? await audioLibrary.createUpload(body, key)
        : await intake.createUpload(body, key);
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
      (match = /^\/v2\/media\/([^/]+)(?:\/(analysis|content|preparation|tracks|evidence|transcript)(?:\/([^/]+))?)?$/.exec(
        path,
      ))
    ) {
      const id = z.uuid().parse(match[1]);
      const kind = await audioAssetKind(ctx, id);
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
      if (
        (match[2] === 'tracks' || match[2] === 'evidence' || match[2] === 'transcript') &&
        method === 'GET' &&
        !match[3]
      ) {
        if (kind !== 'audio') throw new AppError('not_found');
        result =
          match[2] === 'tracks'
            ? await audioAnalysis.tracks(id)
            : match[2] === 'evidence'
              ? await audioAnalysis.evidence(id)
              : await audioAnalysis.transcript(id);
      } else if (match[2] === 'analysis' && method === 'POST' && !match[3]) {
        result =
          kind === 'audio'
            ? await audioAnalysis.request(id, body, key)
            : await analysis.request(id, body, key);
        status = 202;
      } else if (match[2] === 'preparation' && method === 'POST' && !match[3]) {
        result = await intake.retryPreparation(id, body, key);
        status = 202;
      } else if (match[2] === 'analysis' && method === 'GET' && match[3])
        result =
          kind === 'audio'
            ? await audioAnalysis.get(id, z.uuid().parse(match[3]))
            : await analysis.get(id, z.uuid().parse(match[3]));
      else if (match[2] === 'analysis' && method === 'DELETE' && match[3])
        result = await analysis.cancel(id, z.uuid().parse(match[3]), key);
      else if (!match[2] && method === 'GET')
        result = kind === 'audio' ? await audioLibrary.detail(id) : await intake.detail(id);
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
    } else if (path === '/v2/device/commands' && method === 'GET') {
      if (authority.kind !== 'installation') throw new AppError('unauthenticated');
      const query = schemas.NativeCommandQuery.parse(Object.fromEntries(url.searchParams));
      const deadline = Date.now() + query.wait * 1000;
      let batch = await agentCommands.claimCommands(ctx, query.after_sequence);
      while (!batch.items.length && Date.now() < deadline && !request.signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        batch = await agentCommands.claimCommands(ctx, query.after_sequence);
      }
      result = batch;
    } else if ((match = /^\/v2\/device\/commands\/([^/]+)\/ack$/.exec(path)) && method === 'POST') {
      if (authority.kind !== 'installation') throw new AppError('unauthenticated');
      result = await agentCommands.acknowledgeCommand(ctx, z.uuid().parse(match[1]), body, key);
    } else throw new AppError('not_found');
    return Response.json(result, { status, headers });
  } catch (error) {
    const safe = error instanceof z.ZodError ? new AppError('invalid_input') : error;
    const result = toErrorBody(safe, requestId);
    // Same rule as the /v1 handler: unexpected failures are logged by request id
    // (no request body or credentials), so an operator can find the cause.
    if (result.status >= 500 && result.body.code === 'internal')
      console.error(`[v2] ${requestId}`, error);
    const retry: Record<string, string> =
      safe instanceof AppError && safe.retryAfter ? { 'retry-after': String(safe.retryAfter) } : {};
    return Response.json(
      { error: result.body },
      { status: result.status, headers: { ...headers, ...retry } },
    );
  }
}
