import { describe, expect, it } from 'vitest';
import type { ModelGateway, ReadinessDetail, ModelRole } from '@culture-atlas/providers';
import { photoAnalysisReadiness, roleAvailability } from './model-readiness';

function gateway(detail: ReadinessDetail | Error): ModelGateway {
  return {
    readiness: async () => {
      if (detail instanceof Error) throw detail;
      return Object.fromEntries(
        (['vision_photo', 'vision_video_frame', 'research_text', 'composer'] as ModelRole[]).map(
          (role) => [role, { role, model: 'fixture/model-1', ...detail }],
        ),
      ) as Awaited<ReturnType<ModelGateway['readiness']>>;
    },
  } as unknown as ModelGateway;
}

describe('v2 analysis availability (read-only, no paid probe)', () => {
  it.each([
    [{ state: 'qualified' }, 'available'],
    [{ state: 'available' }, 'available'],
    [{ state: 'degraded', reason: 'rate_limited' }, 'waiting'],
    [{ state: 'unavailable', reason: 'credits' }, 'waiting'],
    [{ state: 'unavailable', reason: 'cost_overrun' }, 'waiting'],
    [{ state: 'unavailable', reason: 'auth' }, 'unavailable'],
    [{ state: 'unavailable', reason: 'policy' }, 'unavailable'],
    [{ state: 'unavailable', reason: 'not_configured' }, 'unavailable'],
    [{ state: 'configured', reason: 'not_qualified' }, 'unavailable'],
    [{ state: 'catalog-compatible', reason: 'not_qualified' }, 'unavailable'],
  ] as Array<[ReadinessDetail, string]>)('%j -> %s', async (detail, expected) => {
    await expect(roleAvailability('vision_photo', gateway(detail))).resolves.toBe(expected);
  });

  it('is unavailable on an explicit Featherless/Anthropic rollback or a readiness read failure', async () => {
    await expect(roleAvailability('vision_photo', undefined)).resolves.toBe('unavailable');
    await expect(roleAvailability('vision_photo', gateway(new Error('db down')))).resolves.toBe(
      'unavailable',
    );
  });
});

describe('analysis readiness reports one cause per input', () => {
  it.each([
    [{ state: 'catalog-compatible', reason: 'not_qualified' }, { qualityQualified: false, budgetAvailable: true, providerReady: true }],
    [{ state: 'unavailable', reason: 'credits' }, { qualityQualified: true, budgetAvailable: false, providerReady: true }],
    [{ state: 'unavailable', reason: 'auth' }, { qualityQualified: true, budgetAvailable: true, providerReady: false }],
    [{ state: 'qualified' }, { qualityQualified: true, budgetAvailable: true, providerReady: true }],
  ] as Array<[ReadinessDetail, Record<string, boolean>]>)('%j', async (detail, expected) => {
    await expect(photoAnalysisReadiness(gateway(detail), false)).resolves.toMatchObject(expected);
  });

  it('labels a demo-override reading experimental', async () => {
    await expect(photoAnalysisReadiness(gateway({ state: 'qualified', experimental: true } as ReadinessDetail), false))
      .resolves.toMatchObject({ experimental: true, qualityQualified: true, providerReady: true });
  });
});
