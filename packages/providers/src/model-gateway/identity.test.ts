import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CallOptions } from '../errors';
import { createProviderRegistry } from '../registry';
import { FakeTextModel, FakeVlm } from '../testing';
import { bindModelIdentity, identitySequence } from './identity';

describe('per-job model identity (v1 jobs on the budgeted gateway)', () => {
  it('gives every model call its own stable attempt key and never overrides an explicit identity', async () => {
    const vlm = new FakeVlm(() => ({
      title: 't',
      interpretation: 'i',
      observations: [],
      visible_text: [],
      candidates: [],
      regions: [],
      uncertainty: { overall: 'low', notes: [] },
      competing_subjects: [],
      quality: { usable: true, issue: null },
    }));
    const text = new FakeTextModel(() => ({ ok: true }));
    const analyze = vi.spyOn(vlm, 'analyzeImage');
    const generate = vi.spyOn(text, 'generateStructured');
    const registry = createProviderRegistry(
      { STORAGE_DRIVER: 'memory' },
      { vlm, text, composer: text },
    );
    const bound = bindModelIdentity(
      registry,
      identitySequence({ accountId: 'acct', jobId: 'job', prefix: 'v1:analyze_capture:a1' }),
    );
    await bound.vlm.analyzeImage({
      image: { bytes: new Uint8Array([1]), mediaType: 'image/jpeg' },
    });
    await bound.text.generateStructured({
      system: 's',
      prompt: 'p',
      schema: z.object({ ok: z.boolean() }),
      schemaName: 'dish_ideas',
    });
    await bound.composer.generateStructured(
      { system: 's', prompt: 'p', schema: z.object({ ok: z.boolean() }), schemaName: 'plan_prose' },
      { modelIdentity: { accountId: 'acct', jobId: 'job', attemptKey: 'explicit' } },
    );
    const opts = (calls: unknown[][], i: number) => calls[i]![1] as CallOptions;
    expect(opts(analyze.mock.calls, 0).modelIdentity).toEqual({
      accountId: 'acct',
      jobId: 'job',
      attemptKey: 'v1:analyze_capture:a1:vlm:0',
    });
    expect(opts(generate.mock.calls, 0).modelIdentity!.attemptKey).toBe(
      'v1:analyze_capture:a1:dish_ideas:1',
    );
    expect(opts(generate.mock.calls, 1).modelIdentity!.attemptKey).toBe('explicit');
    expect(bound.vlm.id).toBe(vlm.id);
    expect(bound.capabilities()['qloo.search']).toEqual(registry.capabilities()['qloo.search']);
  });

  it('passes identity into research claim extraction (the research text model call)', async () => {
    const registry = createProviderRegistry({ STORAGE_DRIVER: 'memory' });
    const extract = vi
      .spyOn(registry.research, 'extractClaims')
      .mockResolvedValue({ overview: '', sections: [], claims: [] });
    const bound = bindModelIdentity(
      registry,
      identitySequence({ accountId: 'a', jobId: 'j', prefix: 'p' }),
    );
    await bound.research.extractClaims({ name: 'n', type: 't', sources: [] });
    expect(extract.mock.calls[0]![1]!.modelIdentity).toEqual({
      accountId: 'a',
      jobId: 'j',
      attemptKey: 'p:reference_notes:0',
    });
  });
});
