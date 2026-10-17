import { randomUUID } from 'node:crypto';
import { getProviders, type ProviderRegistry } from '@culture-atlas/providers';
import { getDomainConfig, type DomainConfig } from './config';
import { getDb, type Db } from './db/pool';
import type { Principal } from './principal';
import type { CaptureV2Context } from './capture-v2/types';

/**
 * Everything a service function needs. REST handlers, MCP tools and server
 * components build one per request; tests build one with fakes.
 * Services never read process.env or global singletons directly.
 */
export interface ServiceContext {
  principal: Principal;
  requestId: string;
  db: Db;
  providers: ProviderRegistry;
  config: DomainConfig;
  now(): Date;
  /** Correlates trace_events / provider_queries for the demo inspector. */
  traceId?: string;
  /** Surface the call came from (for traces/metrics). */
  surface: 'rest' | 'mcp' | 'web' | 'worker' | 'test';
  /** Trusted runtime adapter, never accepted from an HTTP/tool payload. */
  captureV2?: CaptureV2Context;
}

export function createServiceContext(
  principal: Principal,
  overrides: Partial<Omit<ServiceContext, 'principal'>> = {},
): ServiceContext {
  return {
    principal,
    requestId: overrides.requestId ?? randomUUID(),
    db: overrides.db ?? getDb(),
    providers: overrides.providers ?? getProviders(),
    config: overrides.config ?? getDomainConfig(),
    now: overrides.now ?? (() => new Date()),
    traceId: overrides.traceId,
    surface: overrides.surface ?? 'rest',
    captureV2: overrides.captureV2,
  };
}
