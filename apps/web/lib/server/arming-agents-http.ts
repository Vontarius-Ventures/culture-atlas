import 'server-only';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  AppError,
  agentConnections,
  createServiceContext,
  toErrorBody,
} from '@culture-atlas/domain';
import { requireCaptureV2InstallationContext } from './capture-v2';

/**
 * Installation-safe agent names for the native arming sheet
 * (GET /v2/agent-connections with a `cna_` bearer).
 *
 * The owner Settings list stays on the cookie/session path and still returns
 * the full connection DTO. An enrolled phone only sees active agents that
 * may command *this* installation: id, name and scopes — no credential
 * prefix, collections or access summary.
 */
const headers = (requestId: string) => ({ 'x-request-id': requestId, 'cache-control': 'no-store' });

function failure(err: unknown, requestId: string): Response {
  const safe = err instanceof z.ZodError ? new AppError('invalid_input') : err;
  const { status, body } = toErrorBody(safe, requestId);
  return Response.json({ error: body }, { status, headers: headers(requestId) });
}

/** Installations may list names; creating or narrowing connections stays owner-only. */
export async function refuseInstallationMutation(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    await requireCaptureV2InstallationContext(request);
    throw new AppError('scope_denied');
  } catch (err) {
    return failure(err, requestId);
  }
}

export async function listArmingAgentsRoute(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    const ctx = await requireCaptureV2InstallationContext(request);
    if (ctx.authority.kind !== 'installation') throw new AppError('unauthenticated');
    const owner = createServiceContext(
      {
        kind: 'account',
        accountId: ctx.authority.accountId,
        sessionId: null,
        isDemoOwner: false,
      },
      { db: ctx.db, requestId, surface: 'rest' },
    );
    const listed = await agentConnections.listAgentConnections(owner);
    const installationId = ctx.authority.installationId;
    const connections = listed.connections
      .filter(
        (c) =>
          c.status === 'active' &&
          c.scopes.includes('devices:command') &&
          (c.installation_ids ?? []).includes(installationId),
      )
      .map((c) => ({ id: c.id, client_name: c.client_name, scopes: c.scopes }));
    return Response.json(
      { schema_version: '2.1', request_id: requestId, connections },
      { headers: headers(requestId) },
    );
  } catch (err) {
    return failure(err, requestId);
  }
}
