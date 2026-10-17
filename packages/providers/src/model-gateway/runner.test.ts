import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ProviderError } from '../errors';
import { identity, limits, profile, request, response } from '../concentrate/test-fixtures';
import { ModelSpendLedger, MemorySpendStore } from './budget';
import { StructuredResponseRunner } from './runner';
import type { StructuredTransport } from './types';

function setup(transport: StructuredTransport = vi.fn(async () => response), overrides = {}) {
  const store = new MemorySpendStore();
  const ledger = new ModelSpendLedger(store, limits);
  const runner = new StructuredResponseRunner({ ...profile, ...overrides }, transport, ledger, {
    identity,
    allowTestStore: true,
    sleep: async () => {},
  });
  return { runner, store, ledger, transport };
}
describe('AI-01 structured runner, fake transports only', () => {
  it('returns only validated output, preserves response identity and unknown dollar charge', async () => {
    const { runner, store } = setup();
    await expect(runner.readiness()).resolves.toBe('qualified');
    const out = await runner.run(request);
    expect(out).toMatchObject({
      data: { ok: true },
      responseId: 'r1',
      actualProvider: null,
      model: profile.model,
    });
    expect((await store.read()).attempts[0]).toMatchObject({
      state: 'unknown',
      costMicros: null,
      usage: response.usage,
      identity: { ...identity, attemptKey: `${identity.attemptKey}:0` },
      promptVersion: 'test-p1',
    });
    await expect(runner.readiness()).resolves.toBe('available');
  });
  it.each([
    ['wrong schema', { text: '{"ok":"yes"}' }, 'invalid_response'],
    ['unknown key', { text: '{"ok":true,"extra":"untrusted"}' }, 'invalid_response'],
    ['missing key', { text: '{}' }, 'invalid_response'],
    ['invalid JSON', { text: '```json\n{"ok":true}\n```' }, 'invalid_response'],
    ['refusal', { outcome: 'refusal' }, 'content_rejected'],
    ['incomplete', { outcome: 'incomplete' }, 'incomplete_response'],
    ['response error', { outcome: 'error' }, 'invalid_response'],
    ['model mismatch', { model: 'other/model' }, 'invalid_response'],
    ['route mismatch', { actualProvider: 'unqualified' }, 'invalid_response'],
  ])('rejects %s without publishing or automatic schema repair', async (_, change, kind) => {
    const transport = vi.fn(async () => ({ ...response, ...change })) as StructuredTransport;
    const { runner, store } = setup(transport);
    await expect(runner.run(request)).rejects.toMatchObject({ kind });
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await store.read()).attempts[0]!.state).toBe('unknown');
    expect(identity.assetId).toBe('asset-1'); // gateway holds metadata only, has no storage/delete capability
  });
  it('rejects semantic cross-references before publication', async () => {
    const { runner } = setup();
    await expect(
      runner.run({
        ...request,
        validate: () => {
          throw new Error('Invalid cross-reference');
        },
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });
  it('enforces timeout even if a transport ignores AbortSignal, with uncertain charge and no retry', async () => {
    const transport = vi.fn(() => new Promise<never>(() => {}));
    const { runner, store } = setup(transport, { timeoutMs: 5 });
    await expect(runner.run(request)).rejects.toMatchObject({ kind: 'timeout' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await store.read()).attempts[0]!.state).toBe('unknown');
  });
  it.each([
    [402, 'budget_exhausted', 'credits'],
    [429, 'rate_limited', 'rate_limited'],
  ])('HTTP %s pauses AI only, no fallback or extra paid probe', async (status, kind, reason) => {
    const transport = vi.fn(async () => {
      throw new ProviderError('concentrate', kind as 'rate_limited', 'safe', {
        status: status as number,
        retryAfterMs: 5000,
      });
    });
    const { runner, store } = setup(transport);
    await expect(runner.run(request)).rejects.toMatchObject({ kind });
    await expect(runner.readiness()).resolves.toBe('degraded');
    await expect(
      runner.run(request, { modelIdentity: { ...identity, attemptKey: 'next' } }),
    ).rejects.toMatchObject({ kind });
    expect((await store.read()).pause).toMatchObject({ reason });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([401, 404, 422])(
    'HTTP %s disables role until operator reconfiguration',
    async (status) => {
      const transport = vi.fn(async () => {
        throw new ProviderError(
          'concentrate',
          status === 401 ? 'auth' : status === 404 ? 'not_found' : 'bad_request',
          'safe',
          { status },
        );
      });
      const { runner } = setup(transport);
      await expect(runner.run(request)).rejects.toBeInstanceOf(ProviderError);
      await expect(runner.run(request)).rejects.toMatchObject({ kind: 'unavailable' });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it('bounds transient retry to one and reserves each unknown attempt', async () => {
    const transport = vi.fn(async () => {
      throw new ProviderError('concentrate', 'server', 'safe', { status: 503 });
    });
    const { runner, store } = setup(transport);
    await expect(runner.run(request, { maxRetries: 99 })).rejects.toMatchObject({ kind: 'server' });
    expect(transport).toHaveBeenCalledTimes(2);
    expect((await store.read()).attempts).toHaveLength(2);
  });
  it('caps each retry against unknown spend rather than multiplying the allowance', async () => {
    const transport = vi.fn(async () => {
      throw new ProviderError('concentrate', 'server', 'safe', { status: 503 });
    });
    const { runner, store } = setup(transport, { reservationMicros: 500 });
    await expect(runner.run(request)).rejects.toMatchObject({ kind: 'budget_exhausted' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await store.read()).attempts).toHaveLength(1);
  });
  it('cancellation fences late output and records uncertain billing', async () => {
    const controller = new AbortController();
    const transport = vi.fn(async () => {
      controller.abort();
      return response;
    });
    const { runner, store } = setup(transport);
    await expect(runner.run(request, { signal: controller.signal })).rejects.toMatchObject({
      kind: 'aborted',
    });
    expect((await store.read()).attempts[0]!.state).toBe('unknown');
  });
  it('never dispatches pre-cancelled, oversized or unrepresentable requests', async () => {
    const { runner, transport, store } = setup();
    await expect(runner.run(request, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      kind: 'aborted',
    });
    await expect(
      runner.run({ ...request, content: [{ type: 'text', text: 'x'.repeat(100_001) }] }),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(
      runner.run({
        ...request,
        schema: z.object({ dictionary: z.record(z.string(), z.unknown()) }),
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    expect(transport).not.toHaveBeenCalled();
    expect((await store.read()).attempts).toHaveLength(0);
  });
  it('requires a durable store and verified identity outside explicit test wiring', async () => {
    const { ledger, transport } = setup();
    expect(() => new StructuredResponseRunner(profile, transport, ledger)).toThrow('Durable');
    const runner = new StructuredResponseRunner(profile, transport, ledger, {
      allowTestStore: true,
    });
    await expect(runner.run(request)).rejects.toMatchObject({ kind: 'bad_request' });
  });
  it('does not dispatch the same job attempt twice, even after an unknown outcome', async () => {
    const { runner, transport } = setup();
    await runner.run(request);
    await expect(runner.run(request)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
