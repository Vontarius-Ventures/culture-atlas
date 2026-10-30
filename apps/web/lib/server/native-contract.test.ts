/**
 * Native client contract (fixtures/native-contract). The iOS and Android unit
 * tests read the same JSON files; this test proves those files agree with the
 * server: every example message parses with the server's zod schema, the
 * enrollment signature vectors verify with the server's payload rule, the
 * policy tables cover the server's error codes and capability reasons, and a
 * full native journey (email sign-in, enrollment, refresh, upload, resume,
 * remote command acks, account switch) runs through the real HTTP handlers.
 */
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createH2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import {
  AppError,
  CAPTURE_PART_SIZE,
  ERROR_CODES,
  agentCommands,
  agentPlatform,
  auth,
  createServiceContext,
  devicePush,
  endCaptureAuthority,
  enrollmentSignaturePayload,
  evaluateCaptureCapabilities,
  identity,
  nativeSessions,
  schemas,
  setDbForTesting,
  setDomainConfigForTesting,
  NATIVE_OWNER_OPERATIONS,
  NATIVE_OWNER_V2_GRAPH_OPERATIONS,
  toErrorBody,
  type CaptureIdentityAdapter,
  type CaptureLimits,
} from '@culture-atlas/domain';
import { closeTestDb, getTestDb, testConfig, testContext } from '@culture-atlas/domain/testing';
import {
  ApnsPushDriver,
  FcmPushDriver,
  LocalMultipartStorage,
  NoopPushDriver,
} from '@culture-atlas/providers';

vi.mock('server-only', () => ({}));
const { captureV2Route, setCaptureV2Runtime } = await import('./capture-v2');
const { identityRoute } = await import('./identity-http');
const { apiRoute } = await import('./http');
const { devicePushTokenRoute } = await import('./device-push-http');

type Json = Record<string, unknown>;
const load = async <T = Json>(name: string): Promise<T> =>
  JSON.parse(
    await readFile(
      new URL(`../../../../fixtures/native-contract/${name}`, import.meta.url),
      'utf8',
    ),
  ) as T;

const contract = await load<{
  contract_version: string;
  headers: Record<string, string>;
  token_patterns: Record<string, string | number>;
  identity: {
    callbacks: Record<'ios' | 'android', string>;
    callback_fragment_keys: string[];
    terminal_sign_out_codes: string[];
  };
  routes: Record<string, { route: string; server: 'routed' | 'domain_only' }>;
  uploads: { max_part_numbers_per_parts_request: number };
  commands: { required_status_capability_keys: string[] };
}>('contract.json');
const messages = (
  await load<{
    messages: Record<
      string,
      { direction: string; route: string; schema: string | null; body: Json }
    >;
  }>('messages.json')
).messages;
const signature = await load<{
  payload_prefix: string;
  public_key: Json;
  public_key_x963_base64url: string;
  vectors: {
    name: string;
    nonce: string;
    installation_public_id: string;
    platform: 'ios' | 'android';
    enrollment_grant: string | null;
    grant_sha256_hex: string;
    payload_utf8: string;
    signature_der_hex: string;
    signature_p1363_base64url: string;
  }[];
  der_conversion: { name: string; der_hex: string; p1363_hex: string }[];
}>('enrollment-signature.json');
const uploads = await load<{
  server_part_size: number;
  plans: {
    name: string;
    byte_size: number;
    part_size: number;
    parts: [number, number, number][];
  }[];
  max_video: {
    byte_size: number;
    part_size: number;
    part_count: number;
    last_part: [number, number, number];
  };
  parts_request_batches: {
    name: string;
    missing?: number[];
    missing_range?: [number, number];
    max_per_request: number;
    batches?: number[][];
    batch_ranges?: [number, number][];
  }[];
  resume: {
    name: string;
    part_count: number;
    server_verified: Receipt[];
    local_receipts: Receipt[];
    missing: number[];
    complete_after_sending: Receipt[];
  }[];
}>('upload-parts.json');
const commandFixture = await load<{
  server_accepted_sequences: {
    name: string;
    acks: { sequence: number; state: string; safe_error?: string; with_result_asset?: boolean }[];
    final_state: string;
  }[];
  decisions: {
    name: string;
    expect: { acks: { state: string; safe_error?: string; result_asset_id?: string }[] };
  }[];
  outcomes: { outcome: string; ack: { state: string; safe_error?: string } }[];
}>('command-lifecycle.json');
const errorPolicy = await load<{
  codes: { code: string; status: number; action: string }[];
  switch_endpoint_terminal_codes: string[];
}>('error-policy.json');
const gate = await load<{
  distribution_reasons: string[];
  local_reasons: string[];
  cases: {
    name: string;
    server: { reasons: string[] };
    expect: { state: string; reasons: string[] };
  }[];
}>('capability-gate.json');
const draftLock = await load<{ server_responses: { error_code?: string }[] }>('draft-lock.json');

type Receipt = { part_number: number; etag: string };

/** Reference implementations of the pure native rules, mirrored in Swift and Kotlin. */
const reference = {
  planParts(byteSize: number, partSize: number): [number, number, number][] {
    const out: [number, number, number][] = [];
    for (let offset = 0, n = 1; offset < byteSize; offset += partSize, n++)
      out.push([n, offset, Math.min(partSize, byteSize - offset)]);
    return out;
  },
  batches(missing: number[], max: number): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < missing.length; i += max) out.push(missing.slice(i, i + max));
    return out;
  },
  mergeReceipts(server: Receipt[], local: Receipt[]): Map<number, string> {
    const merged = new Map<number, string>();
    for (const r of local) merged.set(r.part_number, r.etag);
    for (const r of server) merged.set(r.part_number, r.etag);
    return merged;
  },
  derToP1363(der: Buffer): Buffer {
    if (der[0] !== 0x30) throw new Error('not a DER sequence');
    let i = 2;
    const integer = () => {
      if (der[i] !== 0x02) throw new Error('not a DER integer');
      const length = der[i + 1]!;
      let value = der.subarray(i + 2, i + 2 + length);
      i += 2 + length;
      while (value.length > 32 && value[0] === 0) value = value.subarray(1);
      if (value.length > 32) throw new Error('integer too large');
      const out = Buffer.alloc(32);
      value.copy(out, 32 - value.length);
      return out;
    };
    return Buffer.concat([integer(), integer()]);
  },
  payload(v: {
    nonce: string;
    installation_public_id: string;
    platform: string;
    enrollment_grant: string | null;
  }): string {
    const grantHash = createHash('sha256')
      .update(v.enrollment_grant ?? '')
      .digest('hex');
    return [
      signature.payload_prefix,
      v.nonce,
      v.installation_public_id,
      v.platform,
      grantHash,
    ].join('\n');
  },
  blockingReasons(server: string[]): string[] {
    return server.filter((r) => gate.distribution_reasons.includes(r));
  },
};

function resolveSchema(name: string): z.ZodType {
  const [root, ...path] = name.split('.');
  let target: unknown =
    root === 'schemas'
      ? schemas
      : root === 'identity'
        ? identity
        : root === 'devicePush'
          ? devicePush
          : undefined;
  for (const key of path) target = (target as Record<string, unknown> | undefined)?.[key];
  if (!target || typeof (target as z.ZodType).safeParse !== 'function')
    throw new Error(`Unknown schema ${name}`);
  return target as z.ZodType;
}

/** Same keys and JSON value kinds, recursively. Array element shapes are compared where needed. */
function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Json)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, shapeOf(v)]),
    );
  return typeof value;
}

describe('native contract fixtures (static)', () => {
  it('pins the server contract version, routes and part size', () => {
    expect(contract.contract_version).toBe(schemas.CAPTURE_V2_CONTRACT_VERSION);
    const routed = new Set(Object.values(schemas.CAPTURE_V2_ROUTES));
    for (const [name, entry] of Object.entries(contract.routes)) {
      if (entry.server === 'routed') expect(routed.has(entry.route as never), name).toBe(true);
      else
        expect(routed.has(entry.route as never), `${name} is now routed; mark it routed`).toBe(
          false,
        );
    }
    expect(uploads.server_part_size).toBe(CAPTURE_PART_SIZE);
    expect(contract.commands.required_status_capability_keys).toEqual(['photo', 'video']);
  });

  it('parses every example message with its server schema', () => {
    const checked: string[] = [];
    for (const [name, message] of Object.entries(messages)) {
      if (!message.schema) continue;
      const result = resolveSchema(message.schema).safeParse(message.body);
      expect(result.success, `${name}: ${result.error?.message}`).toBe(true);
      checked.push(name);
    }
    expect(checked.length).toBeGreaterThanOrEqual(25);
  });

  it('keeps example credentials in the documented token formats', () => {
    const p = contract.token_patterns as Record<string, string>;
    const enroll = messages.enroll_response!.body.native_session as Json;
    expect(enroll.access_token).toMatch(new RegExp(p.access_token!));
    expect(enroll.refresh_token).toMatch(new RegExp(p.refresh_token!));
    expect(messages.email_complete_native_response!.body.enrollment_grant).toMatch(
      new RegExp(p.enrollment_grant!),
    );
    expect(messages.refresh_request!.body.refresh_request_id).toMatch(
      new RegExp(p.refresh_request_id!),
    );
    expect(messages.email_complete_request!.body.code_verifier).toMatch(
      new RegExp(p.pkce_code_verifier!),
    );
    expect(messages.email_start_ios!.body.code_challenge).toMatch(
      new RegExp(p.pkce_code_challenge!),
    );
  });

  it('enrollment signature vectors match the server payload rule and verify', () => {
    const publicKey = createPublicKey({ key: signature.public_key as never, format: 'jwk' });
    const x963 = Buffer.from(signature.public_key_x963_base64url, 'base64url');
    expect(x963[0]).toBe(4);
    expect(x963.subarray(1, 33).toString('base64url')).toBe(signature.public_key.x);
    expect(x963.subarray(33).toString('base64url')).toBe(signature.public_key.y);
    for (const v of signature.vectors) {
      const serverPayload = enrollmentSignaturePayload(
        v.nonce,
        v.installation_public_id,
        v.platform,
        v.enrollment_grant ?? undefined,
      );
      expect(serverPayload, v.name).toBe(v.payload_utf8);
      expect(reference.payload(v), v.name).toBe(v.payload_utf8);
      expect(
        createHash('sha256')
          .update(v.enrollment_grant ?? '')
          .digest('hex'),
      ).toBe(v.grant_sha256_hex);
      const raw = Buffer.from(v.signature_p1363_base64url, 'base64url');
      expect(v.signature_p1363_base64url).toMatch(/^[A-Za-z0-9_-]{86}$/);
      expect(
        verify(
          'sha256',
          Buffer.from(v.payload_utf8),
          { key: publicKey, dsaEncoding: 'ieee-p1363' },
          raw,
        ),
        v.name,
      ).toBe(true);
      const der = Buffer.from(v.signature_der_hex, 'hex');
      expect(
        verify('sha256', Buffer.from(v.payload_utf8), { key: publicKey, dsaEncoding: 'der' }, der),
        v.name,
      ).toBe(true);
      expect(reference.derToP1363(der).equals(raw), v.name).toBe(true);
      // The server schema accepts exactly this encoding.
      expect(
        schemas.EnrollCaptureDeviceRequest.safeParse({
          platform: v.platform,
          app_version: '1.0.0',
          installation_public_id: v.installation_public_id,
          proof: {
            nonce: v.nonce,
            signature: v.signature_p1363_base64url,
            public_key: signature.public_key,
          },
          ...(v.enrollment_grant ? { enrollment_grant: v.enrollment_grant } : {}),
        }).success,
      ).toBe(true);
    }
    for (const c of signature.der_conversion)
      expect(reference.derToP1363(Buffer.from(c.der_hex, 'hex')).toString('hex'), c.name).toBe(
        c.p1363_hex,
      );
  });

  it('part plans, batches and resume merges are internally consistent', () => {
    for (const plan of uploads.plans)
      expect(reference.planParts(plan.byte_size, plan.part_size), plan.name).toEqual(plan.parts);
    const max = reference.planParts(uploads.max_video.byte_size, uploads.max_video.part_size);
    expect(max).toHaveLength(uploads.max_video.part_count);
    expect(max.at(-1)).toEqual(uploads.max_video.last_part);
    expect(uploads.max_video.byte_size).toBe(
      schemas.CreateMediaUploadRequest.shape.byte_size.maxValue,
    );
    for (const b of uploads.parts_request_batches) {
      const missing =
        b.missing ??
        Array.from(
          { length: b.missing_range![1] - b.missing_range![0] + 1 },
          (_, i) => b.missing_range![0] + i,
        );
      const batches = reference.batches(missing, b.max_per_request);
      if (b.batches) expect(batches).toEqual(b.batches);
      else expect(batches.map((x) => [x[0], x.at(-1)])).toEqual(b.batch_ranges);
      for (const batch of batches)
        expect(schemas.UploadPartsRequest.safeParse({ part_numbers: batch }).success).toBe(true);
    }
    expect(uploads.parts_request_batches[0]!.max_per_request).toBe(
      contract.uploads.max_part_numbers_per_parts_request,
    );
    for (const r of uploads.resume) {
      const merged = reference.mergeReceipts(r.server_verified, r.local_receipts);
      const missing = Array.from({ length: r.part_count }, (_, i) => i + 1).filter(
        (n) => !merged.has(n),
      );
      expect(missing, r.name).toEqual(r.missing);
      for (const n of missing) merged.set(n, `"new${n}"`);
      const complete = [...merged.entries()]
        .sort(([a], [b]) => a - b)
        .map(([part_number, etag]) => ({ part_number, etag }));
      expect(complete, r.name).toEqual(r.complete_after_sending);
      expect(schemas.CompleteMediaUploadRequest.safeParse({ parts: complete }).success).toBe(true);
    }
  });

  it('error policy covers exactly the server error codes with matching HTTP status', () => {
    const fixtureCodes = new Map(errorPolicy.codes.map((c) => [c.code, c]));
    for (const [code, status] of Object.entries(ERROR_CODES)) {
      if (
        code === 'unsupported_image' ||
        code === 'revision_conflict' ||
        code === 'precondition_failed' ||
        code === 'precondition_required' ||
        code === 'not_implemented'
      )
        continue;
      expect(fixtureCodes.get(code)?.status, `error-policy.json is missing ${code}`).toBe(status);
    }
    for (const c of errorPolicy.codes)
      expect(ERROR_CODES[c.code as keyof typeof ERROR_CODES], c.code).toBe(c.status);
    expect(errorPolicy.switch_endpoint_terminal_codes).toEqual(
      contract.identity.terminal_sign_out_codes,
    );
    for (const r of draftLock.server_responses)
      if (r.error_code) expect(ERROR_CODES).toHaveProperty(r.error_code);
  });

  it('capability reasons partition the server reasons into distribution and local', () => {
    const limits = {
      photoMaxBytes: 1,
      photoMaxPixels: 1,
      videoMaxBytes: 1,
      videoMaxDurationMs: 1,
      captureVideoMaxDurationMs: 1,
      accountQuotaBytes: 1,
      derivativeAllowanceBytes: 1,
    } as CaptureLimits;
    const blocked = evaluateCaptureCapabilities(
      {
        mediaCreationEnabled: true,
        cameraVideoEnabled: true,
        videoDecoderQualified: true,
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
      limits,
    );
    const all = blocked.availability.meta_glasses!.reasons;
    expect([...all].sort()).toEqual([...gate.distribution_reasons, ...gate.local_reasons].sort());
    const today = gate.cases.find((c) => c.name === 'today_server_default_lists_every_reason')!;
    expect(today.server.reasons).toEqual(all);
    for (const c of gate.cases)
      if (c.expect.state === 'unavailable')
        expect(reference.blockingReasons(c.server.reasons), c.name).toEqual(c.expect.reasons);
    expect(Object.keys(blocked.flags).sort()).toEqual(
      Object.keys(messages.capabilities_response!.body.flags as Json).sort(),
    );
  });

  it('every ack a native decision or outcome can send is a valid server CommandAck', () => {
    let sequence = 1;
    const acks = [
      ...commandFixture.decisions.flatMap((d) => d.expect.acks),
      ...commandFixture.outcomes.map((o) => o.ack),
      ...commandFixture.server_accepted_sequences.flatMap((s) => s.acks),
    ];
    for (const ack of acks) {
      const { with_result_asset: _ignored, ...body } = ack as Json & {
        with_result_asset?: boolean;
      };
      expect(
        schemas.CommandAck.safeParse({ sequence: (body.sequence as number) ?? sequence++, ...body })
          .success,
        JSON.stringify(ack),
      ).toBe(true);
    }
  });
});

const db = getTestDb();
const outbox = new identity.DevIdentityOutbox();
let root: string, storage: LocalMultipartStorage;
let ipCounter = 0;
const identityAdapter: CaptureIdentityAdapter = {
  requireRecoverableAccount: async (accountId, sessionId) => {
    await identity.requireRecoverableAccount(
      createServiceContext({ kind: 'account', accountId, sessionId, isDemoOwner: false }, { db }),
    );
  },
  consumeNativeEnrollmentGrant: (tx, token, platform, now) =>
    nativeSessions.consumeNativeEnrollmentGrant(tx, token, platform, now),
  peekNativeEnrollmentGrant: (tx, token, platform, now) =>
    nativeSessions.peekNativeEnrollmentGrant(tx, token, platform, now),
  issueNativeSession: async (tx, input, now) => ({
    ...(await nativeSessions.issueNativeSession(tx, input, now)),
  }),
  revokeInstallationSessions: (tx, accountId, installationId, now) =>
    nativeSessions.revokeInstallationSessions(tx, accountId, installationId, now),
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-native-contract-'));
  storage = new LocalMultipartStorage(root, 'http://localhost:3399', 'native-contract-test-key');
  setDbForTesting(db);
  // The operator has opted in to agent remote capture (default off) for the command journey.
  setDomainConfigForTesting(
    testConfig({
      AGENT_REMOTE_CAPTURE_ENABLED: 'true',
      // Push token registration (ready notices) encrypts tokens at rest.
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    }),
  );
  identity.setIdentityMail(outbox);
  nativeSessions.setAuthorityLifecycle(endCaptureAuthority);
  setCaptureV2Runtime({
    storage,
    identity: identityAdapter,
    resolveNativePrincipal: async (token) => {
      const principal = await nativeSessions.resolveNativePrincipal(db, token);
      return { ...principal, kind: 'installation' };
    },
  });
});
afterAll(async () => {
  setCaptureV2Runtime({});
  nativeSessions.setAuthorityLifecycle(undefined);
  identity.setIdentityMail(undefined);
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});

/** A simulated phone: the same request rules the Swift/Kotlin API clients follow. */
class Phone {
  readonly installationPublicId = randomUUID();
  readonly key: { privateKey: KeyObject; publicKey: KeyObject } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  readonly ip = `198.51.100.${++ipCounter}`;
  accountId = '';
  installationId = '';
  access = '';
  refresh = '';
  statusSequence = 0;
  constructor(readonly platform: 'ios' | 'android') {}

  jwk() {
    const { x, y } = this.key.publicKey.export({ format: 'jwk' });
    return { kty: 'EC', crv: 'P-256', x, y };
  }
  identityRequest(path: string, body: unknown, authorization?: string) {
    return identityRoute(
      new NextRequest(`http://localhost:3399/v2/identity/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': this.ip,
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(body),
      }),
      path,
    );
  }
  /** Every /v2 call: bearer, Idempotency-Key and the expected (draft owner) account on mutations. */
  api(
    method: string,
    path: string,
    body?: unknown,
    opts: { expectedAccount?: string; bearer?: string; noAuth?: boolean } = {},
  ) {
    const mutation = method !== 'GET';
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip };
    if (!opts.noAuth) headers.authorization = `Bearer ${opts.bearer ?? this.access}`;
    if (mutation) {
      headers[contract.headers.idempotency_key!.toLowerCase()] = randomUUID();
      headers[contract.headers.expected_account!.toLowerCase()] =
        opts.expectedAccount ?? this.accountId;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    return captureV2Route(
      new NextRequest(`http://localhost:3399${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  }

  async signIn(email: string) {
    const verifier = randomBytes(32).toString('base64url');
    const start = {
      email,
      purpose: 'sign_in',
      destination: this.platform,
      state: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
    expect(identity.EmailStart.safeParse(start).success).toBe(true);
    const started = await this.identityRequest('email/start', start);
    expect(started.status).toBe(200);
    expect(shapeOf(await started.json())).toEqual(shapeOf(messages.email_start_response!.body));
    const callback = new URL(outbox.messages.at(-1)!.callback);
    expect(`${callback.protocol}//${callback.host}${callback.pathname}`).toBe(
      contract.identity.callbacks[this.platform],
    );
    const fragment = new URLSearchParams(callback.hash.slice(1));
    expect([...fragment.keys()].sort()).toEqual(
      [...contract.identity.callback_fragment_keys].sort(),
    );
    // The app checks state/nonce from the fragment against what it persisted.
    expect(fragment.get('state')).toBe(start.state);
    expect(fragment.get('nonce')).toBe(start.nonce);
    const complete = {
      challenge_id: fragment.get('challenge_id'),
      token: fragment.get('token'),
      state: start.state,
      nonce: start.nonce,
      code_verifier: verifier,
    };
    expect(identity.EmailComplete.safeParse(complete).success).toBe(true);
    const completed = await this.identityRequest('email/complete', complete);
    expect(completed.status).toBe(200);
    const body = (await completed.json()) as {
      account_id: string;
      enrollment_grant: string;
      platform: string;
    };
    expect(shapeOf(body)).toEqual(shapeOf(messages.email_complete_native_response!.body));
    expect(body.enrollment_grant).toMatch(
      new RegExp(contract.token_patterns.enrollment_grant as string),
    );
    expect(body.platform).toBe(this.platform);
    return body;
  }

  async enroll(grant: { account_id: string; enrollment_grant: string }) {
    const challengeBody = {
      enrollment_grant: grant.enrollment_grant,
      installation_public_id: this.installationPublicId,
      platform: this.platform,
      public_key: this.jwk(),
    };
    const challenge = await this.api('POST', '/v2/devices/enrollment/challenge', challengeBody, {
      noAuth: true,
      expectedAccount: grant.account_id,
    });
    expect(challenge.status).toBe(201);
    const { nonce, ...rest } = (await challenge.json()) as { nonce: string; expires_at: string };
    expect(shapeOf({ nonce, ...rest })).toEqual(
      shapeOf(messages.enrollment_challenge_response!.body),
    );
    const payload = reference.payload({
      nonce,
      installation_public_id: this.installationPublicId,
      platform: this.platform,
      enrollment_grant: grant.enrollment_grant,
    });
    const signatureValue = sign('sha256', Buffer.from(payload), {
      key: this.key.privateKey,
      dsaEncoding: 'der',
    });
    const enrollBody = {
      platform: this.platform,
      app_version: '1.0.0 (1)',
      installation_public_id: this.installationPublicId,
      enrollment_grant: grant.enrollment_grant,
      proof: {
        nonce,
        signature: reference.derToP1363(signatureValue).toString('base64url'),
        public_key: this.jwk(),
      },
      capabilities: { photo: true, video: true, meta_glasses_sdk: false },
    };
    const enrolled = await this.api('POST', '/v2/devices/enroll', enrollBody, {
      noAuth: true,
      expectedAccount: grant.account_id,
    });
    const json = (await enrolled.json()) as z.infer<typeof schemas.EnrolledCaptureDeviceResponse>;
    expect(enrolled.status, JSON.stringify(json)).toBe(201);
    expect(schemas.EnrolledCaptureDeviceResponse.safeParse(json).success).toBe(true);
    expect(shapeOf(json)).toEqual(shapeOf(messages.enroll_response!.body));
    expect(json.native_session.account_id).toBe(grant.account_id);
    expect(json.native_session.access_token).toMatch(
      new RegExp(contract.token_patterns.access_token as string),
    );
    expect(json.native_session.refresh_token).toMatch(
      new RegExp(contract.token_patterns.refresh_token as string),
    );
    this.accountId = grant.account_id;
    this.installationId = json.installation.id;
    this.access = json.native_session.access_token;
    this.refresh = json.native_session.refresh_token;
    return json;
  }

  async heartbeat(readiness: 'ready' | 'unavailable' = 'ready') {
    const body = {
      sequence: ++this.statusSequence,
      capabilities: { photo: true, video: true, microphone: false },
      readiness,
      app_state: 'foreground',
    };
    expect(schemas.DeviceStatusRequest.safeParse(body).success).toBe(true);
    const response = await this.api('PUT', '/v2/device/status', body);
    expect(response.status, await response.clone().text()).toBe(200);
    const accepted = await response.json();
    expect(shapeOf(accepted)).toEqual(shapeOf(messages.device_status_response!.body));
    expect(accepted.accepted_sequence).toBe(this.statusSequence);
  }
}

const jpegBytes = (size: number, seed: number) => {
  const out = Buffer.alloc(size, seed);
  out[0] = 0xff;
  out[1] = 0xd8;
  return out;
};

async function putPart(
  instruction: { url: string; method: string; headers: Record<string, string> },
  bytes: Buffer,
) {
  const url = new URL(instruction.url);
  const response = await captureV2Route(
    new NextRequest(`http://localhost:3399${url.pathname}${url.search}`, {
      method: instruction.method,
      headers: instruction.headers,
      body: bytes,
      duplex: 'half',
    } as ConstructorParameters<typeof NextRequest>[1]),
  );
  expect(response.status).toBe(200);
  const etag = response.headers.get(contract.headers.etag!);
  expect(etag).toBeTruthy();
  return etag!;
}

describe('native journey through the real handlers', () => {
  it('signs in, enrolls with a P-256 proof, refreshes with lost-response retry and heartbeats', async () => {
    const phone = new Phone('ios');
    await phone.enroll(await phone.signIn(`${randomUUID()}@example.test`));
    await phone.heartbeat();

    const requestId = randomBytes(32).toString('base64url');
    expect(requestId).toMatch(new RegExp(contract.token_patterns.refresh_request_id as string));
    const refreshBody = {
      refresh_token: phone.refresh,
      installation_id: phone.installationId,
      refresh_request_id: requestId,
    };
    expect(shapeOf(refreshBody)).toEqual(shapeOf(messages.refresh_request!.body));
    const first = await phone.identityRequest('native/refresh', refreshBody);
    expect(first.status).toBe(200);
    const firstPair = (await first.json()) as Json;
    expect(shapeOf(firstPair)).toEqual(shapeOf(messages.native_session_tokens!.body));
    // error-policy.json refresh 'lost_response_retries_same_id': same token + same id inside the window.
    const retried = await phone.identityRequest('native/refresh', refreshBody);
    expect(retried.status).toBe(200);
    const pair = (await retried.json()) as { access_token: string; refresh_token: string };
    expect(pair.access_token).not.toBe(firstPair.access_token);
    phone.access = pair.access_token;
    phone.refresh = pair.refresh_token;
    // The unseen successor from the lost response no longer works.
    expect(
      (
        await phone.api('GET', '/v2/capabilities', undefined, {
          bearer: firstPair.access_token as string,
        })
      ).status,
    ).toBe(401);
    const caps = await phone.api('GET', '/v2/capabilities');
    expect(caps.status).toBe(200);
    const capabilities = await caps.json();
    expect(schemas.CaptureCapabilitiesResponse.safeParse(capabilities).success).toBe(true);
    expect(shapeOf(capabilities)).toEqual(shapeOf(messages.capabilities_response!.body));
    // Server-side flag evaluation (feature-flags.ts) for a freshly heartbeated
    // phone whose build is not an operator-qualified SDK build.
    expect(capabilities.availability.meta_glasses.reasons).toEqual(
      gate.cases.find((c) => c.name === 'enrolled_phone_server_flags_without_qualified_sdk')!.server
        .reasons,
    );
  });

  it('uploads a draft in parts, resumes from server receipts and never duplicates on retry', async () => {
    const phone = new Phone('android');
    await phone.enroll(await phone.signIn(`${randomUUID()}@example.test`));
    const bytes = jpegBytes(CAPTURE_PART_SIZE + 4096, 7);
    const create = {
      client_capture_id: randomUUID(),
      kind: 'photo',
      source: 'phone_camera',
      filename: 'IMG_0002.jpg',
      content_type: 'image/jpeg',
      byte_size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      captured_at: new Date().toISOString(),
    };
    expect(schemas.CreateMediaUploadRequest.safeParse(create).success).toBe(true);
    const created = await phone.api('POST', '/v2/uploads', create);
    expect(created.status).toBe(201);
    const upload = schemas.MediaUploadResponse.parse(await created.json());
    expect(shapeOf({ ...upload, parts: upload.parts.slice(0, 1) })).toEqual(
      shapeOf(messages.upload_response!.body),
    );
    const plan = reference.planParts(create.byte_size, upload.part_size);
    expect(plan).toHaveLength(upload.part_count);

    // Part 1, then the app is killed before saving the receipt.
    const [n1, o1, l1] = plan[0]!;
    await putPart(
      upload.parts.find((p) => p.part_number === n1)!,
      bytes.subarray(o1, o1 + l1),
    );

    // Relaunch: a retried create with the persisted client_capture_id returns the same upload.
    const again = schemas.MediaUploadResponse.parse(
      await (await phone.api('POST', '/v2/uploads', create)).json(),
    );
    expect(again.upload_id).toBe(upload.upload_id);
    expect(again.asset_id).toBe(upload.asset_id);
    // Resume asks the server first.
    const status = schemas.MediaUploadResponse.parse(
      await (await phone.api('GET', `/v2/uploads/${upload.upload_id}`)).json(),
    );
    const merged = reference.mergeReceipts(status.verified_parts, []);
    const missing = plan.map(([n]) => n).filter((n) => !merged.has(n));
    expect(missing).toEqual([2]);
    const partsBody = { part_numbers: missing };
    expect(shapeOf(partsBody)).toEqual(shapeOf(messages.upload_parts_request!.body));
    const fresh = await phone.api('POST', `/v2/uploads/${upload.upload_id}/parts`, partsBody);
    expect(fresh.status).toBe(200);
    const freshBody = (await fresh.json()) as {
      parts: z.infer<typeof schemas.UploadPartInstruction>[];
    };
    expect(shapeOf(freshBody)).toEqual(shapeOf(messages.upload_parts_response!.body));
    const examplePart = (messages.upload_parts_response!.body.parts as Json[])[0];
    expect(shapeOf(freshBody.parts[0])).toEqual(shapeOf(examplePart));
    expect(shapeOf(upload.parts[0])).toEqual(shapeOf(examplePart));
    for (const n of missing) {
      const [, offset, length] = plan[n - 1]!;
      merged.set(
        n,
        await putPart(
          freshBody.parts.find((p) => p.part_number === n)!,
          bytes.subarray(offset, offset + length),
        ),
      );
    }
    const completeBody = {
      parts: [...merged.entries()]
        .sort(([a], [b]) => a - b)
        .map(([part_number, etag]) => ({ part_number, etag })),
    };
    const done = await phone.api('POST', `/v2/uploads/${upload.upload_id}/complete`, completeBody);
    expect(done.status).toBe(202);
    expect(schemas.MediaUploadResponse.parse(await done.json()).state).toBe('verifying');
    // A lost complete response: the retry reports the same state and creates nothing new.
    const replay = await phone.api(
      'POST',
      `/v2/uploads/${upload.upload_id}/complete`,
      completeBody,
    );
    expect([200, 202]).toContain(replay.status);
    const assets = await db.query(
      'SELECT count(*)::int AS n FROM media_assets WHERE account_id=$1 AND client_capture_id=$2',
      [phone.accountId, create.client_capture_id],
    );
    expect(assets.rows[0]!.n).toBe(1);
  });

  it('runs every server-accepted command ack sequence from the fixture against an armed phone', async () => {
    const phone = new Phone('ios');
    await phone.enroll(await phone.signIn(`${randomUUID()}@example.test`));
    const owner = testContext({
      kind: 'account',
      accountId: phone.accountId,
      sessionId: null,
      isDemoOwner: false,
    });
    const connection = await agentPlatform.createConnection(owner, {
      client_name: 'Contract agent',
      scopes: ['devices:command', 'setup:read'],
      installation_ids: [phone.installationId],
    });
    const agent = testContext(
      (await auth.resolvePrincipal(db, { authorization: `Bearer ${connection.credential}` }))!,
      { config: testConfig({ AGENT_REMOTE_CAPTURE_ENABLED: 'true' }) },
    );
    const sessionResponse = await phone.api('POST', '/v2/device/capture-sessions', {
      source: 'phone_camera',
      mode: 'photo',
      local_session_id: randomUUID(),
    });
    expect(sessionResponse.status).toBe(201);
    const session = schemas.CaptureSessionResponse.parse(await sessionResponse.json());
    // The server only arms a phone that reported a ready, foreground camera (see the app's arming flow).
    await phone.heartbeat();
    const arm = {
      enabled: true,
      duration_seconds: 600,
      allowed_agent_connection_ids: [connection.connection.id],
    };
    expect(schemas.ArmCaptureSessionRequest.safeParse(arm).success).toBe(true);
    const armed = await phone.api(
      'POST',
      `/v2/device/capture-sessions/${session.session_id}/arm`,
      arm,
    );
    expect(armed.status, await armed.clone().text()).toBe(200);
    const phoneCtx = {
      db,
      authority: {
        kind: 'installation' as const,
        accountId: phone.accountId,
        installationId: phone.installationId,
        sessionId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      now: () => new Date(),
    };
    let afterSequence = 0;
    for (const scenario of commandFixture.server_accepted_sequences) {
      await phone.heartbeat();
      const command = await agentCommands.requestCapture(
        agent,
        phone.installationId,
        {
          session_id: session.session_id,
          generation: session.generation,
          action: 'capture_photo',
          capture_client_id: randomUUID(),
        },
        randomUUID(),
      );
      const batch = await agentCommands.claimCommands(phoneCtx, afterSequence);
      expect(
        schemas.NativeCommandBatch.safeParse({
          schema_version: '2.1',
          request_id: randomUUID(),
          ...batch,
        }).success,
      ).toBe(true);
      const delivered = batch.items.find((i) => i.command_id === command.command_id)!;
      expect(delivered, scenario.name).toBeTruthy();
      expect(shapeOf(delivered)).toEqual(
        shapeOf((messages.native_command_batch!.body.items as Json[])[0]),
      );
      afterSequence = batch.next_sequence;
      let resultAsset: string | undefined;
      for (const ack of scenario.acks) {
        if (ack.with_result_asset) {
          // The capture is durably on the phone; create its upload in this session to get the asset id.
          const bytes = jpegBytes(2048, 3);
          const created = await phone.api('POST', '/v2/uploads', {
            client_capture_id: delivered.capture_client_id,
            kind: 'photo',
            source: 'phone_camera',
            filename: 'remote.jpg',
            content_type: 'image/jpeg',
            byte_size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            capture_session_id: session.session_id,
          });
          expect(created.status, await created.clone().text()).toBe(201);
          resultAsset = (await created.json()).asset_id;
        }
        const body = {
          sequence: ack.sequence,
          state: ack.state,
          ...(ack.safe_error ? { safe_error: ack.safe_error } : {}),
          ...(ack.with_result_asset ? { result_asset_id: resultAsset } : {}),
        };
        expect(schemas.CommandAck.safeParse(body).success).toBe(true);
        await agentCommands.acknowledgeCommand(phoneCtx, command.command_id, body, randomUUID());
      }
      const final = await agentCommands.getCommand(owner, command.command_id);
      expect(final.state, scenario.name).toBe(scenario.final_state);
      if (resultAsset) expect(final.result_asset_id).toBe(resultAsset);
    }
  });

  it('TEN-02: switching accounts locks pending bytes to the original account until it signs back in', async () => {
    const email = `${randomUUID()}@example.test`;
    const phone = new Phone('ios');
    await phone.enroll(await phone.signIn(email));
    const accountA = phone.accountId;
    const bytes = jpegBytes(4096, 9);
    const create = {
      client_capture_id: randomUUID(),
      kind: 'photo',
      source: 'phone_camera',
      filename: 'draft.jpg',
      content_type: 'image/jpeg',
      byte_size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const upload = schemas.MediaUploadResponse.parse(
      await (await phone.api('POST', '/v2/uploads', create)).json(),
    );

    // Sign-out order (draft-lock.json): ... call_identity_switch, then clear credentials.
    const bearer = `Bearer ${phone.access}`;
    const switched = await phone.identityRequest('switch', {}, bearer);
    expect(switched.status).toBe(200);
    expect(shapeOf(await switched.json())).toEqual(shapeOf(messages.switch_response!.body));
    const retry = await phone.identityRequest('switch', {}, bearer);
    expect(retry.status).toBe(401);
    expect(contract.identity.terminal_sign_out_codes).toContain((await retry.json()).error.code);
    const oldAccess = phone.access;

    // Account B signs in on the same phone with a new installation identity.
    const other = new Phone('ios');
    await other.enroll(await other.signIn(`${randomUUID()}@example.test`));
    // The old credential cannot continue the draft.
    expect(
      (await phone.api('GET', `/v2/uploads/${upload.upload_id}`, undefined, { bearer: oldAccess }))
        .status,
    ).toBe(401);
    // B's credential with the draft owner's account asserted is refused before any effect.
    const mismatch = await other.api(
      'POST',
      `/v2/uploads/${upload.upload_id}/parts`,
      { part_numbers: [1] },
      { expectedAccount: accountA },
    );
    expect(mismatch.status).toBe(409);
    const mismatchBody = await mismatch.json();
    expect(schemas.CaptureV2Error.safeParse(mismatchBody).success).toBe(true);
    expect(mismatchBody.error.code).toBe('account_mismatch');
    expect(errorPolicy.codes.find((c) => c.code === 'account_mismatch')!.action).toBe(
      'lock_to_original_account',
    );
    // Guessing the id under B's own account reveals nothing.
    expect((await other.api('GET', `/v2/uploads/${upload.upload_id}`)).status).toBe(404);

    // A signs back in and reactivates the SAME installation key: the paused upload resumes.
    const paused = await db.query('SELECT state,pause_reason FROM upload_sessions WHERE id=$1', [
      upload.upload_id,
    ]);
    expect(paused.rows[0]).toMatchObject({ state: 'paused', pause_reason: 'authority_ended' });
    await phone.enroll(await phone.signIn(email));
    expect(phone.accountId).toBe(accountA);
    const resumed = schemas.MediaUploadResponse.parse(
      await (await phone.api('GET', `/v2/uploads/${upload.upload_id}`)).json(),
    );
    expect(['created', 'uploading']).toContain(resumed.state);
    expect(resumed.pause_reason).toBeNull();
    const parts = await phone.api('POST', `/v2/uploads/${upload.upload_id}/parts`, {
      part_numbers: [1],
    });
    expect(parts.status).toBe(200);
  });

  it('rejects a reused installation proof and a signature over a different payload', async () => {
    const phone = new Phone('android');
    const grant = await phone.signIn(`${randomUUID()}@example.test`);
    const challenge = await phone.api(
      'POST',
      '/v2/devices/enrollment/challenge',
      {
        enrollment_grant: grant.enrollment_grant,
        installation_public_id: phone.installationPublicId,
        platform: 'android',
        public_key: phone.jwk(),
      },
      { noAuth: true, expectedAccount: grant.account_id },
    );
    const { nonce } = (await challenge.json()) as { nonce: string };
    const wrongPayload = reference.payload({
      nonce,
      installation_public_id: phone.installationPublicId,
      platform: 'ios',
      enrollment_grant: grant.enrollment_grant,
    });
    const bad = sign('sha256', Buffer.from(wrongPayload), {
      key: phone.key.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    const response = await phone.api(
      'POST',
      '/v2/devices/enroll',
      {
        platform: 'android',
        app_version: '1.0.0 (1)',
        installation_public_id: phone.installationPublicId,
        enrollment_grant: grant.enrollment_grant,
        proof: { nonce, signature: bad.toString('base64url'), public_key: phone.jwk() },
      },
      { noAuth: true, expectedAccount: grant.account_id },
    );
    expect(response.status).toBe(401);
    expect(new AppError('unauthenticated').code).toBe((await response.json()).error.code);
  });

  it('signs the installation id exactly as the body carries it (wire UUIDs are lowercase)', async () => {
    expect((contract as unknown as { wire_uuid_case: string }).wire_uuid_case).toBe('lowercase');
    const phone = new Phone('ios');
    const grant = await phone.signIn(`${randomUUID()}@example.test`);
    const upper = phone.installationPublicId.toUpperCase();
    const challenge = await phone.api(
      'POST',
      '/v2/devices/enrollment/challenge',
      {
        enrollment_grant: grant.enrollment_grant,
        installation_public_id: upper,
        platform: 'ios',
        public_key: phone.jwk(),
      },
      { noAuth: true, expectedAccount: grant.account_id },
    );
    expect(challenge.status).toBe(201);
    const { nonce } = (await challenge.json()) as { nonce: string };
    // A client that sends an uppercase id but signs the lowercase form is refused.
    const lowerPayload = reference.payload({
      nonce,
      installation_public_id: phone.installationPublicId,
      platform: 'ios',
      enrollment_grant: grant.enrollment_grant,
    });
    const signature = sign('sha256', Buffer.from(lowerPayload), {
      key: phone.key.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    const response = await phone.api(
      'POST',
      '/v2/devices/enroll',
      {
        platform: 'ios',
        app_version: '1.0.0 (1)',
        installation_public_id: upper,
        enrollment_grant: grant.enrollment_grant,
        proof: { nonce, signature: signature.toString('base64url'), public_key: phone.jwk() },
      },
      { noAuth: true, expectedAccount: grant.account_id },
    );
    expect(response.status).toBe(401);
    // Control: the same challenge signed over the string the body carries is accepted.
    const matching = sign(
      'sha256',
      Buffer.from(
        reference.payload({
          nonce,
          installation_public_id: upper,
          platform: 'ios',
          enrollment_grant: grant.enrollment_grant,
        }),
      ),
      { key: phone.key.privateKey, dsaEncoding: 'ieee-p1363' },
    );
    const accepted = await phone.api(
      'POST',
      '/v2/devices/enroll',
      {
        platform: 'ios',
        app_version: '1.0.0 (1)',
        installation_public_id: upper,
        enrollment_grant: grant.enrollment_grant,
        proof: { nonce, signature: matching.toString('base64url'), public_key: phone.jwk() },
      },
      { noAuth: true, expectedAccount: grant.account_id },
    );
    expect(accepted.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Spec amendment 2.2 (package E): native taste onboarding and ready notices.
// onboarding.json and ready-notice.json hold the decision tables the Swift and
// Kotlin clients implement; the reference implementations below are the third
// copy, checked against the server schemas, copy file and push drivers.
// ---------------------------------------------------------------------------

type SeedCase = {
  name: string;
  state: string;
  categories: string[];
  elapsed_ms: number;
  expect: 'wait' | 'advance' | 'background';
};
type ReadyCase = {
  name: string;
  state: string;
  app: 'background' | 'foreground' | 'viewing';
  watched: boolean;
  notified: boolean;
  age_hours: number;
  expect: { notice: 'none' | 'toast' | 'notification'; keep_watching: boolean };
};
const onboardingFixture = await load<{
  auth: {
    operations: string[];
    mutation_headers: string[];
    error_body: string;
    other_v1_routes_refuse_with: string;
  };
  routes: Record<string, { route: string; operation: string }>;
  limits: Record<string, number>;
  categories: string[];
  category_copy_keys: Record<string, string>;
  exclusion_suggestions: string[];
  copy: Record<string, string>;
  steps: { n: number; id: string; title_key: string; primary_key: string; back: boolean }[];
  step_label_example: { n: number; text: string };
  counter: { picks: number; text: string; progress: number; can_complete: boolean }[];
  search: { debounce_ms: number; cases: { name: string; input: string; expect: string | null }[] };
  exclusions: {
    cases: {
      name: string;
      current: string[];
      input: string;
      expect: { list: string[]; rejected: string | null };
    }[];
    toggle_cases: { name: string; current: string[]; term: string; expect: string[] }[];
    display_examples: { term: string; label: string }[];
  };
  entry: {
    cases: {
      name: string;
      onboarding_flag: boolean;
      state: { required: boolean; picks_count: number } | null;
      error: string | null;
      expect: string;
    }[];
  };
  complete: { cases: { name: string; picks: number; error: string | null; expect: string }[] };
  seed: { default_poll_ms: number; max_wait_ms: number; cases: SeedCase[] };
}>('onboarding.json');
const readyFixture = await load<{
  push: {
    reference_pattern: string;
    apns: { headers: Record<string, string>; body: Json };
    fcm: { android: Json; data: Json };
    invalid_wakes: { name: string; apns_body: Json; fcm_data: Json }[];
    register: {
      route: string;
      clear_route: string;
      providers: Record<'ios' | 'android', string>;
      apns_token_pattern: string;
      examples: Record<'ios' | 'android', string>;
    };
  };
  watch: {
    start_route: string;
    poll_route: string;
    max_watched: number;
    expire_after_hours: number;
  };
  copy: Record<string, string>;
  decisions: ReadyCase[];
}>('ready-notice.json');
const designCopy = JSON.parse(
  await readFile(
    new URL('../../../../specs/capture-platform-v2/design/copy.json', import.meta.url),
    'utf8',
  ),
) as Record<string, string>;

/** Reference implementations of the native onboarding and ready-notice rules. */
const onboardingReference = {
  counter(picks: number) {
    const min = onboardingFixture.limits.min_picks!;
    const left = Math.max(0, min - picks);
    return {
      text:
        left === 0
          ? designCopy['onboarding.counter.ready']!
          : designCopy[`onboarding.counter.${left}`]!,
      progress: Math.min(picks, min),
      can_complete: picks >= min,
    };
  },
  searchQuery(input: string): string | null {
    const q = input.trim();
    const { search_query_min_chars: min, search_query_max_chars: max } = onboardingFixture.limits;
    return q.length >= min! && q.length <= max! ? q : null;
  },
  addExclusion(current: string[], raw: string): { list: string[]; rejected: string | null } {
    const value = raw.trim().replace(/\s+/g, ' ');
    if (!value) return { list: current, rejected: 'empty' };
    if (value.length > onboardingFixture.limits.exclusion_max_chars!)
      return { list: current, rejected: 'too_long' };
    if (current.some((c) => c.toLowerCase() === value.toLowerCase()))
      return { list: current, rejected: 'duplicate' };
    if (current.length >= onboardingFixture.limits.exclusions_max!)
      return { list: current, rejected: 'full' };
    return { list: [...current, value], rejected: null };
  },
  toggleExclusion(current: string[], term: string): string[] {
    const present = current.some((c) => c.toLowerCase() === term.toLowerCase());
    return present
      ? current.filter((c) => c.toLowerCase() !== term.toLowerCase())
      : onboardingReference.addExclusion(current, term).list;
  },
  label: (term: string) => term.charAt(0).toUpperCase() + term.slice(1),
  entry(c: {
    onboarding_flag: boolean;
    state: { required: boolean } | null;
    error: string | null;
  }): string {
    if (!c.onboarding_flag) return 'app';
    if (c.error) {
      if (c.error === 'not_found' || c.error === 'scope_denied') return 'app';
      // error-policy.json sign_in_required codes, plus a refresh that failed.
      const signIn = errorPolicy.codes.find((e) => e.code === c.error)?.action === 'sign_in_required';
      if (signIn || c.error === 'token_expired') return 'sign_in';
      return 'retry';
    }
    return c.state?.required ? 'onboarding' : 'app';
  },
  complete(c: { picks: number; error: string | null }): string {
    if (c.picks < onboardingFixture.limits.min_picks!) return 'disabled';
    if (c.error === 'conflict') return 'reload_state';
    if (c.error) return 'retry';
    return 'building';
  },
  seed(c: SeedCase): SeedCase['expect'] {
    if (c.categories.includes('ready')) return 'advance';
    if (c.state === 'complete' || c.state === 'not_started') return 'advance';
    if (c.state === 'failed' || c.state === 'retrying' || c.categories.includes('unavailable'))
      return 'background';
    if (c.elapsed_ms >= onboardingFixture.seed.max_wait_ms) return 'background';
    return 'wait';
  },
  ready(c: ReadyCase): ReadyCase['expect'] {
    const stop = { notice: 'none' as const, keep_watching: false };
    if (!c.watched || c.notified || c.age_hours >= readyFixture.watch.expire_after_hours)
      return stop;
    if (c.state === 'queued' || c.state === 'running' || c.state === 'partial')
      return { notice: 'none', keep_watching: true };
    if (c.state !== 'complete') return stop;
    return {
      notice: c.app === 'background' ? 'notification' : c.app === 'foreground' ? 'toast' : 'none',
      keep_watching: false,
    };
  },
  validWake(payload: Json): boolean {
    const ref = payload.ref;
    return typeof ref === 'string' && new RegExp(readyFixture.push.reference_pattern).test(ref);
  },
};

describe('native taste onboarding fixtures (amendment 2.2)', () => {
  it('lists exactly the bridged owner routes, matching the server route table', () => {
    const fixtureOps = Object.values(onboardingFixture.routes);
    expect(new Set(onboardingFixture.auth.operations)).toEqual(NATIVE_OWNER_OPERATIONS);
    expect(fixtureOps.map((r) => r.route).sort()).toEqual([...NATIVE_OWNER_OPERATIONS].sort());
    for (const { route, operation } of fixtureOps) {
      const contractRoute = schemas.ROUTES[operation as keyof typeof schemas.ROUTES];
      expect(contractRoute, operation).toBeDefined();
      expect(`${contractRoute.method} ${contractRoute.path}`, operation).toBe(route);
      // Bridged routes are owner/account (or 'any', which still requires taste:read
      // once the installation is converted to the account owner).
      expect(['owner', 'account', 'any'], operation).toContain(contractRoute.auth);
    }
    expect(onboardingFixture.auth.mutation_headers).toEqual([
      contract.headers.idempotency_key,
      contract.headers.expected_account,
    ]);
    // /v1 errors are flat; the native transports decode both shapes.
    const { body } = toErrorBody(
      new AppError('conflict', { message: 'Pick at least 3 to finish.' }),
      randomUUID(),
    );
    expect(shapeOf(body)).toEqual(shapeOf(messages.v1_error_body!.body));
    expect(onboardingFixture.auth.error_body).toBe('flat');
    expect(onboardingFixture.auth.other_v1_routes_refuse_with).toBe('scope_denied');
  });

  it('every onboarding wire example names its route and parses with the route schema', () => {
    const byRoute = new Map(
      Object.values(schemas.ROUTES).map((r) => [
        `${r.method} ${r.path}`,
        r as schemas.RouteContract,
      ]),
    );
    const onboardingMessages = Object.entries(messages).filter(([, m]) =>
      / \/v1\/(onboarding|taste)\//.test(m.route),
    );
    expect(onboardingMessages.length).toBeGreaterThanOrEqual(15);
    for (const [name, message] of onboardingMessages) {
      const route = byRoute.get(message.route);
      expect(route, name).toBeDefined();
      const schema = message.direction === 'request' ? route!.body : route!.response;
      expect((schema as z.ZodType).safeParse(message.body).success, name).toBe(true);
    }
  });

  it('every typed graph wire example names its route and parses with the route schema', () => {
    const byRoute = new Map(
      Object.values(schemas.ROUTES).map((r) => [
        `${r.method} ${r.path}`,
        r as schemas.RouteContract,
      ]),
    );
    const graphMessages = Object.entries(messages).filter(([, m]) => / \/v2\/me\//.test(m.route));
    expect(graphMessages.length).toBeGreaterThanOrEqual(10);
    for (const [name, message] of graphMessages) {
      if (name === 'revision_conflict_error') {
        // The shared typed rejection: v2 error body naming revision_conflict.
        expect(schemas.CaptureV2Error.safeParse(message.body).success, name).toBe(true);
        expect((message.body as { error: { code: string } }).error.code).toBe('revision_conflict');
        continue;
      }
      const route = byRoute.get(message.route);
      expect(route, name).toBeDefined();
      const schema = message.direction === 'request' ? route!.body : route!.response;
      expect((schema as z.ZodType).safeParse(message.body).success, name).toBe(true);
    }
    // The graph routes a native phone reaches are exactly the four bridged v2
    // graph operations of the native owner bridge (VAL-API-003).
    const graphRoutes = new Set(
      graphMessages.filter(([name]) => name !== 'revision_conflict_error').map(([, m]) => m.route),
    );
    expect(graphRoutes).toEqual(new Set(NATIVE_OWNER_V2_GRAPH_OPERATIONS));
  });

  it('copy matches the design copy file exactly', () => {
    const expected = Object.fromEntries(
      Object.entries(designCopy).filter(([k]) => /^(onboarding|building|settings_taste)\./.test(k)),
    );
    expect(onboardingFixture.copy).toEqual(expected);
    const ready = Object.fromEntries(
      Object.entries(designCopy).filter(([k]) => k.startsWith('ready.')),
    );
    expect(readyFixture.copy).toEqual(ready);
    for (const step of onboardingFixture.steps) {
      expect(designCopy[step.title_key], step.id).toBeDefined();
      expect(designCopy[step.primary_key], step.id).toBeDefined();
    }
    expect(onboardingFixture.steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(
      designCopy['onboarding.step']!.replace('{n}', String(onboardingFixture.step_label_example.n)),
    ).toBe(onboardingFixture.step_label_example.text);
    for (const [category, key] of Object.entries(onboardingFixture.category_copy_keys))
      expect(designCopy[key], category).toBeDefined();
  });

  it('limits and vocabularies agree with the server schemas', () => {
    const l = onboardingFixture.limits;
    expect(l.min_picks).toBe(schemas.ONBOARDING_MIN_PICKS);
    expect(l.max_picks).toBe(schemas.ONBOARDING_MAX_PICKS);
    expect(onboardingFixture.categories).toEqual(['wear', 'play', 'watch', 'eat']);
    expect(Object.keys(schemas.TastePicksResponse.shape.picks.shape)).toEqual([
      ...onboardingFixture.categories,
      'other',
    ]);
    expect(onboardingFixture.exclusion_suggestions).toEqual([
      ...schemas.FOOD_EXCLUSION_SUGGESTIONS,
    ]);
    const ex = schemas.FoodExclusions;
    expect(ex.safeParse(onboardingFixture.exclusion_suggestions).success).toBe(true);
    expect(ex.safeParse([...onboardingFixture.exclusion_suggestions, 'celery']).success).toBe(
      false,
    );
    expect(ex.safeParse(['z'.repeat(l.exclusion_max_chars!)]).success).toBe(true);
    expect(ex.safeParse(['z'.repeat(l.exclusion_max_chars! + 1)]).success).toBe(false);
    const result = {
      result_id: 'r'.repeat(16),
      name: 'n',
      type_label: 'Artist',
      category: null,
      picked: false,
    };
    const results = (n: number) =>
      schemas.OnboardingSearchResponse.safeParse({ status: 'ok', results: Array(n).fill(result) })
        .success;
    expect(results(l.search_results_max!)).toBe(true);
    expect(results(l.search_results_max! + 1)).toBe(false);
  });

  it('counter, search, exclusions, entry, complete and seed tables follow the reference rules', () => {
    for (const row of onboardingFixture.counter)
      expect(onboardingReference.counter(row.picks), `counter ${row.picks}`).toEqual({
        text: row.text,
        progress: row.progress,
        can_complete: row.can_complete,
      });
    for (const c of onboardingFixture.search.cases) {
      expect(onboardingReference.searchQuery(c.input), c.name).toBe(c.expect);
      // The phone sends a query exactly when the server accepts it.
      expect(schemas.OnboardingSearchQuery.safeParse({ q: c.input }).success, c.name).toBe(
        c.expect !== null,
      );
    }
    for (const c of onboardingFixture.exclusions.cases) {
      const out = onboardingReference.addExclusion(c.current, c.input);
      expect(out, c.name).toEqual(c.expect);
      expect(
        schemas.PutExclusionsRequest.safeParse({ food_exclusions: out.list }).success,
        c.name,
      ).toBe(true);
    }
    for (const c of onboardingFixture.exclusions.toggle_cases)
      expect(onboardingReference.toggleExclusion(c.current, c.term), c.name).toEqual(c.expect);
    for (const c of onboardingFixture.exclusions.display_examples)
      expect(onboardingReference.label(c.term)).toBe(c.label);
    for (const c of onboardingFixture.entry.cases) {
      if (c.error && c.error !== 'transport') expect(ERROR_CODES, c.name).toHaveProperty(c.error);
      expect(onboardingReference.entry(c), c.name).toBe(c.expect);
    }
    for (const c of onboardingFixture.complete.cases)
      expect(onboardingReference.complete(c), c.name).toBe(c.expect);
    for (const c of onboardingFixture.seed.cases) {
      expect(schemas.SEED_STATES, c.name).toContain(c.state);
      expect(c.categories).toHaveLength(4);
      for (const s of c.categories) expect(schemas.SEED_CATEGORY_STATES, c.name).toContain(s);
      expect(onboardingReference.seed(c), c.name).toBe(c.expect);
    }
    // The seed examples in messages.json decide as their names say.
    const decide = (key: string) => {
      const body = messages[key]!.body as { state: string; categories: { state: string }[] };
      return onboardingReference.seed({
        name: key,
        state: body.state,
        categories: body.categories.map((c) => c.state),
        elapsed_ms: 0,
        expect: 'wait',
      });
    };
    expect(decide('onboarding_seed_partial_response')).toBe('advance');
    expect(decide('onboarding_seed_retrying_response')).toBe('background');
  });
});

describe('native ready notice fixtures (amendment 2.2, screen 17)', () => {
  it('decision table follows the reference rule over the server analysis states', () => {
    const states = schemas.AnalyzeMediaResponse.shape.state.options as readonly string[];
    for (const c of readyFixture.decisions) {
      expect(states, c.name).toContain(c.state);
      expect(onboardingReference.ready(c), c.name).toEqual(c.expect);
    }
    expect(new Set(readyFixture.decisions.map((d) => d.state))).toEqual(new Set(states));
    expect([
      schemas.CAPTURE_V2_ROUTES.analyzeMedia,
      schemas.CAPTURE_V2_ROUTES.mediaAnalysis,
    ]).toEqual([readyFixture.watch.start_route, readyFixture.watch.poll_route]);
    for (const w of readyFixture.push.invalid_wakes) {
      expect(onboardingReference.validWake(w.apns_body), w.name).toBe(false);
      expect(onboardingReference.validWake(w.fcm_data), w.name).toBe(false);
    }
    expect(onboardingReference.validWake(readyFixture.push.apns.body)).toBe(true);
    expect(onboardingReference.validWake(readyFixture.push.fcm.data)).toBe(true);
    expect(messages.push_token_ios_request!.body.token).toMatch(
      new RegExp(readyFixture.push.register.apns_token_pattern),
    );
  });

  it('the real APNs and FCM drivers send exactly the fixture wake shapes', async () => {
    const reference = randomBytes(16).toString('base64url');
    expect(reference).toMatch(new RegExp(readyFixture.push.reference_pattern));
    const seen: { headers: Record<string, unknown>; body: string }[] = [];
    const server = createH2Server();
    server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        seen.push({ headers: { ...headers }, body: Buffer.concat(chunks).toString() });
        stream.respond({ ':status': 200 });
        stream.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const apns = new ApnsPushDriver({
        teamId: 'TEAM123456',
        keyId: 'KEY1234567',
        privateKey: ec.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        topic: 'com.cultureatlas.app',
        origins: { production: origin, sandbox: origin },
      });
      const token = messages.push_token_ios_request!.body.token as string;
      expect(
        await apns.wake({ provider: 'apns', token, environment: 'production' }, reference),
      ).toBe('sent');
      apns.close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    const sent = seen.at(-1)!;
    for (const [k, v] of Object.entries(readyFixture.push.apns.headers))
      expect(sent.headers[k], k).toBe(v);
    expect(JSON.parse(sent.body)).toEqual({ ...readyFixture.push.apns.body, ref: reference });

    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let fcmBody: { message: Json } | undefined;
    const fcm = new FcmPushDriver({
      projectId: 'culture-atlas-test',
      clientEmail: 'push@culture-atlas-test.iam.gserviceaccount.com',
      privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('oauth2'))
          return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), {
            status: 200,
          });
        fcmBody = JSON.parse(String(init?.body)) as { message: Json };
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    const fcmToken = messages.push_token_android_request!.body.token as string;
    expect(
      await fcm.wake({ provider: 'fcm', token: fcmToken, environment: 'production' }, reference),
    ).toBe('sent');
    expect(fcmBody!.message.data).toEqual({ ...readyFixture.push.fcm.data, ref: reference });
    expect(fcmBody!.message.android).toEqual(readyFixture.push.fcm.android);
  });
});

describe('native owner bridge and push registration through the real handlers', () => {
  const requestMessage: Record<string, string | undefined> = {
    createOnboardingPick: 'onboarding_pick_catalog_request',
    createTastePick: 'onboarding_pick_search_request',
    putOnboardingExclusions: 'onboarding_exclusions_request',
    completeOnboarding: 'onboarding_complete_request',
    createCollection: 'collection_create_request',
    addCollectionItem: 'collection_add_item_request',
    discoverRelated: 'related_discovery_request',
  };
  const responseMessage: Record<string, string> = {
    getOnboardingCatalog: 'onboarding_catalog_response',
    searchOnboarding: 'onboarding_search_response',
    createOnboardingPick: 'onboarding_pick_response',
    deleteOnboardingPick: 'onboarding_delete_pick_response',
    putOnboardingExclusions: 'onboarding_exclusions_response',
    completeOnboarding: 'onboarding_complete_response',
    getOnboardingState: 'onboarding_state_response',
    getOnboardingSeed: 'onboarding_seed_partial_response',
    listTastePicks: 'taste_picks_response',
    createTastePick: 'onboarding_pick_response',
    deleteTastePick: 'onboarding_delete_pick_response',
    getDiscoveries: 'discoveries_response',
    getItem: 'item_detail_response',
    discoverRelated: 'related_discovery_response',
    getCapture: 'capture_detail_response',
    listCollections: 'collections_list_response',
    createCollection: 'collection_create_response',
    getCollection: 'collection_detail_response',
    addCollectionItem: 'collection_add_item_response',
  };
  const pickId = '6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f20';
  type Operation = keyof typeof schemas.ROUTES;

  /**
   * One /v1 call the way AtlasAPI / AtlasApi send it (bearer, Idempotency-Key
   * and the expected account on mutations). The handler is a stand-in for the
   * onboarding service: it records the principal the bridge produced and
   * returns the fixture body, which apiRoute validates against the response
   * schema (non-production).
   */
  async function callBridged(
    phone: Phone,
    operation: Operation,
    opts: { expectedAccount?: string | null } = {},
  ) {
    const route = schemas.ROUTES[operation] as schemas.RouteContract;
    const seen: { principal?: unknown } = {};
    const handler = apiRoute(route, async ({ ctx }) => {
      seen.principal = ctx.principal;
      return messages[responseMessage[operation]!]!.body as never;
    });
    const mutation = route.method !== 'GET';
    const headers: Record<string, string> = {
      authorization: `Bearer ${phone.access}`,
      'x-forwarded-for': phone.ip,
    };
    if (mutation) headers['idempotency-key'] = randomUUID();
    const expected = opts.expectedAccount === undefined ? phone.accountId : opts.expectedAccount;
    if (mutation && expected) headers['x-atlas-expected-account'] = expected;
    const bodyKey = requestMessage[operation];
    if (bodyKey) headers['content-type'] = 'application/json';
    const path =
      route.path.replace('{id}', pickId).replace('{item_id}', pickId) +
      (operation === 'searchOnboarding' ? '?q=nina' : '');
    const params: Record<string, string> = {};
    if (route.path.includes('{id}')) params.id = pickId;
    if (route.path.includes('{item_id}')) params.item_id = pickId;
    const response = await handler(
      new NextRequest(`http://localhost:3399${path}`, {
        method: route.method,
        headers,
        body: bodyKey ? JSON.stringify(messages[bodyKey]!.body) : undefined,
      }),
      { params: Promise.resolve(params) },
    );
    return { response, seen };
  }

  it('a live phone acts as its account owner on every onboarding and taste route, and nowhere else', async () => {
    const phone = new Phone('ios');
    await phone.enroll(await phone.signIn(`${randomUUID()}@example.test`));
    for (const { operation } of Object.values(onboardingFixture.routes)) {
      const { response, seen } = await callBridged(phone, operation as Operation);
      expect(response.status, `${operation}: ${await response.clone().text()}`).toBe(
        (schemas.ROUTES[operation as Operation] as schemas.RouteContract).status,
      );
      expect(seen.principal, operation).toEqual({
        kind: 'account',
        accountId: phone.accountId,
        sessionId: null,
        isDemoOwner: false,
      });
    }
    // Every other /v1 route still refuses the installation token before any handler runs.
    const other = Object.values(schemas.ROUTES).find(
      (r) =>
        r.auth === 'account' &&
        r.method === 'GET' &&
        !NATIVE_OWNER_OPERATIONS.has(`${r.method} ${r.path}`),
    ) as schemas.RouteContract;
    let called = false;
    const id = randomUUID();
    const refused = await apiRoute(other, async () => {
      called = true;
      return undefined as never;
    })(
      new NextRequest(`http://localhost:3399${other.path.replace('{id}', id)}`, {
        headers: { authorization: `Bearer ${phone.access}`, 'x-forwarded-for': phone.ip },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('scope_denied');
    expect(called).toBe(false);
  });

  it('a phone completes onboarding through the real /v1/onboarding handlers', async () => {
    const routes = {
      state: await import('../../app/v1/onboarding/state/route'),
      catalog: await import('../../app/v1/onboarding/catalog/route'),
      picks: await import('../../app/v1/onboarding/picks/route'),
      exclusions: await import('../../app/v1/onboarding/exclusions/route'),
      complete: await import('../../app/v1/onboarding/complete/route'),
      seed: await import('../../app/v1/onboarding/seed/route'),
      tastePicks: await import('../../app/v1/taste/picks/route'),
    };
    const phone = new Phone('android');
    await phone.enroll(await phone.signIn(`${randomUUID()}@example.test`));
    const call = async (
      handler: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
      method: string,
      path: string,
      body?: unknown,
    ) => {
      const headers: Record<string, string> = { authorization: `Bearer ${phone.access}`, 'x-forwarded-for': phone.ip };
      if (method !== 'GET') {
        headers['idempotency-key'] = randomUUID();
        headers['x-atlas-expected-account'] = phone.accountId;
      }
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await handler(
        new NextRequest(`http://localhost:3399${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
        { params: Promise.resolve({}) },
      );
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    // A new account made on the phone must finish the questionnaire first (ONB-01).
    const before = await call(routes.state.GET, 'GET', '/v1/onboarding/state');
    expect(before.status).toBe(200);
    expect(before.json.state).toMatchObject({ required: true, picks_count: 0 });
    const catalog = await call(routes.catalog.GET, 'GET', '/v1/onboarding/catalog');
    const chips = Object.values(catalog.json.chips as Record<string, { id: string }[]>).flat();
    for (const chip of chips.slice(0, 2))
      expect((await call(routes.picks.POST, 'POST', '/v1/onboarding/picks', { source: 'catalog', catalog_item_id: chip.id })).status).toBe(201);
    const early = await call(routes.complete.POST, 'POST', '/v1/onboarding/complete');
    expect(early.status).toBe(409);
    await call(routes.picks.POST, 'POST', '/v1/onboarding/picks', { source: 'catalog', catalog_item_id: chips[2]!.id });
    const excl = await call(routes.exclusions.PUT, 'PUT', '/v1/onboarding/exclusions', { food_exclusions: ['peanuts'] });
    expect(excl).toMatchObject({ status: 200, json: { food_exclusions: ['peanuts'] } });
    const done = await call(routes.complete.POST, 'POST', '/v1/onboarding/complete');
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ state: { required: false, picks_count: 3 }, seed: { state: 'queued' } });
    const seed = await call(routes.seed.GET, 'GET', '/v1/onboarding/seed');
    expect(seed.json).toMatchObject({ state: 'queued', job_id: (done.json.seed as { job_id: string }).job_id });
    const taste = await call(routes.tastePicks.GET, 'GET', '/v1/taste/picks');
    expect(taste.json).toMatchObject({ picks_count: 3, food_exclusions: ['peanuts'] });
  });

  it('mutations must name the signed-in account, and an ended installation is refused', async () => {
    const phone = new Phone('android');
    await phone.enroll(await phone.signIn(`${randomUUID()}@example.test`));
    const missing = await callBridged(phone, 'createOnboardingPick', { expectedAccount: null });
    expect(missing.response.status).toBe(409);
    expect((await missing.response.json()).code).toBe('account_mismatch');
    expect(missing.seen.principal).toBeUndefined();
    const other = await callBridged(phone, 'completeOnboarding', { expectedAccount: randomUUID() });
    expect((await other.response.json()).code).toBe('account_mismatch');
    expect(other.seen.principal).toBeUndefined();

    await db.query(`UPDATE mobile_installations SET authority_ended_at=now() WHERE id=$1`, [
      phone.installationId,
    ]);
    const ended = await callBridged(phone, 'getOnboardingState');
    expect(ended.response.status).toBe(401);
    expect((await ended.response.json()).code).toBe('token_revoked');
    expect(ended.seen.principal).toBeUndefined();
  });

  it('registers the fixture push token and wakes the phone with only an opaque reference', async () => {
    const phone = new Phone('ios');
    await phone.enroll(await phone.signIn(`${randomUUID()}@example.test`));
    const put = (body: Json) =>
      devicePushTokenRoute(
        new NextRequest(`http://localhost:3399/v2/device/push-token`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${phone.access}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            'x-atlas-expected-account': phone.accountId,
          },
          body: JSON.stringify(body),
        }),
      );
    const registered = await put(messages[readyFixture.push.register.examples.ios]!.body);
    expect(registered.status, await registered.clone().text()).toBe(200);
    expect(shapeOf(await registered.json())).toEqual(shapeOf(messages.push_token_response!.body));
    const driver = new NoopPushDriver();
    const outcome = await devicePush.wakeInstallation(
      db,
      { accountId: phone.accountId, installationId: phone.installationId },
      { encryptionKey: Buffer.alloc(32, 9).toString('base64'), driver },
    );
    expect(outcome).toBe('not_configured');
    expect(driver.references).toHaveLength(1);
    expect(driver.references[0]!.provider).toBe(readyFixture.push.register.providers.ios);
    expect(driver.references[0]!.reference).toMatch(
      new RegExp(readyFixture.push.reference_pattern),
    );
    // An iPhone must register with APNs, never FCM (and Android the reverse).
    const wrong = await put(messages[readyFixture.push.register.examples.android]!.body);
    expect(wrong.status).toBe(400);
  });
});
